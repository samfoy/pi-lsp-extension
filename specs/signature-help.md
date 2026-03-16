# Signature Help Tool

## Summary

Add an `lsp_signature_help` tool that returns function/method signature information at a call site — parameter names, types, documentation, and which parameter is currently active. This complements `lsp_hover` (which shows type info for a symbol) and `lsp_completions` (which lists available members).

## Motivation

When the LLM is writing a function call with multiple parameters, it needs to know the parameter order, types, and what each parameter does. Today it either:

1. Calls `lsp_hover` on the function name — gets the full signature but no active-parameter context
2. Reads the source/docs — expensive and slow
3. Guesses — risks hallucination

LSP's `textDocument/signatureHelp` is designed exactly for this: given a cursor position inside a call's argument list, it returns the signature with the active parameter highlighted. The `lsp-pi` competitor already exposes this as its `signature` action.

## Goals

- **`lsp_signature_help` tool** — return the active signature, parameters, and documentation at a call site position
- **Active parameter highlighting** — clearly indicate which parameter the cursor is on
- **Multiple overloads** — when a function has overloads, show the active one and list alternatives
- **Clean output** — format for LLM consumption (not raw LSP JSON)

## Non-goals

- Trigger character detection (e.g., auto-invoke on `(` or `,`) — this is a query tool, not an IDE feature
- Tree-sitter fallback — signature help fundamentally requires type resolution; no useful fallback possible
- Retrigger logic — the LSP retrigger context is for interactive editors; we do a single request

## Design

### Tool definition

**`lsp_signature_help`**

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line` | number | Line number (1-indexed) |
| `character` | number | Column number (1-indexed) |

No `query` parameter — signature help is inherently position-based (cursor must be inside the argument list).

### LSP request

```typescript
const result = await client.sendRequest<SignatureHelp | null>("textDocument/signatureHelp", {
  textDocument: { uri },
  position: { line: params.line - 1, character: params.character - 1 },
});
```

### Output format

```
Signature 1 of 2 (active):
  createReadStream(path: PathLike, options?: ReadStreamOptions): ReadStream

  Parameters:
    → path: PathLike — The path to the file to read
      options?: ReadStreamOptions — Options for the stream (encoding, start, end, highWaterMark)

  Returns: ReadStream

Signature 2 of 2:
  createReadStream(path: PathLike, encoding: BufferEncoding): ReadStream
```

Key formatting rules:
- Show all signatures, mark the active one (`activeSignature` index from LSP response)
- For the active signature, show all parameters with the active one marked with `→`
- Include parameter documentation if available (from `SignatureInformation.parameters[].documentation`)
- Include signature-level documentation if available (from `SignatureInformation.documentation`)
- Truncate long documentation to 2 lines per parameter

### Handling edge cases

- **No signature help available** — return "No signature help available at this position. Cursor must be inside a function call's argument list."
- **Empty parameters** — show signature line but skip the parameters section
- **Missing documentation** — show parameters with types only, skip doc lines
- **Multiple overloads** — show all, sorted by the `activeSignature` first
- **No LSP server running** — return the standard unavailable reason message

### Details object

```typescript
interface SignatureHelpDetails {
  hasResult: boolean;
  signatureCount: number;
  activeSignature: number;
  activeParameter: number;
}
```

### TUI rendering

**`renderCall`:**
```
lsp_signature_help  src/handler.ts:42:15
```

**`renderResult` (collapsed):**
```
createReadStream(path, options?) — param 2 of 2
```

Show the function name and active parameter position. If no result, show "No signature help" in dim.

### File layout

```
src/tools/
└── signature-help.ts
```

### Integration

- Register in `index.ts` alongside existing tools
- Add to system prompt snippet: "Use `lsp_signature_help` when you need to know the parameter order or types for a function call"
- No tree-sitter fallback — return clear message when no LSP is available

## Open questions

- **Naming** — `lsp_signature_help` vs `lsp_signature` vs `lsp_params`? The LSP protocol calls it "signature help" so `lsp_signature_help` is most precise, but it's verbose. The competitor uses `signature` (as an action on the unified tool). Going with `lsp_signature_help` for consistency with `lsp_diagnostics`, `lsp_definition`, etc.
- **Context parameter** — should we accept an optional `context` with `triggerKind` and `triggerCharacter`? Probably not — the LLM doesn't know or care about trigger characters. Always send `triggerKind: Invoked`.
- **Interaction with completions** — when the LLM is inside a call and wants to know the expected type for the current argument, should it use signature help (to see the parameter type) then completions (to see what values match)? The system prompt should guide this workflow.
