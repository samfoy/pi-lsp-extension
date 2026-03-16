/**
 * Tree-sitter Parser Manager — loads and caches WASM parsers per language.
 *
 * Uses web-tree-sitter (WASM) so no native compilation is needed.
 * Grammar .wasm files come from the tree-sitter-wasms npm package.
 */

import { resolve } from "node:path";
import Parser from "web-tree-sitter";
import { getLanguageIdFromPath } from "../shared/language-map.js";

type Language = Parser.Language;
type Tree = Parser.Tree;

/** Map language IDs to tree-sitter-wasms grammar file names */
const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  swift: "tree-sitter-swift.wasm",
  lua: "tree-sitter-lua.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm",
};

// File extension → language ID mapping is in shared/language-map.ts

interface CachedTree {
  tree: Tree;
  contentLength: number;
  hashHead: number;
  hashTail: number;
}

export class TreeSitterManager {
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private languages: Map<string, Language> = new Map();
  private loadingLanguages: Map<string, Promise<Language | null>> = new Map();
  private parsers: Map<string, Parser> = new Map();
  private cachedTrees: Map<string, CachedTree> = new Map();
  private grammarsDir: string;

  constructor() {
    // Resolve the grammars directory from tree-sitter-wasms package
    this.grammarsDir = resolve(
      new URL(".", import.meta.url).pathname,
      "../../node_modules/tree-sitter-wasms/out"
    );
  }

  /** Initialize web-tree-sitter WASM runtime. Must be called before any parsing. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    this.initializing = Parser.init({
      locateFile: (scriptName: string) => {
        // web-tree-sitter needs its own .wasm file
        return resolve(
          new URL(".", import.meta.url).pathname,
          "../../node_modules/web-tree-sitter",
          scriptName
        );
      },
    });
    await this.initializing;
    this.initialized = true;
  }

  /** Get the language ID for a file path based on extension */
  getLanguageId(filePath: string): string | undefined {
    return getLanguageIdFromPath(filePath);
  }

  /** Check if we have a grammar available for a language */
  hasGrammar(languageId: string): boolean {
    return languageId in LANGUAGE_TO_GRAMMAR;
  }

  /** Get all supported language IDs */
  getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_TO_GRAMMAR);
  }

  /** Load a language grammar, caching the result */
  async getLanguage(languageId: string): Promise<Language | null> {
    const cached = this.languages.get(languageId);
    if (cached) return cached;

    // Deduplicate concurrent loads
    const loading = this.loadingLanguages.get(languageId);
    if (loading) return loading;

    const grammarFile = LANGUAGE_TO_GRAMMAR[languageId];
    if (!grammarFile) return null;

    const loadPromise = (async (): Promise<Language | null> => {
      await this.init();
      try {
        const grammarPath = resolve(this.grammarsDir, grammarFile);
        const language = await Parser.Language.load(grammarPath);
        this.languages.set(languageId, language);
        return language;
      } catch {
        return null;
      } finally {
        this.loadingLanguages.delete(languageId);
      }
    })();

    this.loadingLanguages.set(languageId, loadPromise);
    return loadPromise;
  }

  /** Get or create a parser for a language */
  private async getParser(languageId: string): Promise<Parser | null> {
    const existing = this.parsers.get(languageId);
    if (existing) return existing;

    const language = await this.getLanguage(languageId);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    this.parsers.set(languageId, parser);
    return parser;
  }

  /** Parse a file's content and return the tree. Caches by file path + content hash. */
  async parse(filePath: string, content: string): Promise<Tree | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.parseWithLanguage(filePath, content, languageId);
  }

  /** Parse content with an explicit language ID */
  async parseWithLanguage(filePath: string, content: string, languageId: string): Promise<Tree | null> {
    const length = content.length;
    const head = djb2Hash(content, 0, Math.min(length, 4096));
    const tail = length > 4096 ? djb2Hash(content, Math.max(0, length - 4096), length) : head;
    const cached = this.cachedTrees.get(filePath);
    if (cached && cached.contentLength === length && cached.hashHead === head && cached.hashTail === tail) {
      return cached.tree;
    }

    const parser = await this.getParser(languageId);
    if (!parser) return null;

    const tree = parser.parse(content);
    if (!tree) return null;

    // Evict old tree
    if (cached) cached.tree.delete();

    this.cachedTrees.set(filePath, { tree, contentLength: length, hashHead: head, hashTail: tail });
    return tree;
  }

  /** Invalidate the cached tree for a file */
  invalidate(filePath: string): void {
    const cached = this.cachedTrees.get(filePath);
    if (cached) {
      cached.tree.delete();
      this.cachedTrees.delete(filePath);
    }
  }

  /** Get a cached tree without re-parsing */
  getCachedTree(filePath: string): Tree | null {
    return this.cachedTrees.get(filePath)?.tree ?? null;
  }

  /** Shut down — free all resources */
  shutdown(): void {
    for (const [, cached] of this.cachedTrees) cached.tree.delete();
    this.cachedTrees.clear();
    for (const [, parser] of this.parsers) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }
}

/**
 * Fast non-cryptographic hash (djb2) over a range of a string.
 * Hashing head + tail separately gives collision resistance close to
 * a full-content hash without iterating every character of large files.
 */
function djb2Hash(str: string, start: number, end: number): number {
  let hash = 5381;
  for (let i = start; i < end; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}
