/**
 * code_rewrite — Transform code matching a structural pattern into a replacement.
 *
 * Matches code by AST structure (like code_search), then applies a replacement
 * template that can reference captured metavariables. Supports dry-run preview.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { relative } from "node:path";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { compilePattern } from "../tree-sitter/pattern-compiler.js";
import { searchFiles } from "../tree-sitter/search-engine.js";
import { computeRewrites, applyRewrites } from "../tree-sitter/rewrite-engine.js";

/** Callback to notify when files are modified by rewrites */
export interface RewriteFileChangeCallback {
  onFileModified(filePath: string): void;
}

const RewriteParams = Type.Object({
  pattern: Type.String({ description: "Structural pattern to match (with $NAME / $$$NAME metavariables)" }),
  replacement: Type.String({ description: "Replacement template using the same metavariables" }),
  language: Type.String({ description: "Target language (typescript, python, rust, java, etc.)" }),
  path: Type.Optional(Type.String({ description: "File or directory scope (default: workspace root)" })),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview changes without applying (default: true)" })),
});

interface RewriteDetails {
  matchCount: number;
  filesModified: number;
  dryRun: boolean;
}

export function createCodeRewriteTool(
  rootDirOrGetter: string | (() => string),
  treeSitter: TreeSitterManager,
  fileChangeCallback?: RewriteFileChangeCallback,
): ToolDefinition<typeof RewriteParams> {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;

  return {
    name: "code_rewrite",
    label: "Code Rewrite",
    description:
      "Transform code matching a structural pattern into a replacement. " +
      "Use $NAME to capture and reuse single nodes, $$$NAME for sequences. " +
      "Defaults to dry-run mode (preview only). Set dry_run=false to apply changes. " +
      "For symbol renames, prefer lsp_rename instead (semantically correct).",
    parameters: RewriteParams,

    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const { pattern: patternStr, replacement, language, path, dry_run } = params;
      const isDryRun = dry_run !== false; // default true

      // Compile the pattern
      let compiled;
      try {
        compiled = await compilePattern(patternStr, language, treeSitter);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          details: { matchCount: 0, filesModified: 0, dryRun: isDryRun },
        };
      }

      // Validate that replacement references only known metavars
      const knownVars = new Set(compiled.metavars);
      const refRe = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;
      let refMatch;
      while ((refMatch = refRe.exec(replacement)) !== null) {
        const name = refMatch[1] ?? refMatch[2];
        if (!knownVars.has(name)) {
          return {
            content: [{ type: "text", text: `Error: Replacement references $${name} but pattern doesn't capture it. Pattern captures: ${compiled.metavars.join(", ") || "(none)"}` }],
            details: { matchCount: 0, filesModified: 0, dryRun: isDryRun },
          };
        }
      }

      // Find matches
      const matches = await searchFiles(compiled, rootDir, treeSitter, {
        path,
        maxResults: 500,
      });

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found. No changes to make." }],
          details: { matchCount: 0, filesModified: 0, dryRun: isDryRun },
        };
      }

      if (isDryRun) {
        // Preview mode
        const changes = computeRewrites(matches, replacement);
        const lines: string[] = [];
        lines.push(`Dry run: ${changes.length} change${changes.length !== 1 ? "s" : ""} would be made:\n`);

        for (const c of changes) {
          const relPath = relative(rootDir, c.file);
          lines.push(`${relPath}:${c.line}:${c.column}`);

          const beforeLines = c.before.split("\n");
          const afterLines = c.after.split("\n");

          for (const l of beforeLines) {
            lines.push(`  - ${l}`);
          }
          for (const l of afterLines) {
            lines.push(`  + ${l}`);
          }
          lines.push("");
        }

        lines.push("Run with dry_run=false to apply these changes.");

        const text = lines.join("\n");
        const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let output = truncation.content;
        if (truncation.truncated) {
          output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
        }

        const uniqueFiles = new Set(changes.map((c) => c.file));
        return {
          content: [{ type: "text", text: output }],
          details: { matchCount: matches.length, filesModified: uniqueFiles.size, dryRun: true },
        };
      }

      // Apply mode
      const result = await applyRewrites(matches, replacement);

      // Notify FileSync about modified files so LSP servers get updated
      if (fileChangeCallback && result.filesModified > 0) {
        const modifiedFiles = new Set(result.changes.map((c) => c.file));
        for (const file of modifiedFiles) {
          fileChangeCallback.onFileModified(file);
        }
      }

      const lines: string[] = [];
      lines.push(`Applied ${result.changes.length} change${result.changes.length !== 1 ? "s" : ""} across ${result.filesModified} file${result.filesModified !== 1 ? "s" : ""}:\n`);

      for (const c of result.changes) {
        const relPath = relative(rootDir, c.file);
        const beforeShort = c.before.length > 80 ? c.before.slice(0, 80) + "..." : c.before;
        const afterShort = c.after.length > 80 ? c.after.slice(0, 80) + "..." : c.after;
        lines.push(`${relPath}:${c.line} — ${beforeShort} → ${afterShort}`);
      }

      const text = lines.join("\n");
      const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: { matchCount: matches.length, filesModified: result.filesModified, dryRun: false },
      };
    },
  };
}
