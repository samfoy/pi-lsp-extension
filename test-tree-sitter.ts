/**
 * Quick smoke test for the tree-sitter integration.
 * Exercises: parser-manager, symbol-extractor, workspace-index
 *
 * Run: npx tsx test-tree-sitter.ts
 */

import { TreeSitterManager } from "./src/tree-sitter/parser-manager.js";
import { extractSymbols, getNodeAtPosition, findDefinition, getSyntaxErrors, getSignatureText, getEnclosingDeclaration } from "./src/tree-sitter/symbol-extractor.js";
import { WorkspaceIndex } from "./src/tree-sitter/workspace-index.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function main() {
  const mgr = new TreeSitterManager();

  // ── 1. Init & language detection ──
  console.log("\n🔧 Parser Manager — init & language detection");
  await mgr.init();
  assert(mgr.getLanguageId("foo.ts") === "typescript", "foo.ts → typescript");
  assert(mgr.getLanguageId("bar.py") === "python", "bar.py → python");
  assert(mgr.getLanguageId("baz.rs") === "rust", "baz.rs → rust");
  assert(mgr.getLanguageId("main.go") === "go", "main.go → go");
  assert(mgr.getLanguageId("App.java") === "java", "App.java → java");
  assert(mgr.getLanguageId("README.md") === undefined, "README.md → undefined");
  assert(mgr.hasGrammar("typescript"), "has grammar: typescript");
  assert(!mgr.hasGrammar("haskell"), "no grammar: haskell");
  assert(mgr.getSupportedLanguages().length >= 19, `supported languages >= 19 (got ${mgr.getSupportedLanguages().length})`);

  // ── 2. Parse TypeScript ──
  console.log("\n🌳 Parse TypeScript");
  const tsCode = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class UserService {
  private users: Map<string, User> = new Map();

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  addUser(user: User): void {
    this.users.set(user.id, user);
  }
}

export interface User {
  id: string;
  name: string;
  email?: string;
}

export const MAX_USERS = 1000;

type UserMap = Map<string, User>;

export default function main() {
  const svc = new UserService();
  svc.addUser({ id: "1", name: "Alice" });
}
`;
  const tsTree = await mgr.parse("/tmp/test.ts", tsCode);
  assert(tsTree !== null, "parsed TypeScript successfully");

  const tsSymbols = extractSymbols(tsTree!, "typescript");
  const names = tsSymbols.map(s => s.name);
  console.log("  Symbols found:", names);
  assert(names.includes("greet"), "found function greet");
  assert(names.includes("UserService"), "found class UserService");
  assert(names.includes("User"), "found interface User");
  assert(names.includes("MAX_USERS"), "found const MAX_USERS");
  assert(names.includes("main"), "found default export function main");
  assert(names.includes("UserMap"), "found type alias UserMap");

  // Check nested methods
  const userServiceSym = tsSymbols.find(s => s.name === "UserService");
  assert(userServiceSym?.children !== undefined, "UserService has children");
  const methodNames = userServiceSym?.children?.map(c => c.name) ?? [];
  assert(methodNames.includes("getUser"), "UserService.getUser found");
  assert(methodNames.includes("addUser"), "UserService.addUser found");

  // ── 3. Parse Python ──
  console.log("\n🐍 Parse Python");
  const pyCode = `
import os

class Calculator:
    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self.history.append(result)
        return result

    def multiply(self, a, b):
        return a * b

def main():
    calc = Calculator()
    print(calc.add(2, 3))

MAX_HISTORY = 100
`;
  const pyTree = await mgr.parse("/tmp/test.py", pyCode);
  assert(pyTree !== null, "parsed Python successfully");
  const pySymbols = extractSymbols(pyTree!, "python");
  const pyNames = pySymbols.map(s => s.name);
  console.log("  Symbols found:", pyNames);
  assert(pyNames.includes("Calculator"), "found class Calculator");
  assert(pyNames.includes("main"), "found function main");
  const calcSym = pySymbols.find(s => s.name === "Calculator");
  const calcMethods = calcSym?.children?.map(c => c.name) ?? [];
  assert(calcMethods.includes("__init__"), "Calculator.__init__ found");
  assert(calcMethods.includes("add"), "Calculator.add found");

  // ── 4. Parse Rust ──
  console.log("\n🦀 Parse Rust");
  const rsCode = `
pub fn process(data: &[u8]) -> Result<Vec<u8>, Error> {
    Ok(data.to_vec())
}

pub struct Config {
    pub name: String,
    pub value: i32,
}

impl Config {
    pub fn new(name: &str) -> Self {
        Config { name: name.to_string(), value: 0 }
    }
}

pub trait Processor {
    fn process(&self, input: &str) -> String;
}

pub enum Status {
    Active,
    Inactive,
    Error(String),
}

const MAX_SIZE: usize = 1024;
`;
  const rsTree = await mgr.parse("/tmp/test.rs", rsCode);
  assert(rsTree !== null, "parsed Rust successfully");
  const rsSymbols = extractSymbols(rsTree!, "rust");
  const rsNames = rsSymbols.map(s => s.name);
  console.log("  Symbols found:", rsNames);
  assert(rsNames.includes("process"), "found fn process");
  assert(rsNames.includes("Config"), "found struct Config");
  assert(rsNames.some(n => n.startsWith("impl")), "found impl block");
  assert(rsNames.includes("Processor"), "found trait Processor");
  assert(rsNames.includes("Status"), "found enum Status");
  assert(rsNames.includes("MAX_SIZE"), "found const MAX_SIZE");

  // ── 5. Parse Go ──
  console.log("\n🔵 Parse Go");
  const goCode = `
package main

import "fmt"

func Add(a, b int) int {
    return a + b
}

type Server struct {
    Port int
    Host string
}

func (s *Server) Start() error {
    return nil
}

const MaxRetries = 3

var DefaultServer = Server{Port: 8080}
`;
  const goTree = await mgr.parse("/tmp/test.go", goCode);
  assert(goTree !== null, "parsed Go successfully");
  const goSymbols = extractSymbols(goTree!, "go");
  const goNames = goSymbols.map(s => s.name);
  console.log("  Symbols found:", goNames);
  assert(goNames.includes("Add"), "found func Add");
  assert(goNames.includes("Server"), "found type Server");
  assert(goNames.includes("Start"), "found method Start");
  assert(goNames.includes("MaxRetries"), "found const MaxRetries");

  // ── 6. Parse Java ──
  console.log("\n☕ Parse Java");
  const javaCode = `
package com.example;

public class Handler {
    private final String name;

    public Handler(String name) {
        this.name = name;
    }

    public String handle(String input) {
        return name + ": " + input;
    }
}

interface Processor {
    void process(String data);
}

enum Status {
    OK, ERROR, PENDING
}
`;
  const javaTree = await mgr.parse("/tmp/Test.java", javaCode);
  assert(javaTree !== null, "parsed Java successfully");
  const javaSymbols = extractSymbols(javaTree!, "java");
  const javaNames = javaSymbols.map(s => s.name);
  console.log("  Symbols found:", javaNames);
  assert(javaNames.includes("Handler"), "found class Handler");
  assert(javaNames.includes("Processor"), "found interface Processor");
  assert(javaNames.includes("Status"), "found enum Status");
  const handlerSym = javaSymbols.find(s => s.name === "Handler");
  const handlerMethods = handlerSym?.children?.map(c => c.name) ?? [];
  assert(handlerMethods.includes("handle"), "Handler.handle found");

  // ── 7. Node at position & definition finding ──
  console.log("\n📍 Node at position & definition lookup");
  // "greet" starts at line 2 col 17 in tsCode (0-indexed: row=1, col=16)
  const node = getNodeAtPosition(tsTree!, 1, 17);
  assert(node !== null, "found node at position");
  assert(node?.text === "greet", `node text is "greet" (got "${node?.text}")`);

  const defs = findDefinition(tsTree!, "greet", "typescript");
  assert(defs.length > 0, "found definition of greet");
  assert(defs[0].name === "greet", "definition name matches");

  // ── 8. Syntax errors ──
  console.log("\n🔴 Syntax error detection");
  const badCode = `function foo( { return 42; }`;
  const badTree = await mgr.parse("/tmp/bad.ts", badCode);
  assert(badTree !== null, "parsed bad code (with errors)");
  const errors = getSyntaxErrors(badTree!);
  assert(errors.length > 0, `found ${errors.length} syntax error(s)`);
  console.log("  Errors:", errors.map(e => e.message));

  // ── 9. Enclosing declaration ──
  console.log("\n🏗️ Enclosing declaration");
  // Line 10 (0-indexed: 9) is inside UserService.getUser
  const enclosing = getEnclosingDeclaration(tsTree!, 9, 10);
  assert(enclosing !== null, "found enclosing declaration");
  if (enclosing) {
    const sig = getSignatureText(enclosing);
    console.log(`  Signature: ${sig}`);
    assert(sig.includes("getUser"), `enclosing is getUser (got: ${sig})`);
  }

  // ── 10. Workspace index ──
  console.log("\n📚 Workspace index");
  const testDir = resolve("/tmp/tree-sitter-test-workspace");
  try { rmSync(testDir, { recursive: true }); } catch {}
  mkdirSync(resolve(testDir, "src"), { recursive: true });
  writeFileSync(resolve(testDir, "src/app.ts"), `
export class AppService {
  start(): void {}
  stop(): void {}
}

export function createApp(): AppService {
  return new AppService();
}
`);
  writeFileSync(resolve(testDir, "src/utils.ts"), `
export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}

export const VERSION = "1.0.0";
`);
  writeFileSync(resolve(testDir, "src/main.py"), `
class Database:
    def connect(self):
        pass

def run_server(port):
    db = Database()
    db.connect()
`);

  const wsIndex = new WorkspaceIndex(testDir, mgr);
  await wsIndex.build();
  const stats = wsIndex.getStats();
  console.log(`  Indexed ${stats.files} files, ${stats.symbols} symbols`);
  assert(stats.files === 3, `indexed 3 files (got ${stats.files})`);
  assert(stats.symbols > 0, `has symbols (got ${stats.symbols})`);

  // Search
  const appResults = wsIndex.search("AppService");
  assert(appResults.length > 0, "found AppService in index");
  assert(appResults[0].name === "AppService", "first result is AppService");

  const formatResults = wsIndex.search("format");
  assert(formatResults.length > 0, "found format* in index");
  assert(formatResults.some(r => r.name === "formatDate"), "found formatDate");

  // Cross-language search
  const dbResults = wsIndex.search("Database");
  assert(dbResults.length > 0, "found Python class Database in index");

  // File-specific symbols
  const appSyms = wsIndex.getSymbolsForFile(resolve(testDir, "src/app.ts"));
  assert(appSyms.length > 0, `app.ts has symbols (got ${appSyms.length})`);

  // Re-index after change
  writeFileSync(resolve(testDir, "src/utils.ts"), `
export function formatDate(d: Date): string {
  return d.toISOString();
}

export function newHelper(): void {}
`);
  await wsIndex.indexFile(resolve(testDir, "src/utils.ts"));
  const newResults = wsIndex.search("newHelper");
  assert(newResults.length > 0, "found newHelper after re-index");
  const versionResults = wsIndex.search("VERSION");
  assert(versionResults.length === 0, "VERSION removed after re-index");

  // ── 11. Tree caching ──
  console.log("\n💾 Tree caching");
  const tree1 = await mgr.parse("/tmp/cache-test.ts", "function a() {}");
  const tree2 = await mgr.parse("/tmp/cache-test.ts", "function a() {}");
  assert(tree1 === tree2, "same content returns cached tree");
  const tree3 = await mgr.parse("/tmp/cache-test.ts", "function b() {}");
  assert(tree3 !== tree1, "different content returns new tree");
  mgr.invalidate("/tmp/cache-test.ts");
  assert(mgr.getCachedTree("/tmp/cache-test.ts") === null, "invalidate clears cache");


  // ── 12. Windows path regression (fileURLToPath vs .pathname) ──
  // On Windows, import.meta.url is 'file:///C:/path/...'.
  // Using .pathname gives '/C:/path/...' — path.resolve() treats the leading
  // slash as 'root of current drive', so if CWD is on E:\ you get E:\C:\...
  // Using fileURLToPath() correctly produces 'C:\path\...' on Windows.
  console.log("\n🪟 Windows path regression (fileURLToPath vs .pathname)");

  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const wasmPath = resolve(moduleDir, "node_modules/web-tree-sitter/tree-sitter.wasm");

  assert(existsSync(wasmPath), `wasm resolves to a real file: ${wasmPath}`);

  // Detect drive-doubling: a sign that .pathname was used on Windows.
  // e.g. 'E:\\C:\\Users\\...' when CWD drive != module drive.
  const hasDriveDoubling = /[A-Za-z]:\\[A-Za-z]:\\/.test(wasmPath);
  assert(!hasDriveDoubling, `path has no doubled drive letter: ${wasmPath}`);

  // Also verify the grammar dir resolves cleanly to real .wasm grammar files.
  const grammarPath = resolve(moduleDir, "node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm");
  assert(existsSync(grammarPath), `grammar wasm resolves to a real file: ${grammarPath}`);

  // ── Cleanup ──
  try { rmSync(testDir, { recursive: true }); } catch {}
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
