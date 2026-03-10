# pi-lsp-extension

A [pi](https://github.com/badlogic/pi-mono) coding agent extension that integrates Language Server Protocol (LSP) servers, exposing LSP capabilities as tools the LLM can call.

## What it does

This extension gives pi's LLM access to the same language intelligence that powers your IDE:

| Tool | Description |
|------|-------------|
| `lsp_diagnostics` | Get compilation errors and warnings for a file |
| `lsp_hover` | Get type information and documentation at a position |
| `lsp_definition` | Go to the definition of a symbol |
| `lsp_references` | Find all references to a symbol |
| `lsp_symbols` | List symbols in a file or search workspace |
| `lsp_rename` | Preview rename refactoring (returns planned edits) |

LSP servers start **lazily** — they only spin up when a tool is first used on a file of that language. File changes made via pi's `read`/`write`/`edit` tools are automatically synced to the LSP server.

## Installation

```bash
git clone <this-repo> ~/.pi/agent/extensions/pi-lsp-extension
cd ~/.pi/agent/extensions/pi-lsp-extension
npm install
```

Or add to your pi `settings.json`:

```json
{
  "extensions": ["/path/to/pi-lsp-extension/src/index.ts"]
}
```

Or test directly:

```bash
pi -e /path/to/pi-lsp-extension/src/index.ts
```

## Supported Languages

Out of the box, these language servers are configured (install them separately):

| Language | Server | Install |
|----------|--------|---------|
| TypeScript/JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript` |
| Rust | `rust-analyzer` | [rustup](https://rustup.rs/) or package manager |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Java | `jdtls` | [Eclipse JDT.LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) |

### Adding more languages

Use the `/lsp-config` command at runtime:

```
/lsp-config ruby solargraph stdio
/lsp-config lua lua-language-server
/lsp-config zig zls
```

Format: `/lsp-config <language-id> <command> [args...]`

## Commands

| Command | Description |
|---------|-------------|
| `/lsp` | Show status of all configured/running LSP servers |
| `/lsp-config` | Add or override a language server configuration |
| `/bemol` | Run bemol, manage watch mode (Brazil workspaces only) |

## Brazil Workspace Support (bemol)

When working in an Amazon Brazil workspace, this extension integrates with [bemol](https://w.amazon.com/bin/view/Bemol) to make LSP servers understand Brazil's project structure.

### How it works

1. **Auto-detection**: On startup, the extension detects Brazil workspaces by looking for a `packageInfo` file
2. **Auto-run**: Before starting any LSP server, if bemol configs are missing, `bemol --verbose` runs automatically
3. **Multi-root**: Package roots from `.bemol/ws_root_folders` are passed as `workspaceFolders` to LSP servers, enabling cross-package go-to-definition and references
4. **Watch mode**: Use `/bemol watch` to keep configs in sync as you modify the workspace

### Commands

```
/bemol           # Run bemol --verbose manually
/bemol run       # Same as above
/bemol watch     # Start bemol --watch in background
/bemol stop      # Stop background watch
/bemol status    # Show bemol status and detected package roots
```

### Requirements

- `bemol` on PATH (install with `toolbox install bemol`)
- A Brazil workspace with a `packageInfo` file

## How it works

1. **Lazy startup**: LSP servers start only when you first use a tool on a file of that language
2. **File sync**: When pi reads/writes/edits files, the extension automatically notifies the LSP server via `textDocument/didOpen` and `textDocument/didChange`
3. **Diagnostics cache**: The server pushes diagnostics asynchronously; `lsp_diagnostics` reads from a local cache
4. **Graceful degradation**: If a server isn't installed, tools return a helpful error instead of crashing

## Architecture

```
src/
├── index.ts          # Extension entry point — wires everything together
├── lsp-client.ts     # JSON-RPC client over stdio (wraps vscode-jsonrpc)
├── lsp-manager.ts    # Manages LSP server instances per language
├── file-sync.ts      # Tracks open files, sends didOpen/didChange notifications
├── bemol.ts          # Brazil workspace detection, bemol execution, watch mode
└── tools/
    ├── diagnostics.ts
    ├── hover.ts
    ├── definition.ts
    ├── references.ts
    ├── symbols.ts
    └── rename.ts
```

## Tips

- **Best first tool to try**: `lsp_diagnostics` — after editing code, check for errors immediately
- **Position parameters** are 1-indexed (line 1, column 1 = first character of file)
- **`lsp_rename`** returns a preview of changes but doesn't apply them — the LLM should use `edit`/`write` to make the actual changes
- The extension adds a prompt guideline suggesting the LLM check diagnostics after edits

## License

MIT
