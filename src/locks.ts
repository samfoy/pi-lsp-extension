/**
 * Workspace Lock — cross-session coordination for bemol runs.
 *
 * Uses PID-based lockfiles in `.bemol/locks/` to prevent multiple pi sessions
 * from running bemol simultaneously in the same workspace.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  startTime: number;
  sessionId: string;
}

/**
 * Check if a process is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire a named lock for this workspace.
 * Uses O_CREAT|O_EXCL for atomic creation to avoid TOCTOU races.
 * Returns true if acquired, false if another live session holds it.
 */
export function acquireLock(workspaceRoot: string, name: string, sessionId: string): boolean {
  const locksDir = join(workspaceRoot, ".bemol", "locks");
  const lockFile = join(locksDir, `${name}.lock`);

  // Check existing lock — clean up stale locks from dead processes
  const existing = readLock(workspaceRoot, name);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    return false; // another live session holds this lock
  }

  // If stale lock exists, remove it first
  if (existing) {
    try { unlinkSync(lockFile); } catch { /* ignore */ }
  }

  // Acquire atomically using O_CREAT|O_EXCL (fails if file already exists)
  try {
    mkdirSync(locksDir, { recursive: true });
    const info: LockInfo = { pid: process.pid, startTime: Date.now(), sessionId };
    const content = JSON.stringify(info);

    // O_WRONLY | O_CREAT | O_EXCL — atomic: fails with EEXIST if another process created it first
    const fd = openSync(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err: any) {
    if (err.code === "EEXIST") {
      // Another process acquired the lock between our unlink and open — that's fine
      return false;
    }
    return false;
  }
}

/**
 * Release a lock owned by this process.
 */
export function releaseLock(workspaceRoot: string, name: string): void {
  const lockFile = join(workspaceRoot, ".bemol", "locks", `${name}.lock`);
  try {
    const existing = readLock(workspaceRoot, name);
    // Only delete if we own it
    if (existing && existing.pid === process.pid) {
      unlinkSync(lockFile);
    }
  } catch {
    // ignore
  }
}

/**
 * Read the current lock holder, or null if no lock / stale lock.
 */
export function readLock(workspaceRoot: string, name: string): LockInfo | null {
  const lockFile = join(workspaceRoot, ".bemol", "locks", `${name}.lock`);
  try {
    if (!existsSync(lockFile)) return null;
    const content = readFileSync(lockFile, "utf-8");
    const info = JSON.parse(content) as LockInfo;
    if (!info.pid || !info.startTime) return null;
    return info;
  } catch {
    return null;
  }
}

/**
 * Check if a lock is held by another live process (not us).
 */
export function isLockedByOther(workspaceRoot: string, name: string): boolean {
  const info = readLock(workspaceRoot, name);
  if (!info) return false;
  if (info.pid === process.pid) return false;
  return isProcessAlive(info.pid);
}

/**
 * Release all locks owned by this process in the workspace.
 */
export function releaseAllLocks(workspaceRoot: string): void {
  const locksDir = join(workspaceRoot, ".bemol", "locks");
  try {
    if (!existsSync(locksDir)) return;
    const files: string[] = readdirSync(locksDir);
    for (const file of files) {
      if (!file.endsWith(".lock")) continue;
      const name = file.replace(/\.lock$/, "");
      releaseLock(workspaceRoot, name);
    }
  } catch {
    // ignore
  }
}
