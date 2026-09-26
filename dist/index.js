// src/index.ts
import {
  isReadToolResult,
  isWriteToolResult,
  isEditToolResult
} from "@earendil-works/pi-coding-agent";
import { DiagnosticSeverity as DiagnosticSeverity2 } from "vscode-languageserver-protocol";

// src/lsp-manager.ts
import { resolve, join, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL as pathToFileURL2 } from "node:url";
import { existsSync, readFileSync, readdirSync, unlinkSync, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn as spawnChild } from "node:child_process";

// src/lsp-client.ts
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  SocketMessageReader,
  SocketMessageWriter
} from "vscode-languageserver-protocol/node";
var LspClient = class {
  constructor(options) {
    this.options = options;
    this.languageId = options.languageId;
    this.command = options.command;
    this.rootDir = options.rootDir;
  }
  options;
  process = null;
  socket = null;
  connection = null;
  _serverCapabilities = null;
  _diagnostics = /* @__PURE__ */ new Map();
  _initialized = false;
  _disposed = false;
  /** True if connected to a daemon socket (server init handled by daemon) */
  _isDaemonClient = false;
  languageId;
  command;
  rootDir;
  get initialized() {
    return this._initialized;
  }
  get disposed() {
    return this._disposed;
  }
  get serverCapabilities() {
    return this._serverCapabilities;
  }
  /** Get cached diagnostics for a URI */
  getDiagnostics(uri) {
    return this._diagnostics.get(uri) ?? [];
  }
  /** Get all cached diagnostics */
  getAllDiagnostics() {
    return new Map(this._diagnostics);
  }
  /** Start the LSP server and perform the initialize handshake */
  async start() {
    if (this._initialized || this._disposed) return;
    if (this.options.socketPath) {
      await this.connectToSocket(this.options.socketPath);
    } else {
      await this.spawnDirect();
    }
  }
  /** Register shared connection handlers (diagnostics, workspace/configuration, errors) */
  registerConnectionHandlers() {
    if (!this.connection) return;
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params) => {
        this._diagnostics.set(params.uri, params.diagnostics);
      }
    );
    this.connection.onRequest(
      "workspace/configuration",
      (params) => {
        const settings = this.options.settings;
        return params.items.map((item) => {
          if (item.section && settings && item.section in settings) {
            return settings[item.section];
          }
          return {};
        });
      }
    );
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
  async connectToSocket(socketPath) {
    this._isDaemonClient = true;
    return new Promise((resolve6, reject) => {
      let settled = false;
      let timer;
      const settle = (fn) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const socket = netConnect(socketPath, () => {
        this.socket = socket;
        const reader = new SocketMessageReader(socket);
        const writer = new SocketMessageWriter(socket);
        this.connection = createMessageConnection(reader, writer);
        this.registerConnectionHandlers();
        this.connection.listen();
        this._initialized = true;
        settle(() => resolve6());
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
      timer = setTimeout(() => {
        if (!settled) {
          socket.destroy();
          settle(() => reject(new Error("Timeout connecting to LSP daemon socket")));
        }
      }, 1e4);
    });
  }
  /** Spawn LSP server directly as child process with stdio */
  async spawnDirect() {
    const env = { ...process.env, ...this.options.env };
    this.process = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.rootDir
    });
    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn LSP server: ${this.options.command}`);
    }
    await new Promise((resolve6, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve6();
      };
      const onError = (err) => {
        cleanup();
        reject(new Error(`Failed to spawn LSP server "${this.options.command}": ${err.message}`));
      };
      const cleanup = () => {
        this.process?.removeListener("spawn", onSpawn);
        this.process?.removeListener("error", onError);
      };
      this.process.on("spawn", onSpawn);
      this.process.on("error", onError);
    });
    this.process.stderr?.resume();
    const stdin = this.process.stdin;
    const originalWrite = stdin.write;
    stdin.write = function(...args) {
      if (this.destroyed || this.writableEnded || this.writableFinished) {
        const cb = args[args.length - 1];
        if (typeof cb === "function") process.nextTick(cb);
        return false;
      }
      try {
        return originalWrite.apply(this, args);
      } catch (err) {
        if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
          const cb = args[args.length - 1];
          if (typeof cb === "function") process.nextTick(cb);
          return false;
        }
        throw err;
      }
    };
    stdin.on("error", (err) => {
      if (err?.code === "EPIPE") return;
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
    const rootUri = pathToFileURL(this.rootDir).toString();
    const defaultFolder = { uri: rootUri, name: this.rootDir.split("/").pop() ?? "workspace" };
    const workspaceFolders = this.options.workspaceFolders && this.options.workspaceFolders.length > 0 ? this.options.workspaceFolders : [defaultFolder];
    const initParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            dynamicRegistration: false
          },
          hover: {
            contentFormat: ["plaintext", "markdown"]
          },
          definition: {},
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true
          },
          rename: {
            prepareSupport: false
          },
          publishDiagnostics: {
            relatedInformation: true
          },
          completion: {
            completionItem: {
              snippetSupport: false
            }
          }
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
          configuration: true
        }
      },
      rootUri,
      workspaceFolders,
      ...this.options.initializationOptions ? { initializationOptions: this.options.initializationOptions } : {}
    };
    const result = await this.connection.sendRequest(
      "initialize",
      initParams
    );
    this._serverCapabilities = result.capabilities;
    this.connection.sendNotification("initialized", {});
    this._initialized = true;
  }
  /** Safely dispose the connection without throwing */
  disposeConnection() {
    try {
      if (this.connection) {
        this.connection.dispose();
      }
    } catch {
    }
    this.connection = null;
  }
  /** Send a request to the LSP server */
  async sendRequest(method, params) {
    if (!this.connection || !this._initialized) {
      throw new Error(`LSP ${this.languageId} not initialized`);
    }
    return this.connection.sendRequest(method, params);
  }
  /** Send a notification to the LSP server */
  sendNotification(method, params) {
    if (!this.connection || !this._initialized) return;
    this.connection.sendNotification(method, params);
  }
  /** Notify server of a newly opened document */
  didOpen(uri, languageId, version, text) {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text }
    });
  }
  /** Notify server of a document change (full content sync) */
  didChange(uri, version, text) {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }
  /** Notify server of a closed document */
  didClose(uri) {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri }
    });
  }
  /** Gracefully shut down or disconnect from the server */
  async shutdown() {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;
    if (this._isDaemonClient) {
      this.disposeConnection();
      if (this.socket) {
        this.socket.destroy();
      }
      this.socket = null;
      return;
    }
    try {
      if (this.connection) {
        const shutdownReq = this.connection.sendRequest("shutdown").catch(() => {
        });
        await Promise.race([
          shutdownReq,
          new Promise((resolve6) => setTimeout(resolve6, 3e3))
        ]);
        try {
          this.connection.sendNotification("exit");
        } catch {
        }
      }
    } catch {
    }
    this.disposeConnection();
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 2e3);
    }
    this.process = null;
  }
};

// src/workspace-provider.ts
var DefaultWorkspaceProvider = class {
  type = "default";
  workspaceRoot = null;
  stateDir = null;
  getWorkspaceFolders() {
    return [];
  }
  async ensureReady() {
    return true;
  }
  getStatusText() {
    return "";
  }
  shutdown() {
  }
};

// src/shared/language-map.ts
var EXT_TO_LANGUAGE = {
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
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".swift": "swift",
  ".zig": "zig",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".vue": "vue",
  ".php": "php"
};
function getLanguageIdFromPath(filePath) {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return ext ? EXT_TO_LANGUAGE[ext] : void 0;
}

// src/shared/timing.ts
var DIAGNOSTIC_SETTLE_DELAY_MS = 1500;
var DAEMON_SOCKET_READY_DELAY_MS = 500;
var DAEMON_RETRY_INTERVAL_MS = 5e3;
var DAEMON_MAX_RETRIES = 60;
var SYNTHETIC_DOT_SETTLE_DELAY_MS = 100;

// src/lsp-manager.ts
var JAVA_IMPORT_EXCLUSIONS = [
  "**/node_modules/**",
  "**/.metadata/**",
  "**/archetype-resources/**",
  "**/META-INF/maven/**",
  "**/.bemol/**",
  // IDE project files generated by workspace tooling
  "**/.gradle/**"
];
function getJdtlsDataDir(cwd, platform = process.platform, env = process.env) {
  const cacheRoot = platform === "win32" && env.APPDATA ? env.APPDATA : platform === "darwin" && env.HOME ? join(env.HOME, "Library", "Caches") : (platform === "linux" || env.TERMUX_VERSION) && env.HOME ? join(env.HOME, ".cache") : tmpdir();
  const hash = createHash("sha1").update(basename(cwd)).digest("hex");
  return join(cacheRoot, "jdtls", `jdtls-${hash}`);
}
function daemonScriptPath(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL("../dist/lsp-daemon.js", moduleUrl));
}
var DEFAULT_SERVERS = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] },
  typescriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  javascriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  rust: { command: "rust-analyzer", args: [] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
  go: { command: "gopls", args: ["serve"] },
  java: { command: "jdtls", args: [] },
  c: { command: "clangd", args: [] },
  cpp: { command: "clangd", args: [] }
};
var LspManager = class _LspManager {
  clients = /* @__PURE__ */ new Map();
  serverConfigs;
  rootDir;
  startingServers = /* @__PURE__ */ new Map();
  _workspace;
  _workspaceReady = false;
  _workspaceReadying = null;
  _callbacks;
  _sessionId;
  _lombokJarPath = null;
  _shuttingDown = false;
  _restartAttempts = /* @__PURE__ */ new Map();
  _restartBackoff = /* @__PURE__ */ new Map();
  static MAX_RESTART_ATTEMPTS = 3;
  static INITIAL_BACKOFF_MS = 1e3;
  static MAX_BACKOFF_MS = 3e4;
  constructor(rootDir, customConfigs, callbacks, sessionId, workspace) {
    this.rootDir = resolve(rootDir);
    this.serverConfigs = new Map(Object.entries({
      ...DEFAULT_SERVERS,
      ...customConfigs
    }));
    this._workspace = workspace ?? new DefaultWorkspaceProvider();
    this._callbacks = callbacks ?? {};
    this._sessionId = sessionId ?? `${process.pid}-${Date.now()}`;
  }
  /** Get the workspace provider */
  get workspace() {
    return this._workspace;
  }
  /** Replace the workspace provider (e.g. when an external extension registers one) */
  setWorkspaceProvider(provider) {
    this._workspace = provider;
    this._workspaceReady = false;
    this._workspaceReadying = null;
  }
  /** Update or add a server configuration */
  setServerConfig(languageId, config) {
    this.serverConfigs.set(languageId, config);
  }
  /** Set an explicit path to a Lombok jar for Java/jdtls support */
  setLombokJar(jarPath) {
    this._lombokJarPath = resolve(this.rootDir, jarPath);
  }
  /** Get the currently configured Lombok jar path (if any) */
  getLombokJar() {
    return this.findLombokJar();
  }
  /**
   * Auto-detect Lombok jar.
   * Searches: explicit path, LOMBOK_JAR env var, workspace root env/ directories.
   */
  findLombokJar() {
    if (this._lombokJarPath) {
      if (existsSync(this._lombokJarPath)) return this._lombokJarPath;
    }
    const envJar = process.env.LOMBOK_JAR;
    if (envJar) {
      const resolved = resolve(this.rootDir, envJar);
      if (existsSync(resolved)) return resolved;
    }
    const searchRoots = [this.rootDir];
    const wsRoot = this._workspace.workspaceRoot;
    if (wsRoot && wsRoot !== this.rootDir) {
      searchRoots.unshift(wsRoot);
    }
    for (const root of searchRoots) {
      const envDir = join(root, "env");
      if (!existsSync(envDir)) continue;
      try {
        const lombokDirs = readdirSync(envDir).filter((d) => d.startsWith("Lombok-"));
        for (const dir of lombokDirs) {
          const libDir = join(envDir, dir, "runtime", "lib");
          if (existsSync(libDir)) {
            const jars = readdirSync(libDir).filter((f) => f.startsWith("lombok-") && f.endsWith(".jar"));
            if (jars.length > 0) return join(libDir, jars[0]);
          }
        }
      } catch {
      }
      const gradleLombok = join(envDir, "gradle-cache-2", "org", "projectlombok", "lombok");
      if (existsSync(gradleLombok)) {
        try {
          const versions = readdirSync(gradleLombok);
          for (const ver of versions) {
            const jarPath = join(gradleLombok, ver, `lombok-${ver}.jar`);
            if (existsSync(jarPath)) return jarPath;
          }
        } catch {
        }
      }
    }
    return null;
  }
  /** Build initializationOptions for Java (jdtls) with Lombok and import exclusions */
  getJavaInitializationOptions() {
    const lombokJar = this.findLombokJar();
    const settings = {
      "java.import.exclusions": JAVA_IMPORT_EXCLUSIONS
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
   * After a wipe the log is rotated, so the same crash is not repaired twice.
   */
  recoverCorruptJavaWorkspace(cwd, notify) {
    const cacheDir = getJdtlsDataDir(cwd);
    const metaDir = join(cacheDir, ".metadata");
    const logPath = join(metaDir, ".log");
    const resDir = join(metaDir, ".plugins", "org.eclipse.core.resources");
    try {
      const root = realpathSync(cacheDir) + sep;
      if (![metaDir, resDir].every((d) => realpathSync(d).startsWith(root))) return;
    } catch {
      return;
    }
    let log = "";
    try {
      if (!lstatSync(logPath).isFile()) return;
      const buf = Buffer.alloc(32768);
      const fd = openSync(logPath, "r");
      try {
        const offset = Math.max(0, fstatSync(fd).size - 32768);
        readSync(fd, buf, 0, 32768, offset);
      } finally {
        closeSync(fd);
      }
      log = buf.toString("utf-8");
    } catch {
      return;
    }
    const CRASH_PATTERN = /ObjectNotFoundException|Could not (?:read|restore) workspace tree|Exception in org\.eclipse\.core\.resources\.ResourcesPlugin\.start/;
    if (!CRASH_PATTERN.test(log)) return;
    const lstatOf = (p) => lstatSync(p, { throwIfNoEntry: false });
    const isRealDir = (p) => lstatOf(p)?.isDirectory() === true;
    const realSubdirs = (dir) => {
      try {
        return readdirSync(dir).map((e) => join(dir, e)).filter(isRealDir);
      } catch {
        return [];
      }
    };
    const projectsDir = join(resDir, ".projects");
    const dirs = [
      resDir,
      ...[join(resDir, ".root")].filter(isRealDir),
      ...isRealDir(projectsDir) ? realSubdirs(projectsDir) : []
    ];
    const wiped = [];
    for (const dir of dirs) {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const p = join(dir, entry);
        if (!/\.snap$|\.tree$/.test(entry) || lstatOf(p)?.isFile() !== true) continue;
        try {
          unlinkSync(p);
          wiped.push(p);
        } catch {
        }
      }
    }
    if (wiped.length === 0) return;
    const rotatedPrefix = ".log.pi-lsp-recovered-";
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    let rotated = true;
    try {
      renameSync(logPath, join(metaDir, rotatedPrefix + stamp));
    } catch {
      rotated = false;
    }
    let rotatedLogs = [];
    try {
      rotatedLogs = readdirSync(metaDir).filter((f) => f.startsWith(rotatedPrefix) && lstatOf(join(metaDir, f))?.isFile() === true);
    } catch {
    }
    for (const f of rotatedLogs.sort().slice(0, -3)) {
      try {
        unlinkSync(join(metaDir, f));
      } catch {
      }
    }
    const msg = `[jdtls] Auto-recovered corrupt workspace \u2014 wiped ${wiped.length} snapshot file(s). Rebuild will take a moment.`;
    if (rotated) notify?.(msg, "info");
    else notify?.(`${msg} The jdtls log (${logPath}) could not be rotated, so this repair may repeat on later launches.`, "warning");
  }
  /** Get all configured languages */
  getConfiguredLanguages() {
    return [...this.serverConfigs.keys()];
  }
  /** Resolve a file path to a language ID */
  getLanguageId(filePath) {
    return getLanguageIdFromPath(filePath);
  }
  /** Get a file URI from a path */
  getFileUri(filePath) {
    const abs = resolve(this.rootDir, filePath);
    return pathToFileURL2(abs).toString();
  }
  /** Resolve an absolute path from potentially relative input */
  resolvePath(filePath) {
    return resolve(this.rootDir, filePath);
  }
  /**
   * Get the LSP client for a language ONLY if it's already running.
   * Does not start a new server. Returns null if no client is active.
   */
  getRunningClient(languageId) {
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
  async getClientForFile(filePath) {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.getClientForLanguage(languageId);
  }
  /**
   * Get a user-friendly message about why no client is available for a file.
   */
  getUnavailableReason(filePath) {
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
  getExpectedStartTime(languageId) {
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
  async getClientForLanguage(languageId) {
    const existing = this.clients.get(languageId);
    if (existing && existing.initialized && !existing.disposed) {
      return existing;
    }
    const starting = this.startingServers.get(languageId);
    if (starting) return null;
    const config = this.serverConfigs.get(languageId);
    if (!config) return null;
    const startPromise = this.startServer(languageId, config);
    this.startingServers.set(languageId, startPromise);
    startPromise.catch((err) => {
      this.startingServers.delete(languageId);
      const message = `Failed to start LSP server for ${languageId}: ${err.message}`;
      this._callbacks.onServerError?.(languageId, message);
    });
    return null;
  }
  /**
   * Check if a server is currently starting up for a language.
   */
  isServerStarting(languageId) {
    return this.startingServers.has(languageId);
  }
  /**
   * Eagerly start LSP servers for the given languages in the background.
   * Unlike getClientForLanguage (which returns null immediately), this method
   * is fire-and-forget — intended for session_start auto-start.
   */
  startEagerly(languageIds) {
    for (const languageId of languageIds) {
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
  async ensureWorkspace() {
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
  async startServer(languageId, config) {
    await this.ensureWorkspace();
    const stateDir = this._workspace.stateDir;
    const folders = this._workspace.getWorkspaceFolders();
    const workspaceFolders = folders.length > 0 ? folders : void 0;
    const initializationOptions = config.initializationOptions ?? (languageId === "java" ? this.getJavaInitializationOptions() : void 0);
    let effectiveArgs = config.args;
    if (languageId === "java") {
      const lombokJar = this.findLombokJar();
      if (lombokJar) {
        effectiveArgs = [`--jvm-arg=-javaagent:${lombokJar}`, ...config.args];
      }
    }
    const onUnexpectedExit = (code) => this.handleUnexpectedExit(languageId, code);
    const socketPath = this.getSocketPath(languageId);
    if (socketPath && this.isDaemonAlive(languageId)) {
      this._callbacks.onServerStart?.(languageId, `${config.command} (shared)`);
      try {
        const client2 = new LspClient({
          command: config.command,
          args: effectiveArgs,
          rootDir: this.rootDir,
          languageId,
          socketPath,
          initializationOptions,
          settings: config.settings,
          onUnexpectedExit
        });
        await client2.start();
        this.clients.set(languageId, client2);
        this.startingServers.delete(languageId);
        this._callbacks.onServerReady?.(languageId);
        this._restartAttempts.delete(languageId);
        this._restartBackoff.delete(languageId);
        this.triggerPostInit(languageId, client2);
        return client2;
      } catch {
      }
    }
    this._callbacks.onServerStart?.(languageId, config.command);
    if (languageId === "java") {
      this.recoverCorruptJavaWorkspace(
        this.rootDir,
        (msg, level) => this._callbacks.onServerNotice?.(languageId, msg, level)
      );
    }
    if (stateDir) {
      try {
        await this.spawnDaemon(languageId, config, effectiveArgs, workspaceFolders, initializationOptions);
        await new Promise((r) => setTimeout(r, DAEMON_SOCKET_READY_DELAY_MS));
        const daemonSocket = this.getSocketPath(languageId);
        let lastErr = null;
        for (let attempt = 0; attempt < DAEMON_MAX_RETRIES; attempt++) {
          try {
            const client2 = new LspClient({
              command: config.command,
              args: effectiveArgs,
              rootDir: this.rootDir,
              languageId,
              socketPath: daemonSocket,
              initializationOptions,
              settings: config.settings,
              onUnexpectedExit
            });
            await client2.start();
            this.clients.set(languageId, client2);
            this.startingServers.delete(languageId);
            this._callbacks.onServerReady?.(languageId);
            this._restartAttempts.delete(languageId);
            this._restartBackoff.delete(languageId);
            this.triggerPostInit(languageId, client2);
            return client2;
          } catch (err) {
            lastErr = err;
            if (!this.isDaemonAlive(languageId)) {
              throw new Error(`Daemon for ${languageId} died during startup: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, DAEMON_RETRY_INTERVAL_MS));
          }
        }
        throw lastErr ?? new Error("Failed to connect to daemon");
      } catch (err) {
        this._callbacks.onServerError?.(languageId, `Daemon mode failed, falling back to direct: ${err.message}`);
        this.startingServers.delete(languageId);
      }
    }
    const client = new LspClient({
      command: config.command,
      args: effectiveArgs,
      rootDir: this.rootDir,
      languageId,
      env: config.env,
      workspaceFolders,
      initializationOptions,
      settings: config.settings,
      onUnexpectedExit
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
    } catch (err) {
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
  triggerPostInit(languageId, client) {
    if (languageId === "java") {
      client.sendRequest("java/buildWorkspace", true).catch(() => {
      });
    }
  }
  /** Get the socket path for a language's daemon */
  getSocketPath(languageId) {
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return null;
    return join(stateDir, "sockets", `lsp-${languageId}.sock`);
  }
  /** Check if a daemon is alive for this language */
  isDaemonAlive(languageId) {
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return false;
    const pidPath = join(stateDir, "sockets", `lsp-${languageId}.pid`);
    try {
      if (!existsSync(pidPath)) return false;
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /** Spawn an LSP daemon as a detached background process */
  async spawnDaemon(languageId, config, effectiveArgs, workspaceFolders, initializationOptions) {
    const socketPath = this.getSocketPath(languageId);
    const daemonScript = daemonScriptPath();
    const env = {
      ...process.env,
      ...config.env ?? {},
      LSP_ROOT_DIR: this.rootDir,
      LSP_LANGUAGE_ID: languageId
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
      process.execPath,
      // node
      [daemonScript, socketPath, config.command, ...effectiveArgs],
      {
        cwd: this.rootDir,
        env,
        detached: true,
        stdio: "ignore"
      }
    );
    child.unref();
  }
  /** Get status of all configured/running servers */
  getStatus() {
    const statuses = [];
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
        shared: daemonAlive
      });
    }
    return statuses;
  }
  /**
   * Handle an unexpected server exit. Attempts auto-restart with exponential backoff.
   * Gives up after MAX_RESTART_ATTEMPTS failures per language per session.
   */
  handleUnexpectedExit(languageId, code) {
    if (this._shuttingDown) return;
    this.clients.delete(languageId);
    this.startingServers.delete(languageId);
    const attempts = this._restartAttempts.get(languageId) ?? 0;
    if (attempts >= _LspManager.MAX_RESTART_ATTEMPTS) {
      this._callbacks.onServerError?.(languageId, `LSP server for ${languageId} crashed ${attempts} times \u2014 giving up auto-restart`);
      this._callbacks.onServerCrash?.(languageId, false, attempts);
      return;
    }
    const backoff = this._restartBackoff.get(languageId) ?? _LspManager.INITIAL_BACKOFF_MS;
    this._restartAttempts.set(languageId, attempts + 1);
    this._restartBackoff.set(languageId, Math.min(backoff * 2, _LspManager.MAX_BACKOFF_MS));
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
        this.handleUnexpectedExit(languageId, null);
      });
    }, backoff);
  }
  /** Shut down all clients (disconnect from daemons, kill direct servers) */
  async shutdownAll() {
    this._workspace.shutdown();
    this._shuttingDown = true;
    const shutdowns = [...this.clients.values()].map(
      (client) => client.shutdown().catch(() => {
      })
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
  async restartServer(languageId) {
    const existing = this.clients.get(languageId);
    if (existing) {
      await existing.shutdown().catch(() => {
      });
      this.clients.delete(languageId);
    }
    this.killDaemon(languageId);
    const pending = this.startingServers.get(languageId);
    if (pending) {
      await pending.catch(() => {
      });
      this.startingServers.delete(languageId);
    }
    const config = this.serverConfigs.get(languageId);
    if (!config) throw new Error(`No server configured for ${languageId}`);
    await this.startServer(languageId, config);
  }
  /** Kill a running daemon for a language (if any) */
  killDaemon(languageId) {
    const stateDir = this._workspace.stateDir;
    if (!stateDir) return;
    const pidPath = join(stateDir, "sockets", `lsp-${languageId}.pid`);
    try {
      if (!existsSync(pidPath)) return;
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) return;
      process.kill(pid, "SIGTERM");
      const socketPath = join(stateDir, "sockets", `lsp-${languageId}.sock`);
      try {
        unlinkSync(socketPath);
      } catch {
      }
      try {
        unlinkSync(pidPath);
      } catch {
      }
    } catch {
    }
  }
};

// src/file-sync.ts
import { readFile } from "node:fs/promises";
var MAX_TRACKED_DOCUMENTS = 100;
var FileSync = class {
  constructor(manager, maxTracked) {
    this.manager = manager;
    this.maxTracked = maxTracked ?? MAX_TRACKED_DOCUMENTS;
  }
  manager;
  /** LRU map: most-recently-used documents are at the end (Map preserves insertion order) */
  tracked = /* @__PURE__ */ new Map();
  treeSitter = null;
  workspaceIndex = null;
  isSyntheticDotActive = () => false;
  maxTracked;
  /** Set the synthetic dot checker to coordinate with the completions tool */
  setSyntheticDotChecker(checker) {
    this.isSyntheticDotActive = checker;
  }
  /** Set the tree-sitter manager for cache invalidation */
  setTreeSitter(treeSitter, workspaceIndex) {
    this.treeSitter = treeSitter;
    this.workspaceIndex = workspaceIndex ?? null;
  }
  /**
   * Touch a URI in the LRU — moves it to the end (most-recently-used position).
   * If the map exceeds maxTracked, evicts the oldest entry and sends didClose.
   */
  touchAndEvict(uri) {
    const doc = this.tracked.get(uri);
    if (doc) {
      this.tracked.delete(uri);
      this.tracked.set(uri, doc);
    }
    while (this.tracked.size > this.maxTracked) {
      const oldest = this.tracked.entries().next();
      if (oldest.done) break;
      const [evictUri, evictDoc] = oldest.value;
      this.tracked.delete(evictUri);
      const client = this.manager.getRunningClient(evictDoc.languageId);
      if (client) {
        client.didClose(evictUri);
      }
    }
  }
  /**
   * Handle a file being read — sends didOpen if not yet tracked.
   * Called from tool_result handler for the `read` tool.
   */
  async handleFileRead(filePath) {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);
    if (this.tracked.has(uri)) {
      this.touchAndEvict(uri);
      return;
    }
    const languageId = this.manager.getLanguageId(absPath);
    if (!languageId) return;
    const client = this.manager.getRunningClient(languageId);
    if (!client) return;
    try {
      const content = await readFile(absPath, "utf-8");
      const doc = { uri, languageId, version: 1 };
      this.tracked.set(uri, doc);
      client.didOpen(uri, languageId, doc.version, content);
      this.touchAndEvict(uri);
    } catch {
    }
  }
  /**
   * Handle a file being written/edited — sends didOpen or didChange.
   * Called from tool_result handler for `write` and `edit` tools.
   */
  async handleFileWrite(filePath) {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);
    const languageId = this.manager.getLanguageId(absPath);
    if (this.treeSitter) {
      this.treeSitter.invalidate(absPath);
      if (this.workspaceIndex) {
        this.workspaceIndex.indexFile(absPath).catch(() => {
        });
      }
    }
    if (!languageId) return;
    if (this.isSyntheticDotActive(uri)) {
      setTimeout(() => {
        if (!this.isSyntheticDotActive(uri)) {
          this.handleFileWrite(filePath).catch(() => {
          });
        }
      }, 200);
      return;
    }
    const client = await this.manager.getClientForFile(absPath).catch(() => null);
    if (!client) return;
    try {
      const content = await readFile(absPath, "utf-8");
      const existing = this.tracked.get(uri);
      if (existing) {
        existing.version++;
        client.didChange(uri, existing.version, content);
      } else {
        const doc = { uri, languageId, version: 1 };
        this.tracked.set(uri, doc);
        client.didOpen(uri, languageId, doc.version, content);
      }
      this.touchAndEvict(uri);
    } catch {
    }
  }
  /**
   * Get the current tracked version for a URI, or null if not tracked.
   * Used by tools that need to send temporary didChange notifications
   * while keeping versions in sync.
   */
  getTrackedVersion(uri) {
    const doc = this.tracked.get(uri);
    return doc ? doc.version : null;
  }
  /**
   * Update the tracked version for a URI after external didChange calls.
   * This keeps FileSync in sync when other code (e.g., completions tool)
   * sends didChange notifications directly to the LSP client.
   */
  setTrackedVersion(uri, version) {
    const doc = this.tracked.get(uri);
    if (doc) {
      doc.version = version;
    }
  }
  /** Get the number of tracked documents */
  get trackedCount() {
    return this.tracked.size;
  }
};

// src/tree-sitter/parser-manager.ts
import { createRequire } from "node:module";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import Parser from "web-tree-sitter";
var require2 = createRequire(import.meta.url);
var LANGUAGE_TO_GRAMMAR = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  swift: "tree-sitter-swift.wasm",
  lua: "tree-sitter-lua.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm"
};
var TreeSitterManager = class {
  initialized = false;
  initializing = null;
  languages = /* @__PURE__ */ new Map();
  loadingLanguages = /* @__PURE__ */ new Map();
  parsers = /* @__PURE__ */ new Map();
  cachedTrees = /* @__PURE__ */ new Map();
  grammarsDir;
  constructor() {
    const wasmsPkgJson = require2.resolve("tree-sitter-wasms/package.json");
    this.grammarsDir = resolve2(dirname2(wasmsPkgJson), "out");
  }
  /** Initialize web-tree-sitter WASM runtime. Must be called before any parsing. */
  async init() {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    this.initializing = Parser.init({
      locateFile: (scriptName) => {
        const webTsPkgJson = require2.resolve("web-tree-sitter/package.json");
        return resolve2(dirname2(webTsPkgJson), scriptName);
      }
    });
    await this.initializing;
    this.initialized = true;
  }
  /** Get the language ID for a file path based on extension */
  getLanguageId(filePath) {
    return getLanguageIdFromPath(filePath);
  }
  /** Check if we have a grammar available for a language */
  hasGrammar(languageId) {
    return languageId in LANGUAGE_TO_GRAMMAR;
  }
  /** Get all supported language IDs */
  getSupportedLanguages() {
    return Object.keys(LANGUAGE_TO_GRAMMAR);
  }
  /** Load a language grammar, caching the result */
  async getLanguage(languageId) {
    const cached = this.languages.get(languageId);
    if (cached) return cached;
    const loading = this.loadingLanguages.get(languageId);
    if (loading) return loading;
    const grammarFile = LANGUAGE_TO_GRAMMAR[languageId];
    if (!grammarFile) return null;
    const loadPromise = (async () => {
      await this.init();
      try {
        const grammarPath = resolve2(this.grammarsDir, grammarFile);
        const language = await Parser.Language.load(grammarPath);
        this.languages.set(languageId, language);
        return language;
      } catch {
        return null;
      } finally {
        this.loadingLanguages.delete(languageId);
      }
    })();
    this.loadingLanguages.set(languageId, loadPromise);
    return loadPromise;
  }
  /** Get or create a parser for a language */
  async getParser(languageId) {
    const existing = this.parsers.get(languageId);
    if (existing) return existing;
    const language = await this.getLanguage(languageId);
    if (!language) return null;
    const parser = new Parser();
    parser.setLanguage(language);
    this.parsers.set(languageId, parser);
    return parser;
  }
  /** Parse a file's content and return the tree. Caches by file path + content hash. */
  async parse(filePath, content) {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.parseWithLanguage(filePath, content, languageId);
  }
  /** Parse content with an explicit language ID */
  async parseWithLanguage(filePath, content, languageId) {
    const length = content.length;
    const head = djb2Hash(content, 0, Math.min(length, 4096));
    const tail = length > 4096 ? djb2Hash(content, Math.max(0, length - 4096), length) : head;
    const cached = this.cachedTrees.get(filePath);
    if (cached && cached.contentLength === length && cached.hashHead === head && cached.hashTail === tail) {
      return cached.tree;
    }
    const parser = await this.getParser(languageId);
    if (!parser) return null;
    const tree = parser.parse(content);
    if (!tree) return null;
    if (cached) cached.tree.delete();
    this.cachedTrees.set(filePath, { tree, contentLength: length, hashHead: head, hashTail: tail });
    return tree;
  }
  /** Invalidate the cached tree for a file */
  invalidate(filePath) {
    const cached = this.cachedTrees.get(filePath);
    if (cached) {
      cached.tree.delete();
      this.cachedTrees.delete(filePath);
    }
  }
  /** Get a cached tree without re-parsing */
  getCachedTree(filePath) {
    return this.cachedTrees.get(filePath)?.tree ?? null;
  }
  /** Shut down — free all resources */
  shutdown() {
    for (const [, cached] of this.cachedTrees) cached.tree.delete();
    this.cachedTrees.clear();
    for (const [, parser] of this.parsers) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }
  /** Alias for shutdown() — conventional dispose pattern for extension lifecycle */
  dispose() {
    this.shutdown();
  }
};
function djb2Hash(str, start, end) {
  let hash = 5381;
  for (let i = start; i < end; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i) | 0;
  }
  return hash;
}

// src/tree-sitter/workspace-index.ts
import { resolve as resolve3 } from "node:path";
import { readdir, stat, readFile as readFile2 } from "node:fs/promises";

// src/tree-sitter/symbol-extractor.ts
var SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Struct: 22
};
var TS_JS_SYMBOLS = [
  { nodeType: "function_declaration", kind: SymbolKind.Function },
  { nodeType: "class_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "interface_declaration", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "enum_declaration", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "type_alias_declaration", kind: SymbolKind.Variable },
  { nodeType: "method_definition", kind: SymbolKind.Method },
  { nodeType: "public_field_definition", kind: SymbolKind.Field },
  { nodeType: "abstract_method_signature", kind: SymbolKind.Method },
  { nodeType: "lexical_declaration", kind: SymbolKind.Variable },
  { nodeType: "variable_declaration", kind: SymbolKind.Variable }
];
var PYTHON_SYMBOLS = [
  { nodeType: "function_definition", kind: SymbolKind.Function },
  { nodeType: "class_definition", kind: SymbolKind.Class, recurse: true },
  { nodeType: "decorated_definition", kind: SymbolKind.Function }
];
var RUST_SYMBOLS = [
  { nodeType: "function_item", kind: SymbolKind.Function },
  { nodeType: "struct_item", kind: SymbolKind.Struct },
  { nodeType: "enum_item", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "impl_item", kind: SymbolKind.Class, recurse: true },
  { nodeType: "trait_item", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "mod_item", kind: SymbolKind.Module, recurse: true },
  { nodeType: "type_item", kind: SymbolKind.Variable },
  { nodeType: "const_item", kind: SymbolKind.Constant },
  { nodeType: "static_item", kind: SymbolKind.Constant },
  { nodeType: "macro_definition", kind: SymbolKind.Function }
];
var GO_SYMBOLS = [
  { nodeType: "function_declaration", kind: SymbolKind.Function },
  { nodeType: "method_declaration", kind: SymbolKind.Method },
  { nodeType: "type_declaration", kind: SymbolKind.Class },
  { nodeType: "type_spec", kind: SymbolKind.Class },
  { nodeType: "const_declaration", kind: SymbolKind.Constant },
  { nodeType: "var_declaration", kind: SymbolKind.Variable }
];
var JAVA_SYMBOLS = [
  { nodeType: "class_declaration", kind: SymbolKind.Class, recurse: true },
  { nodeType: "interface_declaration", kind: SymbolKind.Interface, recurse: true },
  { nodeType: "enum_declaration", kind: SymbolKind.Enum, recurse: true },
  { nodeType: "method_declaration", kind: SymbolKind.Method },
  { nodeType: "constructor_declaration", kind: SymbolKind.Constructor },
  { nodeType: "field_declaration", kind: SymbolKind.Field },
  { nodeType: "annotation_type_declaration", kind: SymbolKind.Interface }
];
var C_CPP_SYMBOLS = [
  { nodeType: "function_definition", kind: SymbolKind.Function },
  { nodeType: "declaration", kind: SymbolKind.Variable },
  { nodeType: "struct_specifier", kind: SymbolKind.Struct },
  { nodeType: "enum_specifier", kind: SymbolKind.Enum },
  { nodeType: "class_specifier", kind: SymbolKind.Class, recurse: true },
  { nodeType: "namespace_definition", kind: SymbolKind.Namespace, recurse: true }
];
var RUBY_SYMBOLS = [
  { nodeType: "method", kind: SymbolKind.Method },
  { nodeType: "singleton_method", kind: SymbolKind.Method },
  { nodeType: "class", kind: SymbolKind.Class, recurse: true },
  { nodeType: "module", kind: SymbolKind.Module, recurse: true }
];
var LANGUAGE_SYMBOLS = {
  typescript: TS_JS_SYMBOLS,
  typescriptreact: TS_JS_SYMBOLS,
  javascript: TS_JS_SYMBOLS,
  javascriptreact: TS_JS_SYMBOLS,
  python: PYTHON_SYMBOLS,
  rust: RUST_SYMBOLS,
  go: GO_SYMBOLS,
  java: JAVA_SYMBOLS,
  c: C_CPP_SYMBOLS,
  cpp: C_CPP_SYMBOLS,
  ruby: RUBY_SYMBOLS
};
function extractSymbols(tree, languageId) {
  const mappings = LANGUAGE_SYMBOLS[languageId];
  if (!mappings) return extractGenericSymbols(tree);
  return extractFromNode(tree.rootNode, mappings, languageId);
}
function extractFromNode(node, mappings, languageId, deep = false) {
  const symbols = [];
  for (const child of node.namedChildren) {
    const mapping = mappings.find((m) => m.nodeType === child.type);
    if (mapping) {
      const name = extractName(child, mapping, languageId);
      if (name) {
        const sym = {
          name,
          kind: mapping.kind,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1
        };
        if (mapping.recurse) {
          const children = extractFromNode(child, mappings, languageId, true);
          if (children.length > 0) sym.children = children;
        }
        symbols.push(sym);
      }
    } else if (child.type === "export_statement" && (languageId.startsWith("typescript") || languageId.startsWith("javascript"))) {
      const inner = extractFromNode(child, mappings, languageId, deep);
      symbols.push(...inner);
    } else if (deep && child.namedChildCount > 0) {
      symbols.push(...extractFromNode(child, mappings, languageId, true));
    }
  }
  return symbols;
}
function extractName(node, mapping, languageId) {
  const nameNode = node.childForFieldName(mapping.nameField ?? "name");
  if (nameNode) return nameNode.text;
  switch (node.type) {
    case "lexical_declaration":
    case "variable_declaration": {
      const declarator = node.namedChildren.find(
        (c) => c.type === "variable_declarator" || c.type === "init_declarator"
      );
      if (declarator) {
        const n = declarator.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "decorated_definition": {
      const inner = node.namedChildren.find(
        (c) => c.type === "function_definition" || c.type === "class_definition"
      );
      if (inner) {
        const n = inner.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "impl_item": {
      const typeNode = node.childForFieldName("type");
      if (typeNode) return `impl ${typeNode.text}`;
      return null;
    }
    case "type_declaration": {
      const spec = node.namedChildren.find((c) => c.type === "type_spec");
      if (spec) {
        const n = spec.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "const_declaration":
    case "var_declaration": {
      const spec = node.namedChildren.find(
        (c) => c.type === "const_spec" || c.type === "var_spec"
      );
      if (spec) {
        const n = spec.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "field_declaration": {
      const declarator = node.namedChildren.find((c) => c.type === "variable_declarator");
      if (declarator) {
        const n = declarator.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    case "declaration": {
      const declarator = node.namedChildren.find(
        (c) => c.type === "init_declarator" || c.type === "function_declarator"
      );
      if (declarator) {
        const n = declarator.childForFieldName("declarator") ?? declarator.childForFieldName("name");
        return n?.text ?? null;
      }
      return null;
    }
    default:
      break;
  }
  const first = node.firstNamedChild;
  if (first && first.text.length < 60) return first.text;
  return null;
}
function extractGenericSymbols(tree) {
  const symbols = [];
  const root = tree.rootNode;
  for (const child of root.namedChildren) {
    if (child.type.includes("function") || child.type.includes("method")) {
      const name = child.childForFieldName("name")?.text;
      if (name) {
        symbols.push({
          name,
          kind: SymbolKind.Function,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1
        });
      }
    } else if (child.type.includes("class") || child.type.includes("struct")) {
      const name = child.childForFieldName("name")?.text;
      if (name) {
        symbols.push({
          name,
          kind: SymbolKind.Class,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1
        });
      }
    }
  }
  return symbols;
}
function getNodeAtPosition(tree, line, character) {
  const point = { row: line, column: character };
  return tree.rootNode.namedDescendantForPosition(point);
}
function findDefinition(tree, symbolName, languageId) {
  const allSymbols = extractSymbols(tree, languageId);
  return findSymbolByName(allSymbols, symbolName);
}
function findSymbolByName(symbols, name) {
  const results = [];
  for (const sym of symbols) {
    if (sym.name === name) results.push(sym);
    if (sym.children) results.push(...findSymbolByName(sym.children, name));
  }
  return results;
}
function getSyntaxErrors(tree) {
  const errors = [];
  function walk(node) {
    if (node.isError) {
      errors.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        message: `Syntax error: unexpected "${node.text.slice(0, 50)}${node.text.length > 50 ? "..." : ""}"`
      });
    } else if (node.isMissing) {
      errors.push({
        line: node.startPosition.row,
        character: node.startPosition.column,
        endLine: node.endPosition.row,
        endCharacter: node.endPosition.column,
        message: `Missing ${node.type}`
      });
    } else if (node.hasError) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }
  walk(tree.rootNode);
  return errors;
}
function getSignatureText(node) {
  const text = node.text;
  const firstLine = text.split("\n")[0];
  return firstLine.replace(/\s*[{:]\s*$/, "").trim();
}
function getEnclosingDeclaration(tree, line, character) {
  const point = { row: line, column: character };
  let node = tree.rootNode.namedDescendantForPosition(point);
  const declarationTypes = /* @__PURE__ */ new Set([
    "function_declaration",
    "function_definition",
    "function_item",
    "method_declaration",
    "method_definition",
    "class_declaration",
    "class_definition",
    "class_specifier",
    "interface_declaration",
    "enum_declaration",
    "enum_item",
    "struct_item",
    "impl_item",
    "trait_item",
    "mod_item",
    "type_alias_declaration",
    "type_declaration",
    "variable_declarator",
    "lexical_declaration",
    "const_item",
    "static_item",
    "decorated_definition"
  ]);
  while (node) {
    if (declarationTypes.has(node.type)) return node;
    node = node.parent;
  }
  return null;
}

// src/shared/constants.ts
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "target",
  "out",
  ".next",
  "__pycache__",
  ".tox",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
  ".bemol",
  "env",
  "coverage",
  ".nyc_output",
  ".cache"
]);
var MAX_FILE_SIZE = 500 * 1024;
var MAX_INDEX_FILES = 5e3;

// src/tree-sitter/workspace-index.ts
var WorkspaceIndex = class {
  constructor(rootDir, treeSitter) {
    this.rootDir = rootDir;
    this.treeSitter = treeSitter;
  }
  rootDir;
  treeSitter;
  /** Map from symbol name (lowercase) to entries */
  index = /* @__PURE__ */ new Map();
  /** Reverse index: file path → set of index keys that have entries for this file */
  fileToKeys = /* @__PURE__ */ new Map();
  /** Set of indexed file paths (absolute) */
  indexedFiles = /* @__PURE__ */ new Set();
  /** Whether the initial build has completed */
  built = false;
  building = null;
  /** Build the index by walking the project tree. Deduplicates concurrent calls. */
  async build() {
    if (this.built) return;
    if (this.building) {
      await this.building;
      return;
    }
    this.building = this._build();
    await this.building;
    this.built = true;
    this.building = null;
  }
  async _build() {
    const files = await this.collectFiles(this.rootDir);
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((f) => this.indexFile(f).catch(() => {
      })));
    }
  }
  /** Collect all indexable files under a directory */
  async collectFiles(dir, collected = []) {
    if (collected.length >= MAX_INDEX_FILES) return collected;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (collected.length >= MAX_INDEX_FILES) break;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          await this.collectFiles(resolve3(dir, entry.name), collected);
        } else if (entry.isFile()) {
          const languageId = this.treeSitter.getLanguageId(entry.name);
          if (languageId && this.treeSitter.hasGrammar(languageId)) {
            collected.push(resolve3(dir, entry.name));
          }
        }
      }
    } catch {
    }
    return collected;
  }
  /** Index (or re-index) a single file */
  async indexFile(filePath) {
    const absPath = resolve3(filePath);
    this.removeFile(absPath);
    try {
      const stats = await stat(absPath);
      if (stats.size > MAX_FILE_SIZE) return;
      const content = await readFile2(absPath, "utf-8");
      const languageId = this.treeSitter.getLanguageId(absPath);
      if (!languageId) return;
      const tree = await this.treeSitter.parse(absPath, content);
      if (!tree) return;
      const symbols = extractSymbols(tree, languageId);
      this.addSymbols(absPath, symbols);
      this.indexedFiles.add(absPath);
    } catch {
    }
  }
  /** Index a file from already-available content (avoids re-reading) */
  async indexFileContent(filePath, content) {
    const absPath = resolve3(filePath);
    this.removeFile(absPath);
    const languageId = this.treeSitter.getLanguageId(absPath);
    if (!languageId) return;
    const tree = await this.treeSitter.parse(absPath, content);
    if (!tree) return;
    const symbols = extractSymbols(tree, languageId);
    this.addSymbols(absPath, symbols);
    this.indexedFiles.add(absPath);
  }
  addSymbols(filePath, symbols) {
    for (const sym of symbols) {
      const entry = {
        name: sym.name,
        kind: sym.kind,
        file: filePath,
        line: sym.line
      };
      const key = sym.name.toLowerCase();
      const existing = this.index.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        this.index.set(key, [entry]);
      }
      let keys = this.fileToKeys.get(filePath);
      if (!keys) {
        keys = /* @__PURE__ */ new Set();
        this.fileToKeys.set(filePath, keys);
      }
      keys.add(key);
      if (sym.children) {
        this.addSymbols(filePath, sym.children);
      }
    }
  }
  /** Remove all entries for a file (O(keys-per-file) via reverse index) */
  removeFile(filePath) {
    const absPath = resolve3(filePath);
    this.indexedFiles.delete(absPath);
    const keys = this.fileToKeys.get(absPath);
    if (keys) {
      for (const key of keys) {
        const entries = this.index.get(key);
        if (!entries) continue;
        const filtered = entries.filter((e) => e.file !== absPath);
        if (filtered.length === 0) {
          this.index.delete(key);
        } else {
          this.index.set(key, filtered);
        }
      }
      this.fileToKeys.delete(absPath);
    }
  }
  /** Search for symbols matching a query (fuzzy) */
  search(query) {
    if (!query) return [];
    const queryLower = query.toLowerCase();
    const exact = this.index.get(queryLower) ?? [];
    const fuzzy = [];
    for (const [key, entries] of this.index) {
      if (key === queryLower) continue;
      if (key.includes(queryLower)) {
        fuzzy.push(...entries);
      }
    }
    const results = [...exact, ...fuzzy];
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
      const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.name.length - b.name.length;
    });
    return results.slice(0, 100);
  }
  /** Get all symbols for a specific file */
  getSymbolsForFile(filePath) {
    const absPath = resolve3(filePath);
    const results = [];
    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.file === absPath) results.push(entry);
      }
    }
    return results.sort((a, b) => a.line - b.line);
  }
  /** Get index stats */
  getStats() {
    let symbolCount = 0;
    for (const entries of this.index.values()) {
      symbolCount += entries.length;
    }
    return { files: this.indexedFiles.size, symbols: symbolCount };
  }
  /** Whether the index has been built */
  get isBuilt() {
    return this.built;
  }
};

// src/tools/diagnostics.ts
import { Type } from "typebox";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// src/resolve-provider.ts
function resolveProvider(filePath, manager, treeSitter) {
  const languageId = manager.getLanguageId(filePath);
  if (languageId) {
    const client = manager.getRunningClient(languageId);
    if (client) return { type: "lsp" };
    if (manager.isServerStarting(languageId)) {
      if (treeSitter?.hasGrammar(languageId)) {
        return { type: "tree-sitter", languageId };
      }
      return { type: "none", reason: `LSP server for ${languageId} is still starting up. Try again in a moment.` };
    }
  }
  if (treeSitter) {
    const tsLang = treeSitter.getLanguageId(filePath);
    if (tsLang && treeSitter.hasGrammar(tsLang)) {
      return { type: "tree-sitter", languageId: tsLang };
    }
  }
  const ext = filePath.match(/\.[^.]+$/)?.[0] ?? "";
  return {
    type: "none",
    reason: `No code intelligence available for ${ext || "this file type"}. No LSP server is running and no tree-sitter grammar is available.`
  };
}

// src/tools/diagnostics.ts
import { readFile as readFile3 } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function severityToString(severity) {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}
function formatDiagnostic(diag, filePath) {
  const line = diag.range.start.line + 1;
  const col = diag.range.start.character + 1;
  const sev = severityToString(diag.severity);
  const source = diag.source ? ` [${diag.source}]` : "";
  const code = diag.code !== void 0 ? ` (${diag.code})` : "";
  return `${filePath}:${line}:${col} ${sev}: ${diag.message}${code}${source}`;
}
var DiagnosticsParams = Type.Object({
  path: Type.String({ description: 'File path to get diagnostics for. Pass "*" to get all workspace diagnostics from all running LSP servers.' })
});
function createDiagnosticsTool(manager, treeSitter) {
  return {
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: 'Get compilation errors and warnings from the LSP server. Pass a file path to check a single file, or pass "*" to get all cached diagnostics across the workspace.',
    promptSnippet: 'Get compiler errors, warnings, and hints for a source file via LSP. Pass path="*" to get all workspace diagnostics.',
    promptGuidelines: [
      "After making code changes with edit or write, use lsp_diagnostics to check for compilation errors before moving on.",
      'To review all workspace diagnostics at once, call lsp_diagnostics with path="*" \u2014 this returns all cached diagnostics from running LSP servers without needing to check files individually.'
    ],
    parameters: DiagnosticsParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      if (filePath === "*" || filePath === "") {
        return executeWorkspaceDiagnostics(manager);
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (client) {
        const uri = manager.getFileUri(filePath);
        const diagnostics = client.getDiagnostics(uri);
        if (diagnostics.length === 0) {
          return { content: [{ type: "text", text: "No diagnostics (clean)." }], details: { count: 0 } };
        }
        const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99));
        const relPath = relative(manager.resolvePath("."), manager.resolvePath(filePath));
        const lines = sorted.map((d) => formatDiagnostic(d, relPath));
        const output = lines.join("\n");
        const errors = sorted.filter((d) => d.severity === DiagnosticSeverity.Error).length;
        const warnings = sorted.filter((d) => d.severity === DiagnosticSeverity.Warning).length;
        const other = sorted.length - errors - warnings;
        const summary = [
          errors > 0 ? `${errors} error(s)` : null,
          warnings > 0 ? `${warnings} warning(s)` : null,
          other > 0 ? `${other} other` : null
        ].filter(Boolean).join(", ");
        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let resultText = `${summary}

${truncation.content}`;
        if (truncation.truncated) {
          resultText += `

[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
        }
        return {
          content: [{ type: "text", text: resultText }],
          details: { count: sorted.length, errors, warnings }
        };
      }
      if (treeSitter) {
        const provider = resolveProvider(filePath, manager, treeSitter);
        if (provider.type === "tree-sitter") {
          try {
            const absPath = manager.resolvePath(filePath);
            const content = await readFile3(absPath, "utf-8");
            const tree = await treeSitter.parse(absPath, content);
            if (tree) {
              const syntaxErrors = getSyntaxErrors(tree);
              if (syntaxErrors.length === 0) {
                return { content: [{ type: "text", text: "No syntax errors detected. [tree-sitter \u2014 syntax only, no type checking]" }], details: { count: 0 } };
              }
              const relPath = relative(manager.resolvePath("."), absPath);
              const lines = syntaxErrors.map(
                (e) => `${relPath}:${e.line + 1}:${e.character + 1} error: ${e.message}`
              );
              const output = lines.join("\n");
              const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
              let resultText = `${syntaxErrors.length} syntax error(s) [tree-sitter \u2014 syntax only, no type checking]

${truncation.content}`;
              if (truncation.truncated) {
                resultText += `

[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
              }
              return {
                content: [{ type: "text", text: resultText }],
                details: { count: syntaxErrors.length, errors: syntaxErrors.length }
              };
            }
          } catch {
          }
        }
      }
      return {
        content: [{ type: "text", text: manager.getUnavailableReason(filePath) }],
        details: { count: 0 }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_diagnostics "));
      if (args.path && args.path !== "*") {
        text += theme.fg("accent", args.path);
      } else {
        text += theme.fg("dim", "(workspace)");
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) {
        return new Text(theme.fg("success", "\u2713 No diagnostics"), 0, 0);
      }
      let text = "";
      if (details.errors && details.errors > 0) text += theme.fg("error", `${details.errors} error(s)`);
      if (details.warnings && details.warnings > 0) {
        if (text) text += " ";
        text += theme.fg("warning", `${details.warnings} warning(s)`);
      }
      if (details.files && details.files > 0) {
        text += theme.fg("dim", ` in ${details.files} file(s)`);
      }
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const lines = content.text.split("\n").slice(0, 30);
          for (const line of lines) text += `
${theme.fg("dim", line)}`;
        }
      }
      return new Text(text, 0, 0);
    }
  };
}
function executeWorkspaceDiagnostics(manager) {
  const statuses = manager.getStatus();
  const running = statuses.filter((s) => s.running);
  if (running.length === 0) {
    return {
      content: [{ type: "text", text: "No LSP servers are running. Use lsp_diagnostics with a file path to start a server and check that file." }],
      details: { count: 0 }
    };
  }
  const rootDir = manager.resolvePath(".");
  const allDiagnostics = [];
  for (const status of running) {
    const client = manager.getRunningClient(status.languageId);
    if (!client) continue;
    const diagMap = client.getAllDiagnostics();
    for (const [uri, diagnostics] of diagMap) {
      if (diagnostics.length === 0) continue;
      let absPath;
      try {
        absPath = fileURLToPath2(uri);
      } catch {
        absPath = uri;
      }
      const relPath = relative(rootDir, absPath);
      for (const diag of diagnostics) {
        allDiagnostics.push({ relPath, diag });
      }
    }
  }
  if (allDiagnostics.length === 0) {
    const langs = running.map((s) => s.languageId).join(", ");
    return {
      content: [{ type: "text", text: `No diagnostics across ${running.length} running server(s) (${langs}).` }],
      details: { count: 0 }
    };
  }
  allDiagnostics.sort((a, b) => {
    const sevDiff = (a.diag.severity ?? 99) - (b.diag.severity ?? 99);
    if (sevDiff !== 0) return sevDiff;
    return a.relPath.localeCompare(b.relPath);
  });
  const errors = allDiagnostics.filter((d) => d.diag.severity === DiagnosticSeverity.Error).length;
  const warnings = allDiagnostics.filter((d) => d.diag.severity === DiagnosticSeverity.Warning).length;
  const other = allDiagnostics.length - errors - warnings;
  const fileCount = new Set(allDiagnostics.map((d) => d.relPath)).size;
  const summary = [
    `${allDiagnostics.length} diagnostic(s) in ${fileCount} file(s)`,
    errors > 0 ? `${errors} error(s)` : null,
    warnings > 0 ? `${warnings} warning(s)` : null,
    other > 0 ? `${other} other` : null
  ].filter(Boolean).join(", ");
  const lines = allDiagnostics.map((d) => formatDiagnostic(d.diag, d.relPath));
  const output = lines.join("\n");
  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let resultText = `${summary}

${truncation.content}`;
  if (truncation.truncated) {
    resultText += `

[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
  }
  return {
    content: [{ type: "text", text: resultText }],
    details: { count: allDiagnostics.length, errors, warnings, files: fileCount }
  };
}

// src/tools/hover.ts
import { Type as Type2 } from "typebox";
import { Text as Text2 } from "@earendil-works/pi-tui";

// src/shared/resolve-position.ts
import { readFile as readFile4 } from "node:fs/promises";
async function resolveSymbolPosition(filePath, query, manager, treeSitter) {
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        const match = findInDocumentSymbols(symbols, query);
        if (match) return match;
      }
    } catch {
    }
  }
  if (treeSitter) {
    try {
      const absPath = manager.resolvePath(filePath);
      const content = await readFile4(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          const match = findInSymbolInfos(symbols, query);
          if (match) return match;
        }
      }
    } catch {
    }
  }
  return null;
}
async function getSymbolNames(filePath, manager, treeSitter) {
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        if ("selectionRange" in symbols[0]) {
          return symbols.map((s) => s.name);
        }
        return symbols.map((s) => s.name);
      }
    } catch {
    }
  }
  if (treeSitter) {
    try {
      const absPath = manager.resolvePath(filePath);
      const content = await readFile4(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          return symbols.map((s) => s.name);
        }
      }
    } catch {
    }
  }
  return [];
}
function findInDocumentSymbols(symbols, query) {
  if (symbols.length === 0) return null;
  if ("selectionRange" in symbols[0]) {
    return findInHierarchicalSymbols(symbols, query);
  }
  return findInFlatSymbols(symbols, query);
}
function findInHierarchicalSymbols(symbols, query) {
  const candidates = flattenDocumentSymbols(symbols);
  return matchCandidates(candidates, query, "lsp");
}
function flattenDocumentSymbols(symbols, parent) {
  const result = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      line: sym.selectionRange.start.line + 1,
      character: sym.selectionRange.start.character + 1,
      parent
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, sym.name));
    }
  }
  return result;
}
function findInFlatSymbols(symbols, query) {
  const candidates = symbols.map((sym) => ({
    name: sym.name,
    line: sym.location.range.start.line + 1,
    character: sym.location.range.start.character + 1,
    parent: sym.containerName ?? void 0
  }));
  return matchCandidates(candidates, query, "lsp");
}
function findInSymbolInfos(symbols, query) {
  const candidates = flattenSymbolInfos(symbols);
  return matchCandidates(candidates, query, "tree-sitter");
}
function flattenSymbolInfos(symbols, parent) {
  const result = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      line: sym.line,
      character: 1,
      // tree-sitter symbols don't have column precision for the name
      parent
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenSymbolInfos(sym.children, sym.name));
    }
  }
  return result;
}
function matchCandidates(candidates, query, source) {
  const dotIndex = query.lastIndexOf(".");
  let parentFilter;
  let symbolQuery;
  if (dotIndex > 0) {
    parentFilter = query.slice(0, dotIndex);
    symbolQuery = query.slice(dotIndex + 1);
  } else {
    symbolQuery = query;
  }
  if (parentFilter) {
    const qualified = candidates.filter(
      (c) => c.parent?.toLowerCase() === parentFilter.toLowerCase()
    );
    const match = matchByPriority(qualified, symbolQuery, source);
    if (match) return match;
  }
  return matchByPriority(candidates, symbolQuery, source);
}
function matchByPriority(candidates, query, source) {
  const queryLower = query.toLowerCase();
  const exact = candidates.find((c) => c.name === query);
  if (exact) return { line: exact.line, character: exact.character, symbolName: exact.name, source };
  const caseInsensitive = candidates.find((c) => c.name.toLowerCase() === queryLower);
  if (caseInsensitive) return { line: caseInsensitive.line, character: caseInsensitive.character, symbolName: caseInsensitive.name, source };
  const substring = candidates.find((c) => c.name.toLowerCase().includes(queryLower));
  if (substring) return { line: substring.line, character: substring.character, symbolName: substring.name, source };
  return null;
}

// src/tools/hover.ts
import { readFile as readFile5 } from "node:fs/promises";
function formatHoverContent(hover) {
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if ("kind" in contents && "value" in contents) return contents.value;
  if ("language" in contents && "value" in contents) {
    return `\`\`\`${contents.language}
${contents.value}
\`\`\``;
  }
  if (Array.isArray(contents)) {
    return contents.map((c) => {
      if (typeof c === "string") return c;
      if ("language" in c && "value" in c) return `\`\`\`${c.language}
${c.value}
\`\`\``;
      return String(c);
    }).join("\n\n");
  }
  return String(contents);
}
var HoverParams = Type2.Object({
  path: Type2.String({ description: "File path" }),
  line: Type2.Optional(Type2.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type2.Optional(Type2.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type2.Optional(Type2.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." }))
});
function createHoverTool(manager, treeSitter) {
  return {
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get type information and documentation for a symbol at a specific position in a file. Line and character are 1-indexed.",
    promptSnippet: "Get type info and docs for a symbol at a file position via LSP",
    parameters: HoverParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `
Available symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { hasResult: false } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { hasResult: false } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (client) {
        const uri = manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };
        try {
          const hover = await client.sendRequest("textDocument/hover", {
            textDocument: { uri },
            position
          });
          if (!hover) {
            const text2 = resolvedFrom ? `${resolvedFrom}

No hover information available at this position.` : "No hover information available at this position.";
            return { content: [{ type: "text", text: text2 }], details: { hasResult: false } };
          }
          const hoverText = formatHoverContent(hover);
          const text = resolvedFrom ? `${resolvedFrom}

${hoverText}` : hoverText;
          return { content: [{ type: "text", text }], details: { hasResult: true } };
        } catch (err) {
          return { content: [{ type: "text", text: `LSP hover request failed: ${err.message}` }], details: { hasResult: false } };
        }
      }
      if (treeSitter) {
        const provider = resolveProvider(filePath, manager, treeSitter);
        if (provider.type === "tree-sitter") {
          try {
            const absPath = manager.resolvePath(filePath);
            const content = await readFile5(absPath, "utf-8");
            const tree = await treeSitter.parse(absPath, content);
            if (tree) {
              const decl = getEnclosingDeclaration(tree, line - 1, character - 1);
              if (decl) {
                const sig = getSignatureText(decl);
                const kindLabel2 = decl.type.replace(/_/g, " ");
                let text2 = `${kindLabel2} [tree-sitter]

\`\`\`
${sig}
\`\`\``;
                if (resolvedFrom) text2 = `${resolvedFrom}

${text2}`;
                return { content: [{ type: "text", text: text2 }], details: { hasResult: true } };
              }
              const text = resolvedFrom ? `${resolvedFrom}

No hover information available at this position. [tree-sitter]` : "No hover information available at this position. [tree-sitter]";
              return { content: [{ type: "text", text }], details: { hasResult: false } };
            }
          } catch {
          }
        }
      }
      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { hasResult: false } };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_hover "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      return new Text2(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text2(theme.fg("warning", "Looking up..."), 0, 0);
      if (!result.details?.hasResult) return new Text2(theme.fg("dim", "No info"), 0, 0);
      const content = result.content[0];
      if (content?.type === "text") {
        const lines = content.text.split("\n").slice(0, 5);
        return new Text2(lines.map((l) => theme.fg("dim", l)).join("\n"), 0, 0);
      }
      return new Text2(theme.fg("dim", "No info"), 0, 0);
    }
  };
}

// src/tools/definition.ts
import { Type as Type3 } from "typebox";
import { Text as Text3 } from "@earendil-works/pi-tui";

// src/shared/format.ts
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { relative as relative2 } from "node:path";
function formatLocation(loc, rootDir) {
  try {
    const absPath = fileURLToPath3(loc.uri);
    const relPath = relative2(rootDir, absPath);
    return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  } catch {
    return `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  }
}
function formatLocationLink(link, rootDir) {
  try {
    const absPath = fileURLToPath3(link.targetUri);
    const relPath = relative2(rootDir, absPath);
    return `${relPath}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  } catch {
    return `${link.targetUri}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  }
}

// src/tools/definition.ts
import { readFile as readFile6 } from "node:fs/promises";
import { relative as relative3 } from "node:path";
var DefinitionParams = Type3.Object({
  path: Type3.String({ description: "File path" }),
  line: Type3.Optional(Type3.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type3.Optional(Type3.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type3.Optional(Type3.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." }))
});
function createDefinitionTool(manager, treeSitter, workspaceIndex) {
  return {
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Go to the definition of a symbol at a specific position. Returns the file path and location of the definition. Line and character are 1-indexed.",
    promptSnippet: "Jump to the definition of a symbol at a file position via LSP",
    parameters: DefinitionParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `
Available symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { count: 0 } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0 } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (client) {
        const uri = manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };
        try {
          const result = await client.sendRequest("textDocument/definition", {
            textDocument: { uri },
            position
          });
          if (!result) {
            const text2 = resolvedFrom ? `${resolvedFrom}

No definition found.` : "No definition found.";
            return { content: [{ type: "text", text: text2 }], details: { count: 0 } };
          }
          const rootDir = manager.resolvePath(".");
          let locations;
          if (Array.isArray(result)) {
            if (result.length === 0) {
              const text2 = resolvedFrom ? `${resolvedFrom}

No definition found.` : "No definition found.";
              return { content: [{ type: "text", text: text2 }], details: { count: 0 } };
            }
            if ("targetUri" in result[0]) {
              locations = result.map((l) => formatLocationLink(l, rootDir));
            } else {
              locations = result.map((l) => formatLocation(l, rootDir));
            }
          } else {
            locations = [formatLocation(result, rootDir)];
          }
          let text = locations.length === 1 ? `Definition: ${locations[0]}` : `Definitions:
${locations.map((l) => `  ${l}`).join("\n")}`;
          if (resolvedFrom) text = `${resolvedFrom}

${text}`;
          return { content: [{ type: "text", text }], details: { count: locations.length } };
        } catch (err) {
          return { content: [{ type: "text", text: `LSP definition request failed: ${err.message}` }], details: { count: 0 } };
        }
      }
      if (treeSitter) {
        const provider = resolveProvider(filePath, manager, treeSitter);
        if (provider.type === "tree-sitter") {
          try {
            const absPath = manager.resolvePath(filePath);
            const content = await readFile6(absPath, "utf-8");
            const tree = await treeSitter.parse(absPath, content);
            if (tree) {
              const node = getNodeAtPosition(tree, line - 1, character - 1);
              if (node) {
                const symbolName = node.text;
                const rootDir = manager.resolvePath(".");
                const relPath = relative3(rootDir, absPath);
                const localDefs = findDefinition(tree, symbolName, provider.languageId);
                if (localDefs.length > 0) {
                  const locs = localDefs.map((d) => `${relPath}:${d.line}:1`);
                  let text2 = locs.length === 1 ? `Definition [tree-sitter]: ${locs[0]}` : `Definitions [tree-sitter]:
${locs.map((l) => `  ${l}`).join("\n")}`;
                  if (resolvedFrom) text2 = `${resolvedFrom}

${text2}`;
                  return { content: [{ type: "text", text: text2 }], details: { count: locs.length } };
                }
                if (workspaceIndex) {
                  await workspaceIndex.build();
                  const entries = workspaceIndex.search(symbolName);
                  const exact = entries.filter((e) => e.name === symbolName);
                  if (exact.length > 0) {
                    const rootDir2 = manager.resolvePath(".");
                    const locs = exact.slice(0, 10).map((e) => {
                      const rel = relative3(rootDir2, e.file);
                      return `${rel}:${e.line}:1`;
                    });
                    let text2 = locs.length === 1 ? `Definition [tree-sitter]: ${locs[0]}` : `Definitions [tree-sitter]:
${locs.map((l) => `  ${l}`).join("\n")}`;
                    if (resolvedFrom) text2 = `${resolvedFrom}

${text2}`;
                    return { content: [{ type: "text", text: text2 }], details: { count: locs.length } };
                  }
                }
                const msg = `No definition found for "${symbolName}" [tree-sitter]`;
                const text = resolvedFrom ? `${resolvedFrom}

${msg}` : msg;
                return { content: [{ type: "text", text }], details: { count: 0 } };
              }
            }
          } catch {
          }
        }
      }
      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_definition "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      return new Text3(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text3(theme.fg("warning", "Resolving..."), 0, 0);
      const content = result.content[0];
      if (content?.type === "text") return new Text3(theme.fg("dim", content.text), 0, 0);
      return new Text3(theme.fg("dim", "No result"), 0, 0);
    }
  };
}

// src/tools/references.ts
import { Type as Type4 } from "typebox";
import { truncateHead as truncateHead2, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES2, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES2 } from "@earendil-works/pi-coding-agent";
import { Text as Text4 } from "@earendil-works/pi-tui";
var ReferencesParams = Type4.Object({
  path: Type4.String({ description: "File path" }),
  line: Type4.Optional(Type4.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type4.Optional(Type4.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type4.Optional(Type4.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." })),
  includeDeclaration: Type4.Optional(
    Type4.Boolean({ description: "Include the declaration in results (default: true)" })
  )
});
function createReferencesTool(manager, treeSitter) {
  return {
    name: "lsp_references",
    label: "LSP References",
    description: "Find all references to a symbol at a specific position. Returns a list of file locations. Line and character are 1-indexed.",
    promptSnippet: "Find all references to a symbol at a file position via LSP",
    parameters: ReferencesParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `
Available symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { count: 0 } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0 } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
      }
      const uri = manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };
      try {
        const locations = await client.sendRequest("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: params.includeDeclaration ?? true }
        });
        if (!locations || locations.length === 0) {
          const text = resolvedFrom ? `${resolvedFrom}

No references found.` : "No references found.";
          return { content: [{ type: "text", text }], details: { count: 0 } };
        }
        const rootDir = manager.resolvePath(".");
        const formatted = locations.map((l) => formatLocation(l, rootDir));
        const output = formatted.join("\n");
        const truncation = truncateHead2(output, { maxLines: DEFAULT_MAX_LINES2, maxBytes: DEFAULT_MAX_BYTES2 });
        let resultText = `${locations.length} reference(s) found:

${truncation.content}`;
        if (truncation.truncated) {
          resultText += `

[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} references]`;
        }
        if (resolvedFrom) resultText = `${resolvedFrom}

${resultText}`;
        return { content: [{ type: "text", text: resultText }], details: { count: locations.length } };
      } catch (err) {
        return { content: [{ type: "text", text: `LSP references request failed: ${err.message}` }], details: { count: 0 } };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_references "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      return new Text4(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text4(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) return new Text4(theme.fg("dim", "No references found"), 0, 0);
      return new Text4(theme.fg("success", `${details.count} reference(s)`), 0, 0);
    }
  };
}

// src/tools/symbols.ts
import { Type as Type5 } from "typebox";
import { SymbolKind as SymbolKind2 } from "vscode-languageserver-protocol";
import { truncateHead as truncateHead3, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES3, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES3 } from "@earendil-works/pi-coding-agent";
import { Text as Text5 } from "@earendil-works/pi-tui";
import { readFile as readFile7 } from "node:fs/promises";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { relative as relative4 } from "node:path";
var SYMBOL_KIND_NAMES = {
  [SymbolKind2.File]: "file",
  [SymbolKind2.Module]: "module",
  [SymbolKind2.Namespace]: "namespace",
  [SymbolKind2.Package]: "package",
  [SymbolKind2.Class]: "class",
  [SymbolKind2.Method]: "method",
  [SymbolKind2.Property]: "property",
  [SymbolKind2.Field]: "field",
  [SymbolKind2.Constructor]: "constructor",
  [SymbolKind2.Enum]: "enum",
  [SymbolKind2.Interface]: "interface",
  [SymbolKind2.Function]: "function",
  [SymbolKind2.Variable]: "variable",
  [SymbolKind2.Constant]: "constant",
  [SymbolKind2.String]: "string",
  [SymbolKind2.Number]: "number",
  [SymbolKind2.Boolean]: "boolean",
  [SymbolKind2.Array]: "array",
  [SymbolKind2.Object]: "object",
  [SymbolKind2.Key]: "key",
  [SymbolKind2.Null]: "null",
  [SymbolKind2.EnumMember]: "enum-member",
  [SymbolKind2.Struct]: "struct",
  [SymbolKind2.Event]: "event",
  [SymbolKind2.Operator]: "operator",
  [SymbolKind2.TypeParameter]: "type-param"
};
function kindName(kind) {
  return SYMBOL_KIND_NAMES[kind] ?? `kind(${kind})`;
}
function formatDocumentSymbol(sym, indent = 0) {
  const prefix = "  ".repeat(indent);
  const line = sym.range.start.line + 1;
  const result = [`${prefix}${kindName(sym.kind)} ${sym.name} (line ${line})`];
  if (sym.children) {
    for (const child of sym.children) result.push(...formatDocumentSymbol(child, indent + 1));
  }
  return result;
}
function formatSymbolInfo(sym, rootDir) {
  let location = "";
  if ("location" in sym && sym.location) {
    try {
      const absPath = fileURLToPath4(sym.location.uri);
      const relPath = relative4(rootDir, absPath);
      const loc = sym.location;
      const line = loc.range ? loc.range.start.line + 1 : "?";
      location = ` ${relPath}:${line}`;
    } catch {
      location = ` ${sym.location.uri}`;
    }
  }
  return `${kindName(sym.kind)} ${sym.name}${location}`;
}
var SymbolsParams = Type5.Object({
  path: Type5.Optional(Type5.String({ description: "File path for document symbols" })),
  query: Type5.Optional(Type5.String({ description: "Search query for workspace symbols (searches across all files)" }))
});
function formatTreeSitterSymbol(sym, indent = 0) {
  const prefix = "  ".repeat(indent);
  const kindStr = SYMBOL_KIND_NAMES[sym.kind] ?? `kind(${sym.kind})`;
  const result = [`${prefix}${kindStr} ${sym.name} (line ${sym.line})`];
  if (sym.children) {
    for (const child of sym.children) result.push(...formatTreeSitterSymbol(child, indent + 1));
  }
  return result;
}
function createSymbolsTool(manager, treeSitter, workspaceIndex) {
  return {
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: "List symbols in a file (document symbols) or search for symbols across the workspace. Provide 'path' for file symbols or 'query' for workspace search.",
    promptSnippet: "List symbols in a file or search workspace symbols via LSP",
    parameters: SymbolsParams,
    async execute(_toolCallId, params) {
      const filePath = params.path?.replace(/^@/, "");
      const query = params.query;
      if (!filePath && query === void 0) {
        return {
          content: [{ type: "text", text: "Please provide either 'path' for file symbols or 'query' for workspace symbol search." }],
          details: { count: 0 }
        };
      }
      if (filePath) {
        const client = await manager.getClientForFile(filePath).catch(() => null);
        if (client) {
          const uri = manager.getFileUri(filePath);
          try {
            const result = await client.sendRequest(
              "textDocument/documentSymbol",
              { textDocument: { uri } }
            );
            if (!result || result.length === 0) {
              return { content: [{ type: "text", text: "No symbols found in this file." }], details: { count: 0 } };
            }
            let lines;
            if ("range" in result[0]) {
              lines = result.flatMap((s) => formatDocumentSymbol(s));
            } else {
              const rootDir = manager.resolvePath(".");
              lines = result.map((s) => formatSymbolInfo(s, rootDir));
            }
            const output = lines.join("\n");
            const truncation = truncateHead3(output, { maxLines: DEFAULT_MAX_LINES3, maxBytes: DEFAULT_MAX_BYTES3 });
            let text = `${lines.length} symbol(s):

${truncation.content}`;
            if (truncation.truncated) text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
            return { content: [{ type: "text", text }], details: { count: lines.length } };
          } catch (err) {
            return { content: [{ type: "text", text: `LSP document symbols request failed: ${err.message}` }], details: { count: 0 } };
          }
        }
        if (treeSitter) {
          const provider = resolveProvider(filePath, manager, treeSitter);
          if (provider.type === "tree-sitter") {
            try {
              const absPath = manager.resolvePath(filePath);
              const content = await readFile7(absPath, "utf-8");
              const tree = await treeSitter.parse(absPath, content);
              if (tree) {
                const symbols = extractSymbols(tree, provider.languageId);
                if (symbols.length === 0) {
                  return { content: [{ type: "text", text: "No symbols found in this file." }], details: { count: 0 } };
                }
                const lines = symbols.flatMap((s) => formatTreeSitterSymbol(s));
                const output = lines.join("\n");
                const truncation = truncateHead3(output, { maxLines: DEFAULT_MAX_LINES3, maxBytes: DEFAULT_MAX_BYTES3 });
                let text = `${lines.length} symbol(s) [tree-sitter]:

${truncation.content}`;
                if (truncation.truncated) text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
                return { content: [{ type: "text", text }], details: { count: lines.length } };
              }
            } catch {
            }
          }
        }
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
      }
      const statuses = manager.getStatus();
      const runningLang = statuses.find((s) => s.running)?.languageId;
      if (runningLang) {
        const client = await manager.getClientForLanguage(runningLang).catch(() => null);
        if (client) {
          try {
            const result = await client.sendRequest(
              "workspace/symbol",
              { query: query ?? "" }
            );
            if (!result || result.length === 0) {
              return { content: [{ type: "text", text: `No workspace symbols found for query: "${query}"` }], details: { count: 0 } };
            }
            const rootDir = manager.resolvePath(".");
            const lines = result.map((s) => formatSymbolInfo(s, rootDir));
            const output = lines.join("\n");
            const truncation = truncateHead3(output, { maxLines: DEFAULT_MAX_LINES3, maxBytes: DEFAULT_MAX_BYTES3 });
            let text = `${result.length} symbol(s) found:

${truncation.content}`;
            if (truncation.truncated) text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
            return { content: [{ type: "text", text }], details: { count: result.length } };
          } catch (err) {
            return { content: [{ type: "text", text: `LSP workspace symbols request failed: ${err.message}` }], details: { count: 0 } };
          }
        }
      }
      if (workspaceIndex && query) {
        try {
          await workspaceIndex.build();
          const results = workspaceIndex.search(query);
          if (results.length === 0) {
            return { content: [{ type: "text", text: `No workspace symbols found for query: "${query}" [tree-sitter]` }], details: { count: 0 } };
          }
          const rootDir = manager.resolvePath(".");
          const lines = results.map((e) => {
            const relPath = relative4(rootDir, e.file);
            return `${kindName(e.kind)} ${e.name} ${relPath}:${e.line}`;
          });
          const output = lines.join("\n");
          const truncation = truncateHead3(output, { maxLines: DEFAULT_MAX_LINES3, maxBytes: DEFAULT_MAX_BYTES3 });
          let text = `${results.length} symbol(s) found [tree-sitter]:

${truncation.content}`;
          if (truncation.truncated) text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
          return { content: [{ type: "text", text }], details: { count: results.length } };
        } catch {
        }
      }
      return {
        content: [{ type: "text", text: "No LSP servers are currently running and no workspace index is available. Use lsp_diagnostics or lsp_hover on a file first to start a server." }],
        details: { count: 0 }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_symbols "));
      if (args.path) text += theme.fg("accent", args.path);
      if (args.query) text += theme.fg("accent", `query="${args.query}"`);
      return new Text5(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text5(theme.fg("warning", "Loading symbols..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) return new Text5(theme.fg("dim", "No symbols"), 0, 0);
      return new Text5(theme.fg("success", `${details.count} symbol(s)`), 0, 0);
    }
  };
}

// src/tools/rename.ts
import { Type as Type6 } from "typebox";
import { truncateHead as truncateHead4, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES4, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES4 } from "@earendil-works/pi-coding-agent";
import { Text as Text6 } from "@earendil-works/pi-tui";
import { fileURLToPath as fileURLToPath5 } from "node:url";
import { relative as relative5 } from "node:path";
function formatWorkspaceEdit(edit, rootDir) {
  const lines = [];
  let totalEdits = 0;
  let fileCount = 0;
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        fileCount++;
        let relPath;
        try {
          relPath = relative5(rootDir, fileURLToPath5(change.textDocument.uri));
        } catch {
          relPath = change.textDocument.uri;
        }
        lines.push(`${relPath}:`);
        for (const textEdit of change.edits) {
          const line = textEdit.range.start.line + 1;
          const col = textEdit.range.start.character + 1;
          lines.push(`  ${line}:${col} \u2192 "${textEdit.newText}"`);
          totalEdits++;
        }
      }
    }
  }
  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    fileCount++;
    let relPath;
    try {
      relPath = relative5(rootDir, fileURLToPath5(uri));
    } catch {
      relPath = uri;
    }
    lines.push(`${relPath}:`);
    for (const textEdit of edits) {
      const line = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      lines.push(`  ${line}:${col} \u2192 "${textEdit.newText}"`);
      totalEdits++;
    }
  }
  return { summary: lines.join("\n"), fileCount, editCount: totalEdits };
}
var RenameParams = Type6.Object({
  path: Type6.String({ description: "File path" }),
  line: Type6.Optional(Type6.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type6.Optional(Type6.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type6.Optional(Type6.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." })),
  newName: Type6.String({ description: "New name for the symbol" })
});
function createRenameTool(manager, treeSitter) {
  return {
    name: "lsp_rename",
    label: "LSP Rename",
    description: "Preview a rename refactoring for a symbol at a position. Returns the list of changes that would be made across all files. Does NOT apply the changes \u2014 use edit/write tools to apply them. Line and character are 1-indexed.",
    promptSnippet: "Preview rename refactoring for a symbol (returns planned edits, does not apply them)",
    parameters: RenameParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `
Available symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { fileCount: 0, editCount: 0 } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { fileCount: 0, editCount: 0 } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { fileCount: 0, editCount: 0 } };
      }
      const uri = manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };
      try {
        const result = await client.sendRequest("textDocument/rename", {
          textDocument: { uri },
          position,
          newName: params.newName
        });
        if (!result) {
          const text2 = resolvedFrom ? `${resolvedFrom}

Rename not possible at this position.` : "Rename not possible at this position.";
          return { content: [{ type: "text", text: text2 }], details: { fileCount: 0, editCount: 0 } };
        }
        const rootDir = manager.resolvePath(".");
        const { summary, fileCount, editCount } = formatWorkspaceEdit(result, rootDir);
        if (editCount === 0) {
          const text2 = resolvedFrom ? `${resolvedFrom}

No edits needed for this rename.` : "No edits needed for this rename.";
          return { content: [{ type: "text", text: text2 }], details: { fileCount: 0, editCount: 0 } };
        }
        const truncation = truncateHead4(summary, { maxLines: DEFAULT_MAX_LINES4, maxBytes: DEFAULT_MAX_BYTES4 });
        let text = "";
        if (resolvedFrom) text += `${resolvedFrom}

`;
        text += `Rename "${params.newName}": ${editCount} edit(s) across ${fileCount} file(s)

`;
        text += "NOTE: These changes are NOT applied. Use edit/write tools to make the changes.\n\n";
        text += truncation.content;
        if (truncation.truncated) text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
        return { content: [{ type: "text", text }], details: { fileCount, editCount } };
      } catch (err) {
        return { content: [{ type: "text", text: `LSP rename request failed: ${err.message}` }], details: { fileCount: 0, editCount: 0 } };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_rename "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}" \u2192 ${args.newName}`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
        text += theme.fg("muted", ` \u2192 ${args.newName}`);
      }
      return new Text6(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text6(theme.fg("warning", "Computing..."), 0, 0);
      const details = result.details;
      if (!details || details.editCount === 0) return new Text6(theme.fg("dim", "No edits"), 0, 0);
      return new Text6(theme.fg("success", `${details.editCount} edit(s) in ${details.fileCount} file(s) (preview only)`), 0, 0);
    }
  };
}

// src/tools/code-overview.ts
import { Type as Type7 } from "typebox";
import { truncateHead as truncateHead5, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES5, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES5 } from "@earendil-works/pi-coding-agent";
import { Text as Text7 } from "@earendil-works/pi-tui";
import { resolve as resolve4, relative as relative6 } from "node:path";
import { readdir as readdir2, readFile as readFile8 } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
var MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Gemfile",
  "Makefile",
  "CMakeLists.txt"
];
var ENTRY_PATTERNS = [
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "app.ts",
  "app.js",
  "main.py",
  "app.py",
  "__init__.py",
  "main.rs",
  "lib.rs",
  "main.go",
  "Main.java",
  "Application.java"
];
var MAX_TREE_DEPTH = 3;
var MAX_TREE_ENTRIES = 200;
var OverviewParams = Type7.Object({
  path: Type7.Optional(Type7.String({ description: "Root directory to analyze (defaults to project root)" })),
  depth: Type7.Optional(Type7.Number({ description: "Maximum directory depth (default: 3)" }))
});
function createCodeOverviewTool(rootDirOrGetter, treeSitter, workspaceIndex) {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;
  return {
    name: "code_overview",
    label: "Code Overview",
    description: "Summarize project structure: directory tree, top-level symbols per key file, dependency manifests. Uses tree-sitter for symbol extraction \u2014 no LSP required.",
    promptSnippet: "Get a structural overview of the project (directories, key files, symbols)",
    parameters: OverviewParams,
    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const targetDir = resolve4(rootDir, params.path ?? ".");
      const maxDepth = params.depth ?? MAX_TREE_DEPTH;
      const sections = [];
      let totalFiles = 0;
      let totalSymbols = 0;
      const treeLines = [];
      await buildTree(targetDir, "", 0, maxDepth, treeLines);
      totalFiles = treeLines.filter((l) => !l.endsWith("/")).length;
      sections.push("## Directory Structure\n\n```\n" + treeLines.join("\n") + "\n```");
      const manifests = [];
      for (const m of MANIFESTS) {
        const path = resolve4(targetDir, m);
        if (existsSync2(path)) {
          manifests.push(m);
        }
      }
      if (manifests.length > 0) {
        sections.push("## Dependency Manifests\n\n" + manifests.map((m) => `- ${m}`).join("\n"));
      }
      const keyFiles = await findKeyFiles(targetDir);
      if (keyFiles.length > 0) {
        const symbolSections = [];
        for (const file of keyFiles.slice(0, 10)) {
          try {
            const content = await readFile8(file, "utf-8");
            const languageId = treeSitter.getLanguageId(file);
            if (!languageId) continue;
            const tree = await treeSitter.parse(file, content);
            if (!tree) continue;
            const symbols = extractSymbols(tree, languageId);
            if (symbols.length === 0) continue;
            const relPath = relative6(targetDir, file);
            const symbolLines = symbols.slice(0, 20).map((s) => {
              const kindNames = {
                5: "class",
                6: "method",
                10: "enum",
                11: "interface",
                12: "function",
                13: "variable",
                14: "constant",
                22: "struct"
              };
              const kind = kindNames[s.kind] ?? "symbol";
              return `  ${kind} ${s.name} (line ${s.line})`;
            });
            if (symbols.length > 20) {
              symbolLines.push(`  ... and ${symbols.length - 20} more`);
            }
            totalSymbols += symbols.length;
            symbolSections.push(`### ${relPath}
${symbolLines.join("\n")}`);
          } catch {
          }
        }
        if (symbolSections.length > 0) {
          sections.push("## Key Files\n\n" + symbolSections.join("\n\n"));
        }
      }
      if (workspaceIndex.isBuilt) {
        const stats = workspaceIndex.getStats();
        sections.push(`## Index Stats

- ${stats.files} indexed files
- ${stats.symbols} symbols`);
      }
      const output = sections.join("\n\n");
      const truncation = truncateHead5(output, { maxLines: DEFAULT_MAX_LINES5, maxBytes: DEFAULT_MAX_BYTES5 });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }
      return {
        content: [{ type: "text", text }],
        details: { files: totalFiles, symbols: totalSymbols }
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("code_overview "));
      if (args.path) text += theme.fg("accent", args.path);
      else text += theme.fg("dim", "(project root)");
      return new Text7(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text7(theme.fg("warning", "Analyzing..."), 0, 0);
      const d = result.details;
      if (!d) return new Text7(theme.fg("dim", "No overview"), 0, 0);
      return new Text7(theme.fg("success", `${d.files} files, ${d.symbols} symbols`), 0, 0);
    }
  };
}
async function buildTree(dir, prefix, depth, maxDepth, lines) {
  if (depth > maxDepth || lines.length > MAX_TREE_ENTRIES) return;
  try {
    const entries = await readdir2(dir, { withFileTypes: true });
    const sorted = entries.filter((e) => !e.name.startsWith(".") || e.name === ".github").sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < sorted.length; i++) {
      if (lines.length > MAX_TREE_ENTRIES) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }
      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const childPrefix = isLast ? "    " : "\u2502   ";
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          lines.push(`${prefix}${connector}${entry.name}/ (skipped)`);
          continue;
        }
        lines.push(`${prefix}${connector}${entry.name}/`);
        await buildTree(
          resolve4(dir, entry.name),
          prefix + childPrefix,
          depth + 1,
          maxDepth,
          lines
        );
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch {
  }
}
async function findKeyFiles(dir) {
  const found = [];
  const searchDirs = [dir, resolve4(dir, "src"), resolve4(dir, "lib"), resolve4(dir, "app")];
  for (const searchDir of searchDirs) {
    for (const pattern of ENTRY_PATTERNS) {
      const fullPath = resolve4(searchDir, pattern);
      if (existsSync2(fullPath)) {
        found.push(fullPath);
      }
    }
  }
  return [...new Set(found)];
}

// src/tools/completions.ts
import { Type as Type8 } from "typebox";
import { Text as Text8 } from "@earendil-works/pi-tui";
import { readFile as readFile9 } from "node:fs/promises";
var KIND_LABELS = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  11: "unit",
  12: "value",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  20: "enum member",
  21: "constant",
  22: "struct",
  23: "event",
  24: "operator",
  25: "type param"
};
function kindLabel(kind) {
  if (!kind) return "unknown";
  return KIND_LABELS[kind] ?? "unknown";
}
function docSummary(doc) {
  if (!doc) return void 0;
  const text = typeof doc === "string" ? doc : doc.value;
  if (!text) return void 0;
  const lines = text.replace(/```[\s\S]*?```/g, "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const summary = lines.slice(0, 2).join(" ");
  return summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
}
function formatItem(item) {
  const kind = kindLabel(item.kind);
  const label = item.label;
  const detail = item.detail ? ` ${item.detail}` : "";
  const labelDetail = item.labelDetails?.detail ? item.labelDetails.detail : "";
  const labelDesc = item.labelDetails?.description ? ` \u2014 ${item.labelDetails.description}` : "";
  let line = `${kind.padEnd(12)} ${label}${labelDetail}${detail}${labelDesc}`;
  const doc = docSummary(item.documentation);
  if (doc) {
    line += `
${"".padEnd(13)}${doc}`;
  }
  return line;
}
var CompletionParams = Type8.Object({
  path: Type8.String({ description: "File path" }),
  line: Type8.Optional(Type8.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type8.Optional(Type8.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type8.Optional(Type8.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." })),
  limit: Type8.Optional(
    Type8.Number({ description: "Max results to return (default: 20)" })
  ),
  trigger: Type8.Optional(
    Type8.Union([Type8.Literal("auto"), Type8.Literal("none")], {
      description: 'Synthetic trigger mode (default: "auto"). When "auto", if the position is at the end of an identifier (no trailing dot), a dot is temporarily inserted to trigger member completions. Use "none" to skip this.'
    })
  )
});
function shouldSyntheticTrigger(content, line, character) {
  const lines = content.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const lineText = lines[line];
  if (character < 0 || character > lineText.length) return null;
  if (lineText[character] === ".") return null;
  const charBefore = character > 0 ? lineText[character - 1] : "";
  if (!charBefore) return null;
  if (/[\w\d_\)\]]/.test(charBefore)) {
    return { insertLine: line, insertChar: character };
  }
  return null;
}
function insertDot(content, line, character) {
  const lines = content.split("\n");
  const lineText = lines[line];
  lines[line] = lineText.slice(0, character) + "." + lineText.slice(character);
  return lines.join("\n");
}
var syntheticDotLocks = /* @__PURE__ */ new Set();
function createCompletionsTool(manager, versionTracker, treeSitter) {
  return {
    name: "lsp_completions",
    label: "LSP Completions",
    description: 'Get completion suggestions at a specific position in a file. Returns methods, properties, and other symbols available at that point. Useful for discovering APIs and verifying method names. Line and character are 1-indexed. When trigger is "auto" (default), a dot is temporarily inserted if the position is at the end of an identifier, enabling member completion without editing the file.',
    promptSnippet: "Get code completion suggestions at a file position via LSP. Use to discover available methods, properties, and APIs on objects. Supports automatic dot insertion for exploring members on identifiers.",
    parameters: CompletionParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const limit = params.limit ?? 20;
      const trigger = params.trigger ?? "auto";
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line + 1;
          character = resolved.character + 1;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}` }], details: { count: 0, total: 0 } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0, total: 0 } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return {
          content: [
            { type: "text", text: manager.getUnavailableReason(filePath) }
          ],
          details: { count: 0, total: 0 }
        };
      }
      const caps = client.serverCapabilities;
      if (caps && !caps.completionProvider) {
        return {
          content: [
            {
              type: "text",
              text: `LSP server for this file does not support completions.`
            }
          ],
          details: { count: 0, total: 0 }
        };
      }
      const uri = manager.getFileUri(filePath);
      const position = {
        line: line - 1,
        character: character - 1
      };
      try {
        let syntheticDot = false;
        let originalContent = null;
        let revertVersion = 99991;
        let completionPosition = position;
        if (trigger === "auto") {
          if (syntheticDotLocks.has(uri)) {
          } else {
            try {
              syntheticDotLocks.add(uri);
              const absPath = manager.resolvePath(filePath);
              const fileContent = await readFile9(absPath, "utf-8");
              const triggerPos = shouldSyntheticTrigger(fileContent, position.line, position.character);
              if (triggerPos) {
                originalContent = fileContent;
                const modifiedContent = insertDot(fileContent, triggerPos.insertLine, triggerPos.insertChar);
                const currentVersion = versionTracker?.getTrackedVersion(uri);
                const insertVersion = currentVersion != null ? currentVersion + 1 : 99990;
                revertVersion = currentVersion != null ? currentVersion + 2 : 99991;
                client.didChange(uri, insertVersion, modifiedContent);
                if (versionTracker && currentVersion != null) {
                  versionTracker.setTrackedVersion(uri, insertVersion);
                }
                completionPosition = {
                  line: triggerPos.insertLine,
                  character: triggerPos.insertChar + 1
                };
                syntheticDot = true;
                await new Promise((r) => setTimeout(r, SYNTHETIC_DOT_SETTLE_DELAY_MS));
              }
            } catch {
            } finally {
              syntheticDotLocks.delete(uri);
            }
          }
        }
        let response;
        try {
          response = await client.sendRequest(
            "textDocument/completion",
            { textDocument: { uri }, position: completionPosition }
          );
        } finally {
          if (syntheticDot && originalContent !== null) {
            try {
              client.didChange(uri, revertVersion, originalContent);
              if (versionTracker) {
                versionTracker.setTrackedVersion(uri, revertVersion);
              }
            } catch {
            }
          }
        }
        if (!response) {
          return {
            content: [
              { type: "text", text: "No completions available at this position." }
            ],
            details: { count: 0, total: 0 }
          };
        }
        const allItems = Array.isArray(response) ? response : response.items;
        if (allItems.length === 0) {
          return {
            content: [
              { type: "text", text: "No completions available at this position." }
            ],
            details: { count: 0, total: 0 }
          };
        }
        const total = allItems.length;
        const sorted = [...allItems].sort((a, b) => {
          const sa = a.sortText ?? a.label;
          const sb = b.sortText ?? b.label;
          return sa.localeCompare(sb);
        });
        const topItems = sorted.slice(0, limit);
        const resolveSupported = caps?.completionProvider?.resolveProvider;
        let resolvedItems;
        if (resolveSupported) {
          const resolveResults = await Promise.allSettled(
            topItems.map(
              (item) => Promise.race([
                client.sendRequest(
                  "completionItem/resolve",
                  item
                ),
                // Timeout per item: 2 seconds
                new Promise(
                  (_, reject) => setTimeout(() => reject(new Error("resolve timeout")), 2e3)
                )
              ])
            )
          );
          resolvedItems = resolveResults.map(
            (result, i) => result.status === "fulfilled" ? result.value : topItems[i]
          );
        } else {
          resolvedItems = topItems;
        }
        const triggerNote = syntheticDot ? " (synthetic dot trigger)" : "";
        let header = `${resolvedItems.length} of ${total} completions at ${filePath}:${line}:${character}${triggerNote}
`;
        if (resolvedFrom) header = `${resolvedFrom}

${header}`;
        const lines = resolvedItems.map(formatItem);
        const text = header + lines.join("\n");
        return {
          content: [{ type: "text", text }],
          details: { count: resolvedItems.length, total }
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `LSP completion request failed: ${err.message}`
            }
          ],
          details: { count: 0, total: 0 }
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_completions "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      const extras = [];
      if (args.limit) extras.push(`limit: ${args.limit}`);
      if (args.trigger === "none") extras.push("trigger: none");
      if (extras.length > 0) {
        text += theme.fg("dim", ` (${extras.join(", ")})`);
      }
      return new Text8(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial)
        return new Text8(theme.fg("warning", "Loading completions..."), 0, 0);
      if (!result.details || result.details.count === 0) {
        const content = result.content[0];
        if (content?.type === "text")
          return new Text8(theme.fg("dim", content.text), 0, 0);
        return new Text8(theme.fg("dim", "No completions"), 0, 0);
      }
      const { count, total } = result.details;
      const summary = `${count} of ${total} completions`;
      return new Text8(theme.fg("dim", summary), 0, 0);
    }
  };
}

// src/tools/code-search.ts
import { Type as Type9 } from "typebox";
import { truncateHead as truncateHead6, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES6, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES6 } from "@earendil-works/pi-coding-agent";
import { relative as relative7 } from "node:path";

// src/tree-sitter/pattern-compiler.ts
var VARIADIC_RE = /^\$\$\$([A-Z_][A-Z0-9_]*)?$/;
var METAVAR_RE = /^\$([A-Z_][A-Z0-9_]*)$/;
function isVariadic(text) {
  const m = VARIADIC_RE.exec(text);
  return m ? m[1] ?? "" : null;
}
function isMetavar(text) {
  const m = METAVAR_RE.exec(text);
  return m ? m[1] : null;
}
var META_PREFIX = "__META_";
var VMETA_PREFIX = "__VMETA_";
var META_SUFFIX = "__";
function preprocessMetavars(source) {
  const placeholders = /* @__PURE__ */ new Map();
  let preprocessed = source.replace(/\$\$\$([A-Z_][A-Z0-9_]*)?/g, (_match, name) => {
    const n = name ?? "";
    const placeholder = `${VMETA_PREFIX}${n || "ANON"}${META_SUFFIX}`;
    placeholders.set(placeholder, { kind: "variadic", name: n });
    return placeholder;
  });
  preprocessed = preprocessed.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, name) => {
    const placeholder = `${META_PREFIX}${name}${META_SUFFIX}`;
    placeholders.set(placeholder, { kind: "metavar", name });
    return placeholder;
  });
  return { preprocessed, placeholders };
}
function decodePlaceholder(text, placeholders) {
  return placeholders.get(text) ?? null;
}
async function compilePattern(source, languageId, treeSitter) {
  await treeSitter.init();
  const { preprocessed, placeholders } = preprocessMetavars(source);
  const wrappers = getWrappersForLanguage(languageId);
  for (const { wrap, unwrap } of wrappers) {
    const wrapped = wrap(preprocessed);
    const tree = await treeSitter.parseWithLanguage(
      `__pattern__${Date.now()}`,
      wrapped,
      languageId
    );
    if (!tree) continue;
    const root = tree.rootNode;
    if (hasErrors(root)) continue;
    const unwrapped = unwrap(root);
    if (!unwrapped) continue;
    const metavars = [];
    const patternNode = buildPatternNode(unwrapped, metavars, void 0, placeholders);
    return { root: patternNode, metavars: [...new Set(metavars)], languageId };
  }
  throw new Error(
    `Failed to parse pattern as ${languageId}. The pattern may have syntax errors or may not be a valid code fragment in this language.`
  );
}
function getWrappersForLanguage(languageId) {
  const common = [
    { wrap: (s) => s, unwrap: unwrapProgram },
    { wrap: (s) => `${s};`, unwrap: unwrapProgram },
    { wrap: (s) => `(${s})`, unwrap: unwrapExpression }
  ];
  switch (languageId) {
    case "python":
      return [
        { wrap: (s) => s, unwrap: unwrapModule },
        { wrap: (s) => `(${s})`, unwrap: unwrapExpression },
        { wrap: (s) => `def _():
  ${s}`, unwrap: unwrapPythonFunctionBody }
      ];
    default:
      return [
        ...common,
        { wrap: (s) => `function _() { ${s} }`, unwrap: unwrapFunctionBody }
      ];
  }
}
function buildPatternNode(node, metavars, fieldName, placeholders) {
  const text = node.text;
  if (node.namedChildCount === 0) {
    const decoded = decodePlaceholder(text, placeholders);
    if (decoded) {
      if (decoded.name) metavars.push(decoded.name);
      if (decoded.kind === "variadic") {
        return { kind: "variadic", name: decoded.name, fieldName };
      }
      return { kind: "metavar", name: decoded.name, fieldName };
    }
  }
  if (node.namedChildCount === 0) {
    const variadicName = isVariadic(text);
    if (variadicName !== null) {
      if (variadicName) metavars.push(variadicName);
      return { kind: "variadic", name: variadicName, fieldName };
    }
    const metavarName = isMetavar(text);
    if (metavarName !== null) {
      metavars.push(metavarName);
      return { kind: "metavar", name: metavarName, fieldName };
    }
  }
  if (node.namedChildCount === 1) {
    const onlyChild = node.namedChildren[0];
    if (onlyChild.namedChildCount === 0) {
      const decoded = decodePlaceholder(onlyChild.text, placeholders);
      if (decoded) {
        if (decoded.name) metavars.push(decoded.name);
        if (decoded.kind === "variadic") {
          return { kind: "variadic", name: decoded.name, fieldName };
        }
        return { kind: "metavar", name: decoded.name, fieldName };
      }
      const childMeta = isMetavar(onlyChild.text);
      if (childMeta !== null) {
        metavars.push(childMeta);
        return { kind: "metavar", name: childMeta, fieldName };
      }
      const childVariadic = isVariadic(onlyChild.text);
      if (childVariadic !== null) {
        if (childVariadic) metavars.push(childVariadic);
        return { kind: "variadic", name: childVariadic, fieldName };
      }
    }
  }
  if (node.namedChildCount === 0) {
    return { kind: "literal", nodeType: node.type, text, children: [], fieldName };
  }
  const children = [];
  for (const child of node.namedChildren) {
    const childFieldName = getFieldName(node, child);
    children.push(buildPatternNode(child, metavars, childFieldName, placeholders));
  }
  return { kind: "literal", nodeType: node.type, children, fieldName };
}
function getFieldName(parent, child) {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.id === child.id) {
      return parent.fieldNameForChild(i) ?? void 0;
    }
  }
  return void 0;
}
function unwrapProgram(root) {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  const child = root.namedChildren[0];
  if (child.type === "expression_statement" && child.namedChildCount === 1) {
    return child.namedChildren[0];
  }
  return child;
}
function unwrapModule(root) {
  if (root.type !== "module" || root.namedChildCount === 0) return null;
  const child = root.namedChildren[0];
  if (child.type === "expression_statement" && child.namedChildCount === 1) {
    return child.namedChildren[0];
  }
  return child;
}
function unwrapExpression(root) {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  let node = root.namedChildren[0];
  if (node.type === "expression_statement") node = node.namedChildren[0];
  if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
    return node.namedChildren[0];
  }
  return node;
}
function unwrapFunctionBody(root) {
  if (root.type !== "program" || root.namedChildCount === 0) return null;
  const fn = root.namedChildren[0];
  if (!fn.type.includes("function")) return null;
  const body = fn.childForFieldName("body");
  if (!body || body.namedChildCount === 0) return null;
  const stmt = body.namedChildren[0];
  if (stmt.type === "expression_statement" && stmt.namedChildCount === 1) {
    return stmt.namedChildren[0];
  }
  return stmt;
}
function unwrapPythonFunctionBody(root) {
  if (root.type !== "module" || root.namedChildCount === 0) return null;
  const fn = root.namedChildren[0];
  if (fn.type !== "function_definition") return null;
  const body = fn.childForFieldName("body");
  if (!body || body.namedChildCount === 0) return null;
  const stmt = body.namedChildren[0];
  if (stmt.type === "expression_statement" && stmt.namedChildCount === 1) {
    return stmt.namedChildren[0];
  }
  return stmt;
}
function hasErrors(node) {
  if (node.type === "ERROR" || node.isMissing) return true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && hasErrors(child)) return true;
  }
  return false;
}

// src/tree-sitter/search-engine.ts
import { resolve as resolve5 } from "node:path";
import { readdir as readdir3, readFile as readFile10, stat as stat2 } from "node:fs/promises";
async function searchFiles(pattern, rootDir, treeSitter, options = {}) {
  const searchRoot = options.path ? resolve5(rootDir, options.path) : rootDir;
  const maxResults = options.maxResults ?? 50;
  const stats = await stat2(searchRoot);
  let files;
  if (stats.isFile()) {
    files = [searchRoot];
  } else {
    files = await collectFilesByLanguage(searchRoot, pattern.languageId, treeSitter);
  }
  const matches = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    try {
      const content = await readFile10(file, "utf-8");
      const tree = await treeSitter.parseWithLanguage(file, content, pattern.languageId);
      if (!tree) continue;
      const fileMatches = findMatches(tree.rootNode, pattern.root);
      for (const m of fileMatches) {
        if (matches.length >= maxResults) break;
        matches.push({
          file,
          line: m.node.startPosition.row + 1,
          column: m.node.startPosition.column + 1,
          matchedText: m.node.text,
          startIndex: m.node.startIndex,
          endIndex: m.node.endIndex,
          captures: m.captures
        });
      }
    } catch {
    }
  }
  return matches;
}
async function collectFilesByLanguage(dir, languageId, treeSitter, collected = [], maxFiles = MAX_INDEX_FILES) {
  if (collected.length >= maxFiles) return collected;
  try {
    const entries = await readdir3(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await collectFilesByLanguage(resolve5(dir, entry.name), languageId, treeSitter, collected, maxFiles);
      } else if (entry.isFile()) {
        const fileLang = treeSitter.getLanguageId(entry.name);
        if (fileLang === languageId) {
          const filePath = resolve5(dir, entry.name);
          try {
            const s = await stat2(filePath);
            if (s.size <= MAX_FILE_SIZE) {
              collected.push(filePath);
            }
          } catch {
          }
        }
      }
    }
  } catch {
  }
  return collected;
}
function findMatches(root, pattern) {
  const matches = [];
  const visited = /* @__PURE__ */ new Set();
  function walk(node) {
    if (visited.has(node.id)) return;
    const captures = {};
    if (matchNode(node, pattern, captures)) {
      matches.push({ node, captures });
      markDescendants(node, visited);
      return;
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  }
  walk(root);
  return matches;
}
function markDescendants(node, visited) {
  visited.add(node.id);
  for (const child of node.namedChildren) {
    markDescendants(child, visited);
  }
}
function matchNode(target, pattern, captures) {
  switch (pattern.kind) {
    case "metavar": {
      const name = pattern.name;
      if (name in captures) {
        return captures[name] === target.text;
      }
      captures[name] = target.text;
      return true;
    }
    case "variadic": {
      const name = pattern.name;
      if (name && name in captures) {
        return captures[name] === target.text;
      }
      if (name) captures[name] = target.text;
      return true;
    }
    case "literal": {
      if (target.type !== pattern.nodeType) return false;
      if (pattern.text !== void 0) {
        return target.text === pattern.text;
      }
      return matchChildrenFieldAware(target, pattern.children, captures);
    }
  }
}
function matchChildrenFieldAware(targetNode, patternChildren, captures) {
  const fieldPatterns = [];
  const positionalPatterns = [];
  for (const pc of patternChildren) {
    if (pc.fieldName) {
      fieldPatterns.push(pc);
    } else {
      positionalPatterns.push(pc);
    }
  }
  for (const fp of fieldPatterns) {
    const targetChild = targetNode.childForFieldName(fp.fieldName);
    if (!targetChild) return false;
    if (!matchNode(targetChild, fp, captures)) return false;
  }
  if (positionalPatterns.length > 0) {
    const matchedFieldNames = new Set(fieldPatterns.map((fp) => fp.fieldName));
    const remainingTargets = [];
    for (const child of targetNode.namedChildren) {
      const childField = getChildFieldName(targetNode, child);
      if (!childField || !matchedFieldNames.has(childField)) {
        remainingTargets.push(child);
      }
    }
    return matchChildrenPositional(remainingTargets, 0, positionalPatterns, 0, captures);
  }
  return true;
}
function getChildFieldName(parent, child) {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.id === child.id) {
      return parent.fieldNameForChild(i);
    }
  }
  return null;
}
function matchChildrenPositional(targets, ti, patterns, pi, captures) {
  if (pi >= patterns.length) return true;
  const pat = patterns[pi];
  if (pat.kind === "variadic") {
    const isLast = pi === patterns.length - 1;
    if (isLast) {
      const remainingText = targets.slice(ti).map((t) => t.text).join(", ");
      if (pat.name) {
        if (pat.name in captures && captures[pat.name] !== remainingText) return false;
        captures[pat.name] = remainingText;
      }
      return true;
    }
    for (let take = 0; take <= targets.length - ti; take++) {
      const captureSnapshot2 = { ...captures };
      const consumedText = targets.slice(ti, ti + take).map((t) => t.text).join(", ");
      if (pat.name) {
        if (pat.name in captureSnapshot2 && captureSnapshot2[pat.name] !== consumedText) continue;
        captureSnapshot2[pat.name] = consumedText;
      }
      if (matchChildrenPositional(targets, ti + take, patterns, pi + 1, captureSnapshot2)) {
        Object.assign(captures, captureSnapshot2);
        return true;
      }
    }
    return false;
  }
  if (ti >= targets.length) return false;
  const captureSnapshot = { ...captures };
  if (matchNode(targets[ti], pat, captureSnapshot)) {
    if (matchChildrenPositional(targets, ti + 1, patterns, pi + 1, captureSnapshot)) {
      Object.assign(captures, captureSnapshot);
      return true;
    }
  }
  return false;
}

// src/tools/code-search.ts
var SearchParams = Type9.Object({
  pattern: Type9.String({ description: "Structural pattern with metavariables ($NAME for single node, $$$NAME for variadic)" }),
  language: Type9.String({ description: "Target language (typescript, python, rust, java, etc.)" }),
  path: Type9.Optional(Type9.String({ description: "File or directory to search (default: workspace root)" })),
  max_results: Type9.Optional(Type9.Number({ description: "Maximum results to return (default: 50)" }))
});
function createCodeSearchTool(rootDirOrGetter, treeSitter) {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;
  return {
    name: "ast_search",
    label: "Code Search",
    description: "Find code matching a structural pattern using AST matching. Use $NAME to match any single node, $$$NAME to match zero-or-more nodes. More precise than grep \u2014 matches code structure, not text.",
    parameters: SearchParams,
    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const { pattern: patternStr, language, path, max_results } = params;
      let compiled;
      try {
        compiled = await compilePattern(patternStr, language, treeSitter);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { matchCount: 0, filesSearched: 0 }
        };
      }
      const matches = await searchFiles(compiled, rootDir, treeSitter, {
        path,
        maxResults: max_results ?? 50
      });
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          details: { matchCount: 0, filesSearched: 0 }
        };
      }
      const lines = [];
      lines.push(`Found ${matches.length} match${matches.length !== 1 ? "es" : ""}:
`);
      for (const m of matches) {
        const relPath = relative7(rootDir, m.file);
        const matchText = m.matchedText.length > 200 ? m.matchedText.slice(0, 200) + "..." : m.matchedText;
        lines.push(`${relPath}:${m.line}:${m.column}`);
        lines.push(`  ${matchText.replace(/\n/g, "\n  ")}`);
        const captureEntries = Object.entries(m.captures);
        if (captureEntries.length > 0) {
          for (const [name, value] of captureEntries) {
            const displayValue = value.length > 100 ? value.slice(0, 100) + "..." : value;
            lines.push(`  $${name} = ${displayValue}`);
          }
        }
        lines.push("");
      }
      const text = lines.join("\n");
      const uniqueFiles = new Set(matches.map((m) => m.file));
      const truncation = truncateHead6(text, { maxLines: DEFAULT_MAX_LINES6, maxBytes: DEFAULT_MAX_BYTES6 });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }
      return {
        content: [{ type: "text", text: output }],
        details: { matchCount: matches.length, filesSearched: uniqueFiles.size }
      };
    }
  };
}

// src/tools/code-rewrite.ts
import { Type as Type10 } from "typebox";
import { truncateHead as truncateHead7, DEFAULT_MAX_LINES as DEFAULT_MAX_LINES7, DEFAULT_MAX_BYTES as DEFAULT_MAX_BYTES7 } from "@earendil-works/pi-coding-agent";
import { relative as relative8 } from "node:path";

// src/tree-sitter/rewrite-engine.ts
import { readFile as readFile11, writeFile } from "node:fs/promises";
var METAVAR_REF_RE = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;
function substituteCaptures(template, captures) {
  return template.replace(METAVAR_REF_RE, (match, variadicName, singleName) => {
    const name = variadicName ?? singleName;
    if (name in captures) return captures[name];
    return match;
  });
}
function preserveTrailingSemicolon(original, replacement) {
  const trailingMatch = original.match(/(\s*;)\s*$/);
  if (trailingMatch && !replacement.trimEnd().endsWith(";")) {
    return replacement + trailingMatch[1];
  }
  return replacement;
}
function computeRewrites(matches, replacementTemplate) {
  return matches.map((m) => {
    const raw = substituteCaptures(replacementTemplate, m.captures);
    const after = preserveTrailingSemicolon(m.matchedText, raw);
    return {
      file: m.file,
      line: m.line,
      column: m.column,
      before: m.matchedText,
      after
    };
  });
}
async function applyRewrites(matches, replacementTemplate) {
  const byFile = /* @__PURE__ */ new Map();
  for (const m of matches) {
    const existing = byFile.get(m.file);
    if (existing) {
      existing.push(m);
    } else {
      byFile.set(m.file, [m]);
    }
  }
  const changes = [];
  let filesModified = 0;
  for (const [file, fileMatches] of byFile) {
    const sorted = [...fileMatches].sort((a, b) => b.startIndex - a.startIndex);
    let content = await readFile11(file, "utf-8");
    let modified = false;
    for (const m of sorted) {
      const raw = substituteCaptures(replacementTemplate, m.captures);
      const replacement = preserveTrailingSemicolon(m.matchedText, raw);
      if (replacement !== m.matchedText) {
        content = content.slice(0, m.startIndex) + replacement + content.slice(m.endIndex);
        modified = true;
      }
      changes.push({
        file,
        line: m.line,
        column: m.column,
        before: m.matchedText,
        after: replacement
      });
    }
    if (modified) {
      await writeFile(file, content, "utf-8");
      filesModified++;
    }
  }
  changes.reverse();
  return { changes, filesModified };
}

// src/tools/code-rewrite.ts
var RewriteParams = Type10.Object({
  pattern: Type10.String({ description: "Structural pattern to match (with $NAME / $$$NAME metavariables)" }),
  replacement: Type10.String({ description: "Replacement template using the same metavariables" }),
  language: Type10.String({ description: "Target language (typescript, python, rust, java, etc.)" }),
  path: Type10.Optional(Type10.String({ description: "File or directory scope (default: workspace root)" })),
  dry_run: Type10.Optional(Type10.Boolean({ description: "Preview changes without applying (default: true)" }))
});
function createCodeRewriteTool(rootDirOrGetter, treeSitter, fileChangeCallback) {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;
  return {
    name: "code_rewrite",
    label: "Code Rewrite",
    description: "Transform code matching a structural pattern into a replacement. Use $NAME to capture and reuse single nodes, $$$NAME for sequences. Defaults to dry-run mode (preview only). Set dry_run=false to apply changes. For symbol renames, prefer lsp_rename instead (semantically correct).",
    parameters: RewriteParams,
    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const { pattern: patternStr, replacement, language, path, dry_run } = params;
      const isDryRun = dry_run !== false;
      let compiled;
      try {
        compiled = await compilePattern(patternStr, language, treeSitter);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { matchCount: 0, filesModified: 0, dryRun: isDryRun }
        };
      }
      const knownVars = new Set(compiled.metavars);
      const refRe = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;
      let refMatch;
      while ((refMatch = refRe.exec(replacement)) !== null) {
        const name = refMatch[1] ?? refMatch[2];
        if (!knownVars.has(name)) {
          return {
            content: [{ type: "text", text: `Error: Replacement references $${name} but pattern doesn't capture it. Pattern captures: ${compiled.metavars.join(", ") || "(none)"}` }],
            details: { matchCount: 0, filesModified: 0, dryRun: isDryRun }
          };
        }
      }
      const matches = await searchFiles(compiled, rootDir, treeSitter, {
        path,
        maxResults: 500
      });
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found. No changes to make." }],
          details: { matchCount: 0, filesModified: 0, dryRun: isDryRun }
        };
      }
      if (isDryRun) {
        const changes = computeRewrites(matches, replacement);
        const lines2 = [];
        lines2.push(`Dry run: ${changes.length} change${changes.length !== 1 ? "s" : ""} would be made:
`);
        for (const c of changes) {
          const relPath = relative8(rootDir, c.file);
          lines2.push(`${relPath}:${c.line}:${c.column}`);
          const beforeLines = c.before.split("\n");
          const afterLines = c.after.split("\n");
          for (const l of beforeLines) {
            lines2.push(`  - ${l}`);
          }
          for (const l of afterLines) {
            lines2.push(`  + ${l}`);
          }
          lines2.push("");
        }
        lines2.push("Run with dry_run=false to apply these changes.");
        const text2 = lines2.join("\n");
        const truncation2 = truncateHead7(text2, { maxLines: DEFAULT_MAX_LINES7, maxBytes: DEFAULT_MAX_BYTES7 });
        let output2 = truncation2.content;
        if (truncation2.truncated) {
          output2 += `

[Truncated: showing ${truncation2.outputLines} of ${truncation2.totalLines} lines]`;
        }
        const uniqueFiles = new Set(changes.map((c) => c.file));
        return {
          content: [{ type: "text", text: output2 }],
          details: { matchCount: matches.length, filesModified: uniqueFiles.size, dryRun: true }
        };
      }
      const result = await applyRewrites(matches, replacement);
      if (fileChangeCallback && result.filesModified > 0) {
        const modifiedFiles = new Set(result.changes.map((c) => c.file));
        for (const file of modifiedFiles) {
          fileChangeCallback.onFileModified(file);
        }
      }
      const lines = [];
      lines.push(`Applied ${result.changes.length} change${result.changes.length !== 1 ? "s" : ""} across ${result.filesModified} file${result.filesModified !== 1 ? "s" : ""}:
`);
      for (const c of result.changes) {
        const relPath = relative8(rootDir, c.file);
        const beforeShort = c.before.length > 80 ? c.before.slice(0, 80) + "..." : c.before;
        const afterShort = c.after.length > 80 ? c.after.slice(0, 80) + "..." : c.after;
        lines.push(`${relPath}:${c.line} \u2014 ${beforeShort} \u2192 ${afterShort}`);
      }
      const text = lines.join("\n");
      const truncation = truncateHead7(text, { maxLines: DEFAULT_MAX_LINES7, maxBytes: DEFAULT_MAX_BYTES7 });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `

[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }
      return {
        content: [{ type: "text", text: output }],
        details: { matchCount: matches.length, filesModified: result.filesModified, dryRun: false }
      };
    }
  };
}

// src/tools/code-actions.ts
import { Type as Type11 } from "typebox";
import { Text as Text9 } from "@earendil-works/pi-tui";
import { fileURLToPath as fileURLToPath6 } from "node:url";
import { relative as relative9 } from "node:path";
var CodeActionsParams = Type11.Object({
  path: Type11.String({ description: "File path" }),
  line: Type11.Optional(Type11.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type11.Optional(Type11.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type11.Optional(Type11.String({ description: "Symbol name to find in the file. Alternative to line/character \u2014 resolves the symbol's position automatically." })),
  endLine: Type11.Optional(Type11.Number({ description: "End line for range selection (1-indexed). Defaults to line." })),
  endCharacter: Type11.Optional(Type11.Number({ description: "End column for range selection (1-indexed). Defaults to character." })),
  kind: Type11.Optional(Type11.String({ description: 'Filter by action kind (e.g., "quickfix", "refactor", "source")' }))
});
function rangeContainsPosition(range, line, character) {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}
function formatEditSummary(edit, rootDir) {
  const lines = [];
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        let relPath;
        try {
          relPath = relative9(rootDir, fileURLToPath6(change.textDocument.uri));
        } catch {
          relPath = change.textDocument.uri;
        }
        for (const textEdit of change.edits.slice(0, 5)) {
          const ln = textEdit.range.start.line + 1;
          const col = textEdit.range.start.character + 1;
          const endLn = textEdit.range.end.line + 1;
          const endCol = textEdit.range.end.character + 1;
          const newText = textEdit.newText.length > 60 ? textEdit.newText.slice(0, 57) + "..." : textEdit.newText;
          if (textEdit.range.start.line === textEdit.range.end.line && textEdit.range.start.character === textEdit.range.end.character) {
            lines.push(`     ${relPath}:${ln}:${col} insert "${newText.replace(/\n/g, "\\n")}"`);
          } else {
            lines.push(`     ${relPath}:${ln}:${col}-${endLn}:${endCol} \u2192 "${newText.replace(/\n/g, "\\n")}"`);
          }
        }
        const remaining = change.edits.length - 5;
        if (remaining > 0) lines.push(`     ... and ${remaining} more edits in ${relPath}`);
      }
    }
  }
  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    let relPath;
    try {
      relPath = relative9(rootDir, fileURLToPath6(uri));
    } catch {
      relPath = uri;
    }
    for (const textEdit of edits.slice(0, 5)) {
      const ln = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      const endLn = textEdit.range.end.line + 1;
      const endCol = textEdit.range.end.character + 1;
      const newText = textEdit.newText.length > 60 ? textEdit.newText.slice(0, 57) + "..." : textEdit.newText;
      if (textEdit.range.start.line === textEdit.range.end.line && textEdit.range.start.character === textEdit.range.end.character) {
        lines.push(`     ${relPath}:${ln}:${col} insert "${newText.replace(/\n/g, "\\n")}"`);
      } else {
        lines.push(`     ${relPath}:${ln}:${col}-${endLn}:${endCol} \u2192 "${newText.replace(/\n/g, "\\n")}"`);
      }
    }
    const remaining = edits.length - 5;
    if (remaining > 0) lines.push(`     ... and ${remaining} more edits in ${relPath}`);
  }
  return lines;
}
function isCodeAction(item) {
  return "kind" in item || "edit" in item || "diagnostics" in item || "isPreferred" in item;
}
function createCodeActionsTool(manager, treeSitter) {
  return {
    name: "lsp_code_actions",
    label: "LSP Code Actions",
    description: "Get available code actions (quick fixes, refactorings, source actions) at a position or range. Returns actionable fixes the LSP server can suggest \u2014 auto-imports, remove unused, extract method, etc.",
    promptSnippet: "Get available code actions (quick fixes, refactorings) at a file position via LSP. Use after lsp_diagnostics shows errors to find auto-fixes.",
    parameters: CodeActionsParams,
    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom;
      if ((line === void 0 || character === void 0) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" \u2192 ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `
Available symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { count: 0, preferredCount: 0 } };
        }
      }
      if (line === void 0 || character === void 0) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0, preferredCount: 0 } };
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0, preferredCount: 0 } };
      }
      const caps = client.serverCapabilities;
      if (caps && !caps.codeActionProvider) {
        return {
          content: [{ type: "text", text: "LSP server for this file does not support code actions." }],
          details: { count: 0, preferredCount: 0 }
        };
      }
      const uri = manager.getFileUri(filePath);
      const startLine = line - 1;
      const startChar = character - 1;
      const endLine = (params.endLine ?? line) - 1;
      const endChar = (params.endCharacter ?? character) - 1;
      const allDiags = client.getDiagnostics(uri) ?? [];
      const rangeDiags = allDiags.filter(
        (d) => rangeContainsPosition(d.range, startLine, startChar) || rangeContainsPosition({ start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } }, d.range.start.line, d.range.start.character)
      );
      try {
        const response = await client.sendRequest("textDocument/codeAction", {
          textDocument: { uri },
          range: {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar }
          },
          context: {
            diagnostics: rangeDiags,
            only: params.kind ? [params.kind] : void 0
          }
        });
        if (!response || response.length === 0) {
          const text2 = resolvedFrom ? `${resolvedFrom}

No code actions available at this position.` : "No code actions available at this position.";
          return { content: [{ type: "text", text: text2 }], details: { count: 0, preferredCount: 0 } };
        }
        const actions = [];
        const commands = [];
        for (const item of response) {
          if (isCodeAction(item)) {
            actions.push(item);
          } else {
            commands.push(item);
          }
        }
        const kindOrder = { quickfix: 0, refactor: 1, source: 2 };
        actions.sort((a, b) => {
          if (a.isPreferred && !b.isPreferred) return -1;
          if (!a.isPreferred && b.isPreferred) return 1;
          const aKind = a.kind?.split(".")[0] ?? "zzz";
          const bKind = b.kind?.split(".")[0] ?? "zzz";
          return (kindOrder[aKind] ?? 3) - (kindOrder[bKind] ?? 3);
        });
        const rootDir = manager.resolvePath(".");
        const outputLines = [];
        let preferredCount = 0;
        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          const preferred = action.isPreferred ? "\u2605 " : "";
          if (action.isPreferred) preferredCount++;
          const kindStr = action.kind ? ` [${action.kind}]` : "";
          outputLines.push(`  ${i + 1}. ${preferred}${action.title}${kindStr}`);
          if (action.edit) {
            const editLines = formatEditSummary(action.edit, rootDir);
            outputLines.push(...editLines);
          } else if (action.command && !action.edit) {
            outputLines.push(`     (command: ${action.command.title || action.command.command})`);
          } else {
            outputLines.push("     (resolve required)");
          }
        }
        for (const cmd of commands) {
          outputLines.push(`  \u2022 ${cmd.title} (command-only, requires IDE execution)`);
        }
        const totalCount = actions.length + commands.length;
        const header = `${totalCount} code action(s) at ${filePath}:${line}:${character}`;
        const preferredNote = preferredCount > 0 ? ` (${preferredCount} preferred)` : "";
        let text = `${header}${preferredNote}

${outputLines.join("\n")}`;
        if (resolvedFrom) text = `${resolvedFrom}

${text}`;
        return {
          content: [{ type: "text", text }],
          details: { count: totalCount, preferredCount }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `LSP code action request failed: ${err.message}` }],
          details: { count: 0, preferredCount: 0 }
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_code_actions "));
      if (args.query && !args.line) {
        text += theme.fg("accent", args.path);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else if (args.endLine) {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}-${args.endLine}:${args.endCharacter}`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      if (args.kind) {
        text += theme.fg("dim", ` [${args.kind}]`);
      }
      return new Text9(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text9(theme.fg("warning", "Loading..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) {
        return new Text9(theme.fg("dim", "No code actions available"), 0, 0);
      }
      const preferred = details.preferredCount > 0 ? ` (${details.preferredCount} preferred)` : "";
      return new Text9(theme.fg("success", `${details.count} action(s)${preferred}`), 0, 0);
    }
  };
}

// src/index.ts
import { relative as relative10 } from "node:path";
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function loadProjectConfig(dir) {
  const configPath = join2(dir, ".pi-lsp.json");
  try {
    if (!existsSync3(configPath)) return null;
    const raw = readFileSync2(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
function lspExtension(pi) {
  const origListeners = process.listeners("uncaughtException");
  process.on("uncaughtException", (err) => {
    if (err?.code === "EPIPE") return;
    for (const listener of origListeners) listener(err);
    if (origListeners.length === 0) {
      console.error("[LSP] Uncaught exception:", err);
    }
  });
  let manager = null;
  let fileSync = null;
  let treeSitter = null;
  let workspaceIndex = null;
  let pendingProvider = null;
  let latestCtx = null;
  let projectConfig = null;
  const withLatestCtx = (fn) => {
    const ctx = latestCtx;
    if (!ctx) return;
    try {
      fn(ctx);
    } catch (err) {
      if (typeof err?.message === "string" && err.message.includes("stale after session")) {
        latestCtx = null;
        return;
      }
      throw err;
    }
  };
  const applyProvider = (data) => {
    const provider = data;
    pendingProvider = provider;
    if (manager) {
      manager.setWorkspaceProvider(provider);
    }
    const statusText = provider.getStatusText();
    if (!statusText) return;
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    });
  };
  pi.events.on("lsp:register-workspace-provider", applyProvider);
  const existing = pi.events["lsp:workspace-provider"];
  if (existing) applyProvider(existing);
  const setLspStatus = (color, text) => {
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg(color, text));
    });
  };
  const makeCallbacks = () => ({
    onWorkspaceSetupStart: () => {
      setLspStatus("warning", "LSP: workspace setup...");
    },
    onWorkspaceSetupEnd: (success, duration) => {
      const secs = (duration / 1e3).toFixed(1);
      if (success) {
        setLspStatus("accent", `LSP: workspace ready (${secs}s)`);
      } else {
        setLspStatus("warning", `LSP: workspace setup failed (${secs}s)`);
      }
    },
    onServerStart: (languageId, command) => {
      setLspStatus("warning", `LSP: starting ${languageId} (${command})...`);
    },
    onServerReady: (languageId) => {
      setLspStatus("accent", `LSP: ${languageId} ready`);
    },
    onServerError: (languageId, _error) => {
      setLspStatus("error", `LSP: ${languageId} failed`);
    },
    onServerNotice: (_languageId, message, level) => {
      withLatestCtx((ctx) => ctx.ui.notify(message, level));
    },
    onServerCrash: (languageId, restarting, attempt) => {
      if (restarting) {
        setLspStatus("warning", `LSP: restarting ${languageId}... (attempt ${attempt}/3)`);
      } else {
        setLspStatus("error", `LSP: ${languageId} crashed \u2014 auto-restart exhausted`);
      }
    }
  });
  const getManager = () => {
    if (!manager) {
      manager = new LspManager(process.cwd(), void 0, makeCallbacks(), void 0, pendingProvider ?? void 0);
      fileSync = new FileSync(manager);
      fileSync.setSyntheticDotChecker((uri) => syntheticDotLocks.has(uri));
      treeSitter = new TreeSitterManager();
      workspaceIndex = new WorkspaceIndex(process.cwd(), treeSitter);
      fileSync.setTreeSitter(treeSitter, workspaceIndex);
    }
    return manager;
  };
  const getFileSync = () => {
    if (!fileSync) {
      getManager();
    }
    return fileSync;
  };
  const getTreeSitter = () => {
    if (!treeSitter) {
      getManager();
    }
    return treeSitter;
  };
  const getWorkspaceIndex = () => {
    if (!workspaceIndex) {
      getManager();
    }
    return workspaceIndex;
  };
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (manager) {
      await manager.shutdownAll().catch(() => {
      });
      if (treeSitter) treeSitter.shutdown();
    }
    manager = new LspManager(ctx.cwd, void 0, makeCallbacks(), void 0, pendingProvider ?? void 0);
    fileSync = new FileSync(manager);
    fileSync.setSyntheticDotChecker((uri) => syntheticDotLocks.has(uri));
    treeSitter = new TreeSitterManager();
    workspaceIndex = new WorkspaceIndex(ctx.cwd, treeSitter);
    fileSync.setTreeSitter(treeSitter, workspaceIndex);
    treeSitter.init().catch((err) => {
      console.error(`[pi-lsp-extension] tree-sitter WASM init failed: ${err?.message ?? err}`);
    });
    const wsProvider = manager.workspace;
    const statusText = wsProvider.getStatusText();
    if (statusText) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    } else {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    }
    projectConfig = loadProjectConfig(ctx.cwd);
    if (projectConfig) {
      if (projectConfig.servers) {
        for (const [lang, serverConf] of Object.entries(projectConfig.servers)) {
          manager.setServerConfig(lang, {
            command: serverConf.command,
            args: serverConf.args ?? [],
            env: serverConf.env,
            initializationOptions: serverConf.initializationOptions,
            settings: serverConf.settings
          });
        }
      }
      if (projectConfig.lombokJar) {
        if (projectConfig.lombokJar !== "auto") {
          manager.setLombokJar(projectConfig.lombokJar);
        }
      }
      if (projectConfig.autoStart && projectConfig.autoStart.length > 0) {
        const langs = projectConfig.autoStart;
        const lombokNote = langs.includes("java") && manager.getLombokJar() ? ` (lombok: ${manager.getLombokJar()?.split("/").pop()})` : "";
        setLspStatus("warning", `LSP: auto-starting ${langs.join(", ")}${lombokNote}...`);
        manager.startEagerly(langs);
      }
    }
  });
  const lazy = (current) => new Proxy({}, {
    get(_target, prop) {
      const target = current();
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (_target, prop, value) => Reflect.set(current(), prop, value)
  });
  const managerProxy = lazy(getManager);
  const treeSitterProxy = lazy(getTreeSitter);
  const workspaceIndexProxy = lazy(getWorkspaceIndex);
  pi.registerTool(createDiagnosticsTool(managerProxy, treeSitterProxy));
  pi.registerTool(createHoverTool(managerProxy, treeSitterProxy));
  pi.registerTool(createDefinitionTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createReferencesTool(managerProxy, treeSitterProxy));
  pi.registerTool(createSymbolsTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createRenameTool(managerProxy, treeSitterProxy));
  pi.registerTool(createCodeActionsTool(managerProxy, treeSitterProxy));
  pi.registerTool(createCompletionsTool(managerProxy, {
    getTrackedVersion: (uri) => getFileSync().getTrackedVersion(uri),
    setTrackedVersion: (uri, v) => getFileSync().setTrackedVersion(uri, v),
    isSyntheticDotActive: (uri) => syntheticDotLocks.has(uri)
  }, treeSitterProxy));
  const getRootDir = () => manager?.resolvePath(".") ?? process.cwd();
  pi.registerTool(createCodeOverviewTool(getRootDir, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createCodeSearchTool(getRootDir, treeSitterProxy));
  pi.registerTool(createCodeRewriteTool(getRootDir, treeSitterProxy, {
    onFileModified: (filePath) => {
      getFileSync().handleFileWrite(filePath).catch(() => {
      });
    }
  }));
  pi.registerTool(createCodeActionsTool(managerProxy, treeSitterProxy));
  pi.on("tool_result", async (event) => {
    const sync = getFileSync();
    try {
      if (isReadToolResult(event) && !event.isError) {
        const path = event.input?.path;
        if (path) await sync.handleFileRead(path);
      }
      if (isWriteToolResult(event) && !event.isError) {
        const path = event.input?.path;
        if (path) await sync.handleFileWrite(path);
      }
      if (isEditToolResult(event) && !event.isError) {
        const path = event.input?.path;
        if (path) await sync.handleFileWrite(path);
      }
    } catch {
    }
    if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError && manager) {
      const path = event.input?.path;
      if (!path) return;
      const languageId = manager.getLanguageId(path);
      if (!languageId) return;
      const inject = projectConfig?.autoInjectDiagnostics;
      if (inject === false) return;
      if (Array.isArray(inject) && !inject.includes(languageId)) return;
      const client = manager.getRunningClient(languageId);
      if (!client) return;
      await new Promise((r) => setTimeout(r, DIAGNOSTIC_SETTLE_DELAY_MS));
      const uri = manager.getFileUri(path);
      const diagnostics = client.getDiagnostics(uri);
      const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity2.Error);
      if (errors.length === 0) return;
      const relPath = relative10(manager.resolvePath("."), manager.resolvePath(path));
      const lines = errors.slice(0, 10).map((d) => {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const source = d.source ? ` [${d.source}]` : "";
        return `${relPath}:${line}:${col} error: ${d.message}${source}`;
      });
      if (errors.length > 10) {
        lines.push(`... and ${errors.length - 10} more error(s)`);
      }
      const summary = `

\u26A0 LSP: ${errors.length} error(s) in ${relPath}:
${lines.join("\n")}`;
      return {
        content: [
          ...event.content,
          { type: "text", text: summary }
        ]
      };
    }
  });
  pi.on("tool_execution_end", async (_event, ctx) => {
    latestCtx = ctx;
    if (!manager) return;
    const statuses = manager.getStatus();
    const running = statuses.filter((s) => s.running);
    if (running.length === 0) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    } else {
      const totalDiags = running.reduce((n, s) => n + s.diagnosticsCount, 0);
      const langs = running.map((s) => s.languageId).join(", ");
      let status = `LSP: ${langs}`;
      if (totalDiags > 0) {
        status += ` (${totalDiags} diagnostic${totalDiags !== 1 ? "s" : ""})`;
      }
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", status));
    }
  });
  pi.registerCommand("lsp", {
    description: "Show LSP server status",
    handler: async (_args, ctx) => {
      if (!manager) {
        ctx.ui.notify("LSP manager not initialized", "warning");
        return;
      }
      const statuses = manager.getStatus();
      if (statuses.length === 0) {
        ctx.ui.notify("No LSP servers configured", "info");
        return;
      }
      const lines = statuses.map((s) => {
        const icon = s.running ? "\u{1F7E2}" : "\u26AA";
        const diags = s.diagnosticsCount > 0 ? ` (${s.diagnosticsCount} diagnostics)` : "";
        const shared = s.shared ? " [shared]" : "";
        return `${icon} ${s.languageId}: ${s.command}${diags}${shared}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
  pi.registerCommand("lsp-restart", {
    description: "Restart an LSP server: /lsp-restart <language> (e.g. java, typescript)",
    handler: async (args, ctx) => {
      if (!manager) {
        ctx.ui.notify("LSP manager not initialized", "warning");
        return;
      }
      const languageId = args?.trim().toLowerCase();
      if (!languageId) {
        const statuses = manager.getStatus().filter((s) => s.running);
        if (statuses.length === 0) {
          ctx.ui.notify("No LSP servers are running.\n\nUsage: /lsp-restart <language>", "info");
        } else {
          const langs = statuses.map((s) => s.languageId).join(", ");
          ctx.ui.notify(
            `Running servers: ${langs}

Usage: /lsp-restart <language>
Example: /lsp-restart java`,
            "info"
          );
        }
        return;
      }
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("warning", `LSP: restarting ${languageId}...`));
      ctx.ui.notify(`Restarting ${languageId} server (kills daemon if shared)...`, "info");
      try {
        await manager.restartServer(languageId);
        const lombokJar = languageId === "java" ? manager.getLombokJar() : null;
        const lombokNote = lombokJar ? `
Lombok: ${lombokJar}` : "";
        ctx.ui.notify(`${languageId} server restarted successfully.${lombokNote}`, "info");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${languageId} ready`));
      } catch (err) {
        ctx.ui.notify(`Failed to restart ${languageId}: ${err.message}`, "error");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("error", `LSP: ${languageId} restart failed`));
      }
    }
  });
  pi.registerCommand("lsp-config", {
    description: "Configure an LSP server: /lsp-config <language> <command> [args...]",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]\nExample: /lsp-config python pylsp",
          "info"
        );
        return;
      }
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]",
          "warning"
        );
        return;
      }
      const [languageId, command, ...serverArgs] = parts;
      const config = { command, args: serverArgs };
      getManager().setServerConfig(languageId, config);
      ctx.ui.notify(
        `Configured LSP for ${languageId}: ${command} ${serverArgs.join(" ")}`,
        "info"
      );
    }
  });
  pi.registerCommand("lsp-lombok", {
    description: "Set Lombok jar path for Java: /lsp-lombok <path-to-lombok.jar>",
    handler: async (args, ctx) => {
      const mgr = getManager();
      if (!args?.trim()) {
        const current = mgr.getLombokJar();
        if (current) {
          ctx.ui.notify(`Lombok jar: ${current}`, "info");
        } else {
          ctx.ui.notify(
            "No Lombok jar configured or detected.\n\nUsage: /lsp-lombok <path-to-lombok.jar>\nOr set LOMBOK_JAR environment variable.\n\nDownload from: https://projectlombok.org/download",
            "info"
          );
        }
        return;
      }
      const jarPath = args.trim();
      const { existsSync: existsSync4 } = await import("node:fs");
      const { resolve: resolve6 } = await import("node:path");
      const resolved = resolve6(ctx.cwd, jarPath);
      if (!existsSync4(resolved)) {
        ctx.ui.notify(`File not found: ${resolved}`, "error");
        return;
      }
      if (!resolved.endsWith(".jar")) {
        ctx.ui.notify(`Warning: ${resolved} doesn't end in .jar \u2014 setting anyway`, "warning");
      }
      mgr.setLombokJar(resolved);
      ctx.ui.notify(`Lombok jar set: ${resolved}`, "info");
    }
  });
  pi.on("session_shutdown", async () => {
    latestCtx = null;
    if (manager) {
      await manager.shutdownAll();
      manager = null;
      fileSync = null;
    }
    if (treeSitter) {
      treeSitter.shutdown();
      treeSitter = null;
    }
    workspaceIndex = null;
  });
}
export {
  lspExtension as default
};
