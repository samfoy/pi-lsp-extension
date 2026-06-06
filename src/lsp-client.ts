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
} from "vscode-languageserver-protocol/node";
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
  /** Additional workspace folders (e.g. for multi-package workspaces) */
  workspaceFolders?: { uri: string; name: string }[];
  /** Connect to existing daemon socket instead of spawning a new process */
  socketPath?: string;
  /** LSP initializationOptions (e.g. jdtls settings for Lombok) */
  initializationOptions?: Record<string, unknown>;
  /** Settings returned by workspace/configuration handler (keyed by section, e.g. { intelephense: {...} }) */
  settings?: Record<string, unknown>;
  /** Called when the server exits unexpectedly (not from user-initiated shutdown) */
  onUnexpectedExit?: (code: number | null) => void;
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

  /** Register shared connection handlers (diagnostics, workspace/configuration, errors) */
  private registerConnectionHandlers(): void {
    if (!this.connection) return;

    // Listen for published diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this._diagnostics.set(params.uri, params.diagnostics);
      }
    );

    // Handle workspace/configuration requests from the server.
    // Servers like Intelephense request their settings via this method.
    // Return settings from options if configured, otherwise empty defaults.
    this.connection.onRequest(
      "workspace/configuration",
      (params: { items: { section?: string }[] }) => {
        const settings = this.options.settings;
        return params.items.map((item) => {
          if (item.section && settings && item.section in settings) {
            return settings[item.section];
          }
          return {};
        });
      }
    );

    // Handle connection-level errors to prevent unhandled exceptions
    this.connection.onError(([err]) => {
      console.error(`[LSP ${this.languageId}] Connection error: ${err.message}`);
    });

    this.connection.onClose(() => {
      if (!this._disposed) {
        this._initialized = false;
      }
    });
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

        this.registerConnectionHandlers();

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
          this.options.onUnexpectedExit?.(null);
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

    // Wait for the process to successfully spawn before setting up the connection.
    // spawn() is async — ENOENT and other errors arrive on the 'error' event.
    // If we don't wait, we'll try to write to a destroyed stdin and crash.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn LSP server "${this.options.command}": ${err.message}`));
      };
      const cleanup = () => {
        this.process?.removeListener("spawn", onSpawn);
        this.process?.removeListener("error", onError);
      };
      this.process!.on("spawn", onSpawn);
      this.process!.on("error", onError);
    });

    // Discard stderr to prevent blocking
    this.process.stderr?.resume();

    // Patch stdin.write to silently drop writes when the stream is destroyed.
    // StreamMessageWriter wraps stdin and calls write() which returns a Promise.
    // If the stream is destroyed (process exited), write() throws ERR_STREAM_DESTROYED
    // inside the Promise constructor, creating a rejection that propagates through
    // the writer's semaphore and becomes unhandled (notifications are fire-and-forget).
    // No amount of error handlers on the stream or connection can catch this.
    const stdin = this.process.stdin!;
    const originalWrite = stdin.write;
    stdin.write = function (this: typeof stdin, ...args: any[]): boolean {
      if (this.destroyed || this.writableEnded || this.writableFinished) {
        // Call the callback (last arg) so the Promise resolves instead of rejecting
        const cb = args[args.length - 1];
        if (typeof cb === "function") process.nextTick(cb);
        return false;
      }
      try {
        return originalWrite.apply(this, args as any);
      } catch (err: any) {
        // Catch EPIPE synchronously — process exited between our check and the write
        if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
          const cb = args[args.length - 1];
          if (typeof cb === "function") process.nextTick(cb);
          return false;
        }
        throw err;
      }
    } as any;

    // Catch EPIPE on the stdin stream itself to prevent unhandled error events
    stdin.on("error", (err: any) => {
      if (err?.code === "EPIPE") return; // expected when server exits
      console.error(`[LSP ${this.languageId}] stdin error: ${err.message}`);
    });

    this.process.on("error", (err) => {
      console.error(`[LSP ${this.languageId}] Process error: ${err.message}`);
      this._initialized = false;
      this.disposeConnection();
    });

    this.process.on("exit", (code) => {
      if (!this._disposed) {
        console.error(`[LSP ${this.languageId}] Server exited with code ${code}`);
        this._initialized = false;
        this.disposeConnection();
        this.options.onUnexpectedExit?.(code);
      }
    });

    const reader = new StreamMessageReader(this.process.stdout);
    const writer = new StreamMessageWriter(this.process.stdin);
    this.connection = createMessageConnection(reader, writer);

    this.registerConnectionHandlers();

    this.connection.listen();

    // Initialize handshake
    const rootUri = pathToFileURL(this.rootDir).toString();
    const defaultFolder = { uri: rootUri, name: this.rootDir.split("/").pop() ?? "workspace" };

    // Use provided workspace folders or fall back to single root
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
          configuration: true,
        },
      },
      rootUri,
      workspaceFolders,
      ...(this.options.initializationOptions
        ? { initializationOptions: this.options.initializationOptions }
        : {}),
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

  /** Safely dispose the connection without throwing */
  private disposeConnection(): void {
    try {
      if (this.connection) {
        this.connection.dispose();
      }
    } catch {
      // Already disposed or stream destroyed — ignore
    }
    this.connection = null;
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
      this.disposeConnection();
      if (this.socket) {
        this.socket.destroy();
      }
      this.socket = null;
      return;
    }

    // Direct mode: shut down the server we own
    try {
      if (this.connection) {
        // Race shutdown request against a timeout. Catch the request separately
        // so if the timeout wins, the abandoned sendRequest rejection doesn't
        // become an unhandled promise rejection.
        const shutdownReq = this.connection.sendRequest("shutdown").catch(() => {});
        await Promise.race([
          shutdownReq,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        try { this.connection.sendNotification("exit"); } catch {}
      }
    } catch {
      // Server may already be dead
    }
    this.disposeConnection();

    if (this.process) {
      this.process.kill("SIGTERM");
      // Force kill after 2s
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 2000);
    }

    this.process = null;
  }
}
