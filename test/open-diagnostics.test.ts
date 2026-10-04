// lsp_diagnostics against servers that only analyze opened documents (typescript-language-server,
// kotlin-lsp): the tool must open the file itself and wait for (or pull) a fresh report, never
// answer "clean" from an empty or stale cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LspManager, nativeTypeScriptServers } from "../src/lsp-manager.js";
import { FileSync } from "../src/file-sync.js";
import { createDiagnosticsTool } from "../src/tools/diagnostics.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-lsp-opened.mjs", import.meta.url));

async function withFakeServer(
  env: Record<string, string>,
  fn: (call: (path: string) => Promise<string>, ctx: { dir: string; mgr: LspManager }) => Promise<void>,
  maxTracked?: number,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-open-"));
  writeFileSync(join(dir, "bad.ts"), "BAD\n");
  writeFileSync(join(dir, "good.ts"), "ok\n");
  const mgr = new LspManager(dir, { typescript: { command: process.execPath, args: [FAKE], env } });
  new FileSync(mgr, maxTracked); // registers itself as the document opener
  const tool = createDiagnosticsTool(mgr);
  const call = async (path: string) => {
    const r = await tool.execute("t", { path }, undefined as never, undefined as never, undefined as never);
    return (r.content[0] as { text: string }).text;
  };
  try {
    await call("good.ts"); // first call starts the server
    for (let i = 0; i < 100 && !mgr.getRunningClient("typescript"); i++) await sleep(50);
    assert.ok(mgr.getRunningClient("typescript"), "fake server did not start");
    await fn(call, { dir, mgr });
  } finally {
    await mgr.shutdownAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("push-only server: the tool opens the file and waits for its report", { timeout: 20_000 }, async () => {
  await withFakeServer({}, async (call) => {
    assert.match(await call("bad.ts"), /fake type error/);
    assert.equal(await call("good.ts"), "No diagnostics (clean).");
  });
});

test("pull-capable server: the tool requests textDocument/diagnostic", { timeout: 20_000 }, async () => {
  await withFakeServer({ FAKE_PULL: "1" }, async (call) => {
    assert.match(await call("bad.ts"), /fake type error/);
    assert.equal(await call("good.ts"), "No diagnostics (clean).");
  });
});

test("a reopened document is not answered from the stale report its didClose produced", { timeout: 20_000 }, async () => {
  // maxTracked=1: opening good.ts evicts bad.ts (didClose → server publishes []).
  await withFakeServer({}, async (call, { dir }) => {
    writeFileSync(join(dir, "bad.ts"), "ok\n");
    assert.equal(await call("bad.ts"), "No diagnostics (clean).");
    await call("good.ts");
    await sleep(100);
    writeFileSync(join(dir, "bad.ts"), "BAD\n"); // changed on disk while closed
    assert.match(await call("bad.ts"), /fake type error/);
  }, 1);
});

test("a pull server that keeps cancelling gets a fast honest answer, not a push wait", { timeout: 20_000 }, async () => {
  await withFakeServer({ FAKE_PULL_FAIL: "1" }, async (call) => {
    const started = Date.now();
    assert.match(await call("bad.ts"), /did not answer the diagnostics request/);
    assert.ok(Date.now() - started < 4_000, "fell back to waiting for a push");
  });
});

test("a server that never reports on a file costs one wait, then answers at once", { timeout: 30_000 }, async () => {
  await withFakeServer({}, async (call, { dir }) => {
    writeFileSync(join(dir, "silent.ts"), "ok\n");
    assert.match(await call("silent.ts"), /not a clean result/);
    const started = Date.now();
    assert.equal(await call("silent.ts"), "The server has not reported diagnostics for this file.");
    assert.ok(Date.now() - started < 1_000, "waited again on an already-open document");
  });
});

test("ensureOpen: one didOpen per client, concurrent callers share it, a new client reopens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sync-"));
  writeFileSync(join(dir, "a.ts"), "x\n");
  try {
    const mgr = new LspManager(dir);
    const sync = new FileSync(mgr);
    const fakeClient = () => {
      const opens: string[] = [];
      return { opens, client: { disposed: false, didOpen: (uri: string) => opens.push(uri), clearDiagnostics() {}, didClose() {} } as any };
    };
    const c1 = fakeClient();
    const results = await Promise.all([sync.ensureOpen("a.ts", c1.client), sync.ensureOpen("a.ts", c1.client)]);
    assert.equal(c1.opens.length, 1, "concurrent callers sent two didOpen");
    assert.deepEqual(results, [true, true]);
    assert.equal(await sync.ensureOpen("a.ts", c1.client), false);
    const c2 = fakeClient(); // e.g. the server restarted
    assert.equal(await sync.ensureOpen("a.ts", c2.client), true);
    assert.equal(c2.opens.length, 1, "restarted client never received didOpen");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TypeScript 7 projects (no tsserver.js) run the project's tsc --lsp through node", () => {
  const mk = (withTsserver: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lsp-ts7-"));
    mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "typescript", "package.json"), "{}");
    writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), "");
    if (withTsserver) writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "");
    return dir;
  };
  const ts6 = mk(true);
  const ts7 = mk(false);
  try {
    assert.deepEqual(nativeTypeScriptServers(ts6), {});
    const native = nativeTypeScriptServers(ts7);
    const bin = join(ts7, "node_modules", "typescript", "bin", "tsc");
    assert.deepEqual(native.typescript, { command: process.execPath, args: [bin, "--lsp", "--stdio"] });
    assert.deepEqual(Object.keys(native).sort(), ["javascript", "javascriptreact", "typescript", "typescriptreact"]);
    const custom = { command: "custom-ts", args: [] };
    const mgr = new LspManager(ts7, { typescript: custom });
    assert.deepEqual((mgr as any).serverConfigs.get("typescript"), custom, ".pi-lsp.json still wins");
    assert.deepEqual((mgr as any).serverConfigs.get("javascript").args, [bin, "--lsp", "--stdio"]);
  } finally {
    rmSync(ts6, { recursive: true, force: true });
    rmSync(ts7, { recursive: true, force: true });
  }
});
