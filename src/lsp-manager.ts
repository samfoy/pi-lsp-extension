/**
 * LSP Manager — manages multiple LSP server instances, one per language.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 * Integrates with bemol for Brazil workspace support.
 */

import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { LspClient } from "./lsp-client.js";
import { BemolManager } from "./bemol.js";
import { getLanguageIdFromPath } from "./shared/language-map.js";
import { DAEMON_SOCKET_READY_DELAY_MS, DAEMON_RETRY_INTERVAL_MS, DAEMON_MAX_RETRIES } from "./shared/timing.js";

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

// File extension → language ID mapping is in shared/language-map.ts

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
  private _lombokJarPath: string | null = null;

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

  /** Set an explicit path to a Lombok jar for Java/jdtls support */
  setLombokJar(jarPath: string): void {
    this._lombokJarPath = resolve(this.rootDir, jarPath);
  }

  /** Get the currently configured Lombok jar path (if any) */
  getLombokJar(): string | null {
    return this.findLombokJar();
  }

  /**
   * Auto-detect Lombok jar in a Brazil workspace.
   * Searches common locations: env/Lombok-{version}/runtime/lib/, env/gradle-cache-2/org/projectlombok/
   */
  private findLombokJar(): string | null {
    // 1. Explicit path set via setLombokJar()
    if (this._lombokJarPath) {
      if (existsSync(this._lombokJarPath)) return this._lombokJarPath;
    }

    // 2. LOMBOK_JAR environment variable
    const envJar = process.env.LOMBOK_JAR;
    if (envJar) {
      const resolved = resolve(this.rootDir, envJar);
      if (existsSync(resolved)) return resolved;
    }

    // 3. Auto-detect in Brazil workspace: env/Lombok-{version}/runtime/lib/lombok-*.jar
    const envDir = join(this.rootDir, "env");
    if (existsSync(envDir)) {
      try {
        const lombokDirs = readdirSync(envDir).filter(d => d.startsWith("Lombok-"));
        for (const dir of lombokDirs) {
          const libDir = join(envDir, dir, "runtime", "lib");
          if (existsSync(libDir)) {
            const jars = readdirSync(libDir).filter(f => f.startsWith("lombok-") && f.endsWith(".jar"));
            if (jars.length > 0) return join(libDir, jars[0]);
          }
        }
      } catch { /* ignore */ }
    }

    // 4. Auto-detect in Brazil workspace: env/gradle-cache-2/org/projectlombok/lombok/{version}/lombok-{version}.jar
    const gradleLombok = join(envDir, "gradle-cache-2", "org", "projectlombok", "lombok");
    if (existsSync(gradleLombok)) {
      try {
        const versions = readdirSync(gradleLombok);
        for (const ver of versions) {
          const jarPath = join(gradleLombok, ver, `lombok-${ver}.jar`);
          if (existsSync(jarPath)) return jarPath;
        }
      } catch { /* ignore */ }
    }

    return null;
  }

  /** Build initializationOptions for Java (jdtls) with Lombok support */
  private getJavaInitializationOptions(): Record<string, unknown> | undefined {
    const lombokJar = this.findLombokJar();
    if (!lombokJar) return undefined;

    // jdtls expects flat dotted keys in settings, not nested objects
    return {
      settings: {
        "java.jdt.ls.vmargs": `-javaagent:${lombokJar}`,
      },
    };
  }

  /** Get all configured languages */
  getConfiguredLanguages(): string[] {
    return [...this.serverConfigs.keys()];
  }

  /** Resolve a file path to a language ID */
  getLanguageId(filePath: string): string | undefined {
    return getLanguageIdFromPath(filePath);
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
   * Get a user-friendly message about why no client is available for a file.
   */
  getUnavailableReason(filePath: string): string {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return `No LSP server configured for file type: ${filePath}`;
    if (this.startingServers.has(languageId)) {
      return `LSP server for ${languageId} is still starting up. Try again in a moment.`;
    }
    const existing = this.clients.get(languageId);
    if (existing && !existing.initialized && !existing.disposed) {
      return `LSP server for ${languageId} is initializing. Try again in a moment.`;
    }
    return `No LSP server available for: ${filePath}`;
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

    // Already starting? Don't block — return null so tools can show "starting" message
    const starting = this.startingServers.get(languageId);
    if (starting) return null;

    const config = this.serverConfigs.get(languageId);
    if (!config) return null;

    // Kick off server start in the background — don't await
    const startPromise = this.startServer(languageId, config);
    this.startingServers.set(languageId, startPromise);

    // Fire-and-forget: clean up on completion or failure
    startPromise.catch((err) => {
      this.startingServers.delete(languageId);
      const message = `Failed to start LSP server for ${languageId}: ${err.message}`;
      this._callbacks.onServerError?.(languageId, message);
    });

    return null; // Server not ready yet
  }

  /**
   * Check if a server is currently starting up for a language.
   */
  isServerStarting(languageId: string): boolean {
    return this.startingServers.has(languageId);
  }

  /**
   * Eagerly start LSP servers for the given languages in the background.
   * Unlike getClientForLanguage (which returns null immediately), this method
   * is fire-and-forget — intended for session_start auto-start.
   */
  startEagerly(languageIds: string[]): void {
    for (const languageId of languageIds) {
      // Skip if already running or starting
      const existing = this.clients.get(languageId);
      if (existing && existing.initialized && !existing.disposed) continue;
      if (this.startingServers.has(languageId)) continue;

      const config = this.serverConfigs.get(languageId);
      if (!config) continue;

      const startPromise = this.startServer(languageId, config);
      this.startingServers.set(languageId, startPromise);

      startPromise.catch((err) => {
        this.startingServers.delete(languageId);
        this._callbacks.onServerError?.(languageId, `Auto-start failed: ${err.message}`);
      });
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

    // Build language-specific initializationOptions (e.g. Lombok for Java)
    const initializationOptions = languageId === "java"
      ? this.getJavaInitializationOptions()
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
          initializationOptions,
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
        await this.spawnDaemon(languageId, config, workspaceFolders, initializationOptions);
        // Small delay to let daemon start listening
        await new Promise((r) => setTimeout(r, DAEMON_SOCKET_READY_DELAY_MS));

        const daemonSocket = this.getSocketPath(languageId)!;

        // Retry connection (daemon may still be initializing jdtls which can take minutes)
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < DAEMON_MAX_RETRIES; attempt++) {
          try {
            const client = new LspClient({
              command: config.command,
              args: config.args,
              rootDir: this.rootDir,
              languageId,
              socketPath: daemonSocket,
              initializationOptions,
            });
            await client.start();
            this.clients.set(languageId, client);
            this.startingServers.delete(languageId);
            this._callbacks.onServerReady?.(languageId);
            return client;
          } catch (err: any) {
            lastErr = err;
            // Check if daemon is still alive before retrying
            if (!this.isDaemonAlive(languageId)) {
              throw new Error(`Daemon for ${languageId} died during startup: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, DAEMON_RETRY_INTERVAL_MS));
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
      initializationOptions,
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
    initializationOptions?: Record<string, unknown>,
  ): Promise<void> {
    const socketPath = this.getSocketPath(languageId)!;
    const daemonScript = new URL("./lsp-daemon.ts", import.meta.url).pathname;
    const launcherScript = new URL("./lsp-daemon-launcher.cjs", import.meta.url).pathname;

    // Resolve jiti from the running process's module context
    let jitiPath: string;
    try {
      jitiPath = require.resolve("@mariozechner/jiti");
    } catch {
      try {
        jitiPath = require.resolve("jiti");
      } catch {
        throw new Error("Cannot resolve jiti for daemon spawn — jiti not found in module path");
      }
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(config.env ?? {}),
      LSP_ROOT_DIR: this.rootDir,
      LSP_LANGUAGE_ID: languageId,
    };

    if (workspaceFolders && workspaceFolders.length > 0) {
      env.LSP_WORKSPACE_FOLDERS = JSON.stringify(workspaceFolders);
    }

    if (initializationOptions) {
      env.LSP_INITIALIZATION_OPTIONS = JSON.stringify(initializationOptions);
    }

    const child = spawnChild(
      process.execPath, // node
      [launcherScript, jitiPath, daemonScript, socketPath, config.command, ...config.args],
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

  /**
   * Restart a specific language server. Shuts down the existing client
   * (and kills the daemon if shared), then starts a fresh server.
   * Returns once the new server is initialized, or throws on failure.
   */
  async restartServer(languageId: string): Promise<void> {
    // Shut down existing client
    const existing = this.clients.get(languageId);
    if (existing) {
      await existing.shutdown().catch(() => {});
      this.clients.delete(languageId);
    }

    // Kill the daemon if one is running (so we get a fresh server with new config)
    this.killDaemon(languageId);

    // Wait for pending starts to clear
    const pending = this.startingServers.get(languageId);
    if (pending) {
      await pending.catch(() => {});
      this.startingServers.delete(languageId);
    }

    // Start fresh
    const config = this.serverConfigs.get(languageId);
    if (!config) throw new Error(`No server configured for ${languageId}`);

    await this.startServer(languageId, config);
  }

  /** Kill a running daemon for a language (if any) */
  private killDaemon(languageId: string): void {
    const wsRoot = this._bemol.workspaceRoot;
    if (!wsRoot) return;
    const pidPath = join(wsRoot, ".bemol", "sockets", `lsp-${languageId}.pid`);
    try {
      if (!existsSync(pidPath)) return;
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return;
      process.kill(pid, "SIGTERM");
      // Clean up socket and pid files
      const socketPath = join(wsRoot, ".bemol", "sockets", `lsp-${languageId}.sock`);
      try { unlinkSync(socketPath); } catch {}
      try { unlinkSync(pidPath); } catch {}
    } catch {
      // Process may already be dead
    }
  }
}
