/**
 * File Sync — keeps LSP servers informed of file changes.
 *
 * Hooks into pi tool results for read/write/edit and sends
 * didOpen/didChange notifications to the appropriate LSP server.
 */

import { readFile } from "node:fs/promises";
import { LspManager } from "./lsp-manager.js";
import type { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "./tree-sitter/workspace-index.js";

/** Callback to check if a synthetic dot operation is in progress for a URI */
export type SyntheticDotChecker = (uri: string) => boolean;

interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
}

export class FileSync {
  private tracked: Map<string, TrackedDocument> = new Map();
  private treeSitter: TreeSitterManager | null = null;
  private workspaceIndex: WorkspaceIndex | null = null;
  private isSyntheticDotActive: SyntheticDotChecker = () => false;

  constructor(private manager: LspManager) {}

  /** Set the synthetic dot checker to coordinate with the completions tool */
  setSyntheticDotChecker(checker: SyntheticDotChecker): void {
    this.isSyntheticDotActive = checker;
  }

  /** Set the tree-sitter manager for cache invalidation */
  setTreeSitter(treeSitter: TreeSitterManager, workspaceIndex?: WorkspaceIndex): void {
    this.treeSitter = treeSitter;
    this.workspaceIndex = workspaceIndex ?? null;
  }

  /**
   * Handle a file being read — sends didOpen if not yet tracked.
   * Called from tool_result handler for the `read` tool.
   */
  async handleFileRead(filePath: string): Promise<void> {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);

    // Already tracked? Nothing to do for reads.
    if (this.tracked.has(uri)) return;

    const languageId = this.manager.getLanguageId(absPath);
    if (!languageId) return;

    // Only sync if we have a client already running for this language (don't start one just for a read)
    const client = this.manager.getRunningClient(languageId);
    if (!client) return;

    try {
      const content = await readFile(absPath, "utf-8");
      const doc: TrackedDocument = { uri, languageId, version: 1 };
      this.tracked.set(uri, doc);
      client.didOpen(uri, languageId, doc.version, content);
    } catch {
      // File might not exist or be unreadable — ignore
    }
  }

  /**
   * Handle a file being written/edited — sends didOpen or didChange.
   * Called from tool_result handler for `write` and `edit` tools.
   */
  async handleFileWrite(filePath: string): Promise<void> {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);
    const languageId = this.manager.getLanguageId(absPath);

    // Invalidate tree-sitter cache and re-index
    if (this.treeSitter) {
      this.treeSitter.invalidate(absPath);
      if (this.workspaceIndex) {
        // Re-index in the background (don't block the write)
        this.workspaceIndex.indexFile(absPath).catch(() => {});
      }
    }

    if (!languageId) return;

    // If a synthetic dot operation is in progress for this URI, defer the
    // didChange to avoid version conflicts. The completions tool will revert
    // the document to the correct content when it's done.
    if (this.isSyntheticDotActive(uri)) {
      // Schedule a retry after the synthetic dot window (200ms should be enough
      // for the 100ms settle delay + completion request + revert)
      setTimeout(() => {
        // Re-check: if still active, skip — another retry would be needed
        if (!this.isSyntheticDotActive(uri)) {
          this.handleFileWrite(filePath).catch(() => {});
        }
      }, 200);
      return;
    }

    // Get client (start server lazily if configured)
    const client = await this.manager.getClientForFile(absPath).catch(() => null);
    if (!client) return;

    try {
      const content = await readFile(absPath, "utf-8");
      const existing = this.tracked.get(uri);

      if (existing) {
        // Already open — send didChange with incremented version
        existing.version++;
        client.didChange(uri, existing.version, content);
      } else {
        // First time — send didOpen
        const doc: TrackedDocument = { uri, languageId, version: 1 };
        this.tracked.set(uri, doc);
        client.didOpen(uri, languageId, doc.version, content);
      }
    } catch {
      // File might not exist or be unreadable — ignore
    }
  }

  /**
   * Get the current tracked version for a URI, or null if not tracked.
   * Used by tools that need to send temporary didChange notifications
   * while keeping versions in sync.
   */
  getTrackedVersion(uri: string): number | null {
    const doc = this.tracked.get(uri);
    return doc ? doc.version : null;
  }

  /**
   * Update the tracked version for a URI after external didChange calls.
   * This keeps FileSync in sync when other code (e.g., completions tool)
   * sends didChange notifications directly to the LSP client.
   */
  setTrackedVersion(uri: string, version: number): void {
    const doc = this.tracked.get(uri);
    if (doc) {
      doc.version = version;
    }
  }

  /** Get the number of tracked documents */
  get trackedCount(): number {
    return this.tracked.size;
  }
}
