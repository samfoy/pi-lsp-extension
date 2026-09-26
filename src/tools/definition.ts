/**
 * lsp_definition — Go to the definition of a symbol.
 */

import { Type } from "typebox";
import type { Location, LocationLink } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { FileSync } from "../file-sync.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";
import { resolveProvider } from "../resolve-provider.js";
import { getNodeAtPosition, findDefinition } from "../tree-sitter/symbol-extractor.js";
import { formatLocation, formatLocationLink } from "../shared/format.js";
import { resolveSymbolPosition, getSymbolNames } from "../shared/resolve-position.js";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

type DefinitionResult = Location | Location[] | LocationLink[] | null;

const DefinitionParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
  character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
  query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically." })),
});

interface DefinitionDetails { count: number }

export function createDefinitionTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
  workspaceIndex?: WorkspaceIndex | null,
  fileSync?: FileSync,
): ToolDefinition<typeof DefinitionParams, DefinitionDetails> {
  return {
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Go to the definition of a symbol at a specific position. Returns the file path and location of the definition. Line and character are 1-indexed.",
    promptSnippet: "Jump to the definition of a symbol at a file position via LSP",
    parameters: DefinitionParams,

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

      if (client) {
        // LSP path
        await fileSync?.ensureOpen(filePath); // servers like tsserver/clangd need an open document
        const uri = manager.getFileUri(filePath);
        const position = { line: line - 1, character: character - 1 };

        try {
          const result = await client.sendRequest<DefinitionResult>("textDocument/definition", {
            textDocument: { uri }, position,
          });

          if (!result) {
            const text = resolvedFrom ? `${resolvedFrom}\n\nNo definition found.` : "No definition found.";
            return { content: [{ type: "text", text }], details: { count: 0 } };
          }

          const rootDir = manager.resolvePath(".");
          let locations: string[];

          if (Array.isArray(result)) {
            if (result.length === 0) {
              const text = resolvedFrom ? `${resolvedFrom}\n\nNo definition found.` : "No definition found.";
              return { content: [{ type: "text", text }], details: { count: 0 } };
            }
            if ("targetUri" in result[0]) {
              locations = (result as LocationLink[]).map((l) => formatLocationLink(l, rootDir));
            } else {
              locations = (result as Location[]).map((l) => formatLocation(l, rootDir));
            }
          } else {
            locations = [formatLocation(result as Location, rootDir)];
          }

          let text = locations.length === 1
            ? `Definition: ${locations[0]}`
            : `Definitions:\n${locations.map((l) => `  ${l}`).join("\n")}`;
          if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;

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
              const node = getNodeAtPosition(tree, line - 1, character - 1);
              if (node) {
                const symbolName = node.text;
                const rootDir = manager.resolvePath(".");
                const relPath = relative(rootDir, absPath);

                // Search current file first
                const localDefs = findDefinition(tree, symbolName, provider.languageId);
                if (localDefs.length > 0) {
                  const locs = localDefs.map((d) => `${relPath}:${d.line}:1`);
                  let text = locs.length === 1
                    ? `Definition [tree-sitter]: ${locs[0]}`
                    : `Definitions [tree-sitter]:\n${locs.map((l) => `  ${l}`).join("\n")}`;
                  if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;
                  return { content: [{ type: "text", text }], details: { count: locs.length } };
                }

                // Search workspace index
                if (workspaceIndex) {
                  await workspaceIndex.build();
                  const entries = workspaceIndex.search(symbolName);
                  const exact = entries.filter((e) => e.name === symbolName);
                  if (exact.length > 0) {
                    const rootDir2 = manager.resolvePath(".");
                    const locs = exact.slice(0, 10).map((e) => {
                      const rel = relative(rootDir2, e.file);
                      return `${rel}:${e.line}:1`;
                    });
                    let text = locs.length === 1
                      ? `Definition [tree-sitter]: ${locs[0]}`
                      : `Definitions [tree-sitter]:\n${locs.map((l) => `  ${l}`).join("\n")}`;
                    if (resolvedFrom) text = `${resolvedFrom}\n\n${text}`;
                    return { content: [{ type: "text", text }], details: { count: locs.length } };
                  }
                }

                const msg = `No definition found for "${symbolName}" [tree-sitter]`;
                const text = resolvedFrom ? `${resolvedFrom}\n\n${msg}` : msg;
                return { content: [{ type: "text", text }], details: { count: 0 } };
              }
            }
          } catch { /* fall through */ }
        }
      }

      return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_definition "));
      if (args.query && !args.line) {
        text += theme.fg("accent", `${args.path}`);
        text += theme.fg("muted", ` query="${args.query}"`);
      } else {
        text += theme.fg("accent", `${args.path}:${args.line}:${args.character}`);
      }
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
