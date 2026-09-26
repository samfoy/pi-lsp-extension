/**
 * lsp_hover — Get type information and documentation at a position.
 */

import { Type } from "typebox";
import type { Hover, MarkupContent } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { FileSync } from "../file-sync.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveProvider } from "../resolve-provider.js";
import { getEnclosingDeclaration, getSignatureText } from "../tree-sitter/symbol-extractor.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";
import { readFile } from "node:fs/promises";

function formatHoverContent(hover: Hover): string {
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if ("kind" in contents && "value" in contents) return (contents as MarkupContent).value;
  if ("language" in contents && "value" in contents) {
    return `\`\`\`${(contents as any).language}\n${(contents as any).value}\n\`\`\``;
  }
  if (Array.isArray(contents)) {
    return contents.map((c) => {
      if (typeof c === "string") return c;
      if ("language" in c && "value" in c) return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
      return String(c);
    }).join("\n\n");
  }
  return String(contents);
}

const HoverParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically." })),
});

interface HoverDetails { hasResult: boolean }

export function createHoverTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
  fileSync?: FileSync,
): ToolDefinition<typeof HoverParams, HoverDetails> {
  return {
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get type information and documentation for a symbol at a specific position in a file. Line and character are 1-indexed.",
    promptSnippet: "Get type info and docs for a symbol at a file position via LSP",
    parameters: HoverParams,

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
          return { content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}${hint}` }], details: { hasResult: false } };
        }
      }

      if (line === undefined || character === undefined) {
        return { content: [{ type: "text", text: "Either line/character or query is required." }], details: { hasResult: false } };
      }

      const client = await manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        // LSP path
        await fileSync?.ensureOpen(filePath); // servers like tsserver/clangd need an open document
        const uri = manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };

        try {
          const hover = await client.sendRequest<Hover | null>("textDocument/hover", {
            textDocument: { uri }, position,
          });
          if (!hover) {
            const text = resolvedFrom
              ? `${resolvedFrom}\n\nNo hover information available at this position.`
              : "No hover information available at this position.";
            return { content: [{ type: "text", text }], details: { hasResult: false } };
          }
          const hoverText = formatHoverContent(hover);
          const text = resolvedFrom ? `${resolvedFrom}\n\n${hoverText}` : hoverText;
          return { content: [{ type: "text", text }], details: { hasResult: true } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `LSP hover request failed: ${err.message}` }], details: { hasResult: false } };
        }
      }

      // Tree-sitter fallback
      if (treeSitter) {
        const provider = resolveProvider(filePath, manager, treeSitter);
        if (provider.type === "tree-sitter") {
          try {
            const absPath = manager.resolvePath(filePath);
            const content = await readFile(absPath, "utf-8");
            const tree = await treeSitter.parse(absPath, content);
            if (tree) {
              const decl = getEnclosingDeclaration(tree, line - 1, character - 1);
              if (decl) {
                const sig = getSignatureText(decl);
                const kindLabel = decl.type.replace(/_/g, " ");
                let text = `${kindLabel} [tree-sitter]\n\n\`\`\`\n${sig}\n\`\`\``;
                if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;
                return { content: [{ type: "text", text }], details: { hasResult: true } };
              }
              const text = resolvedFrom
                ? `${resolvedFrom}\n\nNo hover information available at this position. [tree-sitter]`
                : "No hover information available at this position. [tree-sitter]";
              return { content: [{ type: "text", text }], details: { hasResult: false } };
            }
          } catch { /* fall through */ }
        }
      }

      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { hasResult: false } };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_hover "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Looking up..."), 0, 0);
      if (!result.details?.hasResult) return new Text(theme.fg("dim", "No info"), 0, 0);
      const content = result.content[0];
      if (content?.type === "text") {
        const lines = content.text.split("\n").slice(0, 5);
        return new Text(lines.map((l) => theme.fg("dim", l)).join("\n"), 0, 0);
      }
      return new Text(theme.fg("dim", "No info"), 0, 0);
    },
  };
}
