// Unit tests for the user-level config path and the key-by-key merge (issue #15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, mergeConfigs, resolveUserConfigPath } from "../src/index.js";

test("resolveUserConfigPath prefers PI_CODING_AGENT_DIR", () => {
  assert.equal(
    resolveUserConfigPath({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/u"),
    "/custom/agent/pi-lsp.json",
  );
});

test("resolveUserConfigPath falls back to ~/.pi/agent", () => {
  assert.equal(
    resolveUserConfigPath({}, "/home/u"),
    join("/home/u", ".pi", "agent", "pi-lsp.json"),
  );
});

test("loadUserConfig reads pi-lsp.json from PI_CODING_AGENT_DIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-usercfg-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "pi-lsp.json"), JSON.stringify({ autoInjectDiagnostics: false }));
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.deepEqual(loadUserConfig(), { autoInjectDiagnostics: false });
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeConfigs returns the other side when one is null", () => {
  const only = { autoStart: ["rust"] };
  assert.equal(mergeConfigs(null, only), only);
  assert.equal(mergeConfigs(only, null), only);
  assert.equal(mergeConfigs(null, null), null);
});

test("project keys replace user keys; omitted user keys survive", () => {
  const merged = mergeConfigs(
    { autoInjectDiagnostics: false, lombokJar: "auto" },
    { autoStart: ["rust"] },
  )!;
  assert.equal(merged.autoInjectDiagnostics, false);
  assert.equal(merged.lombokJar, "auto");
  assert.deepEqual(merged.autoStart, ["rust"]);
});

test("project values replace user values on the same key", () => {
  const merged = mergeConfigs(
    { autoInjectDiagnostics: false },
    { autoInjectDiagnostics: true },
  )!;
  assert.equal(merged.autoInjectDiagnostics, true);
});

test("arrays are replaced wholesale by the project value", () => {
  const merged = mergeConfigs({ autoStart: ["typescript"] }, { autoStart: ["rust"] })!;
  assert.deepEqual(merged.autoStart, ["rust"]);
});

test("servers merge per language: project wins its languages, user languages remain", () => {
  const merged = mergeConfigs(
    {
      servers: {
        python: { command: "ty", args: ["server"] },
        rust: { command: "old-rust", args: [] },
      },
    },
    {
      servers: {
        rust: { command: "rust-analyzer", args: [] },
        cpp: { command: "clangd", args: [] },
      },
    },
  )!;
  assert.deepEqual(merged.servers?.python, { command: "ty", args: ["server"] });
  assert.deepEqual(merged.servers?.rust, { command: "rust-analyzer", args: [] });
  assert.deepEqual(merged.servers?.cpp, { command: "clangd", args: [] });
});
