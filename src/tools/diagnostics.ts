/**
 * lsp_diagnostics — Get compilation errors and warnings for a file or the whole workspace.
 *
 * When `path` is provided: returns diagnostics for that single file.
 * When `path` is omitted: returns all cached diagnostics across all running LSP servers.
 */

import { Type } from "@sinclair/typebox";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveProvider } from "../resolve-provider.js";
import { getSyntaxErrors } from "../tree-sitter/symbol-extractor.js";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

function severityToString(severity: number | undefined): string {
  switch (severity) {
    case DiagnosticSeverity.Error: return "error";
    case DiagnosticSeverity.Warning: return "warning";
    case DiagnosticSeverity.Information: return "info";
    case DiagnosticSeverity.Hint: return "hint";
    default: return "unknown";
  }
}

function formatDiagnostic(diag: Diagnostic, filePath: string): string {
  const line = diag.range.start.line + 1;
  const col = diag.range.start.character + 1;
  const sev = severityToString(diag.severity);
  const source = diag.source ? ` [${diag.source}]` : "";
  const code = diag.code !== undefined ? ` (${diag.code})` : "";
  return `${filePath}:${line}:${col} ${sev}: ${diag.message}${code}${source}`;
}

const DiagnosticsParams = Type.Object({
  path: Type.String({ description: "File path to get diagnostics for. Pass \"*\" to get all workspace diagnostics from all running LSP servers." }),
});

interface DiagnosticsDetails {
  count: number;
  errors?: number;
  warnings?: number;
  files?: number;
}

export function createDiagnosticsTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): ToolDefinition<typeof DiagnosticsParams, DiagnosticsDetails> {
  return {
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get compilation errors and warnings from the LSP server. Pass a file path to check a single file, or pass \"*\" to get all cached diagnostics across the workspace.",
    promptSnippet: "Get compiler errors, warnings, and hints for a source file via LSP. Pass path=\"*\" to get all workspace diagnostics.",
    promptGuidelines: [
      "After making code changes with edit or write, use lsp_diagnostics to check for compilation errors before moving on.",
      "To review all workspace diagnostics at once, call lsp_diagnostics with path=\"*\" — this returns all cached diagnostics from running LSP servers without needing to check files individually.",
    ],
    parameters: DiagnosticsParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");

      // Workspace-wide mode
      if (filePath === "*" || filePath === "") {
        return executeWorkspaceDiagnostics(manager);
      }
      const client = await manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        // LSP path
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
          other > 0 ? `${other} other` : null,
        ].filter(Boolean).join(", ");

        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let resultText = `${summary}\n\n${truncation.content}`;
        if (truncation.truncated) {
          resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
        }

        return {
          content: [{ type: "text", text: resultText }],
          details: { count: sorted.length, errors, warnings },
        };
      }

      // Tree-sitter fallback: report syntax errors
      if (treeSitter) {
        const provider = resolveProvider(filePath, manager, treeSitter);
        if (provider.type === "tree-sitter") {
          try {
            const absPath = manager.resolvePath(filePath);
            const content = await readFile(absPath, "utf-8");
            const tree = await treeSitter.parse(absPath, content);
            if (tree) {
              const syntaxErrors = getSyntaxErrors(tree);
              if (syntaxErrors.length === 0) {
                return { content: [{ type: "text", text: "No syntax errors detected. [tree-sitter — syntax only, no type checking]" }], details: { count: 0 } };
              }
              const relPath = relative(manager.resolvePath("."), absPath);
              const lines = syntaxErrors.map((e) =>
                `${relPath}:${e.line + 1}:${e.character + 1} error: ${e.message}`
              );
              const output = lines.join("\n");
              const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
              let resultText = `${syntaxErrors.length} syntax error(s) [tree-sitter — syntax only, no type checking]\n\n${truncation.content}`;
              if (truncation.truncated) {
                resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
              }
              return {
                content: [{ type: "text", text: resultText }],
                details: { count: syntaxErrors.length, errors: syntaxErrors.length },
              };
            }
          } catch { /* fall through */ }
        }
      }

      return {
        content: [{ type: "text", text: manager.getUnavailableReason(filePath) }],
        details: { count: 0 },
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
        return new Text(theme.fg("success", "✓ No diagnostics"), 0, 0);
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
          for (const line of lines) text += `\n${theme.fg("dim", line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  };
}

/** Collect all diagnostics from all running LSP servers */
function executeWorkspaceDiagnostics(manager: LspManager) {
  const statuses = manager.getStatus();
  const running = statuses.filter((s) => s.running);

  if (running.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No LSP servers are running. Use lsp_diagnostics with a file path to start a server and check that file." }],
      details: { count: 0 },
    };
  }

  const rootDir = manager.resolvePath(".");
  const allDiagnostics: { relPath: string; diag: Diagnostic }[] = [];

  for (const status of running) {
    const client = manager.getRunningClient(status.languageId);
    if (!client) continue;

    const diagMap = client.getAllDiagnostics();
    for (const [uri, diagnostics] of diagMap) {
      if (diagnostics.length === 0) continue;
      let absPath: string;
      try {
        absPath = fileURLToPath(uri);
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
      content: [{ type: "text" as const, text: `No diagnostics across ${running.length} running server(s) (${langs}).` }],
      details: { count: 0 },
    };
  }

  // Sort: errors first, then by file path
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
    other > 0 ? `${other} other` : null,
  ].filter(Boolean).join(", ");

  const lines = allDiagnostics.map((d) => formatDiagnostic(d.diag, d.relPath));
  const output = lines.join("\n");

  const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let resultText = `${summary}\n\n${truncation.content}`;
  if (truncation.truncated) {
    resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} diagnostics]`;
  }

  return {
    content: [{ type: "text" as const, text: resultText }],
    details: { count: allDiagnostics.length, errors, warnings, files: fileCount },
  };
}
