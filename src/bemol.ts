/**
 * Bemol — Amazon's Brazil workspace → LSP bridge integration.
 *
 * Detects Brazil workspaces, runs bemol to generate LSP configs,
 * manages a background bemol --watch process, and reads workspace
 * root folders for multi-root LSP support.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface BemolStatus {
  isBrazilWorkspace: boolean;
  workspaceRoot: string | null;
  bemolAvailable: boolean;
  hasConfig: boolean;
  watching: boolean;
  workspaceRoots: string[];
}

export interface BemolRunResult {
  success: boolean;
  output: string;
  duration: number;
}

export class BemolManager {
  private watchProcess: ChildProcess | null = null;
  private _workspaceRoot: string | null = null;
  private _bemolAvailable: boolean | null = null;
  private _bemolRan = false;

  constructor(rootDir: string) {
    this._workspaceRoot = BemolManager.findWorkspaceRoot(rootDir);
  }

  /** Whether the cwd is inside a Brazil workspace */
  get isBrazilWorkspace(): boolean {
    return this._workspaceRoot !== null;
  }

  /** The Brazil workspace root (directory containing packageInfo) */
  get workspaceRoot(): string | null {
    return this._workspaceRoot;
  }

  /** Whether bemol has already been run this session */
  get bemolRan(): boolean {
    return this._bemolRan;
  }

  /** Whether bemol --watch is running */
  get isWatching(): boolean {
    return this.watchProcess !== null && !this.watchProcess.killed;
  }

  /**
   * Walk up from startDir looking for a `packageInfo` file.
   * Returns the directory containing it, or null.
   */
  static findWorkspaceRoot(startDir: string): string | null {
    let dir = startDir;
    // Walk up at most 20 levels to avoid infinite loops
    for (let i = 0; i < 20; i++) {
      const candidate = join(dir, "packageInfo");
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return dir;
        }
      } catch {
        // ignore
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  }

  /** Check if bemol is available on PATH */
  static isBemolAvailable(): boolean {
    try {
      execSync("which bemol", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if bemol is available (cached) */
  get bemolAvailable(): boolean {
    if (this._bemolAvailable === null) {
      this._bemolAvailable = BemolManager.isBemolAvailable();
    }
    return this._bemolAvailable;
  }

  /** Check if .bemol/ws_root_folders exists */
  hasConfig(): boolean {
    if (!this._workspaceRoot) return false;
    const foldersFile = join(this._workspaceRoot, ".bemol", "ws_root_folders");
    return existsSync(foldersFile);
  }

  /**
   * Read .bemol/ws_root_folders and return array of existing directory paths.
   */
  getWorkspaceRoots(): string[] {
    if (!this._workspaceRoot) return [];
    const foldersFile = join(this._workspaceRoot, ".bemol", "ws_root_folders");
    try {
      const content = readFileSync(foldersFile, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((dir) => {
          try {
            return existsSync(dir) && statSync(dir).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  /**
   * Get workspace folders formatted for LSP InitializeParams.
   * Returns array of { uri, name } objects.
   */
  getWorkspaceFolders(): { uri: string; name: string }[] {
    const roots = this.getWorkspaceRoots();
    if (roots.length === 0) return [];
    return roots.map((dir) => ({
      uri: pathToFileURL(dir).toString(),
      name: dir.split("/").pop() ?? "package",
    }));
  }

  /**
   * Run `bemol --verbose` in the workspace root.
   * Returns result with success status, output, and duration.
   */
  async runBemol(): Promise<BemolRunResult> {
    if (!this._workspaceRoot) {
      return { success: false, output: "Not in a Brazil workspace", duration: 0 };
    }
    if (!this.bemolAvailable) {
      return { success: false, output: "bemol is not installed (try: toolbox install bemol)", duration: 0 };
    }

    const start = Date.now();

    return new Promise((resolve) => {
      const child = spawn("bemol", ["--verbose"], {
        cwd: this._workspaceRoot!,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (data) => chunks.push(data));
      child.stderr?.on("data", (data) => chunks.push(data));

      // Timeout after 120s
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({
          success: false,
          output: "bemol timed out after 120 seconds",
          duration: Date.now() - start,
        });
      }, 120_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: `bemol failed to start: ${err.message}`,
          duration: Date.now() - start,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString();
        this._bemolRan = true;
        resolve({
          success: code === 0,
          output: output || (code === 0 ? "bemol completed successfully" : `bemol exited with code ${code}`),
          duration: Date.now() - start,
        });
      });
    });
  }

  /**
   * Ensure bemol has been run at least once this session.
   * If configs exist already, skips. If not, runs bemol.
   * Returns true if configs are available after this call.
   */
  async ensureBemolConfig(): Promise<boolean> {
    if (!this.isBrazilWorkspace) return false;
    if (this.hasConfig()) {
      this._bemolRan = true;
      return true;
    }
    if (this._bemolRan) return this.hasConfig();
    if (!this.bemolAvailable) return false;

    const result = await this.runBemol();
    return result.success && this.hasConfig();
  }

  /**
   * Start `bemol --watch` as a background process.
   */
  startWatch(): boolean {
    if (!this._workspaceRoot || !this.bemolAvailable) return false;
    if (this.isWatching) return true; // already running

    this.watchProcess = spawn("bemol", ["--watch"], {
      cwd: this._workspaceRoot,
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });

    this.watchProcess.on("error", () => {
      this.watchProcess = null;
    });

    this.watchProcess.on("exit", () => {
      this.watchProcess = null;
    });

    return true;
  }

  /** Stop the background bemol --watch process */
  stopWatch(): void {
    if (this.watchProcess) {
      this.watchProcess.kill("SIGTERM");
      setTimeout(() => {
        if (this.watchProcess && !this.watchProcess.killed) {
          this.watchProcess.kill("SIGKILL");
        }
      }, 2000);
      this.watchProcess = null;
    }
  }

  /** Get full status summary */
  getStatus(): BemolStatus {
    return {
      isBrazilWorkspace: this.isBrazilWorkspace,
      workspaceRoot: this._workspaceRoot,
      bemolAvailable: this.bemolAvailable,
      hasConfig: this.hasConfig(),
      watching: this.isWatching,
      workspaceRoots: this.getWorkspaceRoots(),
    };
  }

  /** Shutdown: stop watch, clean up */
  shutdown(): void {
    this.stopWatch();
  }
}
