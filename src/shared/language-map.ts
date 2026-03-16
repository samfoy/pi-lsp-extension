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
};

/** Get the language ID for a file path based on extension */
export function getLanguageIdFromPath(filePath: string): string | undefined {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return ext ? EXT_TO_LANGUAGE[ext] : undefined;
}
