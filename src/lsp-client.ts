/**
 * LSP Client — lightweight JSON-RPC client over stdio for LSP servers.
 *
 * Uses vscode-jsonrpc (bundled with vscode-languageserver-protocol) to
 * communicate with any Language Server Protocol server spawned as a child process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-languageserver-protocol/node.js";
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  Diagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";

export interface LspClientOptions {
  /** Command to start the LSP server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Root directory of the workspace */
  rootDir: string;
  /** Language ID this server handles */
  languageId: string;
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Additional workspace folders (e.g. from bemol for Brazil multi-package workspaces) */
  workspaceFolders?: { uri: string; name: string }[];
}

export class LspClient {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private _serverCapabilities: ServerCapabilities | null = null;
  private _diagnostics: Map<string, Diagnostic[]> = new Map();
  private _initialized = false;
  private _disposed = false;

  readonly languageId: string;
  readonly command: string;
  readonly rootDir: string;

  constructor(private options: LspClientOptions) {
    this.languageId = options.languageId;
    this.command = options.command;
    this.rootDir = options.rootDir;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get serverCapabilities(): ServerCapabilities | null {
    return this._serverCapabilities;
  }

  /** Get cached diagnostics for a URI */
  getDiagnostics(uri: string): Diagnostic[] {
    return this._diagnostics.get(uri) ?? [];
  }

  /** Get all cached diagnostics */
  getAllDiagnostics(): Map<string, Diagnostic[]> {
    return new Map(this._diagnostics);
  }

  /** Start the LSP server and perform the initialize handshake */
  async start(): Promise<void> {
    if (this._initialized || this._disposed) return;

    const env = { ...process.env, ...this.options.env };

    this.process = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.rootDir,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn LSP server: ${this.options.command}`);
    }

    // Discard stderr to prevent blocking
    this.process.stderr?.resume();

    this.process.on("error", (err) => {
      console.error(`[LSP ${this.languageId}] Process error: ${err.message}`);
      this._initialized = false;
    });

    this.process.on("exit", (code) => {
      if (!this._disposed) {
        console.error(`[LSP ${this.languageId}] Server exited with code ${code}`);
        this._initialized = false;
      }
    });

    const reader = new StreamMessageReader(this.process.stdout);
    const writer = new StreamMessageWriter(this.process.stdin);
    this.connection = createMessageConnection(reader, writer);

    // Listen for published diagnostics (using string method to avoid type conflicts)
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this._diagnostics.set(params.uri, params.diagnostics);
      }
    );

    this.connection.listen();

    // Initialize handshake
    const rootUri = pathToFileURL(this.rootDir).toString();
    const defaultFolder = { uri: rootUri, name: this.rootDir.split("/").pop() ?? "workspace" };

    // Use provided workspace folders (e.g. from bemol) or fall back to single root
    const workspaceFolders = this.options.workspaceFolders && this.options.workspaceFolders.length > 0
      ? this.options.workspaceFolders
      : [defaultFolder];

    const initParams: InitializeParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            dynamicRegistration: false,
          },
          hover: {
            contentFormat: ["plaintext", "markdown"],
          },
          definition: {},
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          rename: {
            prepareSupport: false,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
          completion: {
            completionItem: {
              snippetSupport: false,
            },
          },
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
        },
      },
      rootUri,
      workspaceFolders,
    };

    const result: InitializeResult = await this.connection.sendRequest(
      "initialize",
      initParams
    );
    this._serverCapabilities = result.capabilities;

    // Send initialized notification
    this.connection.sendNotification("initialized", {});
    this._initialized = true;
  }

  /** Send a request to the LSP server */
  async sendRequest<R>(method: string, params: unknown): Promise<R> {
    if (!this.connection || !this._initialized) {
      throw new Error(`LSP ${this.languageId} not initialized`);
    }
    return this.connection.sendRequest(method, params) as Promise<R>;
  }

  /** Send a notification to the LSP server */
  sendNotification(method: string, params: unknown): void {
    if (!this.connection || !this._initialized) return;
    this.connection.sendNotification(method, params);
  }

  /** Notify server of a newly opened document */
  didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** Notify server of a document change (full content sync) */
  didChange(uri: string, version: number, text: string): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Notify server of a closed document */
  didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /** Gracefully shut down the server */
  async shutdown(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;

    try {
      if (this.connection) {
        await Promise.race([
          this.connection.sendRequest("shutdown"),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        this.connection.sendNotification("exit");
        this.connection.dispose();
      }
    } catch {
      // Server may already be dead
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      // Force kill after 2s
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 2000);
    }

    this.connection = null;
    this.process = null;
  }
}
