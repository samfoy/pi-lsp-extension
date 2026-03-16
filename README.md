# pi-lsp-extension

A [pi](https://github.com/mariozechner/pi-mono) coding agent extension that integrates Language Server Protocol (LSP) servers, giving the LLM access to the same language intelligence that powers your IDE.

## Tools

| Tool | Description |
|------|-------------|
| `lsp_diagnostics` | Compilation errors and warnings for a file |
| `lsp_hover` | Type information and documentation at a position |
| `lsp_definition` | Go to definition of a symbol |
| `lsp_references` | Find all references to a symbol |
| `lsp_symbols` | List file symbols or search workspace symbols |
| `lsp_rename` | Preview rename refactoring (returns planned edits) |
| `lsp_completions` | Code completion suggestions at a position |
| `code_overview` | Project structure, key files, and symbols (tree-sitter) |
| `code_search` | Find code by AST structure with metavariables |
| `code_rewrite` | Transform code matching structural patterns |

LSP servers start lazily — they only spin up when a tool is first used on a file of that language. For slow servers (e.g. jdtls), you can [auto-start them on session launch](#project-config).

## Auto-diagnostics

After a successful `write` or `edit`, if an LSP server is already running for that file type, the extension automatically appends compilation errors to the tool result. This gives the LLM immediate feedback without requiring a separate `lsp_diagnostics` call.

- Scoped to the single changed file (no workspace-wide noise)
- Only errors, max 10 lines — keeps context lean
- Only fires when a server is already running (no lazy startup)

## Installation

```bash
git clone https://github.com/samfoy/pi-lsp-extension.git
cd pi-lsp-extension
npm install
```

Add to your pi `settings.json`:

```json
{
  "extensions": ["/path/to/pi-lsp-extension/src/index.ts"]
}
```

Or run directly:

```bash
pi -e /path/to/pi-lsp-extension/src/index.ts
```

## Supported Languages

Install the language server you need, then it works automatically:

| Language | Server | Install |
|----------|--------|---------|
| TypeScript/JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `pip install pyright` |
| Rust | `rust-analyzer` | [rustup](https://rustup.rs/) |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Java | `jdtls` | [Eclipse JDT.LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) |

Add more at runtime:

```
/lsp-config ruby solargraph stdio
/lsp-config lua lua-language-server
```

## Commands

| Command | Description |
|---------|-------------|
| `/lsp` | Show status of running LSP servers |
| `/lsp-restart <lang>` | Restart an LSP server (kills daemon, re-initializes) |
| `/lsp-config <lang> <cmd> [args]` | Configure a language server |
| `/lsp-lombok [path]` | Set Lombok jar path for Java (or show current) |
| `/bemol [run\|watch\|stop\|status]` | Manage bemol (Brazil workspaces) |

## How it Works

1. **Lazy startup** — servers start on first tool use for a file type (or eagerly via [`.pi-lsp.json`](#project-config))
2. **File sync** — pi's `read`/`write`/`edit` operations are automatically synced to the LSP via `didOpen`/`didChange`
3. **Diagnostics cache** — the server pushes diagnostics asynchronously; tools read from a local cache
4. **Auto-diagnostics** — errors are appended to write/edit results when a server is running
5. **Shared daemons** — in supported workspaces, LSP servers run as background daemons shared across pi sessions

## Lombok Support (Java)

If your Java project uses [Lombok](https://projectlombok.org/), jdtls needs the Lombok agent jar to understand generated code. The extension resolves the jar in this order:

1. **`/lsp-lombok` command** — set the path at runtime:
   ```
   /lsp-lombok /path/to/lombok.jar
   ```

2. **`LOMBOK_JAR` environment variable** — set before starting pi:
   ```bash
   export LOMBOK_JAR=/path/to/lombok.jar
   pi
   ```

3. **Auto-detection** — in Brazil workspaces, the extension searches `env/Lombok-*/runtime/lib/` and `env/gradle-cache-2/` automatically.

Run `/lsp-lombok` with no arguments to see which jar is currently configured.

## Project Config

Create a `.pi-lsp.json` file in your project root to configure LSP behavior per-project:

```json
{
  "autoStart": ["java", "typescript"],
  "servers": {
    "python": { "command": "pylsp", "args": [] }
  }
}
```

| Field | Description |
|-------|-------------|
| `autoStart` | Array of language IDs to start eagerly on session launch. Servers begin initializing in the background immediately — no need to wait for the first tool call. Ideal for slow servers like `jdtls`. |
| `lombokJar` | Path to a Lombok jar (absolute or relative to project root), or `"auto"` to auto-detect in Brazil workspaces. Applied before auto-start so jdtls launches with the correct `-javaagent` flag. |
| `servers` | Custom server configs keyed by language ID. Overrides the built-in defaults. Each entry has `command`, optional `args` (string array), and optional `env` (key-value pairs). |

The config file is loaded once at session start. Changes require restarting the pi session.

**Example for a Java Brazil workspace:**
```json
{
  "autoStart": ["java"],
  "lombokJar": "auto"
}
```

This triggers bemol + jdtls startup as soon as the session begins, so by the time you need `lsp_diagnostics` or `lsp_hover`, the server is already warm.

## Architecture

```
src/
├── index.ts              # Extension entry point, .pi-lsp.json config loader
├── lsp-client.ts         # JSON-RPC client (stdio + socket modes)
├── lsp-manager.ts        # Server lifecycle, per-language instances
├── file-sync.ts          # didOpen/didChange tracking
├── lsp-daemon.ts         # Background daemon for shared servers
├── lsp-daemon-launcher.cjs
├── bemol.ts              # Brazil workspace support
├── locks.ts              # File-based locking for daemon coordination
├── resolve-provider.ts   # LSP vs tree-sitter provider selection
├── shared/
│   ├── constants.ts      # Skip dirs, file size limits
│   ├── format.ts         # Location formatting utilities
│   ├── language-map.ts   # File extension → language ID mapping
│   └── timing.ts         # Timing constants
├── tree-sitter/
│   ├── parser-manager.ts # WASM parser loading and caching
│   ├── pattern-compiler.ts # Metavariable pattern → AST matcher
│   ├── search-engine.ts  # Structural search over files
│   ├── rewrite-engine.ts # Structural find-and-replace
│   ├── symbol-extractor.ts # Per-language symbol extraction
│   └── workspace-index.ts # Project-wide symbol index
└── tools/
    ├── diagnostics.ts
    ├── hover.ts
    ├── definition.ts
    ├── references.ts
    ├── symbols.ts
    ├── rename.ts
    ├── completions.ts
    ├── code-overview.ts
    ├── code-search.ts
    └── code-rewrite.ts
```

## Tips

- Position parameters are 1-indexed (line 1, column 1 = first character)
- `lsp_rename` returns a preview — the LLM uses `edit`/`write` to apply changes
- The extension adds a system prompt guideline nudging the LLM to check diagnostics after edits

## License

MIT
