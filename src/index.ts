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

import { LspManager, type ServerConfig } from "./lsp-manager.js";
import { FileSync } from "./file-sync.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createHoverTool } from "./tools/hover.js";
import { createDefinitionTool } from "./tools/definition.js";
import { createReferencesTool } from "./tools/references.js";
import { createSymbolsTool } from "./tools/symbols.js";
import { createRenameTool } from "./tools/rename.js";

export default function lspExtension(pi: ExtensionAPI) {
  let manager: LspManager | null = null;
  let fileSync: FileSync | null = null;

  // Create manager eagerly so tools can reference it, but servers start lazily
  const getManager = (): LspManager => {
    if (!manager) {
      manager = new LspManager(process.cwd());
      fileSync = new FileSync(manager);
    }
    return manager;
  };

  const getFileSync = (): FileSync => {
    if (!fileSync) {
      getManager(); // ensures fileSync is created
    }
    return fileSync!;
  };

  // Initialize manager (uses cwd at session start time)
  pi.on("session_start", async (_event, ctx) => {
    manager = new LspManager(ctx.cwd);
    fileSync = new FileSync(manager);
    ctx.ui.setStatus(
      "lsp",
      ctx.ui.theme.fg("dim", "LSP: idle")
    );
  });

  // Register all LSP tools
  // Tools call getManager() lazily so they work even if session_start hasn't fired
  const managerProxy = new Proxy({} as LspManager, {
    get(_target, prop) {
      return (getManager() as any)[prop];
    },
  });

  pi.registerTool(createDiagnosticsTool(managerProxy));
  pi.registerTool(createHoverTool(managerProxy));
  pi.registerTool(createDefinitionTool(managerProxy));
  pi.registerTool(createReferencesTool(managerProxy));
  pi.registerTool(createSymbolsTool(managerProxy));
  pi.registerTool(createRenameTool(managerProxy));

  // File sync: track file reads/writes/edits
  pi.on("tool_result", async (event) => {
    const sync = getFileSync();

    try {
      if (isReadToolResult(event) && !event.isError) {
        // Extract path from input
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
  });

  // Update status after tool execution ends
  pi.on("tool_execution_end", async (_event, ctx) => {
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
        return `${icon} ${s.languageId}: ${s.command}${diags}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
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

  // Clean shutdown
  pi.on("session_shutdown", async () => {
    if (manager) {
      await manager.shutdownAll();
      manager = null;
      fileSync = null;
    }
  });
}
