# Code Actions Tool

## Summary

Add an `lsp_code_actions` tool that retrieves available code actions (quick fixes, refactorings, source actions) for a position or range in a file. This lets the LLM discover and apply IDE-level fixes — auto-imports, extract method, fix lint errors — that would otherwise require manual knowledge of the codebase.

## Motivation

When the LLM encounters a diagnostic error (e.g., "Cannot find name 'Foo'"), it currently has to reason about the fix from scratch. But the LSP server often already knows the fix — "Add import from './foo'" — via code actions. Exposing these saves time and reduces hallucination.

The `lsp-pi` competitor exposes `codeAction` as one of its actions and it covers:
- Quick fixes (auto-import, remove unused variable, fix typo)
- Refactorings (extract method, extract variable, inline variable)
- Source actions (organize imports, add missing members)

## Goals

- **`lsp_code_actions` tool** — return available actions for a position or diagnostic range
- **Diagnostic-aware** — when called with a position that has a diagnostic, include the diagnostic context so the server returns relevant fixes
- **Actionable output** — format actions so the LLM knows what each one does and can apply the edits
- **Preferred actions** — highlight preferred/auto-fix actions (the server marks these)

## Non-goals

- Executing code actions automatically — the tool returns the action list and their edits; the LLM uses `edit`/`write` to apply
- Command-based actions — some code actions return a `command` instead of `edit`. We report these but can't execute them (they require IDE integration)
- Resolving lazy actions — `codeAction/resolve` for actions that defer their edit computation. This can be a follow-up if needed.

## Design

### Tool definition

**`lsp_code_actions`**

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path |
| `line` | number | Line number (1-indexed) |
| `character` | number | Column number (1-indexed) |
| `endLine` | number? | End line for range selection (1-indexed). Defaults to `line`. |
| `endCharacter` | number? | End column for range selection (1-indexed). Defaults to `character`. |
| `kind` | string? | Filter by action kind (e.g., `"quickfix"`, `"refactor"`, `"source"`) |

### LSP request

```typescript
// Collect diagnostics at the position to include as context
const uri = manager.getFileUri(filePath);
const allDiags = client.getDiagnostics(uri);
const rangeDiags = allDiags.filter(d => rangeContainsPosition(d.range, line, character));

const result = await client.sendRequest<CodeAction[]>("textDocument/codeAction", {
  textDocument: { uri },
  range: {
    start: { line: params.line - 1, character: params.character - 1 },
    end: { line: (params.endLine ?? params.line) - 1, character: (params.endCharacter ?? params.character) - 1 },
  },
  context: {
    diagnostics: rangeDiags,
    only: params.kind ? [params.kind] : undefined,
  },
});
```

Including matching diagnostics in the `context` is critical — many servers (jdtls, pyright, typescript-language-server) only return quick fixes when the relevant diagnostic is in the context.

### Output format

```
5 code actions at src/handler.ts:42:10

  1. ★ Add import from './types' [quickfix]
     Edits: src/handler.ts:1:1 insert "import { Foo } from './types';\n"

  2. ★ Remove unused variable 'x' [quickfix]
     Edits: src/handler.ts:42:3-42:15 delete

  3. Extract to function in module scope [refactor.extract]
     Edits: (resolve required)

  4. Convert to arrow function [refactor.rewrite]
     Edits: src/handler.ts:40:1-45:2 replace

  5. Organize imports [source.organizeImports]
     Edits: (resolve required)
```

Key formatting:
- **★** marks preferred actions (`isPreferred: true`) — these are the auto-fix candidates
- **Kind** shown in brackets — helps the LLM filter mentally
- **Edits** shown inline if the action includes a `WorkspaceEdit`. Format matches `lsp_rename` output
- **"resolve required"** for actions that have no edit but have a `data` field (need `codeAction/resolve`)
- Actions are sorted: preferred first, then by kind (quickfix → refactor → source → other)

### Details object

```typescript
interface CodeActionsDetails {
  count: number;
  preferredCount: number;
  actions: Array<{
    title: string;
    kind?: string;
    isPreferred: boolean;
    hasEdit: boolean;
    hasCommand: boolean;
  }>;
}
```

### TUI rendering

**`renderCall`:**
```
lsp_code_actions  src/handler.ts:42:10
```

With kind filter:
```
lsp_code_actions  src/handler.ts:42:10  [quickfix]
```

With range:
```
lsp_code_actions  src/handler.ts:42:10-45:2
```

**`renderResult` (collapsed):**
```
5 actions (2 preferred)
```

Or if no actions:
```
No code actions available
```

### Handling edge cases

- **No actions available** — return "No code actions available at this position."
- **Command-only actions** — report the title and note that it requires IDE execution: "This action requires IDE execution and cannot be applied via edit/write."
- **Large edit sets** — truncate edits to first 20 per action, note remaining count
- **No LSP server** — return standard unavailable reason
- **Server doesn't support code actions** — check `capabilities.codeActionProvider` and return a clear message

### File layout

```
src/tools/
└── code-actions.ts
```

### Integration

- Register in `index.ts` alongside existing tools
- Add to system prompt: "When `lsp_diagnostics` shows errors, try `lsp_code_actions` at the error position to find available quick fixes before writing a manual fix."
- The workflow is: `lsp_diagnostics` → see error → `lsp_code_actions` at error position → find auto-import fix → apply with `edit`

### Utility: `rangeContainsPosition`

Add a shared helper in `src/shared/format.ts`:

```typescript
export function rangeContainsPosition(
  range: Range,
  line: number,   // 0-indexed
  character: number, // 0-indexed
): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}
```

## Open questions

- **`codeAction/resolve`** — should we automatically resolve actions that have `data` but no `edit`? This adds a round-trip per action but gives the LLM the actual edits. Could be gated: resolve only preferred actions, or only when the action count is small (< 5).
- **Applying actions** — should the tool have an `apply` mode that applies a specific action's edits directly? Pro: simpler workflow. Con: the LLM can already use the edit tool with the provided edit locations. Lean towards keeping it read-only for v1, matching how `lsp_rename` works.
- **Interaction with diagnostics auto-append** — when the auto-diagnostics hook fires after a write/edit and shows errors, should it also hint "try lsp_code_actions at line X for quick fixes"? Potentially noisy.
