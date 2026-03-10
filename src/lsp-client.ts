/**
 * LSP Client — JSON-RPC client for LSP servers.
 *
 * Supports two modes:
 * - **Direct**: spawns LSP server as child process (stdio)
 * - **Socket**: connects to an LSP daemon via Unix domain socket
 *
 * Uses vscode-jsonrpc (bundled with vscode-languageserver-protocol) for
 * JSON-RPC message framing and transport.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  SocketMessageReader,
  SocketMessageWriter,
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
  /** Connect to existing daemon socket instead of spawning a new process */
  socketPath?: string;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private connection: MessageConnection | null = null;
  private _serverCapabilities: ServerCapabilities | null = null;
  private _diagnostics: Map<string, Diagnostic[]> = new Map();
  private _initialized = false;
  private _disposed = false;
  /** True if connected to a daemon socket (server init handled by daemon) */
  private _isDaemonClient = false;

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

    if (this.options.socketPath) {
      await this.connectToSocket(this.options.socketPath);
    } else {
      await this.spawnDirect();
    }
  }

  /** Connect to an existing LSP daemon via Unix socket (no init handshake needed) */
  private async connectToSocket(socketPath: string): Promise<void> {
    this._isDaemonClient = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      const socket = netConnect(socketPath, () => {
        this.socket = socket;

        const reader = new SocketMessageReader(socket);
        const writer = new SocketMessageWriter(socket);
        this.connection = createMessageConnection(reader, writer);

        // Listen for diagnostics
        this.connection.onNotification(
          "textDocument/publishDiagnostics",
          (params: PublishDiagnosticsParams) => {
            this._diagnostics.set(params.uri, params.diagnostics);
          }
        );

        this.connection.listen();
        this._initialized = true;
        settle(() => resolve());
      });

      socket.on("error", (err) => {
        if (!this._initialized) {
          settle(() => reject(new Error(`Failed to connect to LSP daemon: ${err.message}`)));
        } else {
          this._initialized = false;
        }
      });

      socket.on("close", () => {
        if (!this._disposed) {
          this._initialized = false;
        }
      });

      // Timeout
      setTimeout(() => {
        if (!settled) {
          socket.destroy();
          settle(() => reject(new Error("Timeout connecting to LSP daemon socket")));
        }
      }, 10_000);
    });
  }

  /** Spawn LSP server directly as child process with stdio */
  private async spawnDirect(): Promise<void> {
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

    // Listen for published diagnostics
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

  /** Gracefully shut down or disconnect from the server */
  async shutdown(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;

    if (this._isDaemonClient) {
      // Socket client: just disconnect — daemon keeps the server alive
      try {
        if (this.connection) this.connection.dispose();
      } catch { /* ignore */ }
      if (this.socket) {
        this.socket.destroy();
      }
      this.connection = null;
      this.socket = null;
      return;
    }

    // Direct mode: shut down the server we own
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
