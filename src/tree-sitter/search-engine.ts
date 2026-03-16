/**
 * Search Engine — run compiled patterns against source files and collect matches.
 *
 * Uses a recursive AST matcher: the target file's tree-sitter AST is walked
 * depth-first, and at each node we attempt to match the compiled pattern tree.
 * Metavariable nodes capture any single AST node; variadic nodes capture
 * zero-or-more siblings.
 */

import { resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type Parser from "web-tree-sitter";
import type { TreeSitterManager } from "./parser-manager.js";
import type {
  CompiledPattern,
  PatternNode,
} from "./pattern-compiler.js";
import { SKIP_DIRS, MAX_FILE_SIZE, MAX_INDEX_FILES } from "../shared/constants.js";

type SyntaxNode = Parser.SyntaxNode;

// ── Result types ────────────────────────────────────────────────────────────

export interface SearchMatch {
  /** Absolute file path */
  file: string;
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column */
  column: number;
  /** The matched source text */
  matchedText: string;
  /** Byte offset of match start */
  startIndex: number;
  /** Byte offset of match end */
  endIndex: number;
  /** Metavariable bindings: name → captured text */
  captures: Record<string, string>;
}

// ── Directories to skip ─────────────────────────────────────────────────────

// Shared constants imported from ../shared/constants.ts

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Search files for matches against a compiled pattern.
 */
export async function searchFiles(
  pattern: CompiledPattern,
  rootDir: string,
  treeSitter: TreeSitterManager,
  options: {
    path?: string;
    maxResults?: number;
  } = {},
): Promise<SearchMatch[]> {
  const searchRoot = options.path ? resolve(rootDir, options.path) : rootDir;
  const maxResults = options.maxResults ?? 50;

  // Determine if searchRoot is a file or directory
  const stats = await stat(searchRoot);
  let files: string[];
  if (stats.isFile()) {
    files = [searchRoot];
  } else {
    files = await collectFilesByLanguage(searchRoot, pattern.languageId, treeSitter);
  }

  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;

    try {
      const content = await readFile(file, "utf-8");
      const tree = await treeSitter.parseWithLanguage(file, content, pattern.languageId);
      if (!tree) continue;

      const fileMatches = findMatches(tree.rootNode, pattern.root);
      for (const m of fileMatches) {
        if (matches.length >= maxResults) break;
        matches.push({
          file,
          line: m.node.startPosition.row + 1,
          column: m.node.startPosition.column + 1,
          matchedText: m.node.text,
          startIndex: m.node.startIndex,
          endIndex: m.node.endIndex,
          captures: m.captures,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return matches;
}

// ── File collection ─────────────────────────────────────────────────────────

/**
 * Collect all files matching a given language under a directory.
 */
export async function collectFilesByLanguage(
  dir: string,
  languageId: string,
  treeSitter: TreeSitterManager,
  collected: string[] = [],
  maxFiles: number = MAX_INDEX_FILES,
): Promise<string[]> {
  if (collected.length >= maxFiles) return collected;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await collectFilesByLanguage(resolve(dir, entry.name), languageId, treeSitter, collected, maxFiles);
      } else if (entry.isFile()) {
        const fileLang = treeSitter.getLanguageId(entry.name);
        if (fileLang === languageId) {
          const filePath = resolve(dir, entry.name);
          try {
            const s = await stat(filePath);
            if (s.size <= MAX_FILE_SIZE) {
              collected.push(filePath);
            }
          } catch {}
        }
      }
    }
  } catch {
    // Permission denied or other IO error — skip
  }

  return collected;
}

// ── Matching engine ─────────────────────────────────────────────────────────

interface RawMatch {
  node: SyntaxNode;
  captures: Record<string, string>;
}

/**
 * Find all non-overlapping matches of the pattern in the target AST.
 * Walks the tree depth-first, attempting to match at each node.
 */
function findMatches(root: SyntaxNode, pattern: PatternNode): RawMatch[] {
  const matches: RawMatch[] = [];
  const visited = new Set<number>(); // node ids already part of a match

  function walk(node: SyntaxNode): void {
    if (visited.has(node.id)) return;

    const captures: Record<string, string> = {};
    if (matchNode(node, pattern, captures)) {
      matches.push({ node, captures });
      // Mark all descendant nodes as visited to prevent overlapping matches
      markDescendants(node, visited);
      return; // Don't recurse into matched subtree
    }

    // Recurse into children
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return matches;
}

function markDescendants(node: SyntaxNode, visited: Set<number>): void {
  visited.add(node.id);
  for (const child of node.namedChildren) {
    markDescendants(child, visited);
  }
}

/**
 * Try to match a target AST node against a pattern node.
 * Returns true if matched, populating `captures` with metavariable bindings.
 */
function matchNode(
  target: SyntaxNode,
  pattern: PatternNode,
  captures: Record<string, string>,
): boolean {
  switch (pattern.kind) {
    case "metavar": {
      // A metavar matches any single node
      const name = pattern.name;
      if (name in captures) {
        // Already captured — must match same text
        return captures[name] === target.text;
      }
      captures[name] = target.text;
      return true;
    }

    case "variadic": {
      // Variadic at the top level matches any single node
      // (variadic is really only meaningful in a children-list context)
      const name = pattern.name;
      if (name && name in captures) {
        return captures[name] === target.text;
      }
      if (name) captures[name] = target.text;
      return true;
    }

    case "literal": {
      // Must match node type
      if (target.type !== pattern.nodeType) return false;

      // Leaf node: must match text exactly
      if (pattern.text !== undefined) {
        return target.text === pattern.text;
      }

      // Branch node: use field-aware matching
      // Pattern children that have field names → match against target children with same field name
      // This allows the target to have extra children not mentioned in the pattern
      return matchChildrenFieldAware(target, pattern.children, captures);
    }
  }
}

/**
 * Match pattern children against target node's children using field-name-aware matching.
 *
 * Strategy:
 * 1. Pattern children WITH field names: find the target child with the same field name and match
 * 2. Pattern children WITHOUT field names: match positionally against unmatched target children
 * 3. Extra target children not mentioned in the pattern are allowed (implicit wildcards)
 */
function matchChildrenFieldAware(
  targetNode: SyntaxNode,
  patternChildren: PatternNode[],
  captures: Record<string, string>,
): boolean {
  // Separate pattern children into field-named and positional
  const fieldPatterns: PatternNode[] = [];
  const positionalPatterns: PatternNode[] = [];

  for (const pc of patternChildren) {
    if (pc.fieldName) {
      fieldPatterns.push(pc);
    } else {
      positionalPatterns.push(pc);
    }
  }

  // First, match all field-named pattern children
  for (const fp of fieldPatterns) {
    const targetChild = targetNode.childForFieldName(fp.fieldName!);
    if (!targetChild) return false;
    if (!matchNode(targetChild, fp, captures)) return false;
  }

  // If there are positional patterns, match them against the remaining unnamed target children
  if (positionalPatterns.length > 0) {
    // Get target children that aren't already matched by field names
    const matchedFieldNames = new Set(fieldPatterns.map(fp => fp.fieldName));
    const remainingTargets: SyntaxNode[] = [];
    for (const child of targetNode.namedChildren) {
      const childField = getChildFieldName(targetNode, child);
      if (!childField || !matchedFieldNames.has(childField)) {
        remainingTargets.push(child);
      }
    }

    return matchChildrenPositional(remainingTargets, 0, positionalPatterns, 0, captures);
  }

  return true;
}

/** Get the field name of a child node within its parent */
function getChildFieldName(parent: SyntaxNode, child: SyntaxNode): string | null {
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.id === child.id) {
      return parent.fieldNameForChild(i);
    }
  }
  return null;
}

/**
 * Match pattern children positionally against target children.
 * Handles variadic patterns that can match zero or more consecutive children.
 * Extra target children at the end are allowed (pattern doesn't need to cover all children).
 */
function matchChildrenPositional(
  targets: SyntaxNode[],
  ti: number,
  patterns: PatternNode[],
  pi: number,
  captures: Record<string, string>,
): boolean {
  // All patterns consumed — success (extra targets are OK)
  if (pi >= patterns.length) return true;

  const pat = patterns[pi];

  // Variadic pattern: try matching 0, 1, 2, ... consecutive target nodes
  if (pat.kind === "variadic") {
    const isLast = pi === patterns.length - 1;

    // Optimization: if this is the last pattern, consume all remaining
    if (isLast) {
      const remainingText = targets.slice(ti).map(t => t.text).join(", ");
      if (pat.name) {
        if (pat.name in captures && captures[pat.name] !== remainingText) return false;
        captures[pat.name] = remainingText;
      }
      return true;
    }

    // Try consuming 0..N target nodes
    for (let take = 0; take <= targets.length - ti; take++) {
      const captureSnapshot = { ...captures };
      const consumedText = targets.slice(ti, ti + take).map(t => t.text).join(", ");

      if (pat.name) {
        if (pat.name in captureSnapshot && captureSnapshot[pat.name] !== consumedText) continue;
        captureSnapshot[pat.name] = consumedText;
      }

      if (matchChildrenPositional(targets, ti + take, patterns, pi + 1, captureSnapshot)) {
        // Success — commit captures
        Object.assign(captures, captureSnapshot);
        return true;
      }
    }
    return false;
  }

  // Non-variadic pattern: must match the current target
  if (ti >= targets.length) return false;

  const captureSnapshot = { ...captures };
  if (matchNode(targets[ti], pat, captureSnapshot)) {
    if (matchChildrenPositional(targets, ti + 1, patterns, pi + 1, captureSnapshot)) {
      Object.assign(captures, captureSnapshot);
      return true;
    }
  }

  return false;
}
