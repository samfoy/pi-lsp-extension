/**
 * Shared timing constants for LSP operations.
 */

/** Delay (ms) to wait for LSP to publish diagnostics after a file change */
export const DIAGNOSTIC_SETTLE_DELAY_MS = 1500;

/** Delay (ms) to wait for a daemon socket to start listening after spawn */
export const DAEMON_SOCKET_READY_DELAY_MS = 500;

/** Interval (ms) between retries when connecting to a daemon */
export const DAEMON_RETRY_INTERVAL_MS = 5000;

/** Maximum number of retries when connecting to a daemon (5 min total at 5s intervals) */
export const DAEMON_MAX_RETRIES = 60;

/** Delay (ms) to let LSP process a synthetic didChange before requesting completions */
export const SYNTHETIC_DOT_SETTLE_DELAY_MS = 100;
