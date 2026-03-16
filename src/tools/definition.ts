/**
 * lsp_definition — Go to the definition of a symbol.
 */

import { Type } from "@sinclair/typebox";
import type { Location, LocationLink } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";
import { resolveProvider } from "../resolve-provider.js";
import { getNodeAtPosition, findDefinition } from "../tree-sitter/symbol-extractor.js";
import { formatLocation, formatLocationLink } from "../shared/format.js";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

type DefinitionResult = Location | Location[] | LocationLink[] | null;

const DefinitionParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
});

interface DefinitionDetails { count: number }

export function createDefinitionTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
  workspaceIndex?: WorkspaceIndex | null,
): ToolDefinition<typeof DefinitionParams, DefinitionDetails> {
  return {
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Go to the definition of a symbol at a specific position. Returns the file path and location of the definition. Line and character are 1-indexed.",
    promptSnippet: "Jump to the definition of a symbol at a file position via LSP",
    parameters: DefinitionParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);

      if (client) {
        // LSP path
        const uri = manager.getFileUri(filePath);
        const position = { line: params.line - 1, character: params.character - 1 };

        try {
          const result = await client.sendRequest<DefinitionResult>("textDocument/definition", {
            textDocument: { uri }, position,
          });

          if (!result) return { content: [{ type: "text", text: "No definition found." }], details: { count: 0 } };

          const rootDir = manager.resolvePath(".");
          let locations: string[];

          if (Array.isArray(result)) {
            if (result.length === 0) return { content: [{ type: "text", text: "No definition found." }], details: { count: 0 } };
            if ("targetUri" in result[0]) {
              locations = (result as LocationLink[]).map((l) => formatLocationLink(l, rootDir));
            } else {
              locations = (result as Location[]).map((l) => formatLocation(l, rootDir));
            }
          } else {
            locations = [formatLocation(result as Location, rootDir)];
          }

          const text = locations.length === 1
            ? `Definition: ${locations[0]}`
            : `Definitions:\n${locations.map((l) => `  ${l}`).join("\n")}`;

          return { content: [{ type: "text", text }], details: { count: locations.length } };
        } catch (err: any) {
          return { content: [{ type: "text", text: `LSP definition request failed: ${err.message}` }], details: { count: 0 } };
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
              // Get the symbol name at the cursor position
              const node = getNodeAtPosition(tree, params.line - 1, params.character - 1);
              if (node) {
                const symbolName = node.text;
                const rootDir = manager.resolvePath(".");
                const relPath = relative(rootDir, absPath);

                // Search current file first
                const localDefs = findDefinition(tree, symbolName, provider.languageId);
                if (localDefs.length > 0) {
                  const locations = localDefs.map((d) => `${relPath}:${d.line}:1`);
                  const text = locations.length === 1
                    ? `Definition [tree-sitter]: ${locations[0]}`
                    : `Definitions [tree-sitter]:\n${locations.map((l) => `  ${l}`).join("\n")}`;
                  return { content: [{ type: "text", text }], details: { count: locations.length } };
                }

                // Search workspace index
                if (workspaceIndex) {
                  await workspaceIndex.build();
                  const entries = workspaceIndex.search(symbolName);
                  // Filter to exact name matches for definitions
                  const exact = entries.filter((e) => e.name === symbolName);
                  if (exact.length > 0) {
                    const locations = exact.slice(0, 10).map((e) => {
                      const rel = relative(rootDir, e.file);
                      return `${rel}:${e.line}:1`;
                    });
                    const text = locations.length === 1
                      ? `Definition [tree-sitter]: ${locations[0]}`
                      : `Definitions [tree-sitter]:\n${locations.map((l) => `  ${l}`).join("\n")}`;
                    return { content: [{ type: "text", text }], details: { count: locations.length } };
                  }
                }

                return { content: [{ type: "text", text: `No definition found for "${symbolName}" [tree-sitter]` }], details: { count: 0 } };
              }
            }
          } catch { /* fall through */ }
        }
      }

      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_definition "));
      text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Resolving..."), 0, 0);
      const content = result.content[0];
      if (content?.type === "text") return new Text(theme.fg("dim", content.text), 0, 0);
      return new Text(theme.fg("dim", "No result"), 0, 0);
    },
  };
}
