// Real-subprocess tests against test/fixtures/fake-lsp.mjs. Every test sets an explicit timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, getJdtlsDataDir } from "../src/lsp-manager.js";

const FAKE_LSP = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

test("a successful jdtls recovery is an info notice, not a server error", { timeout: 20_000, skip: process.platform !== "linux" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-lsp-home-"));
  const prev = { HOME: process.env.HOME, LOMBOK_JAR: process.env.LOMBOK_JAR };
  process.env.HOME = home;
  delete process.env.LOMBOK_JAR;
  const cwd = join(home, "my-project");
  const dataDir = getJdtlsDataDir(cwd);
  const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
  mkdirSync(cwd);
  mkdirSync(res, { recursive: true });
  writeFileSync(join(dataDir, ".metadata", ".log"), "org.eclipse.core.internal.resources.ObjectNotFoundException\n");
  writeFileSync(join(res, "1.snap"), "x");

  const java = { command: process.execPath, args: [FAKE_LSP] };
  const errors: string[] = [];
  const notices: string[] = [];
  const ready: string[] = [];
  const mgr = new LspManager(cwd, { java }, {
    onServerError: (_lang, msg) => errors.push(msg),
    onServerNotice: (_lang, msg) => notices.push(msg),
    onServerReady: (lang) => ready.push(lang),
  });
  try {
    await (mgr as any).startServer("java", java);
    assert.deepEqual(errors, []);
    assert.deepEqual(ready, ["java"]);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /wiped 1 snapshot file/);
  } finally {
    await mgr.shutdownAll();
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});
