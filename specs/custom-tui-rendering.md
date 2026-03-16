# Custom TUI Rendering

## Summary

Add `renderCall` and `renderResult` methods to the two tools that currently lack them (`code_search` and `code_rewrite`), bringing all tools to parity with the rendering quality of the LSP tools.

## Motivation

The `lsp-pi` competitor has polished TUI rendering for its unified `lsp` tool — themed headers, collapsible result previews, match counts. Our LSP tools already have good rendering (hover, diagnostics, rename, etc.), but `code_search` and `code_rewrite` fall back to the default pi rendering which dumps raw JSON-ish output.

These are high-visibility tools — structural search results and rewrite previews benefit significantly from custom formatting.

## Goals

- **`code_search`**: show a compact one-liner for the call (pattern + language + scope), and a results view with match counts, file grouping, and highlighted captured metavariables
- **`code_rewrite`**: show the call as pattern → replacement, and results as a diff-style before/after preview with file counts
- **Consistent style** — match the rendering patterns used by the existing LSP tools (themed labels, accent colors for paths, dim for metadata, success/error for status)

## Non-goals

- Interactive expansion/collapse of individual matches — pi's TUI doesn't support that level of interactivity in tool results
- Syntax highlighting of matched code — theme colors only (muted, accent, etc.), not language-aware highlighting

## Design

### `code_search` rendering

#### `renderCall`

```
code_search  console.log($ARG)  typescript  src/
```

Format: `{toolTitle bold} {pattern accent} {language dim} {path dim}`

If no path is given, omit it (workspace root is the default).

#### `renderResult`

**Collapsed (default):**
```
23 matches in 8 files
```

Use `success` color if matches found, `dim` if zero matches.

**Expanded:**
```
23 matches in 8 files

src/handler.ts:
  42:5  console.log(response)       $ARG = response
  67:3  console.log("done")         $ARG = "done"

src/utils.ts:
  12:1  console.log(err.message)    $ARG = err.message
  ...
```

Group by file, show line:col, matched text (truncated to ~60 chars), and metavariable bindings. Cap at 20 matches in collapsed view, show all in expanded.

### `code_rewrite` rendering

#### `renderCall`

```
code_rewrite  var $N = $V → const $N = $V  javascript  [dry-run]
```

Format: `{toolTitle bold} {pattern accent} → {replacement accent} {language dim} {mode dim}`

Show `[dry-run]` or `[apply]` based on the `dry_run` parameter.

#### `renderResult`

**Collapsed (default):**
```
12 replacements in 5 files (dry-run)
```

Or after apply:
```
✓ 12 replacements applied in 5 files
```

**Expanded:**
```
12 replacements in 5 files (dry-run)

src/handler.ts:
  42:  - var count = 0
       + const count = 0
  67:  - var name = "foo"
       + const name = "foo"

src/utils.ts:
  12:  - var x = arr.length
       + const x = arr.length
  ...
```

Use `error` color for `-` lines, `success` color for `+` lines. Cap preview at 10 replacements collapsed, all in expanded.

### Implementation

Both tools already return structured `details` objects — the rendering just needs to read from them.

#### `code_search` details shape (existing)

```typescript
interface CodeSearchDetails {
  matchCount: number;
  fileCount: number;
  matches: Array<{
    file: string;
    line: number;
    column: number;
    text: string;
    captures: Record<string, string>;
  }>;
}
```

#### `code_rewrite` details shape (existing)

```typescript
interface CodeRewriteDetails {
  replacementCount: number;
  fileCount: number;
  dryRun: boolean;
  replacements: Array<{
    file: string;
    line: number;
    before: string;
    after: string;
  }>;
}
```

If the current details shapes don't have all these fields, extend them as needed.

### File changes

- `src/tools/code-search.ts` — add `renderCall` and `renderResult` methods
- `src/tools/code-rewrite.ts` — add `renderCall` and `renderResult` methods

No new files needed.

## Open questions

- **Theme tokens** — the existing tools use `toolTitle`, `accent`, `dim`, `muted`, `success`, `error`, `warning`. Are there additional tokens available for diff-style rendering (e.g., `added`, `removed`)?
- **Expanded state** — does pi pass `expanded` in the `renderResult` options? Need to verify the `RenderResultOptions` type. The diagnostics tool already checks `options.expanded`.
