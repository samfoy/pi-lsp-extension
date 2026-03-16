/**
 * code_search — Find code matching a structural pattern with metavariables.
 *
 * Uses tree-sitter AST matching to find code by structure, not text.
 * Supports `$NAME` for single-node wildcards and `$$$NAME` for variadic.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { relative } from "node:path";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { compilePattern } from "../tree-sitter/pattern-compiler.js";
import { searchFiles } from "../tree-sitter/search-engine.js";

const SearchParams = Type.Object({
  pattern: Type.String({ description: "Structural pattern with metavariables ($NAME for single node, $$$NAME for variadic)" }),
  language: Type.String({ description: "Target language (typescript, python, rust, java, etc.)" }),
  path: Type.Optional(Type.String({ description: "File or directory to search (default: workspace root)" })),
  max_results: Type.Optional(Type.Number({ description: "Maximum results to return (default: 50)" })),
});

interface SearchDetails {
  matchCount: number;
  filesSearched: number;
}

export function createCodeSearchTool(
  rootDirOrGetter: string | (() => string),
  treeSitter: TreeSitterManager,
): ToolDefinition<typeof SearchParams> {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;

  return {
    name: "code_search",
    label: "Code Search",
    description:
      "Find code matching a structural pattern using AST matching. " +
      "Use $NAME to match any single node, $$$NAME to match zero-or-more nodes. " +
      "More precise than grep — matches code structure, not text.",
    parameters: SearchParams,

    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const { pattern: patternStr, language, path, max_results } = params;

      // Compile the pattern
      let compiled;
      try {
        compiled = await compilePattern(patternStr, language, treeSitter);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { matchCount: 0, filesSearched: 0 },
        };
      }

      // Run the search
      const matches = await searchFiles(compiled, rootDir, treeSitter, {
        path,
        maxResults: max_results ?? 50,
      });

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          details: { matchCount: 0, filesSearched: 0 },
        };
      }

      // Format results
      const lines: string[] = [];
      lines.push(`Found ${matches.length} match${matches.length !== 1 ? "es" : ""}:\n`);

      for (const m of matches) {
        const relPath = relative(rootDir, m.file);
        const matchText = m.matchedText.length > 200
          ? m.matchedText.slice(0, 200) + "..."
          : m.matchedText;

        lines.push(`${relPath}:${m.line}:${m.column}`);
        lines.push(`  ${matchText.replace(/\n/g, "\n  ")}`);

        // Show captures
        const captureEntries = Object.entries(m.captures);
        if (captureEntries.length > 0) {
          for (const [name, value] of captureEntries) {
            const displayValue = value.length > 100 ? value.slice(0, 100) + "..." : value;
            lines.push(`  $${name} = ${displayValue}`);
          }
        }
        lines.push("");
      }

      const text = lines.join("\n");
      const uniqueFiles = new Set(matches.map((m) => m.file));

      const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: { matchCount: matches.length, filesSearched: uniqueFiles.size },
      };
    },
  };
}
