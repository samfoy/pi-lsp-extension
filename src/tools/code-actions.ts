/**
 * lsp_code_actions — Get available code actions (quick fixes, refactorings) at a position.
 */

import { Type } from "typebox";
import type {
  CodeAction,
  Command,
  Diagnostic,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

type CodeActionResponse = (CodeAction | Command)[] | null;

const CodeActionsParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically." })),
  endLine: Type.Optional(Type.Number({ description: "End line for range selection (1-indexed). Defaults to line." })),
  endCharacter: Type.Optional(Type.Number({ description: "End column for range selection (1-indexed). Defaults to character." })),
  kind: Type.Optional(Type.String({ description: 'Filter by action kind (e.g., "quickfix", "refactor", "source")' })),
});

interface CodeActionsDetails {
  count: number;
  preferredCount: number;
}

/** Check if a range contains a position (all 0-indexed) */
function rangeContainsPosition(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  line: number,
  character: number,
): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

/** Format a workspace edit's changes into readable lines */
function formatEditSummary(edit: WorkspaceEdit, rootDir: string): string[] {
  const lines: string[] = [];

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        let relPath: string;
        try { relPath = relative(rootDir, fileURLToPath(change.textDocument.uri)); } catch { relPath = change.textDocument.uri; }
        for (const textEdit of (change.edits as TextEdit[]).slice(0, 5)) {
          const ln = textEdit.range.start.line + 1;
          const col = textEdit.range.start.character + 1;
          const endLn = textEdit.range.end.line + 1;
          const endCol = textEdit.range.end.character + 1;
          const newText = textEdit.newText.length > 60
            ? textEdit.newText.slice(0, 57) + "..."
            : textEdit.newText;
          if (textEdit.range.start.line === textEdit.range.end.line && textEdit.range.start.character === textEdit.range.end.character) {
            lines.push(`     ${relPath}:${ln}:${col} insert "${newText.replace(/\n/g, "\\n")}"`);
          } else {
            lines.push(`     ${relPath}:${ln}:${col}-${endLn}:${endCol} → "${newText.replace(/\n/g, "\\n")}"`);
          }
        }
        const remaining = (change.edits as TextEdit[]).length - 5;
        if (remaining > 0) lines.push(`     ... and ${remaining} more edits in ${relPath}`);
      }
    }
  }

  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    let relPath: string;
    try { relPath = relative(rootDir, fileURLToPath(uri)); } catch { relPath = uri; }
    for (const textEdit of edits.slice(0, 5)) {
      const ln = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      const endLn = textEdit.range.end.line + 1;
      const endCol = textEdit.range.end.character + 1;
      const newText = textEdit.newText.length > 60
        ? textEdit.newText.slice(0, 57) + "..."
        : textEdit.newText;
      if (textEdit.range.start.line === textEdit.range.end.line && textEdit.range.start.character === textEdit.range.end.character) {
        lines.push(`     ${relPath}:${ln}:${col} insert "${newText.replace(/\n/g, "\\n")}"`);
      } else {
        lines.push(`     ${relPath}:${ln}:${col}-${endLn}:${endCol} → "${newText.replace(/\n/g, "\\n")}"`);
      }
    }
    const remaining = edits.length - 5;
    if (remaining > 0) lines.push(`     ... and ${remaining} more edits in ${relPath}`);
  }

  return lines;
}

/** Check if a response item is a CodeAction (vs a Command) */
function isCodeAction(item: CodeAction | Command): item is CodeAction {
  return "kind" in item || "edit" in item || "diagnostics" in item || "isPreferred" in item;
}

export function createCodeActionsTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): ToolDefinition<typeof CodeActionsParams, CodeActionsDetails> {
  return {
    name: "lsp_code_actions",
    label: "LSP Code Actions",
    description: "Get available code actions (quick fixes, refactorings, source actions) at a position or range. Returns actionable fixes the LSP server can suggest — auto-imports, remove unused, extract method, etc.",
    promptSnippet: "Get available code actions (quick fixes, refactorings) at a file position via LSP. Use after lsp_diagnostics shows errors to find auto-fixes.",
    parameters: CodeActionsParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      let line = params.line;
      let character = params.character;
      let resolvedFrom: string | undefined;

      // Resolve position from query if line/character not provided
      if ((line === undefined || character === undefined) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" → ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          const names = await getSymbolNames(filePath, manager, treeSitter);
          const hint = names.length > 0 ? `\nAvailable symbols: ${names.slice(0, 20).join(", ")}` : "";
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { count: 0, preferredCount: 0 } };
        }
      }

      if (line === undefined || character === undefined) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0, preferredCount: 0 } };
      }

      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0, preferredCount: 0 } };
      }

      // Check if server supports code actions
      const caps = client.serverCapabilities;
      if (caps && !caps.codeActionProvider) {
        return {
          content: [{ type: "text", text: "LSP server for this file does not support code actions." }],
          details: { count: 0, preferredCount: 0 },
        };
      }

      const uri = manager.getFileUri(filePath);
      const startLine = line - 1;
      const startChar = character - 1;
      const endLine = (params.endLine ?? line) - 1;
      const endChar = (params.endCharacter ?? character) - 1;

      // Collect diagnostics that overlap with the requested range
      const allDiags = client.getDiagnostics(uri) ?? [];
      const rangeDiags = allDiags.filter((d: Diagnostic) =>
        rangeContainsPosition(d.range, startLine, startChar) ||
        rangeContainsPosition({ start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } }, d.range.start.line, d.range.start.character)
      );

      try {
        const response = await client.sendRequest<CodeActionResponse>("textDocument/codeAction", {
          textDocument: { uri },
          range: {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar },
          },
          context: {
            diagnostics: rangeDiags,
            only: params.kind ? [params.kind] : undefined,
          },
        });

        if (!response || response.length === 0) {
          const text = resolvedFrom
            ? `${resolvedFrom}\n\nNo code actions available at this position.`
            : "No code actions available at this position.";
          return { content: [{ type: "text", text }], details: { count: 0, preferredCount: 0 } };
        }

        // Separate CodeActions from Commands, sort: preferred first, then by kind
        const actions: CodeAction[] = [];
        const commands: Command[] = [];

        for (const item of response) {
          if (isCodeAction(item)) {
            actions.push(item);
          } else {
            commands.push(item);
          }
        }

        // Sort: preferred first, then quickfix > refactor > source > other
        const kindOrder: Record<string, number> = { quickfix: 0, refactor: 1, source: 2 };
        actions.sort((a, b) => {
          if (a.isPreferred && !b.isPreferred) return -1;
          if (!a.isPreferred && b.isPreferred) return 1;
          const aKind = a.kind?.split(".")[0] ?? "zzz";
          const bKind = b.kind?.split(".")[0] ?? "zzz";
          return (kindOrder[aKind] ?? 3) - (kindOrder[bKind] ?? 3);
        });

        const rootDir = manager.resolvePath(".");
        const outputLines: string[] = [];
        let preferredCount = 0;

        for (let i = 0; i < actions.length; i++) {
          const action = actions[i];
          const preferred = action.isPreferred ? "★ " : "";
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

        // Append plain commands at the end
        for (const cmd of commands) {
          outputLines.push(`  • ${cmd.title} (command-only, requires IDE execution)`);
        }

        const totalCount = actions.length + commands.length;
        const header = `${totalCount} code action(s) at ${filePath}:${line}:${character}`;
        const preferredNote = preferredCount > 0 ? ` (${preferredCount} preferred)` : "";

        let text = `${header}${preferredNote}\n\n${outputLines.join("\n")}`;
        if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;

        return {
          content: [{ type: "text", text }],
          details: { count: totalCount, preferredCount },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `LSP code action request failed: ${err.message}` }],
          details: { count: 0, preferredCount: 0 },
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
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Loading..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) {
        return new Text(theme.fg("dim", "No code actions available"), 0, 0);
      }
      const preferred = details.preferredCount > 0 ? ` (${details.preferredCount} preferred)` : "";
      return new Text(theme.fg("success", `${details.count} action(s)${preferred}`), 0, 0);
    },
  };
}
