/**
 * Shared debug logger — lightweight logging for non-fatal errors.
 *
 * Controlled by the PI_LSP_DEBUG environment variable.
 * When enabled, logs to stderr so they're visible but don't interfere
 * with JSON-RPC or tool output.
 */

const DEBUG = process.env.PI_LSP_DEBUG === "1" || process.env.PI_LSP_DEBUG === "true";

/** Log a debug message if PI_LSP_DEBUG is enabled */
export function debug(context: string, message: string, error?: unknown): void {
  if (!DEBUG) return;
  const errMsg = error instanceof Error ? error.message : error ? String(error) : "";
  const suffix = errMsg ? `: ${errMsg}` : "";
  console.error(`[pi-lsp] ${context}${suffix ? " — " + message + suffix : " — " + message}`);
}
