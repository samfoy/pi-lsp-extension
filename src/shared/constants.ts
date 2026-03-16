/**
 * Shared constants — directories to skip, file size limits, etc.
 *
 * Used across code-overview, workspace-index, and search-engine.
 */

/** Directories to always skip when walking the project tree */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "dist", "target", "out", ".next",
  "__pycache__", ".tox", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  "vendor", ".gradle", ".idea", ".vscode", ".bemol", "env",
  "coverage", ".nyc_output", ".cache",
]);

/** Max file size to parse (500KB) */
export const MAX_FILE_SIZE = 500 * 1024;

/** Max files to index in the initial pass */
export const MAX_INDEX_FILES = 5000;
