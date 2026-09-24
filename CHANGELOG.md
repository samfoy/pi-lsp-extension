# Changelog

## 1.4.0

1.3.0 is the latest release on npm. This release also ships the fix for #13, which was merged on GitHub after 1.3.0 but never released.

### Fixed

- The extension failed to load when npm installed vscode-languageserver-protocol 3.18.x:
  `Package subpath './node.js' is not defined by "exports"`. It now imports the `./node` subpath (#12),
  which resolves on both 3.17.5 and 3.18.x. Fixes #13.
- Java: jdtls always receives `java.import.exclusions`, not only when Lombok is found. The list keeps
  jdtls's own defaults and adds generated/output dirs (`build/`, `.gradle/`, `bin/`, `.bemol/`), so
  transient dirs no longer poison the saved workspace snapshot.
- Java: a jdtls workspace corrupted by a previous session (`ObjectNotFoundException` while restoring
  the workspace tree) is repaired before launch. Only the resource-tree snapshots are removed and the
  JDT index is kept. The workspace data dir is located the same way as jdtls's launcher does it on
  Linux, macOS and Windows. Recovery never deletes anything outside the data dir: it does not
  follow symlinks, and does nothing if the resource-tree dir resolves elsewhere.
  Recovery never runs underneath a live shared daemon.
- The package now includes the full MIT `LICENSE` file. Fixes #14.

### Changed

- The package ships a bundled `dist/` (built with esbuild) instead of raw `src/*.ts`, and the pi
  manifest points at `./dist/index.js`. `dist/` is committed, so `pi install git:github.com/samfoy/pi-lsp-extension` works without a build step.
- The shared LSP daemon runs as plain `node dist/lsp-daemon.js`. The jiti launcher, including its
  `@mariozechner/jiti` fallback and the transpile on every daemon start, is gone.
- TypeBox 1.x: the `typebox` peer replaces `@sinclair/typebox`. The unused `@earendil-works/pi-ai` peer is dropped.
- `engines.node` is now `>=22.19.0`, pi's own minimum.

### Development

- Real `npm run check` (`tsc --noEmit`), `npm test` (tree-sitter, structural search, Java workspace)
  and `npm run build` scripts replace the `echo` placeholders.
- CI checks types, tests, the build, and that `dist/` is up to date. Publishing uses npm trusted publishing.
