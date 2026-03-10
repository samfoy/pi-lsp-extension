/**
 * lsp_definition — Go to the definition of a symbol.
 */

import { Type } from "@sinclair/typebox";
import type { Location, LocationLink } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { LspManager } from "../lsp-manager.js";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

type DefinitionResult = Location | Location[] | LocationLink[] | null;

function formatLocation(loc: Location, rootDir: string): string {
  try {
    const absPath = fileURLToPath(loc.uri);
    const relPath = relative(rootDir, absPath);
    return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  } catch {
    return `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  }
}

function formatLocationLink(link: LocationLink, rootDir: string): string {
  try {
    const absPath = fileURLToPath(link.targetUri);
    const relPath = relative(rootDir, absPath);
    return `${relPath}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  } catch {
    return `${link.targetUri}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  }
}

const DefinitionParams = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Line number (1-indexed)" }),
  character: Type.Number({ description: "Column number (1-indexed)" }),
});

interface DefinitionDetails { count: number }

export function createDefinitionTool(manager: LspManager): ToolDefinition<typeof DefinitionParams, DefinitionDetails> {
  return {
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Go to the definition of a symbol at a specific position. Returns the file path and location of the definition. Line and character are 1-indexed.",
    promptSnippet: "Jump to the definition of a symbol at a file position via LSP",
    parameters: DefinitionParams,

    async execute(_toolCallId, params) {
      const filePath = params.path.replace(/^@/, "");
      const client = await manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { content: [{ type: "text", text: `No LSP server available for: ${filePath}` }], details: { count: 0 } } as any;
      }

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
        return { content: [{ type: "text", text: `LSP definition request failed: ${err.message}` }], details: { count: 0 } } as any;
      }
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
