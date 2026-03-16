/**
 * lsp_hover — Get type information and documentation at a position.
 */

import { Type } from "@sinclair/typebox";
import type { Hover, MarkupContent } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { resolveProvider } from "../resolve-provider.js";
import { getEnclosingDeclaration, getSignatureText } from "../tree-sitter/symbol-extractor.js";
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
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
});

interface HoverDetails { hasResult: boolean }

export function createHoverTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): ToolDefinition<typeof HoverParams, HoverDetails> {
  return {
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get type information and documentation for a symbol at a specific position in a file. Line and character are 1-indexed.",
    promptSnippet: "Get type info and docs for a symbol at a file position via LSP",
    parameters: HoverParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        // LSP path
        const uri = manager.getFileUri(filePath);
        const position = { line: params.line - 1, character: params.character - 1 };

        try {
          const hover = await client.sendRequest<Hover | null>("textDocument/hover", {
            textDocument: { uri }, position,
          });
          if (!hover) {
            return { content: [{ type: "text", text: "No hover information available at this position." }], details: { hasResult: false } };
          }
          return { content: [{ type: "text", text: formatHoverContent(hover) }], details: { hasResult: true } };
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
              const decl = getEnclosingDeclaration(tree, params.line - 1, params.character - 1);
              if (decl) {
                const sig = getSignatureText(decl);
                const kindLabel = decl.type.replace(/_/g, " ");
                const text = `${kindLabel} [tree-sitter]\n\n\`\`\`\n${sig}\n\`\`\``;
                return { content: [{ type: "text", text }], details: { hasResult: true } };
              }
              return { content: [{ type: "text", text: "No hover information available at this position. [tree-sitter]" }], details: { hasResult: false } };
            }
          } catch { /* fall through */ }
        }
      }

      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { hasResult: false } };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_hover "));
      text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
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
