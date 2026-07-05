---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Two entry points use this contract:
- `task` — used only inside the `codex:codex` subagent to run delegated Codex work.
- `ask` — used from the main Claude loop (or a workflow subagent with Bash) to consult Codex read-only. See the `advisor` skill for when to reach for it.

## task (inside the `codex:codex` subagent)

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`

Execution rules:
- The subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, `cancel`, or `ask` from `codex:codex`.
- Use `task` for every delegated request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort. GPT-5.5 reasons efficiently at the Codex default; tighten the prompt before escalating.
- Leave model unset by default — the plugin uses the Codex config's model, falling back to `gpt-5.5` on fresh threads when neither sets one. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per delegated handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegated run.

Safety rules:
- Default to write-capable Codex work in `codex:codex` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.

## ask (from the main Claude loop)

Canonical invocation:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ask "<question>"`

Contract:
- `ask` is always read-only. Codex cannot edit files through it; never use `ask` for work that should produce edits (delegate to the `codex:codex` subagent with `task` instead).
- `ask` runs in the foreground only. `--background`, `--wait`, `--write`, `--resume`, and `--resume-last` are rejected with an error.
- Resume is automatic: each `ask` continues this Claude session's advisor thread, so follow-ups only need the new question or delta — do not re-send context Codex already has.
- `--fresh` starts a new advisor thread. Use it for an unrelated topic, and always in parallel or workflow contexts (concurrent asks on the shared thread make the second turn fail on a busy thread).
- `-m`/`--model <model|spark>` and `--effort <none|minimal|low|medium|high|xhigh>` work as on `task`; `spark` maps to `gpt-5.3-codex-spark`. Leave both unset by default.
- The output ends with a `Codex advisor thread: <id> (continued|new)` line; keep it visible so the user can continue the conversation.
- Auto-resume is best-effort within tracked job state: job pruning or session end silently starts a fresh advisor thread.
