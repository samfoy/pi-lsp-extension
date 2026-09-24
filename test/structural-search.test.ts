/**
 * Tests for structural search & rewrite: pattern-compiler, search-engine, rewrite-engine.
 *
 * Run: npm test (or: npx tsx test/structural-search.test.ts)
 */

import { TreeSitterManager } from "../src/tree-sitter/parser-manager.js";
import { compilePattern, type CompiledPattern } from "../src/tree-sitter/pattern-compiler.js";
import { searchFiles, collectFilesByLanguage } from "../src/tree-sitter/search-engine.js";
import { computeRewrites, applyRewrites, substituteCaptures } from "../src/tree-sitter/rewrite-engine.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const TEST_DIR = resolve("/tmp/structural-search-test");

async function main() {
  const mgr = new TreeSitterManager();
  await mgr.init();

  // Set up test fixtures
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  mkdirSync(resolve(TEST_DIR, "src"), { recursive: true });

  writeFileSync(resolve(TEST_DIR, "src/app.ts"), `
import { readFile } from "fs";

function processData(data: string): string {
  console.log("processing", data);
  const result = data.trim();
  console.log("done");
  return result;
}

function helper() {
  var x = 10;
  var y = "hello";
  const z = 42;
}

class UserService {
  async getUser(id: string) {
    const user = await this.db.find(id);
    return user;
  }

  async deleteUser(id: string) {
    console.log("deleting", id);
    await this.db.remove(id);
  }
}
`);

  writeFileSync(resolve(TEST_DIR, "src/utils.ts"), `
export function formatDate(d: Date): string {
  console.log("formatting date");
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}

export const doSomething = (a: number, b: number) => {
  var result = a + b;
  return result;
};
`);

  // ── 1. Pattern compiler ──
  console.log("\n🔧 Pattern Compiler");

  // Simple identifier pattern
  const p1 = await compilePattern("console.log($ARG)", "typescript", mgr);
  assert(p1.root.kind === "literal", "console.log($ARG) compiles to literal root");
  assert(p1.metavars.includes("ARG"), "captures $ARG metavar");
  assert(p1.languageId === "typescript", "language is typescript");

  // Variadic pattern
  const p2 = await compilePattern("console.log($$$ARGS)", "typescript", mgr);
  assert(p2.metavars.includes("ARGS"), "captures $$$ARGS variadic metavar");

  // Variable declaration pattern
  const p3 = await compilePattern("var $N = $V", "typescript", mgr);
  assert(p3.metavars.includes("N"), "captures $N");
  assert(p3.metavars.includes("V"), "captures $V");

  // Pattern with no metavars
  const p4 = await compilePattern("return result", "typescript", mgr);
  assert(p4.metavars.length === 0, "no metavars in literal pattern");

  // Bad pattern should throw
  let threw = false;
  try {
    await compilePattern("{{{{invalid}}}", "typescript", mgr);
  } catch {
    threw = true;
  }
  assert(threw, "invalid pattern throws error");

  // ── 2. Search engine — basic matching ──
  console.log("\n🔍 Search Engine — basic matching");

  // Find console.log calls with single arg
  const compiled1 = await compilePattern("console.log($ARG)", "typescript", mgr);
  const matches1 = await searchFiles(compiled1, TEST_DIR, mgr);
  console.log(`  Found ${matches1.length} console.log($ARG) matches`);
  assert(matches1.length > 0, "found console.log($ARG) matches");
  // Check captures
  const firstMatch = matches1[0];
  assert("ARG" in firstMatch.captures, "match has $ARG capture");
  console.log(`  First $ARG = "${firstMatch.captures.ARG}"`);

  // Find var declarations
  const compiled3 = await compilePattern("var $N = $V", "typescript", mgr);
  const matches3 = await searchFiles(compiled3, TEST_DIR, mgr);
  console.log(`  Found ${matches3.length} var $N = $V matches`);
  assert(matches3.length >= 3, "found at least 3 var declarations");
  // Check that captures are different
  const varNames = matches3.map(m => m.captures.N);
  console.log(`  Variable names: ${varNames.join(", ")}`);
  assert(varNames.includes("x"), 'found var x');
  assert(varNames.includes("y"), 'found var y');

  // ── 3. Search engine — variadic matching ──
  console.log("\n🔍 Search Engine — variadic matching");

  // Find console.log with any number of args
  const compiled2 = await compilePattern("console.log($$$ARGS)", "typescript", mgr);
  const matches2 = await searchFiles(compiled2, TEST_DIR, mgr);
  console.log(`  Found ${matches2.length} console.log($$$ARGS) matches`);
  assert(matches2.length >= 4, "found variadic console.log matches (at least 4)");

  // ── 4. Search engine — file scoping ──
  console.log("\n🔍 Search Engine — file scoping");

  const scopedMatches = await searchFiles(compiled1, TEST_DIR, mgr, {
    path: "src/utils.ts",
  });
  console.log(`  Found ${scopedMatches.length} matches in utils.ts only`);
  assert(scopedMatches.length >= 1, "found matches in scoped file");
  assert(scopedMatches.every(m => m.file.endsWith("utils.ts")), "all matches in utils.ts");

  // ── 5. Search engine — max results ──
  console.log("\n🔍 Search Engine — max results");

  const limitedMatches = await searchFiles(compiled2, TEST_DIR, mgr, { maxResults: 2 });
  assert(limitedMatches.length <= 2, `max_results respected (got ${limitedMatches.length})`);

  // ── 6. File collection ──
  console.log("\n📂 File Collection");

  const tsFiles = await collectFilesByLanguage(TEST_DIR, "typescript", mgr);
  assert(tsFiles.length === 2, `found 2 TypeScript files (got ${tsFiles.length})`);
  assert(tsFiles.some(f => f.endsWith("app.ts")), "includes app.ts");
  assert(tsFiles.some(f => f.endsWith("utils.ts")), "includes utils.ts");

  // Skips node_modules
  mkdirSync(resolve(TEST_DIR, "node_modules/pkg"), { recursive: true });
  writeFileSync(resolve(TEST_DIR, "node_modules/pkg/index.ts"), "export const x = 1;");
  const tsFiles2 = await collectFilesByLanguage(TEST_DIR, "typescript", mgr);
  assert(tsFiles2.length === 2, `still 2 files (node_modules skipped, got ${tsFiles2.length})`);

  // ── 7. Rewrite engine — substituteCaptures ──
  console.log("\n✏️ Rewrite Engine — substituteCaptures");

  assert(
    substituteCaptures("const $N = $V", { N: "x", V: "42" }) === "const x = 42",
    "basic substitution works",
  );
  assert(
    substituteCaptures("$$$ARGS", { ARGS: "a, b, c" }) === "a, b, c",
    "variadic substitution works",
  );
  assert(
    substituteCaptures("$UNKNOWN stays", {}) === "$UNKNOWN stays",
    "unknown metavar left as-is",
  );

  // ── 8. Rewrite engine — computeRewrites (dry run) ──
  console.log("\n✏️ Rewrite Engine — computeRewrites (dry run)");

  const varMatches = await searchFiles(compiled3, TEST_DIR, mgr);
  const rewrites = computeRewrites(varMatches, "const $N = $V");
  assert(rewrites.length === varMatches.length, "one rewrite per match");
  for (const r of rewrites) {
    assert(r.before.startsWith("var "), `before starts with "var" (got: ${r.before})`);
    assert(r.after.startsWith("const "), `after starts with "const" (got: ${r.after})`);
    console.log(`  ${r.file.split("/").pop()}:${r.line} — ${r.before} → ${r.after}`);
  }

  // ── 9. Rewrite engine — applyRewrites ──
  console.log("\n✏️ Rewrite Engine — applyRewrites");

  // Work on a copy to not mess up other tests
  const rewriteDir = resolve(TEST_DIR, "rewrite-test");
  mkdirSync(rewriteDir, { recursive: true });
  writeFileSync(resolve(rewriteDir, "test.ts"), `
function example() {
  var a = 1;
  var b = "hello";
  const c = true;
  var d = [];
}
`);

  const varPattern = await compilePattern("var $N = $V", "typescript", mgr);
  const varResults = await searchFiles(varPattern, rewriteDir, mgr);
  console.log(`  Found ${varResults.length} var declarations to rewrite`);
  assert(varResults.length === 3, `found 3 var declarations (got ${varResults.length})`);

  const result = await applyRewrites(varResults, "const $N = $V");
  assert(result.filesModified === 1, `modified 1 file (got ${result.filesModified})`);
  assert(result.changes.length === 3, `3 changes (got ${result.changes.length})`);

  // Verify the file was actually rewritten
  const rewritten = readFileSync(resolve(rewriteDir, "test.ts"), "utf-8");
  assert(!rewritten.includes("var a"), "var a replaced");
  assert(!rewritten.includes("var b"), "var b replaced");
  assert(!rewritten.includes("var d"), "var d replaced");
  assert(rewritten.includes("const a = 1"), "const a = 1 present");
  assert(rewritten.includes('const b = "hello"'), 'const b = "hello" present');
  assert(rewritten.includes("const d = []"), "const d = [] present");
  assert(rewritten.includes("const c = true"), "original const c preserved");
  console.log("  Rewritten file content:");
  console.log(rewritten.split("\n").map(l => `    ${l}`).join("\n"));

  // ── 10. Rewrite — no-op when before === after ──
  console.log("\n✏️ Rewrite Engine — no-op detection");

  const constPattern = await compilePattern("const $N = $V", "typescript", mgr);
  const constMatches = await searchFiles(constPattern, rewriteDir, mgr);
  const noopResult = await applyRewrites(constMatches, "const $N = $V");
  assert(noopResult.filesModified === 0, "no files modified when replacement matches original");

  // ── 11. Cross-language — Python ──
  console.log("\n🐍 Cross-language — Python");

  mkdirSync(resolve(TEST_DIR, "py"), { recursive: true });
  writeFileSync(resolve(TEST_DIR, "py/main.py"), `
def process(data):
    print("start")
    result = data.strip()
    print("done")
    return result

def helper():
    print("helper called")
`);

  const pyPattern = await compilePattern("print($ARG)", "python", mgr);
  const pyMatches = await searchFiles(pyPattern, TEST_DIR, mgr, { path: "py" });
  console.log(`  Found ${pyMatches.length} print($ARG) matches in Python`);
  assert(pyMatches.length >= 3, "found Python print matches");
  assert(pyMatches.every(m => m.file.endsWith(".py")), "all matches are Python files");

  // ── 12. Search — return value structure ──
  console.log("\n📋 Search — result structure");

  const singleMatch = (await searchFiles(compiled1, TEST_DIR, mgr, { maxResults: 1 }))[0];
  assert(typeof singleMatch.file === "string", "match.file is string");
  assert(typeof singleMatch.line === "number" && singleMatch.line > 0, "match.line is positive number");
  assert(typeof singleMatch.column === "number" && singleMatch.column > 0, "match.column is positive number");
  assert(typeof singleMatch.matchedText === "string", "match.matchedText is string");
  assert(typeof singleMatch.startIndex === "number", "match.startIndex exists");
  assert(typeof singleMatch.endIndex === "number", "match.endIndex exists");
  assert(singleMatch.endIndex > singleMatch.startIndex, "endIndex > startIndex");
  assert(typeof singleMatch.captures === "object", "match.captures is object");

  // ── Cleanup ──
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  mgr.shutdown();

  // ── Summary ──
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
