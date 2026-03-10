/**
 * LSP Manager — manages multiple LSP server instances, one per language.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, type LspClientOptions } from "./lsp-client.js";

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
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
}

export class LspManager {
  private clients: Map<string, LspClient> = new Map();
  private serverConfigs: Map<string, ServerConfig>;
  private rootDir: string;
  private startingServers: Map<string, Promise<LspClient>> = new Map();

  constructor(rootDir: string, customConfigs?: Record<string, ServerConfig>) {
    this.rootDir = resolve(rootDir);
    this.serverConfigs = new Map(Object.entries({
      ...DEFAULT_SERVERS,
      ...customConfigs,
    }));
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

  private async startServer(languageId: string, config: ServerConfig): Promise<LspClient> {
    const client = new LspClient({
      command: config.command,
      args: config.args,
      rootDir: this.rootDir,
      languageId,
      env: config.env,
    });

    try {
      await client.start();
      this.clients.set(languageId, client);
      this.startingServers.delete(languageId);
      return client;
    } catch (err: any) {
      this.startingServers.delete(languageId);
      throw new Error(
        `Failed to start LSP server for ${languageId} (${config.command}): ${err.message}`
      );
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
      statuses.push({
        languageId,
        command: config.command,
        running: client?.initialized === true && !client.disposed,
        diagnosticsCount,
      });
    }
    return statuses;
  }

  /** Shut down all running servers */
  async shutdownAll(): Promise<void> {
    const shutdowns = [...this.clients.values()].map((client) =>
      client.shutdown().catch(() => {})
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.startingServers.clear();
  }
}
