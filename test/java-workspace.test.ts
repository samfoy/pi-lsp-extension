import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JAVA_IMPORT_EXCLUSIONS, LspManager, getJdtlsDataDir } from "../src/lsp-manager.js";

// sha1("my-project"), as computed by jdtls.py: sha1(cwd_name.encode()).hexdigest()
const HASH = "66a4119f8aefbe8687ef0e14c6e7e0e1844b7950";

test("getJdtlsDataDir mirrors jdtls.py's default -data per platform", () => {
  const cwd = "/work/my-project";
  assert.equal(getJdtlsDataDir(cwd, "linux", { HOME: "/h" }), `/h/.cache/jdtls/jdtls-${HASH}`);
  assert.equal(getJdtlsDataDir(cwd, "darwin", { HOME: "/h" }), `/h/Library/Caches/jdtls/jdtls-${HASH}`);
  assert.equal(getJdtlsDataDir(cwd, "win32", { APPDATA: "/appdata" }), `/appdata/jdtls/jdtls-${HASH}`);
  assert.equal(getJdtlsDataDir(cwd, "freebsd", { HOME: "/h" }), join(tmpdir(), "jdtls", `jdtls-${HASH}`));
});

test("Java init options always carry import exclusions, keeping jdtls defaults", () => {
  const mgr = new LspManager(mkdtempSync(join(tmpdir(), "pi-lsp-java-")));
  const opts = (mgr as any).getJavaInitializationOptions();
  const exclusions = opts.settings["java.import.exclusions"];
  assert.deepEqual(exclusions, JAVA_IMPORT_EXCLUSIONS);
  for (const d of ["**/node_modules/**", "**/.metadata/**", "**/archetype-resources/**", "**/META-INF/maven/**"]) {
    assert.ok(exclusions.includes(d), `keeps jdtls default ${d}`);
  }
  // jdtls matches against absolute paths: these would hide a workspace that lives under /build/ or /bin/.
  for (const d of ["**/build/**", "**/bin/**"]) {
    assert.ok(!exclusions.includes(d), `does not exclude ${d}`);
  }
});

function withFakeJdtlsWorkspace(log: string, fn: (dataDir: string, cwd: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pi-lsp-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = join(home, "my-project");
    const dataDir = getJdtlsDataDir(cwd);
    const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
    mkdirSync(join(res, ".root"), { recursive: true });
    mkdirSync(join(res, ".projects", "p"), { recursive: true });
    mkdirSync(join(dataDir, ".metadata", ".plugins", "org.eclipse.jdt.core"), { recursive: true });
    writeFileSync(join(dataDir, ".metadata", ".log"), log);
    for (const f of ["1.snap", ".root/2.tree", ".projects/p/3.snap"]) writeFileSync(join(res, f), "x");
    writeFileSync(join(dataDir, ".metadata", ".plugins", "org.eclipse.jdt.core", "index.db"), "index");
    fn(dataDir, cwd);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("corrupt jdtls workspace: snapshots are wiped, the JDT index is kept", { skip: process.platform !== "linux" }, () => {
  withFakeJdtlsWorkspace("!ENTRY ...\norg.eclipse.core.internal.resources.ObjectNotFoundException: Resource '/x' does not exist.\n", (dataDir, cwd) => {
    const messages: string[] = [];
    const mgr = new LspManager(cwd);
    (mgr as any).recoverCorruptJavaWorkspace(cwd, (m: string) => messages.push(m));
    const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
    assert.equal(existsSync(join(res, "1.snap")), false);
    assert.equal(existsSync(join(res, ".root", "2.tree")), false);
    assert.equal(existsSync(join(res, ".projects", "p", "3.snap")), false);
    assert.ok(existsSync(join(dataDir, ".metadata", ".plugins", "org.eclipse.jdt.core", "index.db")));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /wiped 3 snapshot file/);
  });
});

const CRASH_LOG = "org.eclipse.core.internal.resources.ObjectNotFoundException: Resource '/x' does not exist.\n";

/** A dir outside the jdtls data dir holding snapshot-named files recovery must not touch. */
function outsideDirWithSnapshots(): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-outside-"));
  const files = ["1.snap", ".root/2.tree", ".projects/p/3.snap"].map((f) => join(dir, f));
  mkdirSync(join(dir, ".root"));
  mkdirSync(join(dir, ".projects", "p"), { recursive: true });
  for (const f of files) writeFileSync(f, "outside");
  return { dir, files };
}

test("corrupt jdtls workspace: a symlinked project dir pointing outside is not followed", { skip: process.platform !== "linux" }, () => {
  const outside = outsideDirWithSnapshots();
  try {
    withFakeJdtlsWorkspace(CRASH_LOG, (dataDir, cwd) => {
      const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
      symlinkSync(outside.dir, join(res, ".projects", "linked"));
      const messages: string[] = [];
      (new LspManager(cwd) as any).recoverCorruptJavaWorkspace(cwd, (m: string) => messages.push(m));
      for (const f of outside.files) assert.ok(existsSync(f), `outside file kept: ${f}`);
      assert.equal(existsSync(join(res, ".projects", "p", "3.snap")), false);
      assert.match(messages[0], /wiped 3 snapshot file/);
    });
  } finally {
    rmSync(outside.dir, { recursive: true, force: true });
  }
});

test("corrupt jdtls workspace: a symlinked resources dir pointing outside is left alone", { skip: process.platform !== "linux" }, () => {
  const outside = outsideDirWithSnapshots();
  try {
    withFakeJdtlsWorkspace(CRASH_LOG, (dataDir, cwd) => {
      const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
      rmSync(res, { recursive: true });
      symlinkSync(outside.dir, res);
      const messages: string[] = [];
      (new LspManager(cwd) as any).recoverCorruptJavaWorkspace(cwd, (m: string) => messages.push(m));
      for (const f of outside.files) assert.ok(existsSync(f), `outside file kept: ${f}`);
      assert.deepEqual(messages, []);
    });
  } finally {
    rmSync(outside.dir, { recursive: true, force: true });
  }
});

test("corrupt jdtls workspace: recovery rotates the log, so the next launch wipes nothing", { skip: process.platform !== "linux" }, () => {
  withFakeJdtlsWorkspace(CRASH_LOG, (dataDir, cwd) => {
    const messages: string[] = [];
    const recover = () => (new LspManager(cwd) as any).recoverCorruptJavaWorkspace(cwd, (m: string) => messages.push(m));
    recover();
    const meta = join(dataDir, ".metadata");
    assert.equal(existsSync(join(meta, ".log")), false);
    const rotated = readdirSync(meta).filter((f) => f.startsWith(".log.pi-lsp-recovered-"));
    assert.equal(rotated.length, 1);
    assert.equal(readFileSync(join(meta, rotated[0]), "utf-8"), CRASH_LOG);

    // The recovered launch saves healthy snapshots and appends to .log, as Eclipse does.
    const res = join(meta, ".plugins", "org.eclipse.core.resources");
    writeFileSync(join(res, "1.snap"), "healthy");
    appendFileSync(join(meta, ".log"), "!ENTRY org.eclipse.jdt.ls.core 1 0 Initialized\n");
    recover();
    assert.equal(readFileSync(join(res, "1.snap"), "utf-8"), "healthy");
    assert.equal(messages.length, 1);
  });
});

test("a jdtls log that fails to read does not leak its file descriptor", { skip: process.platform !== "linux" }, () => {
  withFakeJdtlsWorkspace("", (dataDir, cwd) => {
    // A directory opens fine on Linux, then readSync throws EISDIR.
    const log = join(dataDir, ".metadata", ".log");
    rmSync(log);
    mkdirSync(log);
    const openFds = () => readdirSync("/proc/self/fd").length;
    const before = openFds();
    (new LspManager(cwd) as any).recoverCorruptJavaWorkspace(cwd);
    assert.equal(openFds(), before);
  });
});

test("healthy jdtls workspace: nothing is wiped", { skip: process.platform !== "linux" }, () => {
  withFakeJdtlsWorkspace("!ENTRY org.eclipse.jdt.ls.core 1 0 Initialized\n", (dataDir, cwd) => {
    const messages: string[] = [];
    (new LspManager(cwd) as any).recoverCorruptJavaWorkspace(cwd, (m: string) => messages.push(m));
    const res = join(dataDir, ".metadata", ".plugins", "org.eclipse.core.resources");
    assert.ok(existsSync(join(res, "1.snap")));
    assert.deepEqual(messages, []);
  });
});
