/**
 * lsp_references — Find all references to a symbol.
 */

import { Type } from "@sinclair/typebox";
import type { Location } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import { formatLocation } from "../shared/format.js";

const ReferencesParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "Include the declaration in results (default: true)" })
  ),
});

interface ReferencesDetails { count: number }

export function createReferencesTool(manager: LspManager): ToolDefinition<typeof ReferencesParams, ReferencesDetails> {
  return {
    name: "lsp_references",
    label: "LSP References",
    description: "Find all references to a symbol at a specific position. Returns a list of file locations. Line and character are 1-indexed.",
    promptSnippet: "Find all references to a symbol at a file position via LSP",
    parameters: ReferencesParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
      }

      const uri = manager.getFileUri(filePath);
      const position = { line: params.line - 1, character: params.character - 1 };

      try {
        const locations = await client.sendRequest<Location[] | null>("textDocument/references", {
          textDocument: { uri }, position,
          context: { includeDeclaration: params.includeDeclaration ?? true },
        });

        if (!locations || locations.length === 0) {
          return { content: [{ type: "text", text: "No references found." }], details: { count: 0 } };
        }

        const rootDir = manager.resolvePath(".");
        const formatted = locations.map((l) => formatLocation(l, rootDir));
        const output = formatted.join("\n");

        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let resultText = `${locations.length} reference(s) found:\n\n${truncation.content}`;
        if (truncation.truncated) {
          resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} references]`;
        }

        return { content: [{ type: "text", text: resultText }], details: { count: locations.length } };
      } catch (err: any) {
        return { content: [{ type: "text", text: `LSP references request failed: ${err.message}` }], details: { count: 0 } };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_references "));
      text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) return new Text(theme.fg("dim", "No references found"), 0, 0);
      return new Text(theme.fg("success", `${details.count} reference(s)`), 0, 0);
    },
  };
}
