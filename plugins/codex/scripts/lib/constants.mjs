// Shared string constants that must stay identical across the CLI, the hooks,
// and the state layer. Keeping them in one module prevents the silent drift
// that duplicated literals invite (a rename in one place breaking the others).

/** Env var carrying the current Claude Code session id into tracked jobs. */
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

/** Env var pointing at the plugin's per-workspace data directory. */
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

/**
 * Marker embedded in the stop-gate review prompt. The companion detects it to
 * classify the job as a stop-review; it MUST match the wording in
 * `prompts/stop-review-gate.md`.
 */
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
