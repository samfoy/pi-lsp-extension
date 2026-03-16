/**
 * code_overview — Summarize project structure, key files, and symbols.
 *
 * Uses tree-sitter for symbol extraction. Shows:
 * - Directory tree (respecting .gitignore, max depth ~3)
 * - Top-level symbols per key file
 * - Dependency manifests
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { resolve, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";
import { extractSymbols } from "../tree-sitter/symbol-extractor.js";
import { SKIP_DIRS } from "../shared/constants.js";

// Shared constant imported from ../shared/constants.ts

/** Known dependency manifest files */
const MANIFESTS = [
  "package.json", "Cargo.toml", "go.mod", "go.sum",
  "pom.xml", "build.gradle", "build.gradle.kts",
  "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg",
  "Gemfile", "Makefile", "CMakeLists.txt",
];

/** Known entry point patterns */
const ENTRY_PATTERNS = [
  "index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js",
  "main.py", "app.py", "__init__.py",
  "main.rs", "lib.rs",
  "main.go",
  "Main.java", "Application.java",
];

const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 200;

const OverviewParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Root directory to analyze (defaults to project root)" })),
  depth: Type.Optional(Type.Number({ description: "Maximum directory depth (default: 3)" })),
});

interface OverviewDetails { files: number; symbols: number }

export function createCodeOverviewTool(
  rootDirOrGetter: string | (() => string),
  treeSitter: TreeSitterManager,
  workspaceIndex: WorkspaceIndex,
): ToolDefinition<typeof OverviewParams, OverviewDetails> {
  const getRootDir = typeof rootDirOrGetter === "function" ? rootDirOrGetter : () => rootDirOrGetter;

  return {
    name: "code_overview",
    label: "Code Overview",
    description: "Summarize project structure: directory tree, top-level symbols per key file, dependency manifests. Uses tree-sitter for symbol extraction — no LSP required.",
    promptSnippet: "Get a structural overview of the project (directories, key files, symbols)",
    parameters: OverviewParams,

    async execute(_toolCallId, params) {
      const rootDir = getRootDir();
      const targetDir = resolve(rootDir, params.path ?? ".");
      const maxDepth = params.depth ?? MAX_TREE_DEPTH;

      const sections: string[] = [];
      let totalFiles = 0;
      let totalSymbols = 0;

      // 1. Directory tree
      const treeLines: string[] = [];
      await buildTree(targetDir, "", 0, maxDepth, treeLines);
      totalFiles = treeLines.filter((l) => !l.endsWith("/")).length;
      sections.push("## Directory Structure\n\n```\n" + treeLines.join("\n") + "\n```");

      // 2. Dependency manifests
      const manifests: string[] = [];
      for (const m of MANIFESTS) {
        const path = resolve(targetDir, m);
        if (existsSync(path)) {
          manifests.push(m);
        }
      }
      if (manifests.length > 0) {
        sections.push("## Dependency Manifests\n\n" + manifests.map((m) => `- ${m}`).join("\n"));
      }

      // 3. Key files with symbols
      const keyFiles = await findKeyFiles(targetDir);
      if (keyFiles.length > 0) {
        const symbolSections: string[] = [];
        for (const file of keyFiles.slice(0, 10)) {
          try {
            const content = await readFile(file, "utf-8");
            const languageId = treeSitter.getLanguageId(file);
            if (!languageId) continue;

            const tree = await treeSitter.parse(file, content);
            if (!tree) continue;

            const symbols = extractSymbols(tree, languageId);
            if (symbols.length === 0) continue;

            const relPath = relative(targetDir, file);
            const symbolLines = symbols.slice(0, 20).map((s) => {
              const kindNames: Record<number, string> = {
                5: "class", 6: "method", 10: "enum", 11: "interface",
                12: "function", 13: "variable", 14: "constant", 22: "struct",
              };
              const kind = kindNames[s.kind] ?? "symbol";
              return `  ${kind} ${s.name} (line ${s.line})`;
            });
            if (symbols.length > 20) {
              symbolLines.push(`  ... and ${symbols.length - 20} more`);
            }
            totalSymbols += symbols.length;
            symbolSections.push(`### ${relPath}\n${symbolLines.join("\n")}`);
          } catch { /* skip */ }
        }
        if (symbolSections.length > 0) {
          sections.push("## Key Files\n\n" + symbolSections.join("\n\n"));
        }
      }

      // 4. Workspace index stats
      if (workspaceIndex.isBuilt) {
        const stats = workspaceIndex.getStats();
        sections.push(`## Index Stats\n\n- ${stats.files} indexed files\n- ${stats.symbols} symbols`);
      }

      const output = sections.join("\n\n");
      const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let text = truncation.content;
      if (truncation.truncated) {
        text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }

      return {
        content: [{ type: "text", text }],
        details: { files: totalFiles, symbols: totalSymbols },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("code_overview "));
      if (args.path) text += theme.fg("accent", args.path);
      else text += theme.fg("dim", "(project root)");
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Analyzing..."), 0, 0);
      const d = result.details;
      if (!d) return new Text(theme.fg("dim", "No overview"), 0, 0);
      return new Text(theme.fg("success", `${d.files} files, ${d.symbols} symbols`), 0, 0);
    },
  };
}

/** Build a directory tree representation */
async function buildTree(
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): Promise<void> {
  if (depth > maxDepth || lines.length > MAX_TREE_ENTRIES) return;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Sort: directories first, then files
    const sorted = entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < sorted.length; i++) {
      if (lines.length > MAX_TREE_ENTRIES) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }

      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          lines.push(`${prefix}${connector}${entry.name}/ (skipped)`);
          continue;
        }
        lines.push(`${prefix}${connector}${entry.name}/`);
        await buildTree(
          resolve(dir, entry.name),
          prefix + childPrefix,
          depth + 1,
          maxDepth,
          lines,
        );
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch { /* permission denied */ }
}

/** Find key/entry-point files in the project */
async function findKeyFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  // Check common entry point locations
  const searchDirs = [dir, resolve(dir, "src"), resolve(dir, "lib"), resolve(dir, "app")];

  for (const searchDir of searchDirs) {
    for (const pattern of ENTRY_PATTERNS) {
      const fullPath = resolve(searchDir, pattern);
      if (existsSync(fullPath)) {
        found.push(fullPath);
      }
    }
  }

  return [...new Set(found)]; // deduplicate
}
