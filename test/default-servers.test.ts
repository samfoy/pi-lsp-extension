// Regression tests for the built-in server defaults (issue #17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SERVERS } from "../src/lsp-manager.js";
import { EXT_TO_LANGUAGE } from "../src/shared/language-map.js";

test("c and cpp default to clangd with no extra args", () => {
  assert.equal(DEFAULT_SERVERS.c?.command, "clangd");
  assert.equal(DEFAULT_SERVERS.cpp?.command, "clangd");
  assert.deepEqual(DEFAULT_SERVERS.c?.args, []);
  assert.deepEqual(DEFAULT_SERVERS.cpp?.args, []);
});

test("every default server entry has a command", () => {
  for (const [id, config] of Object.entries(DEFAULT_SERVERS)) {
    assert.ok(config.command, `default server ${id} has no command`);
  }
});

test("every C/C++ extension in the language map resolves to a default server", () => {
  const cExts = [".c", ".h", ".cpp", ".cc", ".hpp"];
  for (const ext of cExts) {
    const langId = EXT_TO_LANGUAGE[ext];
    assert.ok(langId, `language map lost ${ext}`);
    assert.equal(DEFAULT_SERVERS[langId]?.command, "clangd", `${ext} -> ${langId} not served by clangd`);
  }
});
