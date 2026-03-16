/**
 * Workspace Index — project-wide symbol index with incremental updates.
 *
 * Walks the project tree, parses files with tree-sitter, and maintains
 * an in-memory symbol index keyed by name for fast lookup.
 */

import { resolve } from "node:path";
import { readdir, stat, readFile } from "node:fs/promises";
import { TreeSitterManager } from "./parser-manager.js";
import { extractSymbols, type SymbolInfo, type SymbolKindValue } from "./symbol-extractor.js";
import { SKIP_DIRS, MAX_FILE_SIZE, MAX_INDEX_FILES } from "../shared/constants.js";

export interface SymbolEntry {
  name: string;
  kind: SymbolKindValue;
  file: string;   // absolute path
  line: number;    // 1-indexed
}

// Shared constants imported from ../shared/constants.ts

export class WorkspaceIndex {
  /** Map from symbol name (lowercase) to entries */
  private index: Map<string, SymbolEntry[]> = new Map();
  /** Reverse index: file path → set of index keys that have entries for this file */
  private fileToKeys: Map<string, Set<string>> = new Map();
  /** Set of indexed file paths (absolute) */
  private indexedFiles: Set<string> = new Set();
  /** Whether the initial build has completed */
  private built = false;
  private building: Promise<void> | null = null;

  constructor(
    private rootDir: string,
    private treeSitter: TreeSitterManager,
  ) {}

  /** Build the index by walking the project tree. Deduplicates concurrent calls. */
  async build(): Promise<void> {
    if (this.built) return;
    if (this.building) {
      await this.building;
      return;
    }
    this.building = this._build();
    await this.building;
    this.built = true;
    this.building = null;
  }

  private async _build(): Promise<void> {
    const files = await this.collectFiles(this.rootDir);
    // Parse and index each file
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((f) => this.indexFile(f).catch(() => {})));
    }
  }

  /** Collect all indexable files under a directory */
  private async collectFiles(dir: string, collected: string[] = []): Promise<string[]> {
    if (collected.length >= MAX_INDEX_FILES) return collected;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (collected.length >= MAX_INDEX_FILES) break;

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          await this.collectFiles(resolve(dir, entry.name), collected);
        } else if (entry.isFile()) {
          const languageId = this.treeSitter.getLanguageId(entry.name);
          if (languageId && this.treeSitter.hasGrammar(languageId)) {
            collected.push(resolve(dir, entry.name));
          }
        }
      }
    } catch {
      // Permission denied or other IO error — skip
    }

    return collected;
  }

  /** Index (or re-index) a single file */
  async indexFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);

    // Remove old entries for this file
    this.removeFile(absPath);

    try {
      const stats = await stat(absPath);
      if (stats.size > MAX_FILE_SIZE) return;

      const content = await readFile(absPath, "utf-8");
      const languageId = this.treeSitter.getLanguageId(absPath);
      if (!languageId) return;

      const tree = await this.treeSitter.parse(absPath, content);
      if (!tree) return;

      const symbols = extractSymbols(tree, languageId);
      this.addSymbols(absPath, symbols);
      this.indexedFiles.add(absPath);
    } catch {
      // File might not exist or be unreadable
    }
  }

  /** Index a file from already-available content (avoids re-reading) */
  async indexFileContent(filePath: string, content: string): Promise<void> {
    const absPath = resolve(filePath);
    this.removeFile(absPath);

    const languageId = this.treeSitter.getLanguageId(absPath);
    if (!languageId) return;

    const tree = await this.treeSitter.parse(absPath, content);
    if (!tree) return;

    const symbols = extractSymbols(tree, languageId);
    this.addSymbols(absPath, symbols);
    this.indexedFiles.add(absPath);
  }

  private addSymbols(filePath: string, symbols: SymbolInfo[]): void {
    for (const sym of symbols) {
      const entry: SymbolEntry = {
        name: sym.name,
        kind: sym.kind,
        file: filePath,
        line: sym.line,
      };
      const key = sym.name.toLowerCase();
      const existing = this.index.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        this.index.set(key, [entry]);
      }

      // Track in reverse index for fast removal
      let keys = this.fileToKeys.get(filePath);
      if (!keys) {
        keys = new Set();
        this.fileToKeys.set(filePath, keys);
      }
      keys.add(key);

      // Recurse into children
      if (sym.children) {
        this.addSymbols(filePath, sym.children);
      }
    }
  }

  /** Remove all entries for a file (O(keys-per-file) via reverse index) */
  removeFile(filePath: string): void {
    const absPath = resolve(filePath);
    this.indexedFiles.delete(absPath);

    // Use reverse index for targeted removal
    const keys = this.fileToKeys.get(absPath);
    if (keys) {
      for (const key of keys) {
        const entries = this.index.get(key);
        if (!entries) continue;
        const filtered = entries.filter((e) => e.file !== absPath);
        if (filtered.length === 0) {
          this.index.delete(key);
        } else {
          this.index.set(key, filtered);
        }
      }
      this.fileToKeys.delete(absPath);
    }
  }

  /** Search for symbols matching a query (fuzzy) */
  search(query: string): SymbolEntry[] {
    if (!query) return [];
    const queryLower = query.toLowerCase();

    // Exact match first
    const exact = this.index.get(queryLower) ?? [];

    // Prefix/substring matches
    const fuzzy: SymbolEntry[] = [];
    for (const [key, entries] of this.index) {
      if (key === queryLower) continue; // already included
      if (key.includes(queryLower)) {
        fuzzy.push(...entries);
      }
    }

    // Sort: exact matches first, then by name length (shorter = more relevant)
    const results = [...exact, ...fuzzy];
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
      const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.name.length - b.name.length;
    });

    return results.slice(0, 100); // Cap results
  }

  /** Get all symbols for a specific file */
  getSymbolsForFile(filePath: string): SymbolEntry[] {
    const absPath = resolve(filePath);
    const results: SymbolEntry[] = [];
    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.file === absPath) results.push(entry);
      }
    }
    return results.sort((a, b) => a.line - b.line);
  }

  /** Get index stats */
  getStats(): { files: number; symbols: number } {
    let symbolCount = 0;
    for (const entries of this.index.values()) {
      symbolCount += entries.length;
    }
    return { files: this.indexedFiles.size, symbols: symbolCount };
  }

  /** Whether the index has been built */
  get isBuilt(): boolean {
    return this.built;
  }
}
