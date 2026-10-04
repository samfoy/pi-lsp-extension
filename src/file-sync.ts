/**
 * File Sync — keeps LSP servers informed of file changes.
 *
 * Hooks into pi tool results for read/write/edit and sends
 * didOpen/didChange notifications to the appropriate LSP server.
 *
 * Maintains an LRU-bounded set of tracked documents. When the limit is
 * reached, the least-recently-used document is closed via didClose to
 * prevent unbounded memory growth in the LSP server during long sessions.
 */

import type { LspClient } from "./lsp-client.js";
import { readFile } from "node:fs/promises";
import { LspManager } from "./lsp-manager.js";
import type { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "./tree-sitter/workspace-index.js";

/** Callback to check if a synthetic dot operation is in progress for a URI */
export type SyntheticDotChecker = (uri: string) => boolean;

/** Max open documents tracked simultaneously. Oldest are closed via didClose. */
const MAX_TRACKED_DOCUMENTS = 100;

interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
  /** The client the document was opened on; a replaced (restarted) client needs its own didOpen. */
  client: LspClient;
}

export class FileSync {
  /** LRU map: most-recently-used documents are at the end (Map preserves insertion order) */
  private tracked: Map<string, TrackedDocument> = new Map();
  private treeSitter: TreeSitterManager | null = null;
  private workspaceIndex: WorkspaceIndex | null = null;
  private isSyntheticDotActive: SyntheticDotChecker = () => false;
  private maxTracked: number;
  /** Opens in flight, so concurrent callers share one didOpen per URI. */
  private opening: Map<string, Promise<boolean>> = new Map();

  constructor(private manager: LspManager, maxTracked?: number) {
    this.maxTracked = maxTracked ?? MAX_TRACKED_DOCUMENTS;
    manager.setDocumentOpener((filePath, client) => this.ensureOpen(filePath, client));
  }

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
   * Touch a URI in the LRU — moves it to the end (most-recently-used position).
   * If the map exceeds maxTracked, evicts the oldest entry and sends didClose.
   */
  private touchAndEvict(uri: string): void {
    const doc = this.tracked.get(uri);
    if (doc) {
      // Move to end by deleting and re-inserting
      this.tracked.delete(uri);
      this.tracked.set(uri, doc);
    }

    // Evict oldest if over capacity
    while (this.tracked.size > this.maxTracked) {
      const oldest = this.tracked.entries().next();
      if (oldest.done) break;
      const [evictUri, evictDoc] = oldest.value;
      this.tracked.delete(evictUri);

      // Send didClose to the server the document was opened on, if it is still alive
      const client = evictDoc.client;
      if (client && !client.disposed) {
        client.didClose(evictUri);
      }
    }
  }

  /**
   * Handle a file being read — sends didOpen if not yet tracked.
   * Called from tool_result handler for the `read` tool.
   */
  async handleFileRead(filePath: string): Promise<void> {
    const absPath = this.manager.resolvePath(filePath);
    const languageId = this.manager.getLanguageId(absPath);
    if (!languageId) return;
    // Only sync if a client is already running for this language (don't start one just for a read)
    const client = this.manager.getRunningClient(languageId);
    if (!client) return;
    await this.ensureOpen(absPath, client);
  }

  /**
   * Make sure a document is open on the given client before a request about it.
   * Servers such as typescript-language-server and kotlin-lsp only analyze opened
   * documents, so tools must open the file themselves when pi has not synced it yet
   * (handleFileRead skips files read before the server was running).
   * Returns true if this call opened the document.
   */
  async ensureOpen(filePath: string, client: LspClient): Promise<boolean> {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);
    const existing = this.tracked.get(uri);
    if (existing && existing.client === client) {
      this.touchAndEvict(uri);
      return false;
    }
    const pending = this.opening.get(uri);
    if (pending) return pending;
    const languageId = this.manager.getLanguageId(absPath);
    if (!languageId) return false;
    const open = (async () => {
      try {
        const content = await readFile(absPath, "utf-8");
        // Drop any report from a previous open (or a previous client) so callers wait for a fresh one.
        client.clearDiagnostics(uri);
        this.tracked.set(uri, { uri, languageId, version: 1, client });
        client.didOpen(uri, languageId, 1, content);
        this.touchAndEvict(uri);
        return true;
      } catch {
        return false;
      } finally {
        this.opening.delete(uri);
      }
    })();
    this.opening.set(uri, open);
    return open;
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

    const existing = this.tracked.get(uri);
    if (!existing || existing.client !== client) {
      // Not open on this client yet (first write, or the server was restarted): open it.
      await this.ensureOpen(absPath, client);
      return;
    }
    try {
      const content = await readFile(absPath, "utf-8");
      // Already open — send didChange with incremented version
      existing.version++;
      client.didChange(uri, existing.version, content);
      this.touchAndEvict(uri);
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
