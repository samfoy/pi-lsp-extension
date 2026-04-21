# Changelog

## 1.0.0 (2026-04-21)


### Features

* add .pi-lsp.json project config with autoStart for eager server launch ([a702845](https://github.com/samfoy/pi-lsp-extension/commit/a7028452634cc029ea5608a8537de5c3b0fb2660))
* add bemol integration for Brazil workspace LSP support ([3d4129d](https://github.com/samfoy/pi-lsp-extension/commit/3d4129d9e83aad6114ad3ee57b6af09cb02f637a))
* add cross-session locking for LSP servers and bemol ([0331ae1](https://github.com/samfoy/pi-lsp-extension/commit/0331ae15fde5432bf27ee8b17d5555dd66718716))
* add Lombok support for Java/jdtls ([4793417](https://github.com/samfoy/pi-lsp-extension/commit/47934170aef4eeae96fa7502f11e964a316bcf4f))
* add lsp_completions tool for code completion at a position ([95b16ec](https://github.com/samfoy/pi-lsp-extension/commit/95b16ecd0371fb06659bceba5bb2b24807fe3201))
* add pi-package keyword and fix peer deps for gallery listing ([7a5c1c8](https://github.com/samfoy/pi-lsp-extension/commit/7a5c1c89ed4b31fe14a8c546474f4357040a662b))
* add structural code search and rewrite tools ([6fe71f1](https://github.com/samfoy/pi-lsp-extension/commit/6fe71f1a535404e82b7034b066dba248bd6db2d1))
* add tree-sitter integration for zero-config code intelligence ([2375168](https://github.com/samfoy/pi-lsp-extension/commit/2375168f188d7db9491fa3650996fa1f356910e1))
* add UI notifications for bemol and LSP server lifecycle ([fb0b963](https://github.com/samfoy/pi-lsp-extension/commit/fb0b963782b4c568dbe95113fcc95f78cc54ed66))
* auto-append LSP diagnostics to write/edit tool results ([47da393](https://github.com/samfoy/pi-lsp-extension/commit/47da393da32ac425987c8c5ce81a6b2e903079d5))
* initial pi LSP extension with 6 tools ([0d63b07](https://github.com/samfoy/pi-lsp-extension/commit/0d63b07b54ccacbaf58574898656bc67a6c2cb03))
* shared LSP daemon for cross-session server reuse ([b607c6d](https://github.com/samfoy/pi-lsp-extension/commit/b607c6d9b3fed2503e097ef9eb0ee827a495b985))
* support workspace-wide diagnostics when path is omitted ([9114fcd](https://github.com/samfoy/pi-lsp-extension/commit/9114fcda87682358152c16db2fae13eafd30192b))


### Bug Fixes

* add dispose() for parser cleanup, stale lock detection ([5e6a379](https://github.com/samfoy/pi-lsp-extension/commit/5e6a3791800f77c8dbfe0fac1454c4dfce00c1bc))
* create fresh LspClient per retry attempt in daemon connect loop ([f8a0dca](https://github.com/samfoy/pi-lsp-extension/commit/f8a0dca2aa5719e8935f5ebaa322f2703b916dde))
* guard against EPIPE crashes when LSP server exits ([f893985](https://github.com/samfoy/pi-lsp-extension/commit/f89398546c05e144a3e81814d2ce410468486191))
* increase daemon init timeout to 5min, retry loop to 5min ([eb85979](https://github.com/samfoy/pi-lsp-extension/commit/eb859797661cd9765a9ad41ad43abbbce88e7050))
* non-blocking LSP startup and daemon jiti resolution ([042b237](https://github.com/samfoy/pi-lsp-extension/commit/042b2373f1475c50ca96e3893d4aa0396d6cf3d9))
* prevent ERR_STREAM_DESTROYED crash when LSP process exits ([e5ec628](https://github.com/samfoy/pi-lsp-extension/commit/e5ec628eb0ec5240a590fffca5c8f955fe6eb875))
* remaining review issues — error reporting, double-reject, unused imports ([38c596e](https://github.com/samfoy/pi-lsp-extension/commit/38c596ef88d0269133619bb989859488cd80e0e3))
* remove unused originalHandler variable in daemon initializeLsp ([4726987](https://github.com/samfoy/pi-lsp-extension/commit/4726987853eedf54cda72b78e90c097515cb2795))
* rename code_search to ast_search to avoid conflict with pi-web-access ([da7581a](https://github.com/samfoy/pi-lsp-extension/commit/da7581a6d4cb95944f43c8d6d93c5592a71283b6))
* replace CodeArtifact registry with public npm registry ([1426a30](https://github.com/samfoy/pi-lsp-extension/commit/1426a3008b307891babb084a5e97b431e1a0467f))
* replace inline require() with top-level ESM imports in daemon ([990070e](https://github.com/samfoy/pi-lsp-extension/commit/990070ec1f9f352665a2223b86b46a371d1d22d6))
* resolve all remaining review findings ([098c491](https://github.com/samfoy/pi-lsp-extension/commit/098c491d507ff60acb1218df549b35c927269614))
* resolve daemon script path to .ts source for jiti loading ([c34c877](https://github.com/samfoy/pi-lsp-extension/commit/c34c877c19e1495c4a8187616c978626f0d70b54))
* set up daemon stdout listener immediately after spawn ([5192403](https://github.com/samfoy/pi-lsp-extension/commit/5192403af5c2e9101fcd8555fde0363afb716ab8))
* synthetic dot race condition with FileSync and stale rootDir capture ([f7396da](https://github.com/samfoy/pi-lsp-extension/commit/f7396dadfd6aad4957344730fc827f544cf19d73))
* use fileURLToPath instead of .pathname for Windows compatibility ([4f638af](https://github.com/samfoy/pi-lsp-extension/commit/4f638afe6b6e6893a9ae1e139a8b6fdc43a8061c))
* use fileURLToPath instead of .pathname for Windows compatibility ([af36e8c](https://github.com/samfoy/pi-lsp-extension/commit/af36e8c5e7300a77ff27f5c9ecc547df1138e1e6))
* use path="*" instead of optional param for workspace diagnostics ([d10cb56](https://github.com/samfoy/pi-lsp-extension/commit/d10cb563e37d0af978dcfe3a7ba9c483b68d429a))
* walk through container nodes when extracting nested symbols ([256b228](https://github.com/samfoy/pi-lsp-extension/commit/256b22808886a84f6aed40c4adb0ad2b99ba1549))
