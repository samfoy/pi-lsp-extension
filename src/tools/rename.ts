/**
 * lsp_rename — Preview a rename refactoring across the workspace.
 * Returns planned edits but does NOT apply them.
 */

import { Type } from "@sinclair/typebox";
import type { WorkspaceEdit, TextEdit } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

function formatWorkspaceEdit(edit: WorkspaceEdit, rootDir: string): { summary: string; fileCount: number; editCount: number } {
  const lines: string[] = [];
  let totalEdits = 0;
  let fileCount = 0;

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change && "edits" in change) {
        fileCount++;
        let relPath: string;
        try { relPath = relative(rootDir, fileURLToPath(change.textDocument.uri)); } catch { relPath = change.textDocument.uri; }
        lines.push(`${relPath}:`);
        for (const textEdit of change.edits as TextEdit[]) {
          const line = textEdit.range.start.line + 1;
          const col = textEdit.range.start.character + 1;
          lines.push(`  ${line}:${col} → "${textEdit.newText}"`);
          totalEdits++;
        }
      }
    }
  }

  const changes = edit.changes ?? {};
  for (const [uri, edits] of Object.entries(changes)) {
    fileCount++;
    let relPath: string;
    try { relPath = relative(rootDir, fileURLToPath(uri)); } catch { relPath = uri; }
    lines.push(`${relPath}:`);
    for (const textEdit of edits) {
      const line = textEdit.range.start.line + 1;
      const col = textEdit.range.start.character + 1;
      lines.push(`  ${line}:${col} → "${textEdit.newText}"`);
      totalEdits++;
    }
  }

  return { summary: lines.join("\n"), fileCount, editCount: totalEdits };
}

const RenameParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
  newName: Type.String({ description: "New name for the symbol" }),
});

interface RenameDetails { fileCount: number; editCount: number }

export function createRenameTool(manager: LspManager): ToolDefinition<typeof RenameParams, RenameDetails> {
  return {
    name: "lsp_rename",
    label: "LSP Rename",
    description: "Preview a rename refactoring for a symbol at a position. Returns the list of changes that would be made across all files. Does NOT apply the changes — use edit/write tools to apply them. Line and character are 1-indexed.",
    promptSnippet: "Preview rename refactoring for a symbol (returns planned edits, does not apply them)",
    parameters: RenameParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { fileCount: 0, editCount: 0 } };
      }

      const uri = manager.getFileUri(filePath);
      const position = { line: params.line - 1, character: params.character - 1 };

      try {
        const result = await client.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
          textDocument: { uri }, position, newName: params.newName,
        });

        if (!result) {
          return { content: [{ type: "text", text: "Rename not possible at this position." }], details: { fileCount: 0, editCount: 0 } };
        }

        const rootDir = manager.resolvePath(".");
        const { summary, fileCount, editCount } = formatWorkspaceEdit(result, rootDir);

        if (editCount === 0) {
          return { content: [{ type: "text", text: "No edits needed for this rename." }], details: { fileCount: 0, editCount: 0 } };
        }

        const truncation = truncateHead(summary, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let text = `Rename "${params.newName}": ${editCount} edit(s) across ${fileCount} file(s)\n\n`;
        text += "NOTE: These changes are NOT applied. Use edit/write tools to make the changes.\n\n";
        text += truncation.content;
        if (truncation.truncated) text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;

        return { content: [{ type: "text", text }], details: { fileCount, editCount } };
      } catch (err: any) {
        return { content: [{ type: "text", text: `LSP rename request failed: ${err.message}` }], details: { fileCount: 0, editCount: 0 } };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_rename "));
      text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      text += theme.fg("muted", ` → ${args.newName}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Computing..."), 0, 0);
      const details = result.details;
      if (!details || details.editCount === 0) return new Text(theme.fg("dim", "No edits"), 0, 0);
      return new Text(theme.fg("success", `${details.editCount} edit(s) in ${details.fileCount} file(s) (preview only)`), 0, 0);
    },
  };
}
