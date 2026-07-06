# Agent Notes

## Commands

- `npm test` runs the Node test suite. It is integration-heavy and takes about a minute.
- `node --test tests/<file>.mjs` runs one test file.
- `npm run lint` runs ESLint.
- `npm run format:check` checks Prettier formatting; `npm run format` rewrites it.
- `npx tsc -p tsconfig.json --noEmit` runs the strict JSDoc/type check.
- `npm run build` regenerates app-server types with the pinned `@openai/codex` devDependency and then type-checks.

## Layout

- CLI entry: `plugins/codex/scripts/codex-companion.mjs`.
- Shared runtime code: `plugins/codex/scripts/lib/`.
- Broker server: `plugins/codex/scripts/app-server-broker.mjs`.
- Hooks: `plugins/codex/scripts/*-hook.mjs` and `plugins/codex/hooks/hooks.json`.
- Slash commands: `plugins/codex/commands/*.md`.
- Agent and prompts: `plugins/codex/agents/codex.md`, `plugins/codex/prompts/*.md`.
- Generated app-server types live under `plugins/codex/.generated/`; do not edit them by hand.
- Bump `@openai/codex` deliberately; the generator version is locked in `package-lock.json`.

## Invariants

- Preserve shell-free spawning for repo/user-derived args. Use `lib/process.mjs` helpers.
- State is uid-scoped and private. Keep state dirs `0700`, files `0600`, and job ids behind `assertJobId`.
- Tests are hermetic. `tests/helpers.mjs` strips ambient `CODEX_COMPANION_*` and `CLAUDE_PLUGIN_DATA`.
- Broker tests must clean up their detached broker/app-server processes. Use the shared helpers; do not add silent `if (!loadBrokerSession(...)) return` skips.
- Do not overtake Codex config layering. The default model applies only when no explicit option or Codex config chooses one.
- Keep command-layer flags separate from task-layer flags. `/codex:delegate` consumes `--wait`/`--background`; `ask` rejects background/write/resume flags.

## Code Style

Prefer the clean current architecture over compatibility shims. Delete replaced paths, update all in-repo callers, and keep tests describing current behavior only.
