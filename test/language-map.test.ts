/**
 * Tests for the configurable file-type → language-ID map (extensions/filenames overrides).
 *
 * Run: npm test (or: npx tsx test/language-map.test.ts)
 */

import {
  EXT_TO_LANGUAGE,
  getLanguageIdFromPath,
  setLanguageMapOverrides,
} from "../src/shared/language-map.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function main() {
  // ── 1. Built-in table (no overrides installed) ──
  console.log("\n🔧 Built-in mappings");
  setLanguageMapOverrides({});
  assert(getLanguageIdFromPath("foo.ts") === "typescript", "foo.ts → typescript");
  assert(getLanguageIdFromPath("lib/util.cpp") === "cpp", "lib/util.cpp → cpp");
  assert(getLanguageIdFromPath("README.md") === undefined, "README.md → undefined (no override)");
  assert(getLanguageIdFromPath("app/qml/Main.qml") === undefined, "Main.qml → undefined (no override)");

  // ── 2. Extension overrides ──
  console.log("\n🔧 Extension overrides");
  setLanguageMapOverrides({ extensions: { ".qml": "qml", ".md": "markdown", ".yml": "yaml" } });
  assert(getLanguageIdFromPath("app/qml/Main.qml") === "qml", ".qml → qml");
  assert(getLanguageIdFromPath("README.md") === "markdown", ".md → markdown");
  assert(getLanguageIdFromPath("doc/design.MD") === "markdown", "case-insensitive ext");
  assert(getLanguageIdFromPath(".github/workflows/ci.yml") === "yaml", ".yml → yaml");
  assert(getLanguageIdFromPath("foo.ts") === "typescript", "built-in still works");

  // Key normalization: without leading dot, mixed case
  setLanguageMapOverrides({ extensions: { QML: "qml", ".Md": "markdown" } });
  assert(getLanguageIdFromPath("Main.qml") === "qml", "key without dot normalized");
  assert(getLanguageIdFromPath("README.md") === "markdown", "key with mixed case normalized");

  // ── 3. Filename overrides ──
  console.log("\n🔧 Filename overrides");
  setLanguageMapOverrides({ filenames: { "CMakeLists.txt": "cmake" } });
  assert(getLanguageIdFromPath("CMakeLists.txt") === "cmake", "CMakeLists.txt → cmake");
  assert(getLanguageIdFromPath("core/CMakeLists.txt") === "cmake", "nested CMakeLists.txt → cmake");
  assert(getLanguageIdFromPath("notes.txt") === undefined, "other .txt unaffected");
  assert(getLanguageIdFromPath("cmakelists.txt") === undefined, "case-sensitive (documented)");

  // Filename wins over extension
  setLanguageMapOverrides({
    filenames: { "CMakeLists.txt": "cmake" },
    extensions: { ".txt": "plaintext" },
  });
  assert(getLanguageIdFromPath("CMakeLists.txt") === "cmake", "filename takes precedence over extension");
  assert(getLanguageIdFromPath("notes.txt") === "plaintext", "extension used when no filename match");

  // ── 4. Overrides replace, not accumulate; built-ins never mutated ──
  console.log("\n🔧 Override lifecycle");
  setLanguageMapOverrides({ extensions: { ".qml": "qml" } });
  assert(getLanguageIdFromPath("README.md") === undefined, "previous overrides cleared on reinstall");
  setLanguageMapOverrides({});
  assert(getLanguageIdFromPath("Main.qml") === undefined, "empty overrides fully reset");
  assert(EXT_TO_LANGUAGE[".md"] === undefined, "built-in table untouched");

  // ── 5. No-extension paths ──
  console.log("\n🔧 Edge cases");
  setLanguageMapOverrides({ filenames: { Makefile: "make" } });
  assert(getLanguageIdFromPath("Makefile") === "make", "Makefile → make");
  assert(getLanguageIdFromPath("dir/") === undefined, "trailing slash / no basename → undefined");
  assert(getLanguageIdFromPath("") === undefined, "empty path → undefined");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
