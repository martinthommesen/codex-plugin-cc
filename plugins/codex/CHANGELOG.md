# Changelog

## 1.1.0 — 2026-10-25

- Update examples for current Codex models and rename the internal prompting skill
  to `codex-prompting`. Model and effort defaults still come from the user's Codex config.
- Accept `max` and `ultra` reasoning efforts. The retired `spark` shortcut now
  explains how to choose an available model instead of selecting a retired model.
- Wait for the server's terminal turn status before completing tasks and reviews.
  A final assistant message alone no longer implies success, so late failures and
  interruptions are reported. If the parent `turn/completed` never arrives after
  subagent work drains, ask Codex for the turn status with `thread/turns/list`, and
  infer completion (with a visible note) only when Codex cannot report it.
  Runtime disconnects fail pending work instead of leaving it waiting indefinitely.
- Match session-import completion IDs, surface structured import failures, and
  retain compatibility with older import notifications.
- Skip repeat review-gate runs while Claude is responding to stop-hook feedback.
  Rescue instructions now surface runtime errors instead of hiding them.
- Require Node.js 22 or later, pin Codex 0.164.0 for development, and update to
  TypeScript 7.1.0-beta (typecheck only; not used at runtime) and `@types/node` 26.6.5. Update CI to `actions/checkout` v7.0.1 and
  `actions/setup-node` v7.1.0, and test Node.js 22/24/26.
- Add upgrade instructions, a retired-model replacement table (GPT-5.4, GPT-5.4 mini,
  GPT-5.3-Codex-Spark, GPT-5.5), and regression coverage for current protocol behavior.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
