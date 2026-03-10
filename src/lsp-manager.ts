/**
 * LSP Manager — manages multiple LSP server instances, one per language.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 * Integrates with bemol for Brazil workspace support.
 */

import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { LspClient } from "./lsp-client.js";
import { BemolManager } from "./bemol.js";

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Lifecycle callbacks for UI notifications */
export interface LspManagerCallbacks {
  onBemolStart?: () => void;
  onBemolEnd?: (success: boolean, duration: number) => void;
  onServerStart?: (languageId: string, command: string) => void;
  onServerReady?: (languageId: string) => void;
  onServerError?: (languageId: string, error: string) => void;
}

/** Default server configurations for common languages */
const DEFAULT_SERVERS: Record<string, ServerConfig> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] },
  typescriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  javascriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  rust: { command: "rust-analyzer", args: [] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
  go: { command: "gopls", args: ["serve"] },
  java: { command: "jdtls", args: [] },
};

/** Map file extensions to LSP language IDs */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mts": "typescript",
  ".mjs": "javascript",
  ".cts": "typescript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".lua": "lua",
  ".zig": "zig",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
};

export interface ServerStatus {
  languageId: string;
  command: string;
  running: boolean;
  diagnosticsCount: number;
  /** True if using a shared daemon (vs direct spawn) */
  shared: boolean;
}

export class LspManager {
  private clients: Map<string, LspClient> = new Map();
  private serverConfigs: Map<string, ServerConfig>;
  private rootDir: string;
  private startingServers: Map<string, Promise<LspClient>> = new Map();
  private _bemol: BemolManager;
  private _bemolEnsured = false;
  private _bemolEnsuring: Promise<boolean> | null = null;
  private _callbacks: LspManagerCallbacks;
  private _sessionId: string;

  constructor(rootDir: string, customConfigs?: Record<string, ServerConfig>, callbacks?: LspManagerCallbacks, sessionId?: string) {
    this.rootDir = resolve(rootDir);
    this.serverConfigs = new Map(Object.entries({
      ...DEFAULT_SERVERS,
      ...customConfigs,
    }));
    this._bemol = new BemolManager(this.rootDir);
    this._callbacks = callbacks ?? {};
    this._sessionId = sessionId ?? `${process.pid}-${Date.now()}`;
  }

  /** Get the bemol manager for status/commands */
  get bemol(): BemolManager {
    return this._bemol;
  }

  /** Update or add a server configuration */
  setServerConfig(languageId: string, config: ServerConfig): void {
    this.serverConfigs.set(languageId, config);
  }

  /** Get all configured languages */
  getConfiguredLanguages(): string[] {
    return [...this.serverConfigs.keys()];
  }

  /** Resolve a file path to a language ID */
  getLanguageId(filePath: string): string | undefined {
    const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
    return ext ? EXT_TO_LANGUAGE[ext] : undefined;
  }

  /** Get a file URI from a path */
  getFileUri(filePath: string): string {
    const abs = resolve(this.rootDir, filePath);
    return pathToFileURL(abs).toString();
  }

  /** Resolve an absolute path from potentially relative input */
  resolvePath(filePath: string): string {
    return resolve(this.rootDir, filePath);
  }

  /**
   * Get the LSP client for a language ONLY if it's already running.
   * Does not start a new server. Returns null if no client is active.
   */
  getRunningClient(languageId: string): LspClient | null {
    const existing = this.clients.get(languageId);
    if (existing && existing.initialized && !existing.disposed) {
      return existing;
    }
    return null;
  }

  /**
   * Get the LSP client for a file, starting the server if needed.
   * Returns null if no server is configured for this file type.
   */
  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.getClientForLanguage(languageId);
  }

  /**
   * Get the LSP client for a language, starting the server if needed.
   * In Brazil workspaces, connects to a shared daemon (or spawns one).
   * Returns null if no server is configured for this language.
   */
  async getClientForLanguage(languageId: string): Promise<LspClient | null> {
    // Already running?
    const existing = this.clients.get(languageId);
    if (existing && existing.initialized && !existing.disposed) {
      return existing;
    }

    // Already starting?
    const starting = this.startingServers.get(languageId);
    if (starting) return starting;

    const config = this.serverConfigs.get(languageId);
    if (!config) return null;

    // Start a new server (or connect to daemon)
    const startPromise = this.startServer(languageId, config);
    this.startingServers.set(languageId, startPromise);

    try {
      const client = await startPromise;
      return client;
    } catch (err) {
      this.startingServers.delete(languageId);
      throw err;
    }
  }

  /**
   * Ensure bemol config is available (one-time per session).
   * Deduplicates concurrent calls. Uses workspace lock to prevent
   * multiple sessions from running bemol simultaneously.
   */
  private async ensureBemol(): Promise<void> {
    if (this._bemolEnsured || !this._bemol.isBrazilWorkspace) return;
    if (this._bemolEnsuring) {
      await this._bemolEnsuring;
      return;
    }
    this._callbacks.onBemolStart?.();
    const start = Date.now();
    this._bemolEnsuring = this._bemol.ensureBemolConfig(this._sessionId);
    try {
      const success = await this._bemolEnsuring;
      this._callbacks.onBemolEnd?.(success, Date.now() - start);
    } finally {
      this._bemolEnsured = true;
      this._bemolEnsuring = null;
    }
  }

  private async startServer(languageId: string, config: ServerConfig): Promise<LspClient> {
    // Run bemol if in a Brazil workspace (one-time)
    await this.ensureBemol();

    const wsRoot = this._bemol.workspaceRoot;
    const workspaceFolders = this._bemol.isBrazilWorkspace
      ? this._bemol.getWorkspaceFolders()
      : undefined;

    // Try connecting to an existing daemon socket first
    const socketPath = this.getSocketPath(languageId);
    if (socketPath && this.isDaemonAlive(languageId)) {
      this._callbacks.onServerStart?.(languageId, `${config.command} (shared)`);
      try {
        const client = new LspClient({
          command: config.command,
          args: config.args,
          rootDir: this.rootDir,
          languageId,
          socketPath,
        });
        await client.start();
        this.clients.set(languageId, client);
        this.startingServers.delete(languageId);
        this._callbacks.onServerReady?.(languageId);
        return client;
      } catch {
        // Daemon may be stale — fall through to spawn new one
      }
    }

    // No existing daemon — spawn one (or start direct if no workspace root)
    this._callbacks.onServerStart?.(languageId, config.command);

    if (wsRoot) {
      // Spawn daemon and connect via socket
      try {
        await this.spawnDaemon(languageId, config, workspaceFolders);
        // Small delay to let daemon start listening
        await new Promise((r) => setTimeout(r, 500));

        const daemonSocket = this.getSocketPath(languageId)!;

        // Retry connection a few times (daemon may still be initializing)
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const client = new LspClient({
              command: config.command,
              args: config.args,
              rootDir: this.rootDir,
              languageId,
              socketPath: daemonSocket,
            });
            await client.start();
            this.clients.set(languageId, client);
            this.startingServers.delete(languageId);
            this._callbacks.onServerReady?.(languageId);
            return client;
          } catch (err: any) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        throw lastErr ?? new Error("Failed to connect to daemon");
      } catch (err: any) {
        // Fall back to direct mode — log the daemon failure
        this._callbacks.onServerError?.(languageId, `Daemon mode failed, falling back to direct: ${err.message}`);
        this.startingServers.delete(languageId);
        // Don't throw — try direct mode below
      }
    }

    // Direct mode (no workspace root, or daemon failed)
    const client = new LspClient({
      command: config.command,
      args: config.args,
      rootDir: this.rootDir,
      languageId,
      env: config.env,
      workspaceFolders,
    });

    try {
      await client.start();
      this.clients.set(languageId, client);
      this.startingServers.delete(languageId);
      this._callbacks.onServerReady?.(languageId);
      return client;
    } catch (err: any) {
      this.startingServers.delete(languageId);
      const message = `Failed to start LSP server for ${languageId} (${config.command}): ${err.message}`;
      this._callbacks.onServerError?.(languageId, message);
      throw new Error(message);
    }
  }

  /** Get the socket path for a language's daemon */
  private getSocketPath(languageId: string): string | null {
    const wsRoot = this._bemol.workspaceRoot;
    if (!wsRoot) return null;
    return join(wsRoot, ".bemol", "sockets", `lsp-${languageId}.sock`);
  }

  /** Check if a daemon is alive for this language */
  private isDaemonAlive(languageId: string): boolean {
    const wsRoot = this._bemol.workspaceRoot;
    if (!wsRoot) return false;
    const pidPath = join(wsRoot, ".bemol", "sockets", `lsp-${languageId}.pid`);
    try {
      if (!existsSync(pidPath)) return false;
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return false;
      process.kill(pid, 0); // throws if not alive
      return true;
    } catch {
      return false;
    }
  }

  /** Spawn an LSP daemon as a detached background process */
  private async spawnDaemon(
    languageId: string,
    config: ServerConfig,
    workspaceFolders?: { uri: string; name: string }[],
  ): Promise<void> {
    const socketPath = this.getSocketPath(languageId)!;
    const daemonScript = new URL("./lsp-daemon.ts", import.meta.url).pathname;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(config.env ?? {}),
      LSP_ROOT_DIR: this.rootDir,
      LSP_LANGUAGE_ID: languageId,
    };

    if (workspaceFolders && workspaceFolders.length > 0) {
      env.LSP_WORKSPACE_FOLDERS = JSON.stringify(workspaceFolders);
    }

    const child = spawnChild(
      process.execPath, // node
      ["--import", "jiti/register", daemonScript, socketPath, config.command, ...config.args],
      {
        cwd: this.rootDir,
        env,
        detached: true,
        stdio: "ignore",
      },
    );

    child.unref(); // let daemon outlive this process
  }

  /** Get status of all configured/running servers */
  getStatus(): ServerStatus[] {
    const statuses: ServerStatus[] = [];
    for (const [languageId, config] of this.serverConfigs) {
      const client = this.clients.get(languageId);
      let diagnosticsCount = 0;
      if (client) {
        for (const diags of client.getAllDiagnostics().values()) {
          diagnosticsCount += diags.length;
        }
      }
      const daemonAlive = this.isDaemonAlive(languageId);
      statuses.push({
        languageId,
        command: config.command,
        running: client?.initialized === true && !client.disposed,
        diagnosticsCount,
        shared: daemonAlive,
      });
    }
    return statuses;
  }

  /** Shut down all clients (disconnect from daemons, kill direct servers) */
  async shutdownAll(): Promise<void> {
    this._bemol.shutdown();
    const shutdowns = [...this.clients.values()].map((client) =>
      client.shutdown().catch(() => {})
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.startingServers.clear();
  }
}
