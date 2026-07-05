# Changelog

## 2.1.0

- The plugin now targets GPT-5.5. When you pass no `--model` and no Codex config layer sets one, fresh threads fall back to `gpt-5.5`; an explicit `--model`, a config-set `model` (or `review_model` for reviews), any non-OpenAI `model_provider`, and resumed threads are never overridden.
- The internal prompting skill was renamed `gpt-5-4-prompting` → `codex-prompting` and rewritten around OpenAI's GPT-5.5 guidance: short outcome-first prompts (goal, success criteria, constraints, output, stop rules) replace the XML block catalog and mandatory verification loops.
- Effort guidance updated: leave `--effort` to the Codex config/default and tighten the prompt before escalating.

## 2.0.0

- **Breaking:** renamed `/codex:rescue` to `/codex:delegate` and the `codex-rescue` agent to `codex` (`codex:codex`). No aliases — `/codex:rescue` now errors; use `/codex:delegate`.
- New `ask` companion subcommand: read-only advisor turns on a persistent per-session Codex thread with automatic resume (`--fresh` to reset).
- New `codex:advisor` skill so Claude proactively consults Codex for second opinions.
- The `codex:codex` agent is documented for Workflow fan-out (`agentType: 'codex:codex'`, composes with structured-output schemas).
- `/codex:result` without a job id now skips advisor asks (their answers were shown inline); pass the ask job id to replay one.
- Job kind labels now say "task" instead of "rescue"; the stop hook labels running jobs by their class (task/review/ask).

## 1.0.0

- Initial version of the Codex plugin for Claude Code
