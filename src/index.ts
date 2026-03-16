/**
 * pi-lsp-extension — Pi coding agent extension for LSP integration.
 *
 * Exposes Language Server Protocol capabilities as tools the LLM can call:
 * - lsp_diagnostics: compilation errors and warnings
 * - lsp_hover: type info and docs at a position
 * - lsp_definition: go to definition
 * - lsp_references: find all references
 * - lsp_symbols: file/workspace symbol search
 * - lsp_rename: preview rename refactoring
 * - lsp_completions: code completion suggestions at a position
 *
 * Usage:
 *   1. npm install in this directory
 *   2. Add to pi via settings.json extensions, or: pi -e ./src/index.ts
 *   3. LSP servers start lazily when you first use a tool on a file
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  isReadToolResult,
  isWriteToolResult,
  isEditToolResult,
} from "@mariozechner/pi-coding-agent";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import { LspManager, type ServerConfig, type LspManagerCallbacks } from "./lsp-manager.js";
import { FileSync } from "./file-sync.js";
import { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import { WorkspaceIndex } from "./tree-sitter/workspace-index.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createHoverTool } from "./tools/hover.js";
import { createDefinitionTool } from "./tools/definition.js";
import { createReferencesTool } from "./tools/references.js";
import { createSymbolsTool } from "./tools/symbols.js";
import { createRenameTool } from "./tools/rename.js";
import { createCodeOverviewTool } from "./tools/code-overview.js";
import { createCompletionsTool } from "./tools/completions.js";
import { relative } from "node:path";

export default function lspExtension(pi: ExtensionAPI) {
  let manager: LspManager | null = null;
  let fileSync: FileSync | null = null;
  let treeSitter: TreeSitterManager | null = null;
  let workspaceIndex: WorkspaceIndex | null = null;
  // Store latest ctx for lifecycle callbacks (updated on each event)
  let latestCtx: any = null;

  /** Build lifecycle callbacks that update UI status */
  const makeCallbacks = (): LspManagerCallbacks => ({
    onBemolStart: () => {
      latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("warning", "LSP: running bemol..."));
    },
    onBemolEnd: (success: boolean, duration: number) => {
      const secs = (duration / 1000).toFixed(1);
      if (success) {
        latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("accent", `LSP: bemol done (${secs}s)`));
      } else {
        latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("warning", `LSP: bemol failed (${secs}s)`));
      }
    },
    onServerStart: (languageId: string, command: string) => {
      latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("warning", `LSP: starting ${languageId} (${command})...`));
    },
    onServerReady: (languageId: string) => {
      latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("accent", `LSP: ${languageId} ready`));
    },
    onServerError: (languageId: string, error: string) => {
      latestCtx?.ui?.setStatus("lsp", latestCtx.ui.theme.fg("error", `LSP: ${languageId} failed`));
    },
  });

  // Create manager eagerly so tools can reference it, but servers start lazily
  const getManager = (): LspManager => {
    if (!manager) {
      manager = new LspManager(process.cwd(), undefined, makeCallbacks());
      fileSync = new FileSync(manager);
      treeSitter = new TreeSitterManager();
      workspaceIndex = new WorkspaceIndex(process.cwd(), treeSitter);
      fileSync.setTreeSitter(treeSitter, workspaceIndex);
    }
    return manager;
  };

  const getFileSync = (): FileSync => {
    if (!fileSync) {
      getManager(); // ensures fileSync is created
    }
    return fileSync!;
  };

  const getTreeSitter = (): TreeSitterManager => {
    if (!treeSitter) {
      getManager(); // ensures treeSitter is created
    }
    return treeSitter!;
  };

  const getWorkspaceIndex = (): WorkspaceIndex => {
    if (!workspaceIndex) {
      getManager(); // ensures workspaceIndex is created
    }
    return workspaceIndex!;
  };

  // Initialize manager (uses cwd at session start time)
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    manager = new LspManager(ctx.cwd, undefined, makeCallbacks());
    fileSync = new FileSync(manager);
    treeSitter = new TreeSitterManager();
    workspaceIndex = new WorkspaceIndex(ctx.cwd, treeSitter);
    fileSync.setTreeSitter(treeSitter, workspaceIndex);

    // Initialize tree-sitter in the background (don't block session start)
    treeSitter.init().catch(() => {});

    // Detect Brazil workspace and show appropriate status
    const bemol = manager.bemol;
    if (bemol.isBrazilWorkspace) {
      const hasBemol = bemol.bemolAvailable;
      const hasConfig = bemol.hasConfig();
      let status = "LSP: Brazil workspace";
      if (hasConfig) {
        status += " (bemol config found)";
      } else if (hasBemol) {
        status += " (bemol will run on first LSP use)";
      } else {
        status += " (bemol not installed)";
      }
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", status));
    } else {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    }
  });

  // Register all LSP tools
  // Tools call getManager() lazily so they work even if session_start hasn't fired
  const managerProxy = new Proxy({} as LspManager, {
    get(_target, prop) {
      return (getManager() as any)[prop];
    },
  });

  const treeSitterProxy = new Proxy({} as TreeSitterManager, {
    get(_target, prop) {
      return (getTreeSitter() as any)[prop];
    },
  });

  const workspaceIndexProxy = new Proxy({} as WorkspaceIndex, {
    get(_target, prop) {
      return (getWorkspaceIndex() as any)[prop];
    },
  });

  pi.registerTool(createDiagnosticsTool(managerProxy, treeSitterProxy));
  pi.registerTool(createHoverTool(managerProxy, treeSitterProxy));
  pi.registerTool(createDefinitionTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createReferencesTool(managerProxy));
  pi.registerTool(createSymbolsTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createRenameTool(managerProxy));
  pi.registerTool(createCompletionsTool(managerProxy, {
    getTrackedVersion: (uri) => getFileSync().getTrackedVersion(uri),
    setTrackedVersion: (uri, v) => getFileSync().setTrackedVersion(uri, v),
  }));
  pi.registerTool(createCodeOverviewTool(process.cwd(), treeSitterProxy, workspaceIndexProxy));

  // File sync: track file reads/writes/edits
  // After writes/edits, append file-scoped error diagnostics to the tool result
  pi.on("tool_result", async (event) => {
    const sync = getFileSync();

    try {
      if (isReadToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileRead(path);
      }

      if (isWriteToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileWrite(path);
      }

      if (isEditToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileWrite(path);
      }
    } catch {
      // File sync errors are non-fatal
    }

    // Auto-append diagnostics for the changed file (write/edit only)
    if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError && manager) {
      const path = (event.input as any)?.path;
      if (!path) return;

      const languageId = manager.getLanguageId(path);
      if (!languageId) return;

      const client = manager.getRunningClient(languageId);
      if (!client) return;

      // Wait briefly for the LSP to publish updated diagnostics
      await new Promise((r) => setTimeout(r, 1500));

      const uri = manager.getFileUri(path);
      const diagnostics = client.getDiagnostics(uri);
      const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);

      if (errors.length === 0) return;

      // Build a compact summary — just errors, max 10 lines
      const relPath = relative(manager.resolvePath("."), manager.resolvePath(path));
      const lines = errors.slice(0, 10).map((d) => {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const source = d.source ? ` [${d.source}]` : "";
        return `${relPath}:${line}:${col} error: ${d.message}${source}`;
      });
      if (errors.length > 10) {
        lines.push(`... and ${errors.length - 10} more error(s)`);
      }

      const summary = `\n\n⚠ LSP: ${errors.length} error(s) in ${relPath}:\n${lines.join("\n")}`;

      return {
        content: [
          ...event.content,
          { type: "text" as const, text: summary },
        ],
      };
    }
  });

  // Update status after tool execution ends
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

  // /lsp command — show server status
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
        const icon = s.running ? "🟢" : "⚪";
        const diags =
          s.diagnosticsCount > 0 ? ` (${s.diagnosticsCount} diagnostics)` : "";
        const shared = s.shared ? " [shared]" : "";
        return `${icon} ${s.languageId}: ${s.command}${diags}${shared}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /bemol command — run bemol, manage watch mode
  pi.registerCommand("bemol", {
    description: "Manage bemol: /bemol [run|watch|stop|status]",
    handler: async (args, ctx) => {
      const mgr = getManager();
      const bemol = mgr.bemol;

      if (!bemol.isBrazilWorkspace) {
        ctx.ui.notify("Not in a Brazil workspace (no packageInfo found)", "warning");
        return;
      }

      const subcommand = args?.trim().toLowerCase() || "run";

      switch (subcommand) {
        case "run": {
          if (!bemol.bemolAvailable) {
            ctx.ui.notify("bemol is not installed. Run: toolbox install bemol", "warning");
            return;
          }
          ctx.ui.setStatus("lsp", ctx.ui.theme.fg("warning", "LSP: running bemol..."));
          ctx.ui.notify("Running bemol --verbose...", "info");
          const result = await bemol.runBemol();
          if (result.success) {
            const roots = bemol.getWorkspaceRoots();
            ctx.ui.notify(
              `bemol completed in ${(result.duration / 1000).toFixed(1)}s\n${roots.length} package root(s) configured`,
              "info"
            );
          } else {
            ctx.ui.notify(`bemol failed:\n${result.output.slice(0, 500)}`, "error");
          }
          // Reset status
          ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", "LSP: Brazil workspace (bemol done)"));
          break;
        }

        case "watch": {
          if (!bemol.bemolAvailable) {
            ctx.ui.notify("bemol is not installed. Run: toolbox install bemol", "warning");
            return;
          }
          if (bemol.isWatching) {
            ctx.ui.notify("bemol --watch is already running", "info");
            return;
          }
          const started = bemol.startWatch();
          if (started) {
            ctx.ui.notify("Started bemol --watch in background", "info");
            ctx.ui.setStatus("bemol", ctx.ui.theme.fg("accent", "bemol: watching"));
          } else {
            ctx.ui.notify("Failed to start bemol --watch", "error");
          }
          break;
        }

        case "stop": {
          if (!bemol.isWatching) {
            ctx.ui.notify("bemol --watch is not running", "info");
            return;
          }
          bemol.stopWatch();
          ctx.ui.notify("Stopped bemol --watch", "info");
          ctx.ui.setStatus("bemol", "");
          break;
        }

        case "status": {
          const status = bemol.getStatus();
          const lines = [
            `Brazil workspace: ${status.isBrazilWorkspace ? "yes" : "no"}`,
            `Workspace root: ${status.workspaceRoot ?? "N/A"}`,
            `bemol available: ${status.bemolAvailable ? "yes" : "no"}`,
            `bemol config: ${status.hasConfig ? "yes" : "missing"}`,
            `bemol watch: ${status.watching ? "running" : "stopped"}`,
            `Package roots: ${status.workspaceRoots.length}`,
          ];
          if (status.workspaceRoots.length > 0) {
            const shown = status.workspaceRoots.slice(0, 10);
            for (const root of shown) {
              lines.push(`  ${root}`);
            }
            if (status.workspaceRoots.length > 10) {
              lines.push(`  ... and ${status.workspaceRoots.length - 10} more`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /bemol [run|watch|stop|status]\n  run    — run bemol --verbose\n  watch  — start bemol --watch\n  stop   — stop bemol --watch\n  status — show bemol status",
            "info"
          );
      }
    },
  });

  // /lsp-config command — add or override server configuration
  pi.registerCommand("lsp-config", {
    description:
      "Configure an LSP server: /lsp-config <language> <command> [args...]",
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
      const config: ServerConfig = { command, args: serverArgs };

      getManager().setServerConfig(languageId, config);
      ctx.ui.notify(
        `Configured LSP for ${languageId}: ${command} ${serverArgs.join(" ")}`,
        "info"
      );
    },
  });

  // /lsp-lombok command — set Lombok jar path for Java
  pi.registerCommand("lsp-lombok", {
    description:
      "Set Lombok jar path for Java: /lsp-lombok <path-to-lombok.jar>",
    handler: async (args, ctx) => {
      const mgr = getManager();

      if (!args?.trim()) {
        const current = mgr.getLombokJar();
        if (current) {
          ctx.ui.notify(`Lombok jar: ${current}`, "info");
        } else {
          ctx.ui.notify(
            "No Lombok jar configured or detected.\n\n" +
            "Usage: /lsp-lombok <path-to-lombok.jar>\n" +
            "Or set LOMBOK_JAR environment variable.\n\n" +
            "Download from: https://projectlombok.org/download",
            "info"
          );
        }
        return;
      }

      const jarPath = args.trim();
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const resolved = resolve(ctx.cwd, jarPath);

      if (!existsSync(resolved)) {
        ctx.ui.notify(`File not found: ${resolved}`, "error");
        return;
      }

      if (!resolved.endsWith(".jar")) {
        ctx.ui.notify(`Warning: ${resolved} doesn't end in .jar — setting anyway`, "warning");
      }

      mgr.setLombokJar(resolved);
      ctx.ui.notify(`Lombok jar set: ${resolved}`, "info");
    },
  });

  // Clean shutdown (includes bemol watch, all LSP servers, and tree-sitter)
  pi.on("session_shutdown", async () => {
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
