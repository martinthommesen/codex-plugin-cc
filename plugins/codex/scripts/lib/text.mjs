// Small, dependency-free text helpers shared by the CLI, the app-server client,
// and job-control. Kept in a neutral module so `codex.mjs` and `job-control.mjs`
// can both use them without an import cycle (job-control already imports codex).

/**
 * Collapse whitespace and truncate to `limit` characters with an ellipsis.
 * @param {unknown} text
 * @param {number} [limit]
 * @returns {string}
 */
export function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/**
 * Heuristic: does this command line look like a test/lint/build verification step?
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeVerificationCommand(text) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(text ?? "")
  );
}
