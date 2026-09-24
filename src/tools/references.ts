/**
 * lsp_references — Find all references to a symbol.
 */

import { Type } from "typebox";
import type { Location } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { formatLocation } from "../shared/format.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";

const ReferencesParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically." })),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "Include the declaration in results (default: true)" })
  ),
});

interface ReferencesDetails { count: number }

export function createReferencesTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): ToolDefinition<typeof ReferencesParams, ReferencesDetails> {
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
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { count: 0 } };
        }
      }

      if (line === undefined || character === undefined) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { count: 0 } };
      }

      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
      }

      const uri = manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };

      try {
        const locations = await client.sendRequest<Location[] | null>("textDocument/references", {
          textDocument: { uri }, position,
          context: { includeDeclaration: params.includeDeclaration ?? true },
        });

        if (!locations || locations.length === 0) {
          const text = resolvedFrom ? `${resolvedFrom}\n\nNo references found.` : "No references found.";
          return { content: [{ type: "text", text }], details: { count: 0 } };
        }

        const rootDir = manager.resolvePath(".");
        const formatted = locations.map((l) => formatLocation(l, rootDir));
        const output = formatted.join("\n");

        const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let resultText = `${locations.length} reference(s) found:\n\n${truncation.content}`;
        if (truncation.truncated) {
          resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} references]`;
        }
        if (resolvedFrom) resultText = `${resolvedFrom}\n\n${resultText}`;

        return { content: [{ type: "text", text: resultText }], details: { count: locations.length } };
      } catch (err: any) {
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
