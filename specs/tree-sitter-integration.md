# Tree-sitter Integration

## Summary

Add a tree-sitter layer that provides code intelligence without requiring an LSP server. This gives the extension useful symbol search, document symbols, and definition lookup out of the box for any supported language — no install step needed.

## Motivation

Today every tool in the extension requires a running LSP server. If the user hasn't installed `typescript-language-server` or `pyright`, they get nothing. Kiro CLI solves this with a built-in tree-sitter layer that covers 18 languages with zero setup.

Tree-sitter parsing is fast (incremental), works on syntactically broken files, and can power symbol search, document outlines, and basic go-to-definition without any external process.

## Goals

- **Zero-config code intelligence** — symbol search, document symbols, and definition lookup work immediately for supported languages
- **Graceful upgrade** — when an LSP server _is_ running, LSP results take priority; tree-sitter is the fallback
- **Codebase overview** — expose a tool that summarizes project structure (directories, key files, entry points) using tree-sitter symbol extraction
- **Minimal footprint** — tree-sitter WASM bindings, no native compilation required at install time

## Non-goals

- Replacing LSP — tree-sitter cannot do cross-file type resolution, find-references across files, or rename refactoring
- Supporting every language immediately — start with the languages we already support via LSP (TypeScript, JavaScript, Python, Rust, Go, Java) and expand later

## Design

### Parser management

- Use `web-tree-sitter` (WASM-based) so the extension works without native build tools
- Bundle or lazy-download `.wasm` grammar files for each supported language
- Cache parsed trees per-file; invalidate on `didChange` events from `FileSync`
- Reuse the `EXT_TO_LANGUAGE` mapping in `lsp-manager.ts` to detect language from file extension

### Fallback strategy

Each tool that currently calls the LSP checks whether a server is running for the file's language:

1. If LSP server is running and healthy → use LSP (current behavior)
2. If no LSP server → fall back to tree-sitter
3. If tree-sitter has no grammar for the language → return "no intelligence available" error

This logic lives in a shared `resolveProvider(filePath)` helper that tools call instead of going straight to `manager.getClientForFile()`.

### New tools / tool enhancements

| Tool | Tree-sitter behavior |
|------|---------------------|
| `lsp_symbols` (file) | Walk the tree-sitter AST for function, class, method, interface, enum, and variable declarations. Same output format as today. |
| `lsp_symbols` (workspace) | Scan project files (respecting `.gitignore`), parse each, and collect top-level symbols. Fuzzy-match against the query. Cache the index and update incrementally. |
| `lsp_definition` | For a symbol at a position, search the current file's tree for a matching definition node. If not found, search the workspace index. Best-effort — won't resolve imports through `node_modules` or type aliases. |
| `lsp_hover` | Extract the enclosing node's kind and text (e.g., "function declaration", the signature line). No type info — that requires LSP. |
| `lsp_diagnostics` | Tree-sitter can detect parse errors (syntax errors). Report those as a minimal diagnostic set when no LSP is available. |
| `code_overview` | **New tool.** Summarize project structure: directory tree, top-level symbols per file, entry points, dependency manifests. Uses tree-sitter for symbol extraction. |

### Workspace indexing

- On first use, walk the project tree (skip `node_modules`, `.git`, `build`, `dist`, `target`, etc.)
- Parse each file with tree-sitter, extract top-level symbols (name, kind, file, line)
- Store in an in-memory index keyed by symbol name
- Re-index individual files when `FileSync` reports changes
- For large repos, cap initial indexing at ~5000 files and index remaining on demand

### File layout

```
src/
├── tree-sitter/
│   ├── parser-manager.ts    # Load/cache WASM parsers per language
│   ├── symbol-extractor.ts  # AST → symbol list, per-language queries
│   ├── workspace-index.ts   # Project-wide symbol index
│   └── grammars/            # .wasm files (or download script)
├── resolve-provider.ts      # LSP-or-tree-sitter routing
└── tools/
    ├── code-overview.ts     # New tool
    └── ... (existing tools updated to use resolveProvider)
```

## Open questions

- **Grammar distribution** — bundle `.wasm` files in the repo (adds ~2-5 MB) or download on first use? Bundling is simpler; downloading keeps the repo small.
- **Incremental indexing performance** — is the in-memory index fast enough for monorepos with 10k+ files, or do we need SQLite/a persistent cache?
- **Query language** — tree-sitter has a built-in query language for pattern matching. Should we expose that as a user-facing feature here, or save it for the structural search spec?
