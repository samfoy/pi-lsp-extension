/**
 * LSP Manager — manages multiple LSP server instances, one per language.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 * Uses a WorkspaceProvider for workspace detection, multi-root folders, and daemon state.
 */

import { resolve, join, dirname, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync, unlinkSync, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { LspClient } from "./lsp-client.js";
import { type WorkspaceProvider, DefaultWorkspaceProvider } from "./workspace-provider.js";
import { getLanguageIdFromPath } from "./shared/language-map.js";
import { DAEMON_SOCKET_READY_DELAY_MS, DAEMON_RETRY_INTERVAL_MS, DAEMON_MAX_RETRIES } from "./shared/timing.js";

/** jdtls's own default `java.import.exclusions`, then generated/output dirs. */
export const JAVA_IMPORT_EXCLUSIONS: readonly string[] = [
  "**/node_modules/**",
  "**/.metadata/**",
  "**/archetype-resources/**",
  "**/META-INF/maven/**",
  "**/.bemol/**",
  "**/build/**",
  "**/.gradle/**",
  "**/bin/**",
];

/**
 * jdtls workspace data dir, mirroring the default `-data` in jdtls's launcher
 * script (jdtls.py): <platform cache dir>/jdtls/jdtls-<sha1(basename(cwd))>.
 */
export function getJdtlsDataDir(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const cacheRoot =
    platform === "win32" && env.APPDATA ? env.APPDATA
    : platform === "darwin" && env.HOME ? join(env.HOME, "Library", "Caches")
    : (platform === "linux" || env.TERMUX_VERSION) && env.HOME ? join(env.HOME, ".cache")
    : tmpdir();
  const hash = createHash("sha1").update(basename(cwd)).digest("hex");
  return join(cacheRoot, "jdtls", `jdtls-${hash}`);
}

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** LSP initializationOptions passed during the initialize handshake */
  initializationOptions?: Record<string, unknown>;
  /** Settings returned by workspace/configuration handler (keyed by section) */
  settings?: Record<string, unknown>;
}

/** Lifecycle callbacks for UI notifications */
export interface LspManagerCallbacks {
  onWorkspaceSetupStart?: () => void;
  onWorkspaceSetupEnd?: (success: boolean, duration: number) => void;
  onServerStart?: (languageId: string, command: string) => void;
  onServerReady?: (languageId: string) => void;
  onServerError?: (languageId: string, error: string) => void;
  onServerCrash?: (languageId: string, restarting: boolean, attempt: number) => void;
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
  private _workspace: WorkspaceProvider;
  private _workspaceReady = false;
  private _workspaceReadying: Promise<boolean> | null = null;
  private _callbacks: LspManagerCallbacks;
  private _sessionId: string;
  private _lombokJarPath: string | null = null;
  private _shuttingDown = false;
  private _restartAttempts: Map<string, number> = new Map();
  private _restartBackoff: Map<string, number> = new Map();

  private static readonly MAX_RESTART_ATTEMPTS = 3;
  private static readonly INITIAL_BACKOFF_MS = 1000;
  private static readonly MAX_BACKOFF_MS = 30000;

  constructor(rootDir: string, customConfigs?: Record<string, ServerConfig>, callbacks?: LspManagerCallbacks, sessionId?: string, workspace?: WorkspaceProvider) {
    this.rootDir = resolve(rootDir);
    this.serverConfigs = new Map(Object.entries({
      ...DEFAULT_SERVERS,
      ...customConfigs,
    }));
    this._workspace = workspace ?? new DefaultWorkspaceProvider();
    this._callbacks = callbacks ?? {};
    this._sessionId = sessionId ?? `${process.pid}-${Date.now()}`;
  }

  /** Get the workspace provider */
  get workspace(): WorkspaceProvider {
    return this._workspace;
  }

  /** Replace the workspace provider (e.g. when an external extension registers one) */
  setWorkspaceProvider(provider: WorkspaceProvider): void {
    this._workspace = provider;
    this._workspaceReady = false;
    this._workspaceReadying = null;
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
   * Auto-detect Lombok jar.
   * Searches: explicit path, LOMBOK_JAR env var, workspace root env/ directories.
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

    // 3. Auto-detect from workspace root (e.g. Brazil workspace env/ directory)
    //    Search both workspace root and cwd in case they differ
    const searchRoots = [this.rootDir];
    const wsRoot = this._workspace.workspaceRoot;
    if (wsRoot && wsRoot !== this.rootDir) {
      searchRoots.unshift(wsRoot);
    }

    for (const root of searchRoots) {
      const envDir = join(root, "env");
      if (!existsSync(envDir)) continue;

      // env/Lombok-{version}/runtime/lib/lombok-*.jar
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

      // env/gradle-cache-2/org/projectlombok/lombok/{version}/lombok-{version}.jar
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
    }

    return null;
  }

  /** Build initializationOptions for Java (jdtls) with Lombok and import exclusions */
  private getJavaInitializationOptions(): Record<string, unknown> {
    const lombokJar = this.findLombokJar();

    // Keep generated/output dirs out of the Eclipse resource tree: dirs that are
    // regenerated or deleted between sessions leave stale entries in jdtls's saved
    // snapshot and crash the next startup (ObjectNotFoundException). Setting this
    // replaces jdtls's defaults, so they are repeated first.
    const settings: Record<string, unknown> = {
      "java.import.exclusions": JAVA_IMPORT_EXCLUSIONS,
    };

    if (lombokJar) {
      settings["java.jdt.ls.vmargs"] = `-javaagent:${lombokJar}`;
    }

    return { settings };
  }

  /**
   * Pre-launch self-heal for Java/jdtls workspace corruption.
   *
   * jdtls saves the Eclipse resource tree to rotating numbered snapshots
   * (e.g. `1.snap`) in org.eclipse.core.resources/. When generated dirs are
   * regenerated or deleted between sessions, the saved tree has stale paths,
   * causing ResourcesPlugin.start() to throw ObjectNotFoundException and
   * preventing jdtls from initializing at all.
   *
   * Detects the crash signature in .metadata/.log and wipes only the fragile
   * snapshot/marker files (~KB–MB). The (often very large) JDT index is preserved.
   */
  private recoverCorruptJavaWorkspace(cwd: string, notify?: (msg: string) => void): void {
    const cacheDir = getJdtlsDataDir(cwd);
    const logPath = join(cacheDir, ".metadata", ".log");
    if (!existsSync(logPath)) return;

    let log = "";
    try {
      // Read last 32 KB — crash signature is always near the end
      const buf = Buffer.alloc(32768);
      const fd = openSync(logPath, "r");
      const stat = fstatSync(fd);
      const offset = Math.max(0, stat.size - 32768);
      readSync(fd, buf, 0, 32768, offset);
      closeSync(fd);
      log = buf.toString("utf-8");
    } catch {
      return;
    }

    const CRASH_PATTERN = /ObjectNotFoundException|Could not (?:read|restore) workspace tree|Exception in org\.eclipse\.core\.resources\.ResourcesPlugin\.start/;
    if (!CRASH_PATTERN.test(log)) return;

    // Wipe fragile snapshot/marker files under org.eclipse.core.resources/, and
    // only if that dir really lies inside the data dir once symlinks are resolved.
    const resDir = join(cacheDir, ".metadata", ".plugins", "org.eclipse.core.resources");
    try {
      if (!realpathSync(resDir).startsWith(realpathSync(cacheDir) + sep)) return;
    } catch {
      return;
    }

    // lstat, so symlinks are never walked into or deleted through.
    const lstatOf = (p: string) => lstatSync(p, { throwIfNoEntry: false });
    const isRealDir = (p: string) => lstatOf(p)?.isDirectory() === true;
    const realSubdirs = (dir: string): string[] => {
      try { return readdirSync(dir).map((e) => join(dir, e)).filter(isRealDir); } catch { return []; }
    };

    // Top-level snaps (the rotating numbered ones, e.g. 1.snap), .root, and each project.
    const projectsDir = join(resDir, ".projects");
    const dirs = [
      resDir,
      ...[join(resDir, ".root")].filter(isRealDir),
      ...(isRealDir(projectsDir) ? realSubdirs(projectsDir) : []),
    ];

    const wiped: string[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const p = join(dir, entry);
        if (!/\.snap$|\.tree$/.test(entry) || lstatOf(p)?.isFile() !== true) continue;
        try { unlinkSync(p); wiped.push(p); } catch { /* ignore */ }
      }
    }

    if (wiped.length > 0) {
      const msg = `[jdtls] Auto-recovered corrupt workspace — wiped ${wiped.length} snapshot file(s). Rebuild will take a moment.`;
      process.stderr.write(msg + "\n");
      notify?.(msg);
    }
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
    const waitHint = this.getExpectedStartTime(languageId);
    if (this.startingServers.has(languageId)) {
      return `LSP server for ${languageId} is starting. ${waitHint} Retry shortly.`;
    }
    const existing = this.clients.get(languageId);
    if (existing && !existing.initialized && !existing.disposed) {
      return `LSP server for ${languageId} is initializing. ${waitHint} Retry shortly.`;
    }
    return `No LSP server available for: ${filePath}. If you just opened this project, call any LSP tool on a file to trigger server startup.`;
  }

  /** Estimated startup time hint for a language server */
  private getExpectedStartTime(languageId: string): string {
    switch (languageId) {
      case "java":
        return "This typically takes 1-5 minutes for Java (project indexing).";
      case "rust":
        return "This typically takes 30s-2min for Rust (cargo metadata + indexing).";
      case "typescript":
      case "javascript":
      case "typescriptreact":
      case "javascriptreact":
        return "This typically takes 10-30s for TypeScript/JavaScript.";
      case "python":
        return "This typically takes 10-30s for Python.";
      case "go":
        return "This typically takes 10-30s for Go.";
      default:
        return "This may take a few seconds to a minute.";
    }
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
   * Ensure workspace provider is ready (one-time per session).
   * Deduplicates concurrent calls.
   */
  private async ensureWorkspace(): Promise<void> {
    if (this._workspaceReady) return;
    if (this._workspaceReadying) {
      await this._workspaceReadying;
      return;
    }
    this._callbacks.onWorkspaceSetupStart?.();
    const start = Date.now();
    this._workspaceReadying = this._workspace.ensureReady(this._sessionId);
    try {
      const success = await this._workspaceReadying;
      this._callbacks.onWorkspaceSetupEnd?.(success, Date.now() - start);
    } finally {
      this._workspaceReady = true;
      this._workspaceReadying = null;
    }
  }

  private async startServer(languageId: string, config: ServerConfig): Promise<LspClient> {
    // Ensure workspace provider is ready (one-time setup)
    await this.ensureWorkspace();

    const stateDir = this._workspace.stateDir;
    const folders = this._workspace.getWorkspaceFolders();
    const workspaceFolders = folders.length > 0 ? folders : undefined;

    // Build language-specific initializationOptions (e.g. Lombok for Java)
    // Use config-level initializationOptions if provided, otherwise fall back to language-specific defaults
    const initializationOptions = config.initializationOptions
      ?? (languageId === "java" ? this.getJavaInitializationOptions() : undefined);

    // For Java with Lombok, inject --jvm-arg so jdtls launches with -javaagent
    let effectiveArgs = config.args;
    if (languageId === "java") {
      const lombokJar = this.findLombokJar();
      if (lombokJar) {
        effectiveArgs = [`--jvm-arg=-javaagent:${lombokJar}`, ...config.args];
      }
    }

    // Callback for auto-restart on unexpected exit
    const onUnexpectedExit = (code: number | null) => this.handleUnexpectedExit(languageId, code);
    // Try connecting to an existing daemon socket first
    const socketPath = this.getSocketPath(languageId);
    if (socketPath && this.isDaemonAlive(languageId)) {
      this._callbacks.onServerStart?.(languageId, `${config.command} (shared)`);
      try {
        const client = new LspClient({
          command: config.command,
          args: effectiveArgs,
          rootDir: this.rootDir,
          languageId,
          socketPath,
          initializationOptions,
          settings: config.settings,
          onUnexpectedExit,
        });
        await client.start();
        this.clients.set(languageId, client);
        this.startingServers.delete(languageId);
        this._callbacks.onServerReady?.(languageId);
        this._restartAttempts.delete(languageId);
        this._restartBackoff.delete(languageId);
        this.triggerPostInit(languageId, client);
        return client;
      } catch {
        // Daemon may be stale — fall through to spawn new one
      }
    }

    // No existing daemon — spawn one (or start direct if no state directory)
    this._callbacks.onServerStart?.(languageId, config.command);

    // Only before launching a new jdtls, never under a live shared daemon: wipe
    // corrupt snapshot files if the log has the crash signature, keeping the index.
    if (languageId === "java") {
      this.recoverCorruptJavaWorkspace(
        this.rootDir,
        (msg) => this._callbacks.onServerError?.(languageId, msg),
      );
    }

    if (stateDir) {
      // Spawn daemon and connect via socket
      try {
        await this.spawnDaemon(languageId, config, effectiveArgs, workspaceFolders, initializationOptions);
        // Small delay to let daemon start listening
        await new Promise((r) => setTimeout(r, DAEMON_SOCKET_READY_DELAY_MS));

        const daemonSocket = this.getSocketPath(languageId)!;

        // Retry connection (daemon may still be initializing jdtls which can take minutes)
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < DAEMON_MAX_RETRIES; attempt++) {
          try {
            const client = new LspClient({
              command: config.command,
              args: effectiveArgs,
              rootDir: this.rootDir,
              languageId,
              socketPath: daemonSocket,
              initializationOptions,
              settings: config.settings,
              onUnexpectedExit,
            });
            await client.start();
            this.clients.set(languageId, client);
            this.startingServers.delete(languageId);
            this._callbacks.onServerReady?.(languageId);
            this._restartAttempts.delete(languageId);
            this._restartBackoff.delete(languageId);
            this.triggerPostInit(languageId, client);
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

    // Direct mode (no state directory for daemon, or daemon failed)
    const client = new LspClient({
      command: config.command,
      args: effectiveArgs,
      rootDir: this.rootDir,
      languageId,
      env: config.env,
      workspaceFolders,
      initializationOptions,
      settings: config.settings,
      onUnexpectedExit,
    });

    try {
      await client.start();
      this.clients.set(languageId, client);
      this.startingServers.delete(languageId);
      this._callbacks.onServerReady?.(languageId);
      this._restartAttempts.delete(languageId);
      this._restartBackoff.delete(languageId);
      this.triggerPostInit(languageId, client);
      return client;
    } catch (err: any) {
      this.startingServers.delete(languageId);
      const message = `Failed to start LSP server for ${languageId} (${config.command}): ${err.message}`;
      this._callbacks.onServerError?.(languageId, message);
      throw new Error(message);
    }
  }

  /**
   * Post-initialization hook for language-specific setup.
   * For Java/jdtls: triggers a workspace build so diagnostics refresh
   * after Lombok annotation processing completes.
   */
  private triggerPostInit(languageId: string, client: LspClient): void {
    if (languageId === "java") {
      // java/buildWorkspace forces jdtls to rebuild and re-publish diagnostics.
      // The boolean parameter means "full build" (true) vs incremental (false).
      client.sendRequest("java/buildWorkspace", true).catch(() => {
        // Not critical — diagnostics will just be stale until a file changes
      });
    }
  }

  /** Get the socket path for a language's daemon */
  private getSocketPath(languageId: string): string | null {
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return null;
    return join(stateDir, "sockets", `lsp-${languageId}.sock`);
  }

  /** Check if a daemon is alive for this language */
  private isDaemonAlive(languageId: string): boolean {
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return false;
    const pidPath = join(stateDir, "sockets", `lsp-${languageId}.pid`);
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
    effectiveArgs: string[],
    workspaceFolders?: { uri: string; name: string }[],
    initializationOptions?: Record<string, unknown>,
  ): Promise<void> {
    const socketPath = this.getSocketPath(languageId)!;
    // Built next to this bundle (dist/lsp-daemon.js); plain JS, so node runs it directly.
    const daemonScript = fileURLToPath(new URL("./lsp-daemon.js", import.meta.url));

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

    if (config.settings) {
      env.LSP_SETTINGS = JSON.stringify(config.settings);
    }

    const child = spawnChild(
      process.execPath, // node
      [daemonScript, socketPath, config.command, ...effectiveArgs],
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

  /**
   * Handle an unexpected server exit. Attempts auto-restart with exponential backoff.
   * Gives up after MAX_RESTART_ATTEMPTS failures per language per session.
   */
  private handleUnexpectedExit(languageId: string, code: number | null): void {
    if (this._shuttingDown) return;

    // Clean up the dead client
    this.clients.delete(languageId);
    this.startingServers.delete(languageId);

    const attempts = this._restartAttempts.get(languageId) ?? 0;
    if (attempts >= LspManager.MAX_RESTART_ATTEMPTS) {
      this._callbacks.onServerError?.(languageId, `LSP server for ${languageId} crashed ${attempts} times — giving up auto-restart`);
      this._callbacks.onServerCrash?.(languageId, false, attempts);
      return;
    }

    const backoff = this._restartBackoff.get(languageId) ?? LspManager.INITIAL_BACKOFF_MS;
    this._restartAttempts.set(languageId, attempts + 1);
    this._restartBackoff.set(languageId, Math.min(backoff * 2, LspManager.MAX_BACKOFF_MS));

    this._callbacks.onServerCrash?.(languageId, true, attempts + 1);

    setTimeout(() => {
      if (this._shuttingDown) return;
      const config = this.serverConfigs.get(languageId);
      if (!config) return;

      const startPromise = this.startServer(languageId, config);
      this.startingServers.set(languageId, startPromise);
      startPromise.catch((err) => {
        this.startingServers.delete(languageId);
        this._callbacks.onServerError?.(languageId, `Auto-restart failed for ${languageId}: ${err.message}`);
        // Trigger another restart attempt (recursive backoff)
        this.handleUnexpectedExit(languageId, null);
      });
    }, backoff);
  }

  /** Shut down all clients (disconnect from daemons, kill direct servers) */
  async shutdownAll(): Promise<void> {
    this._workspace.shutdown();
    this._shuttingDown = true;
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
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return;
    const pidPath = join(stateDir, "sockets", `lsp-${languageId}.pid`);
    try {
      if (!existsSync(pidPath)) return;
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return;
      process.kill(pid, "SIGTERM");
      // Clean up socket and pid files
      const socketPath = join(stateDir, "sockets", `lsp-${languageId}.sock`);
      try { unlinkSync(socketPath); } catch {}
      try { unlinkSync(pidPath); } catch {}
    } catch {
      // Process may already be dead
    }
  }
}
