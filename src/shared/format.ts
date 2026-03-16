/**
 * Shared formatting utilities for LSP tool results.
 */

import type { Location, LocationLink } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

/** Format an LSP Location as a relative file:line:col string */
export function formatLocation(loc: Location, rootDir: string): string {
  try {
    const absPath = fileURLToPath(loc.uri);
    const relPath = relative(rootDir, absPath);
    return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  } catch {
    return `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  }
}

/** Format an LSP LocationLink as a relative file:line:col string */
export function formatLocationLink(link: LocationLink, rootDir: string): string {
  try {
    const absPath = fileURLToPath(link.targetUri);
    const relPath = relative(rootDir, absPath);
    return `${relPath}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  } catch {
    return `${link.targetUri}:${link.targetSelectionRange.start.line + 1}:${link.targetSelectionRange.start.character + 1}`;
  }
}
