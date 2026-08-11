/**
 * Retention policy for browser-visible execution history.
 *
 * Runtime/lease keys intentionally remain short lived.  The immutable
 * execution state and its durable output transcript must outlive a terminal
 * session so reconnect and refresh can retrieve a completed execution.
 */
export const TTY_EXECUTION_HISTORY_RETENTION_SECONDS = 30 * 24 * 60 * 60
