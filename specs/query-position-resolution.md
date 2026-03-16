# Query-Based Position Resolution

## Summary

Add a `query` parameter to position-based tools (`lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_rename`, `lsp_signature_help`, `lsp_code_actions`) that resolves a symbol name to a file position, eliminating the need for the LLM to know exact line/column numbers when it just wants to query a known symbol.

## Motivation

Today, to hover over a function named `handleRequest`, the LLM must:

1. Know or look up the exact line and column where `handleRequest` is defined or used
2. Call `lsp_hover` with `path`, `line`, `character`

This is friction. The LLM often knows the symbol name but not the exact position. It has to call `lsp_symbols` first to find the position, then call the actual tool — two round-trips.

The `lsp-pi` competitor solves this with a `query` parameter: pass `query: "handleRequest"` and it resolves the position via document symbols before making the LSP request. This is a significant UX improvement.

## Goals

- **Optional `query` parameter** on all position-based tools
- **Symbol name resolution** — find the symbol's position in the file via document symbols (LSP) or tree-sitter
- **Fallback chain** — try LSP document symbols first, then tree-sitter symbol extraction
- **Exact > partial** — exact name match wins over substring match
- **Transparent** — when `query` is used, include the resolved position in the output so the LLM knows where it landed

## Non-goals

- Workspace-wide symbol search via query — this is file-scoped resolution. Use `lsp_symbols` with a `query` for workspace search.
- Fuzzy matching — exact and substring only. Fuzzy introduces ambiguity.
- Replacing `line`/`character` — query is an alternative, not a replacement. When both are provided, `line`/`character` take precedence.

## Design

### Parameter changes

Add to all position-based tool schemas:

```typescript
query: Type.Optional(Type.String({
  description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically."
})),
```

Tools that gain the `query` parameter:
- `lsp_hover`
- `lsp_definition`
- `lsp_references`
- `lsp_rename`
- `lsp_signature_help` (new tool)
- `lsp_code_actions` (new tool)

### Resolution logic

Create a shared resolver in `src/shared/resolve-position.ts`:

```typescript
export interface ResolvedPosition {
  line: number;       // 0-indexed (LSP convention)
  character: number;  // 0-indexed
  symbolName: string; // the matched symbol name
  source: "lsp" | "tree-sitter";
}

export async function resolveSymbolPosition(
  filePath: string,
  query: string,
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): Promise<ResolvedPosition | null> {
  // 1. Try LSP document symbols
  const client = manager.getRunningClient(manager.getLanguageId(filePath) ?? "");
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest<DocumentSymbol[]>(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      const match = findSymbolPosition(symbols, query);
      if (match) return { ...match, source: "lsp" };
    } catch { /* fall through */ }
  }

  // 2. Try tree-sitter
  if (treeSitter) {
    const absPath = manager.resolvePath(filePath);
    const content = await readFile(absPath, "utf-8");
    const tree = await treeSitter.parse(absPath, content);
    if (tree) {
      const match = findSymbolInTree(tree, query);
      if (match) return { ...match, source: "tree-sitter" };
    }
  }

  return null;
}
```

### Symbol matching (`findSymbolPosition`)

Walks the document symbol tree (recursive for children) and matches:

1. **Exact match** — `symbol.name === query` (case-sensitive)
2. **Case-insensitive exact** — `symbol.name.toLowerCase() === query.toLowerCase()`
3. **Substring match** — `symbol.name.toLowerCase().includes(query.toLowerCase())`

Returns the first match in priority order. Uses `selectionRange.start` (preferred) or `range.start` for position.

### Tree-sitter symbol matching (`findSymbolInTree`)

Uses the existing `extractSymbols` function from `symbol-extractor.ts`:

1. Extract all symbols from the tree
2. Match using the same priority chain as above
3. Return the symbol's start position

### Tool integration pattern

Each tool's `execute` function gains a preamble:

```typescript
async execute(_toolCallId, params) {
  const filePath = params.path.replace(/^@/, "");
  let line = params.line;
  let character = params.character;
  let resolvedFrom: string | undefined;

  // Resolve position from query if line/character not provided
  if ((line === undefined || character === undefined) && params.query) {
    const resolved = await resolveSymbolPosition(filePath, params.query, manager, treeSitter);
    if (resolved) {
      line = resolved.line + 1; // convert to 1-indexed
      character = resolved.character + 1;
      resolvedFrom = `Resolved "${params.query}" → ${line}:${character} [${resolved.source}]`;
    } else {
      return {
        content: [{ type: "text", text: `Could not find symbol "${params.query}" in ${filePath}` }],
        details: { hasResult: false },
      };
    }
  }

  if (line === undefined || character === undefined) {
    return {
      content: [{ type: "text", text: "Either line/character or query is required." }],
      details: { hasResult: false },
    };
  }

  // ... existing tool logic using line/character ...

  // Prepend resolved position to output if query was used
  if (resolvedFrom) {
    const existingText = result.content[0]?.text ?? "";
    result.content[0] = { type: "text", text: `${resolvedFrom}\n\n${existingText}` };
  }

  return result;
}
```

### Validation rules

- If both `line`/`character` and `query` are provided: use `line`/`character`, ignore `query`
- If neither is provided: return error "Either line/character or query is required."
- If `query` is provided but doesn't match any symbol: return error with the file's top-level symbol names as a hint
- `line` and `character` remain individually required when `query` is not used (can't provide just `line` without `character`)

### Parameter schema update

The `line` and `character` parameters change from required to optional:

```typescript
// Before
line: Type.Number({ description: "Line number (1-indexed)" }),
character: Type.Number({ description: "Column number (1-indexed)" }),

// After
line: Type.Optional(Type.Number({ description: "Line number (1-indexed). Required unless query is provided." })),
character: Type.Optional(Type.Number({ description: "Column number (1-indexed). Required unless query is provided." })),
query: Type.Optional(Type.String({ description: "Symbol name to find in the file. Alternative to line/character." })),
```

### `renderCall` updates

When query is used instead of line/character:

```
lsp_hover  src/handler.ts  query="handleRequest"
```

When line/character is used (unchanged):

```
lsp_hover  src/handler.ts:42:10
```

### System prompt update

Add a guideline:

```
Position-based LSP tools (lsp_hover, lsp_definition, lsp_references, lsp_rename, lsp_signature_help, lsp_code_actions) accept either line/character or a query parameter. Use query when you know the symbol name but not the exact position — it resolves the position automatically via document symbols.
```

### File layout

```
src/shared/
└── resolve-position.ts    # New: shared position resolver

src/tools/
├── hover.ts               # Modified: add query param
├── definition.ts          # Modified: add query param
├── references.ts          # Modified: add query param
├── rename.ts              # Modified: add query param
├── signature-help.ts      # New tool: includes query param
└── code-actions.ts        # New tool: includes query param
```

## Examples

### Hover by symbol name
```
lsp_hover path="src/handler.ts" query="handleRequest"
→ Resolved "handleRequest" → 42:10 [lsp]
→ function handleRequest(req: Request): Promise<Response>
```

### Find references by name
```
lsp_references path="src/types.ts" query="UserConfig"
→ Resolved "UserConfig" → 15:14 [tree-sitter]
→ 12 references in 5 files
```

### Rename by name
```
lsp_rename path="src/utils.ts" query="formatDate" newName="formatDateTime"
→ Resolved "formatDate" → 8:17 [lsp]
→ Rename "formatDateTime": 23 edit(s) across 7 file(s)
```

## Open questions

- **Ambiguity** — what if a file has multiple symbols with the same name (e.g., overloaded methods, or a variable and a type with the same name)? Current design returns the first exact match. Should we return all matches and let the LLM pick? Or is first-match good enough?
- **Nested symbols** — `findSymbolPosition` walks children recursively, so `query="render"` could match a top-level `render` function or a `render` method inside a class. Should class-qualified names be supported (e.g., `query="MyComponent.render"`)?
- **Performance** — requesting document symbols adds a round-trip before the actual request. For LSP, this is typically fast (<50ms). For tree-sitter, it's a file parse. Acceptable for the ergonomic benefit.
- **`lsp_completions`** — should completions also support query? Less clear — completions are about a cursor position in code, not a symbol name. Leaving out for now.
