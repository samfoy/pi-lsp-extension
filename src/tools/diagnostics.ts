/**
 * lsp_diagnostics — Get compilation errors and warnings for a file.
 */

import { Type } from "@sinclair/typebox";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import { relative } from "node:path";

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
  path: Type.String({ description: "File path to get diagnostics for" }),
});

interface DiagnosticsDetails {
  count: number;
  errors?: number;
  warnings?: number;
}

export function createDiagnosticsTool(manager: LspManager): ToolDefinition<typeof DiagnosticsParams, DiagnosticsDetails> {
  return {
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get compilation errors and warnings for a file from the LSP server. Returns cached diagnostics published by the language server.",
    promptSnippet: "Get compiler errors, warnings, and hints for a source file via LSP",
    promptGuidelines: [
      "After making code changes with edit or write, use lsp_diagnostics to check for compilation errors before moving on.",
    ],
    parameters: DiagnosticsParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);

      if (!client) {
        const lang = manager.getLanguageId(filePath);
        if (!lang) {
          return {
            content: [{ type: "text", text: `No LSP server configured for file type: ${filePath}` }],
            details: { count: 0 },
          };
        }
        return {
          content: [{ type: "text", text: `LSP server for ${lang} is not available. Is the server installed?` }],
          details: { count: 0 },
        } as any;
      }

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
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_diagnostics "));
      text += theme.fg("accent", args.path);
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
