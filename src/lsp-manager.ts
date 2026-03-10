/**
 * LSP Manager — manages multiple LSP server instances, one per language.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 * Integrates with bemol for Brazil workspace support.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, type LspClientOptions } from "./lsp-client.js";
import { BemolManager } from "./bemol.js";
import { acquireLock, releaseLock, isLockedByOther, releaseAllLocks } from "./locks.js";

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
  /** True if another pi session owns the LSP lock for this language */
  lockedOut: boolean;
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
  /** Languages where another session holds the LSP lock */
  private _lockedOut: Set<string> = new Set();

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
   * Returns null if no server is configured for this language or if
   * another session owns the LSP lock for this language.
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

    // Locked out by another session?
    if (this._lockedOut.has(languageId)) return null;

    const config = this.serverConfigs.get(languageId);
    if (!config) return null;

    // Check if another session holds the lock for this language
    const wsRoot = this._bemol.workspaceRoot;
    if (wsRoot && isLockedByOther(wsRoot, `lsp-${languageId}`)) {
      this._lockedOut.add(languageId);
      this._callbacks.onServerError?.(languageId, `LSP server for ${languageId} is owned by another pi session`);
      return null;
    }

    // Start a new server
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

    // Acquire LSP lock for this language
    const wsRoot = this._bemol.workspaceRoot;
    if (wsRoot) {
      const acquired = acquireLock(wsRoot, `lsp-${languageId}`, this._sessionId);
      if (!acquired) {
        this._lockedOut.add(languageId);
        const message = `LSP server for ${languageId} is owned by another pi session`;
        this._callbacks.onServerError?.(languageId, message);
        throw new Error(message);
      }
    }

    // Get workspace folders from bemol if available
    const workspaceFolders = this._bemol.isBrazilWorkspace
      ? this._bemol.getWorkspaceFolders()
      : undefined;

    this._callbacks.onServerStart?.(languageId, config.command);

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
      // Release lock on failure
      if (wsRoot) releaseLock(wsRoot, `lsp-${languageId}`);
      const message = `Failed to start LSP server for ${languageId} (${config.command}): ${err.message}`;
      this._callbacks.onServerError?.(languageId, message);
      throw new Error(message);
    }
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
      const lockedOut = this._lockedOut.has(languageId);
      statuses.push({
        languageId,
        command: config.command,
        running: client?.initialized === true && !client.disposed,
        diagnosticsCount,
        lockedOut,
      });
    }
    return statuses;
  }

  /** Shut down all running servers, release locks, and stop bemol watch */
  async shutdownAll(): Promise<void> {
    this._bemol.shutdown();
    const shutdowns = [...this.clients.values()].map((client) =>
      client.shutdown().catch(() => {})
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.startingServers.clear();

    // Release all LSP locks owned by this session
    const wsRoot = this._bemol.workspaceRoot;
    if (wsRoot) releaseAllLocks(wsRoot);
  }
}
