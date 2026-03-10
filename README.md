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

LSP servers start lazily — they only spin up when a tool is first used on a file of that language.

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
| `/lsp-config <lang> <cmd> [args]` | Configure a language server |
| `/bemol [run\|watch\|stop\|status]` | Manage bemol (Brazil workspaces) |

## How it Works

1. **Lazy startup** — servers start on first tool use for a file type
2. **File sync** — pi's `read`/`write`/`edit` operations are automatically synced to the LSP via `didOpen`/`didChange`
3. **Diagnostics cache** — the server pushes diagnostics asynchronously; tools read from a local cache
4. **Auto-diagnostics** — errors are appended to write/edit results when a server is running
5. **Shared daemons** — in supported workspaces, LSP servers run as background daemons shared across pi sessions

## Architecture

```
src/
├── index.ts              # Extension entry point
├── lsp-client.ts         # JSON-RPC client (stdio + socket modes)
├── lsp-manager.ts        # Server lifecycle, per-language instances
├── file-sync.ts          # didOpen/didChange tracking
├── lsp-daemon.ts         # Background daemon for shared servers
├── lsp-daemon-launcher.cjs
├── bemol.ts              # Brazil workspace support
├── locks.ts              # File-based locking for daemon coordination
└── tools/
    ├── diagnostics.ts
    ├── hover.ts
    ├── definition.ts
    ├── references.ts
    ├── symbols.ts
    └── rename.ts
```

## Tips

- Position parameters are 1-indexed (line 1, column 1 = first character)
- `lsp_rename` returns a preview — the LLM uses `edit`/`write` to apply changes
- The extension adds a system prompt guideline nudging the LLM to check diagnostics after edits

## License

MIT
