// Real-subprocess tests against test/fixtures/fake-lsp.mjs. Every test sets an explicit timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../src/lsp-client.js";
import { LspManager, daemonScriptPath, getJdtlsDataDir } from "../src/lsp-manager.js";

const FAKE_LSP = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));
const BUILT_DAEMON = fileURLToPath(new URL("../dist/lsp-daemon.js", import.meta.url));
const pendingTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("the daemon launches from the built dist/lsp-daemon.js, from the bundle and from source", () => {
  assert.equal(daemonScriptPath(new URL("../dist/index.js", import.meta.url).href), BUILT_DAEMON);
  assert.equal(daemonScriptPath(), BUILT_DAEMON);
  assert.ok(existsSync(BUILT_DAEMON), "dist/lsp-daemon.js is missing: run npm run build");
});

test("the built daemon serves a fake LSP server over its socket", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-daemon-"));
  const socketPath = join(dir, "sockets", "lsp-fake.sock");
  // Plain node, as LspManager.spawnDaemon runs it: no tsx loader in the daemon.
  const { NODE_OPTIONS: _, ...env } = process.env;
  const daemon = spawn(process.execPath, [daemonScriptPath(), socketPath, process.execPath, FAKE_LSP], {
    cwd: dir,
    env: { ...env, LSP_ROOT_DIR: dir, LSP_LANGUAGE_ID: "fake" },
    stdio: "ignore",
  });
  let exited = false;
  daemon.on("exit", () => { exited = true; });
  const client = new LspClient({ command: "unused", args: [], rootDir: dir, languageId: "fake", socketPath });
  try {
    // The daemon writes its pid file once the socket is listening.
    for (let i = 0; i < 100 && !existsSync(socketPath.replace(/\.sock$/, ".pid")); i++) await sleep(50);
    assert.equal(exited, false, "daemon exited during startup");
    const timersBefore = pendingTimers();
    await client.start();
    assert.equal(pendingTimers(), timersBefore, "connecting left its timeout timer pending");
    const uri = pathToFileURL(join(dir, "a.txt")).href;
    const hover = await client.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 2, character: 5 } });
    assert.deepEqual(hover, { contents: { kind: "plaintext", value: "fake hover 2:5" } });
  } finally {
    await client.shutdown();
    if (!exited) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed daemon socket connect leaves no timer pending", { timeout: 5_000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-nosock-"));
  const client = new LspClient({ command: "unused", args: [], rootDir: dir, languageId: "fake", socketPath: join(dir, "missing.sock") });
  try {
    const timersBefore = pendingTimers();
    await assert.rejects(client.start(), /Failed to connect to LSP daemon/);
    assert.equal(pendingTimers(), timersBefore, "the failed connect left its timeout timer pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
