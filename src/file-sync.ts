/**
 * File Sync — keeps LSP servers informed of file changes.
 *
 * Hooks into pi tool results for read/write/edit and sends
 * didOpen/didChange notifications to the appropriate LSP server.
 */

import { readFile } from "node:fs/promises";
import { LspManager } from "./lsp-manager.js";

interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
}

export class FileSync {
  private tracked: Map<string, TrackedDocument> = new Map();

  constructor(private manager: LspManager) {}

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
    if (!languageId) return;

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

  /** Get the number of tracked documents */
  get trackedCount(): number {
    return this.tracked.size;
  }
}
