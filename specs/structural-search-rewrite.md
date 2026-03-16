# Structural Code Search & Rewrite

## Summary

Add AST-based structural search and rewrite tools powered by tree-sitter's query language. Find and transform code by structure, not text — enabling safe, language-aware refactoring that grep and sed can't do.

## Motivation

Text-based search (`grep`, `rg`) matches strings, not code structure. Searching for `console.log` catches comments and string literals. Replacing `var` with `const` via regex can break template literals and object keys.

Kiro CLI offers `pattern_search` and `pattern_rewrite` with metavariable support (`$VAR` matches any single node, `$$$` matches zero-or-more). This is genuinely useful for the LLM — it can propose structural transformations and preview them safely.

## Goals

- **`code_search` tool** — find code matching a structural pattern, returning locations and matched fragments
- **`code_rewrite` tool** — transform code matching a pattern into a replacement pattern, with dry-run support
- **Metavariable syntax** — `$NAME` for single nodes, `$$$` for variadic sequences, matching Kiro's convention
- **Multi-language** — works for any language with a tree-sitter grammar loaded (see tree-sitter-integration spec)

## Non-goals

- Type-aware matching (e.g., "find all calls where the argument is a `string`") — that needs LSP
- Cross-file rewrite coordination (e.g., updating imports when renaming) — use `lsp_rename` for that
- Custom query language exposure — we translate metavariable patterns to tree-sitter queries internally

## Depends on

- [Tree-sitter Integration](./tree-sitter-integration.md) — requires the parser-manager and grammar loading infrastructure

## Design

### Pattern syntax

User-facing patterns use a simplified syntax with metavariables:

```
// Single node capture
console.log($ARG)           → matches console.log(x), console.log("hello"), etc.

// Variadic capture
function $NAME($$$PARAMS) { $$$ }  → matches any function declaration

// Literal matching
$OBJ.hasOwnProperty($KEY)  → matches foo.hasOwnProperty("bar")
```

Internally, patterns are compiled to tree-sitter S-expression queries with `@capture` nodes.

### Pattern compilation

1. Parse the pattern string as code in the target language using tree-sitter
2. Walk the resulting AST and replace metavariable identifiers with query captures:
   - `$NAME` → `(_) @name` (single node wildcard)
   - `$$$PARAMS` → `(_)* @params` (variadic wildcard)
   - Literal nodes stay as concrete matchers
3. Produce a tree-sitter query string

Edge cases:
- Pattern doesn't parse → try wrapping in expression context, then statement context
- Ambiguous parse → return error with suggestion to be more specific

### Tools

#### `code_search`

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Structural pattern with metavariables |
| `language` | string | Target language (typescript, python, rust, etc.) |
| `path` | string? | File or directory to search (default: workspace root) |
| `max_results` | number? | Cap results (default: 50) |

Returns a list of matches with:
- File path, line number, column
- Matched source text
- Captured metavariable bindings (e.g., `$NAME = "fetchUser"`)

#### `code_rewrite`

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Pattern to match |
| `replacement` | string | Replacement pattern using same metavariables |
| `language` | string | Target language |
| `path` | string? | File or directory scope |
| `dry_run` | boolean? | Preview changes without applying (default: true) |

Returns:
- In dry-run mode: list of planned changes (file, line, before → after)
- In apply mode: summary of changes made, number of files modified

The tool applies changes via pi's `write` internally (so auto-diagnostics fire and the LLM sees any errors introduced).

### Matching engine

For each file in scope:
1. Parse with tree-sitter (reuse cached trees from workspace index)
2. Run the compiled query against the tree
3. Collect matches, extract captured nodes
4. For rewrites: reconstruct the replacement by substituting captured text into the replacement pattern
5. Apply replacements bottom-up (last match first) to preserve byte offsets

### File layout

```
src/
├── tree-sitter/
│   ├── pattern-compiler.ts   # Metavariable pattern → tree-sitter query
│   ├── search-engine.ts      # Run queries across files, collect matches
│   └── rewrite-engine.ts     # Apply replacement patterns
└── tools/
    ├── code-search.ts
    └── code-rewrite.ts
```

## Examples

### Find all `.unwrap()` calls in Rust
```
pattern: $E.unwrap()
language: rust
```

### Convert `var` to `const` in JavaScript
```
pattern: var $N = $V
replacement: const $N = $V
language: javascript
```

### Find async functions with no await
```
pattern: async function $NAME($$$) { $$$ }
language: typescript
```
(Post-filter: check that no captured body node contains `await` — this may need a two-pass approach or a `filter` parameter in a future iteration.)

## Open questions

- **Pattern ambiguity** — some patterns could match at multiple AST levels (expression vs. statement). Should we default to the most specific match, or let the user specify?
- **Replacement formatting** — after substitution, should we auto-format the result (e.g., via `prettier` or LSP formatting)? Or leave as-is?
- **Conflict with `lsp_rename`** — structural rewrite overlaps with rename for simple cases. The system prompt should guide the LLM: use `lsp_rename` for symbol renames (semantically correct), use `code_rewrite` for structural transformations.
