# Completions Tool

## Summary

Add an `lsp_completions` tool that returns completion suggestions at a given position in a file. This lets the LLM discover available methods, properties, and APIs on objects without having to read documentation or source code.

## Motivation

When writing code, the LLM often needs to know what methods are available on an object — e.g., "what can I call on `s3Client`?" or "what fields does this struct have?". Today it either guesses (risking hallucination) or has to read the source/type definitions manually.

LSP completion is exactly this: given a cursor position, the language server returns ranked suggestions with type signatures and documentation. Kiro CLI exposes this and it's one of their differentiators.

## Goals

- **`lsp_completions` tool** — return completion items at a position, with type signatures and docs
- **Smart triggering** — the LLM can ask "what methods are available on X" and get actionable results
- **Concise output** — return the top N results (default 20) with kind, label, type, and doc summary — not the full verbose LSP response

## Non-goals

- Snippet expansion or tab-completion UX — this is a query tool, not an interactive completion engine
- Commit characters, edit ranges, or other IDE-specific completion metadata
- Tree-sitter fallback — completions fundamentally require type information, so this is LSP-only

## Design

### Tool definition

**`lsp_completions`**

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line` | number | Line number (1-indexed) |
| `character` | number | Column number (1-indexed) |
| `limit` | number? | Max results to return (default: 20) |

### Trigger workflow

The LLM typically uses this in one of two ways:

1. **Explore an API**: Write `s3Client.` in a file, then call `lsp_completions` at the position after the dot to see available methods.
2. **Verify a method exists**: Before calling `response.bodyAsString()`, check completions on `response.` to confirm the method name.

In both cases the file needs to be open in the LSP (handled by `FileSync`) and the content needs to reflect the current state.

### Synthetic trigger

A common case is "what methods does X have?" where X is already in the code but there's no trailing dot. The tool should support a convenience mode:

- If the position points to the end of an identifier, the tool temporarily inserts a `.` after it, requests completions, then removes it. This avoids forcing the LLM to edit the file just to explore an API.
- This is optional and gated by a `trigger` parameter (`"auto"` | `"none"`, default `"auto"`).

### Output format

```
20 completions at src/handler.ts:42:15

method  getObject(params: GetObjectRequest): Promise<GetObjectOutput>
          Retrieves an object from S3.
method  putObject(params: PutObjectRequest): Promise<PutObjectOutput>
          Uploads an object to S3.
property region: string
          The AWS region for this client.
...
```

Each item shows:
- **Kind** — method, property, function, variable, class, keyword, etc.
- **Label + signature** — from `detail` or `labelDetails` in the LSP response
- **Documentation** — first 1-2 lines of the doc comment, if available

Items are sorted by the LSP server's `sortText` ranking (which considers scope, type match, and usage frequency).

### Resolve for details

Many LSP servers return minimal items in the initial response and require a `completionItem/resolve` call for documentation and full signatures. The tool should:

1. Request completions at the position
2. For the top N items, call `completionItem/resolve` in parallel to get full details
3. Merge results and format output

This adds latency but dramatically improves output quality. Cap resolve calls to the `limit` parameter to bound cost.

### File layout

```
src/tools/
└── completions.ts
```

### Integration

- Register in `index.ts` alongside existing tools
- Add to the extension's system prompt snippet: mention that `lsp_completions` is available for discovering methods and properties
- No tree-sitter fallback — return a clear message if no LSP server is running

## Open questions

- **Synthetic trigger safety** — temporarily modifying file content to insert a `.` could cause issues if the LSP processes the change and emits diagnostics before we revert. Should we use a separate virtual document, or is the insert-request-revert cycle fast enough to be safe?
- **Performance** — `completionItem/resolve` for 20 items could be slow on some servers. Should we resolve lazily (only top 5) or make it configurable?
- **Filter parameter** — should the tool accept a `filter` string to pre-filter results (e.g., only methods, only properties)? Or is that over-engineering for v1?
