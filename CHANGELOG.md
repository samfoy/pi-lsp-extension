# Changelog

## 1.4.0

1.3.0 is the latest release on npm. This release also ships the fix for #13, which was merged on GitHub after 1.3.0 but never released.

### Fixed

- The extension failed to load when npm installed vscode-languageserver-protocol 3.18.x:
  `Package subpath './node.js' is not defined by "exports"`. It now imports the `./node` subpath (#12),
  which resolves on both 3.17.5 and 3.18.x. Fixes #13.
- Java: jdtls always receives `java.import.exclusions`, not only when Lombok is found. The list keeps
  jdtls's own defaults and adds the generated dirs `.gradle/` and `.bemol/`, so they no longer poison
  the saved workspace snapshot. `build/` and `bin/` are not excluded: jdtls matches the globs against
  absolute paths, so they would hide every project of a workspace that lives under such a dir. The
  README shows how to set your own list through `initializationOptions`.
- Java: a jdtls workspace corrupted by a previous session (`ObjectNotFoundException` while restoring
  the workspace tree) is repaired before launch. Only the resource-tree snapshots are removed and the
  JDT index is kept. The workspace data dir is located the same way as jdtls's launcher does it on
  Linux, macOS and Windows. Recovery never deletes anything outside the data dir: it does not
  follow symlinks, and does nothing if the resource-tree dir resolves elsewhere. After a repair the
  jdtls log is renamed to `.log.pi-lsp-recovered-<timestamp>`, so the same crash is repaired once,
  not on every launch. A repair shows as an info notice, not as "LSP: java failed".
  Recovery runs only right before this session launches its own jdtls, so it is skipped whenever the
  session connects to a running shared daemon. It does not check whether another jdtls is using the
  data dir. That can happen when a daemon's PID is alive but connecting to it fails, when another
  session runs jdtls without a shared daemon, or when another workspace has the same directory name
  (jdtls keys the data dir on the directory name alone).
- The package now includes the full MIT `LICENSE` file. Fixes #14.
- The README no longer lists a `/bemol` command, which this package does not ship.
- Connecting to a shared daemon clears its 10s connect timeout, so the timer no longer holds the process open.

### Changed

- The package ships a bundled `dist/` (built with esbuild) instead of raw `src/*.ts`, and the pi
  manifest points at `./dist/index.js`. `dist/` is committed, so `pi install git:github.com/samfoy/pi-lsp-extension` works without a build step.
- The shared LSP daemon runs as plain `node dist/lsp-daemon.js`, from the bundle and from source alike.
  The jiti launcher, including its `@mariozechner/jiti` fallback and the transpile on every daemon
  start, is gone.
- TypeBox 1.x: the `typebox` peer replaces `@sinclair/typebox`. The unused `@earendil-works/pi-ai` peer is dropped.
- `engines.node` is now `>=22.19.0`, pi's own minimum.

### Development

- Real `npm run check` (`tsc --noEmit`), `npm test` (tree-sitter, structural search, Java workspace,
  and smoke tests that run the built daemon against a fake LSP server) and `npm run build` scripts
  replace the `echo` placeholders.
- CI checks types, tests, the build, and that `dist/` is up to date. Publishing uses npm trusted publishing.
