# Test Suite

## Summary

Add a comprehensive test suite covering the extension's core modules: LSP client, LSP manager, file sync, tree-sitter engines, tool implementations, and the extension entry point. Tests should run without requiring real LSP servers (except for optional integration tests).

## Motivation

The extension has grown to ~6,000 lines across 20+ source files with no automated tests. Both competing LSP extensions have similar gaps — `lsp-pi` is the exception with ~1,700 lines of tests. Without tests, refactoring is risky and regressions are invisible until a user hits them.

## Goals

- **Unit tests** for all core modules with mocked LSP connections
- **Integration tests** (optional, gated behind `--integration`) that spin up real LSP servers
- **Test runner** that works with `npm test` out of the box
- **CI-friendly** — no flaky timeouts, no filesystem side effects, deterministic output

## Non-goals

- 100% coverage — focus on logic-heavy modules and known edge cases
- Testing the pi extension API itself — we trust the framework
- Testing TUI rendering pixel-perfectly — just verify the render functions return `Text` nodes

## Design

### Test framework

Use **vitest** — it supports TypeScript natively (no build step), has built-in mocking, and is fast. Add to `devDependencies`.

```json
{
  "devDependencies": {
    "vitest": "^3.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --project integration"
  }
}
```

### File layout

```
tests/
├── unit/
│   ├── lsp-client.test.ts
│   ├── lsp-manager.test.ts
│   ├── file-sync.test.ts
│   ├── resolve-provider.test.ts
│   ├── tree-sitter/
│   │   ├── parser-manager.test.ts
│   │   ├── pattern-compiler.test.ts
│   │   ├── search-engine.test.ts
│   │   ├── rewrite-engine.test.ts
│   │   ├── symbol-extractor.test.ts
│   │   └── workspace-index.test.ts
│   └── tools/
│       ├── diagnostics.test.ts
│       ├── hover.test.ts
│       ├── definition.test.ts
│       ├── references.test.ts
│       ├── symbols.test.ts
│       ├── rename.test.ts
│       ├── completions.test.ts
│       ├── code-search.test.ts
│       ├── code-rewrite.test.ts
│       ├── code-overview.test.ts
│       ├── signature-help.test.ts     # new tool
│       └── code-actions.test.ts       # new tool
├── integration/
│   ├── typescript-server.test.ts
│   └── python-server.test.ts
├── fixtures/
│   ├── sample.ts
│   ├── sample.py
│   ├── sample.rs
│   └── sample-project/
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   └── utils.ts
│       └── tsconfig.json
└── helpers/
    ├── mock-lsp-client.ts
    ├── mock-lsp-manager.ts
    └── test-utils.ts
```

### Mock strategy

#### `MockLspClient`

A fake `LspClient` that:
- Records all `sendRequest` calls with method + params
- Returns pre-configured responses per method (set via `mockResponse(method, response)`)
- Stores and returns diagnostics via `getDiagnostics(uri)` / `getAllDiagnostics()`
- Tracks `didOpen` / `didChange` notifications

```typescript
class MockLspClient {
  private responses = new Map<string, unknown>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private requests: Array<{ method: string; params: unknown }> = [];

  mockResponse(method: string, response: unknown) { ... }
  setDiagnostics(uri: string, diags: Diagnostic[]) { ... }

  async sendRequest<R>(method: string, params: unknown): Promise<R> {
    this.requests.push({ method, params });
    return this.responses.get(method) as R;
  }

  getRequests(method?: string) { ... }
}
```

#### `MockLspManager`

Wraps `MockLspClient` and provides:
- `getClientForFile(path)` → returns the mock client
- `getFileUri(path)` / `resolvePath(path)` → deterministic paths
- `getLanguageId(path)` → based on extension
- `getRunningClient(languageId)` → returns the mock client
- `getUnavailableReason(path)` → returns a test message

### Test categories

#### 1. LSP Client (`lsp-client.test.ts`)

- JSON-RPC message framing (Content-Length header parsing)
- Request/response correlation (matching IDs)
- Notification handling (`textDocument/publishDiagnostics`)
- Connection error handling and reconnection
- Graceful shutdown sequence
- Timeout behavior for pending requests

#### 2. LSP Manager (`lsp-manager.test.ts`)

- Server config resolution (built-in defaults, custom overrides)
- Language detection from file extension
- Lazy server startup (only when `getClientForFile` is called)
- File URI generation (handles spaces, special characters)
- Multiple servers for different languages
- Brazil workspace detection and bemol integration
- Daemon mode (shared server lifecycle)

#### 3. File Sync (`file-sync.test.ts`)

- `handleFileRead` → sends `didOpen` with correct URI and content
- `handleFileWrite` → sends `didChange` with incremented version
- Deduplication (multiple reads of the same file don't re-open)
- Version tracking consistency
- Tree-sitter integration (parse/index updates on file change)

#### 4. Tree-sitter modules

**parser-manager.test.ts**
- WASM init lifecycle
- Parse TypeScript, Python, Rust, Go, Java source
- Incremental re-parse after edit
- Unknown language handling

**pattern-compiler.test.ts**
- `$NAME` single-node metavariable compilation
- `$$$NAME` variadic metavariable compilation
- Literal node preservation
- Expression wrapping for partial patterns
- Error cases (unparseable patterns)

**search-engine.test.ts**
- Single-file pattern matching
- Multi-file directory scanning
- Metavariable capture extraction
- `max_results` limiting
- `.gitignore` respecting

**rewrite-engine.test.ts**
- Simple substitution (`$A → $A`)
- Multi-capture replacement (`$A.$B → $B.$A`)
- Variadic replacement (`$$$ARGS`)
- Bottom-up application (offset preservation)
- Dry-run vs. apply modes

**symbol-extractor.test.ts**
- Function/method/class/interface extraction per language
- Nested symbol handling (methods inside classes)
- Signature text extraction
- Syntax error detection

**workspace-index.test.ts**
- Index build from fixture project
- Symbol search (exact and fuzzy)
- Incremental update on file change
- Skip patterns (`node_modules`, `.git`, etc.)

#### 5. Tool tests

Each tool test follows the same pattern:
1. Create a `MockLspManager` with pre-configured responses
2. Call the tool's `execute` function with test params
3. Assert on the returned `content` text and `details` object
4. Verify `renderCall` returns a `Text` node with expected content
5. Verify `renderResult` returns a `Text` node for both partial and complete states

Example for `hover.test.ts`:

```typescript
describe("lsp_hover", () => {
  it("formats MarkupContent hover response", async () => {
    const mockManager = createMockManager();
    mockManager.client.mockResponse("textDocument/hover", {
      contents: { kind: "markdown", value: "```ts\nfunction foo(): void\n```" },
    });

    const tool = createHoverTool(mockManager);
    const result = await tool.execute("call-1", { path: "test.ts", line: 5, character: 10 });

    expect(result.content[0].text).toContain("function foo(): void");
    expect(result.details.hasResult).toBe(true);
  });

  it("falls back to tree-sitter when no LSP", async () => { ... });
  it("returns unavailable message for unknown language", async () => { ... });
  it("handles LSP error gracefully", async () => { ... });
  it("renderCall shows file:line:col", () => { ... });
  it("renderResult shows truncated hover on collapse", () => { ... });
});
```

#### 6. Integration tests

Gated behind `--project integration` flag. Require real servers installed:

**typescript-server.test.ts**
- Start `typescript-language-server`
- Open a TypeScript file
- Get diagnostics, hover, definition, references, completions
- Verify results against known fixture content
- Clean shutdown

**python-server.test.ts**
- Start `pyright-langserver`
- Same test pattern for Python fixtures

These tests have a 30-second timeout and skip if the server binary isn't found.

### Configuration

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 10000,
    projects: [
      {
        name: "unit",
        include: ["tests/unit/**/*.test.ts"],
      },
      {
        name: "integration",
        include: ["tests/integration/**/*.test.ts"],
        testTimeout: 30000,
      },
    ],
  },
});
```

### Coverage targets

- Unit tests: aim for 80%+ line coverage on core modules
- Tools: every tool should have at least 3 tests (happy path, error, edge case)
- Tree-sitter: heavy coverage on pattern-compiler and search-engine (complex logic)
- Integration: smoke-test level — verify end-to-end flow works

## Open questions

- **Snapshot testing** — should `renderCall`/`renderResult` tests use snapshot assertions for the `Text` output? Pros: catches regressions in formatting. Cons: noisy diffs when theme changes.
- **Fixture management** — should fixtures be inline strings or separate files? Inline is easier to read in tests; files are better for integration tests that need real project structure.
- **Mock fidelity** — how closely should `MockLspClient` mimic real JSON-RPC behavior? A thin mock (just record/playback) is easier to maintain but may miss framing bugs.
