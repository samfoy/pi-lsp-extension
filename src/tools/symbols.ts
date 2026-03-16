/**
 * lsp_symbols — List symbols in a file or search workspace symbols.
 */

import { Type } from "@sinclair/typebox";
import { SymbolKind, type DocumentSymbol, type SymbolInformation, type WorkspaceSymbol } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";
import { resolveProvider } from "../resolve-provider.js";
import { extractSymbols, type SymbolInfo } from "../tree-sitter/symbol-extractor.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const SYMBOL_KIND_NAMES: Record<number, string> = {
  [SymbolKind.File]: "file", [SymbolKind.Module]: "module", [SymbolKind.Namespace]: "namespace",
  [SymbolKind.Package]: "package", [SymbolKind.Class]: "class", [SymbolKind.Method]: "method",
  [SymbolKind.Property]: "property", [SymbolKind.Field]: "field", [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Enum]: "enum", [SymbolKind.Interface]: "interface", [SymbolKind.Function]: "function",
  [SymbolKind.Variable]: "variable", [SymbolKind.Constant]: "constant", [SymbolKind.String]: "string",
  [SymbolKind.Number]: "number", [SymbolKind.Boolean]: "boolean", [SymbolKind.Array]: "array",
  [SymbolKind.Object]: "object", [SymbolKind.Key]: "key", [SymbolKind.Null]: "null",
  [SymbolKind.EnumMember]: "enum-member", [SymbolKind.Struct]: "struct", [SymbolKind.Event]: "event",
  [SymbolKind.Operator]: "operator", [SymbolKind.TypeParameter]: "type-param",
};

function kindName(kind: SymbolKind): string {
  return SYMBOL_KIND_NAMES[kind] ?? `kind(${kind})`;
}

function formatDocumentSymbol(sym: DocumentSymbol, indent: number = 0): string[] {
  const prefix = "  ".repeat(indent);
  const line = sym.range.start.line + 1;
  const result = [`${prefix}${kindName(sym.kind)} ${sym.name} (line ${line})`];
  if (sym.children) {
    for (const child of sym.children) result.push(...formatDocumentSymbol(child, indent + 1));
  }
  return result;
}

function formatSymbolInfo(sym: SymbolInformation | WorkspaceSymbol, rootDir: string): string {
  let location = "";
  if ("location" in sym && sym.location) {
    try {
      const absPath = fileURLToPath(sym.location.uri);
      const relPath = relative(rootDir, absPath);
      const loc = sym.location as any;
      const line = loc.range ? loc.range.start.line + 1 : "?";
      location = ` ${relPath}:${line}`;
    } catch {
      location = ` ${sym.location.uri}`;
    }
  }
  return `${kindName(sym.kind)} ${sym.name}${location}`;
}

const SymbolsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "File path for document symbols" })),
  query: Type.Optional(Type.String({ description: "Search query for workspace symbols (searches across all files)" })),
});

interface SymbolsDetails { count: number }

function formatTreeSitterSymbol(sym: SymbolInfo, indent: number = 0): string[] {
  const prefix = "  ".repeat(indent);
  const kindStr = SYMBOL_KIND_NAMES[sym.kind] ?? `kind(${sym.kind})`;
  const result = [`${prefix}${kindStr} ${sym.name} (line ${sym.line})`];
  if (sym.children) {
    for (const child of sym.children) result.push(...formatTreeSitterSymbol(child, indent + 1));
  }
  return result;
}

export function createSymbolsTool(
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
  workspaceIndex?: WorkspaceIndex | null,
): ToolDefinition<typeof SymbolsParams, SymbolsDetails> {
  return {
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: "List symbols in a file (document symbols) or search for symbols across the workspace. Provide 'path' for file symbols or 'query' for workspace search.",
    promptSnippet: "List symbols in a file or search workspace symbols via LSP",
    parameters: SymbolsParams,

    async execute(_toolCallId, params) {
      const filePath = params.path?.replace(/^@/, "");
      const query = params.query;

      if (!filePath && query === undefined) {
        return {
          content: [{ type: "text", text: "Please provide either 'path' for file symbols or 'query' for workspace symbol search." }],
          details: { count: 0 },
        };
      }

      // Document symbols
      if (filePath) {
        const client = await manager.getClientForFile(filePath).catch(() => null);
        if (client) {
          // LSP path
          const uri = manager.getFileUri(filePath);
          try {
            const result = await client.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
              "textDocument/documentSymbol", { textDocument: { uri } }
            );

            if (!result || result.length === 0) {
              return { content: [{ type: "text", text: "No symbols found in this file." }], details: { count: 0 } };
            }

            let lines: string[];
            if ("range" in result[0]) {
              lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
            } else {
              const rootDir = manager.resolvePath(".");
              lines = (result as SymbolInformation[]).map((s) => formatSymbolInfo(s, rootDir));
            }

            const output = lines.join("\n");
            const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
            let text = `${lines.length} symbol(s):\n\n${truncation.content}`;
            if (truncation.truncated) text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;

            return { content: [{ type: "text", text }], details: { count: lines.length } };
          } catch (err: any) {
            return { content: [{ type: "text", text: `LSP document symbols request failed: ${err.message}` }], details: { count: 0 } };
          }
        }

        // Tree-sitter fallback for document symbols
        if (treeSitter) {
          const provider = resolveProvider(filePath, manager, treeSitter);
          if (provider.type === "tree-sitter") {
            try {
              const absPath = manager.resolvePath(filePath);
              const content = await readFile(absPath, "utf-8");
              const tree = await treeSitter.parse(absPath, content);
              if (tree) {
                const symbols = extractSymbols(tree, provider.languageId);
                if (symbols.length === 0) {
                  return { content: [{ type: "text", text: "No symbols found in this file." }], details: { count: 0 } };
                }
                const lines = symbols.flatMap((s) => formatTreeSitterSymbol(s));
                const output = lines.join("\n");
                const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
                let text = `${lines.length} symbol(s) [tree-sitter]:\n\n${truncation.content}`;
                if (truncation.truncated) text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
                return { content: [{ type: "text", text }], details: { count: lines.length } };
              }
            } catch { /* fall through */ }
          }
        }

        return { content: [{ type: "text", text: manager.getUnavailableReason(filePath) }], details: { count: 0 } };
      }

      // Workspace symbol search
      const statuses = manager.getStatus();
      const runningLang = statuses.find((s) => s.running)?.languageId;

      if (runningLang) {
        const client = await manager.getClientForLanguage(runningLang).catch(() => null);
        if (client) {
          try {
            const result = await client.sendRequest<(SymbolInformation | WorkspaceSymbol)[] | null>(
              "workspace/symbol", { query: query ?? "" }
            );

            if (!result || result.length === 0) {
              return { content: [{ type: "text", text: `No workspace symbols found for query: "${query}"` }], details: { count: 0 } };
            }

            const rootDir = manager.resolvePath(".");
            const lines = result.map((s) => formatSymbolInfo(s, rootDir));
            const output = lines.join("\n");

            const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
            let text = `${result.length} symbol(s) found:\n\n${truncation.content}`;
            if (truncation.truncated) text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;

            return { content: [{ type: "text", text }], details: { count: result.length } };
          } catch (err: any) {
            return { content: [{ type: "text", text: `LSP workspace symbols request failed: ${err.message}` }], details: { count: 0 } };
          }
        }
      }

      // Tree-sitter fallback for workspace symbol search
      if (workspaceIndex && query) {
        try {
          await workspaceIndex.build();
          const results = workspaceIndex.search(query);
          if (results.length === 0) {
            return { content: [{ type: "text", text: `No workspace symbols found for query: "${query}" [tree-sitter]` }], details: { count: 0 } };
          }
          const rootDir = manager.resolvePath(".");
          const lines = results.map((e) => {
            const relPath = relative(rootDir, e.file);
            return `${kindName(e.kind)} ${e.name} ${relPath}:${e.line}`;
          });
          const output = lines.join("\n");
          const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
          let text = `${results.length} symbol(s) found [tree-sitter]:\n\n${truncation.content}`;
          if (truncation.truncated) text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
          return { content: [{ type: "text", text }], details: { count: results.length } };
        } catch { /* fall through */ }
      }

      return {
        content: [{ type: "text", text: "No LSP servers are currently running and no workspace index is available. Use lsp_diagnostics or lsp_hover on a file first to start a server." }],
        details: { count: 0 },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lsp_symbols "));
      if (args.path) text += theme.fg("accent", args.path);
      if (args.query) text += theme.fg("accent", `query="${args.query}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Loading symbols..."), 0, 0);
      const details = result.details;
      if (!details || details.count === 0) return new Text(theme.fg("dim", "No symbols"), 0, 0);
      return new Text(theme.fg("success", `${details.count} symbol(s)`), 0, 0);
    },
  };
}
