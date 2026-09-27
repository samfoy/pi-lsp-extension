/**
 * Shared language mappings — single source of truth for file extension → language ID.
 *
 * Used by both LspManager and TreeSitterManager.
 */

/** Map file extensions to LSP language IDs */
export const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mts": "typescript",
  ".mjs": "javascript",
  ".cts": "typescript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".swift": "swift",
  ".zig": "zig",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".vue": "vue",
  ".php": "php",
};

/**
 * Optional project-configured overrides, applied over EXT_TO_LANGUAGE.
 * Set via `.pi-lsp.json` (`extensions` / `filenames`) at session start.
 * Keys of `extensions` are normalized to `.lowercase` form; keys of
 * `filenames` are matched case-sensitively against the basename.
 */
let EXTENSION_OVERRIDES: Record<string, string> = {};
let FILENAME_OVERRIDES: Record<string, string> = {};

/**
 * Install override mappings from project config. Replaces any previously
 * installed overrides (call once per session start; {} clears them).
 */
export function setLanguageMapOverrides(overrides: {
  extensions?: Record<string, string>;
  filenames?: Record<string, string>;
}): void {
  EXTENSION_OVERRIDES = {};
  for (const [ext, lang] of Object.entries(overrides.extensions ?? {})) {
    const key = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    EXTENSION_OVERRIDES[key] = lang;
  }
  FILENAME_OVERRIDES = { ...(overrides.filenames ?? {}) };
}

/** Get the language ID for a file path based on filename or extension */
export function getLanguageIdFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const byName = FILENAME_OVERRIDES[base];
  if (byName) return byName;
  const ext = base.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return undefined;
  return EXTENSION_OVERRIDES[ext] ?? EXT_TO_LANGUAGE[ext];
}
