// Unit tests for FileSync.open-once semantics (issue #18): navigation tools
// call ensureOpen before their LSP request, and the same-batch read path may
// run concurrently — neither may double-open a document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSync } from "../src/file-sync.js";
import type { LspManager } from "../src/lsp-manager.js";

interface DidOpen {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

function makeHarness(opts?: { running?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-fsync-"));
  writeFileSync(join(dir, "sample.ts"), "export const x = 1;\n");
  const didOpens: DidOpen[] = [];
  const client = {
    didOpen: (uri: string, languageId: string, version: number, text: string) => {
      didOpens.push({ uri, languageId, version, text });
    },
  };
  const manager = {
    resolvePath: (p: string) => (p.startsWith("/") ? p : join(dir, p)),
    getFileUri: (p: string) => `file://${p}`,
    getLanguageId: () => "typescript",
    getRunningClient: () => (opts?.running === false ? null : client),
  } as unknown as LspManager;
  return { dir, didOpens, sync: new FileSync(manager), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ensureOpen sends didOpen exactly once, with the file contents", async () => {
  const h = makeHarness();
  try {
    await h.sync.ensureOpen(h.dir + "/sample.ts");
    await h.sync.ensureOpen("sample.ts"); // second call: already tracked
    assert.equal(h.didOpens.length, 1, "document must open once");
    assert.equal(h.didOpens[0].languageId, "typescript");
    assert.match(h.didOpens[0].text, /export const x/);
  } finally {
    h.cleanup();
  }
});

test("concurrent ensureOpen calls open the document only once", async () => {
  const h = makeHarness();
  try {
    await Promise.all([
      h.sync.ensureOpen("sample.ts"),
      h.sync.ensureOpen("sample.ts"),
      h.sync.ensureOpen("sample.ts"),
    ]);
    assert.equal(h.didOpens.length, 1, "concurrent callers must not double-open");
  } finally {
    h.cleanup();
  }
});

test("ensureOpen racing handleFileRead opens the document only once", async () => {
  const h = makeHarness();
  try {
    // ensureOpen starts first; whichever resumes from its readFile await first
    // must record the document, and the other must detect it and skip.
    const nav = h.sync.ensureOpen("sample.ts");
    const read = h.sync.handleFileRead("sample.ts");
    await Promise.all([nav, read]);
    assert.equal(h.didOpens.length, 1, "read + navigate in one batch must not double-open");
  } finally {
    h.cleanup();
  }
});

test("no running server is a silent no-op", async () => {
  const h = makeHarness({ running: false });
  try {
    await h.sync.ensureOpen("sample.ts");
    assert.equal(h.didOpens.length, 0);
  } finally {
    h.cleanup();
  }
});

test("unreadable file is a silent no-op", async () => {
  const h = makeHarness();
  try {
    await h.sync.ensureOpen("missing.ts");
    assert.equal(h.didOpens.length, 0);
  } finally {
    h.cleanup();
  }
});
