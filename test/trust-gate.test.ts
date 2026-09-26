// The project config is honored only for trusted projects (issue #16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import lspExtension from "../src/index.js";

const FAKE_LSP = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

function makeSession(opts: { trusted: boolean }) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lsp-trust-"));
  const fake = { command: process.execPath, args: [FAKE_LSP] };
  writeFileSync(
    join(cwd, ".pi-lsp.json"),
    JSON.stringify({ autoStart: ["typescript"], servers: { typescript: fake } }),
  );
  writeFileSync(join(cwd, "a.ts"), "const a = 1;\n");

  const handlers = new Map<string, Function[]>();
  lspExtension({
    events: { on() {} },
    registerTool() {},
    registerCommand() {},
    on: (event: string, h: Function) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
  } as any);

  const statuses: string[] = [];
  const notices: string[] = [];
  const ctx = {
    cwd,
    isProjectTrusted: () => opts.trusted,
    ui: {
      theme: { fg: (_c: string, text: string) => text },
      setStatus: (_k: string, text: string) => statuses.push(text),
      notify: (message: string) => notices.push(message),
    },
  };
  const emit = async (event: string) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx);
  };
  return { cwd, statuses, notices, emit, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("untrusted project: the whole config is ignored with a one-line notice", async () => {
  const s = makeSession({ trusted: false });
  try {
    await s.emit("session_start");
    assert.equal(s.notices.length, 1, s.notices.join(" | "));
    assert.match(s.notices[0], /ignored \.pi-lsp\.json \(project not trusted\)/);
    assert.equal(
      s.statuses.filter((t) => t.includes("auto-starting")).length,
      0,
      `autoStart must not fire when untrusted: ${s.statuses.join(" | ")}`,
    );
  } finally {
    await s.emit("session_shutdown");
    s.cleanup();
  }
});

test("trusted project: the config applies and no notice is shown", async () => {
  const s = makeSession({ trusted: true });
  try {
    await s.emit("session_start");
    assert.deepEqual(s.notices, []);
    assert.ok(
      s.statuses.some((t) => t.includes("auto-starting typescript")),
      `autoStart should fire: ${s.statuses.join(" | ")}`,
    );
    // Let the eagerly started fake server come up so shutdown disposes a live client.
    for (let i = 0; i < 100 && !s.statuses.some((t) => t.includes("typescript ready")); i++) {
      await sleep(50);
    }
  } finally {
    await s.emit("session_shutdown");
    s.cleanup();
  }
});
