---
name: codex-prompting
description: Internal guidance for composing Codex and GPT-5.5 prompts for coding, review, diagnosis, and research tasks inside the Codex Claude Code plugin
user-invocable: false
---

# Codex Prompting

Use this skill when the `codex:codex` subagent or a direct `ask` advisor call needs a Codex prompt. It targets GPT-5.5, following the official guidance at https://developers.openai.com/api/docs/guides/latest-model and https://developers.openai.com/api/docs/guides/prompt-guidance?model=gpt-5.5.

Core principle: GPT-5.5 interprets prompts literally and thoroughly and is concise and direct by default. Short, outcome-first prompts beat process-heavy prompt stacks. Do not carry over legacy scaffolding built for weaker models — block catalogs, mandatory verification loops, and follow-through boilerplate add noise, not control.

## Prompt shape

Describe the destination, not every step. Cover, in plain prose or short sections:

- **Goal**: the concrete job and the relevant repository or failure context.
- **Success criteria**: what must be true before the final answer.
- **Constraints**: scope, safety, and evidence limits that actually matter.
- **Output**: the sections, ordering, and length the answer should have.
- **Stop rules**: when to stop, retry, abstain, or ask — e.g. "after each result, ask: can I answer now with useful evidence?"

A Role line is optional; skip Personality blocks entirely for one-shot task prompts.

## Decision rules, not absolutes

- Avoid ALWAYS/NEVER except for true invariants. Use decision rules for judgment calls ("prefer X when Y").
- One invariant stands for write-capable tasks: keep changes tightly scoped to the stated task; no unrelated refactors or cleanup.
- Prefer one clear task per Codex run. Split unrelated asks into separate runs.

## Choosing the surface

- Use built-in `review` or `adversarial-review` commands when the job is reviewing local git changes. Those prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions on the same Codex thread. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.
- Use `ask` for read-only advice on the persistent advisor thread. Send only the question or delta — the thread already carries prior context.

## Structured output

Schemas go through the runtime's `outputSchema` plumbing, never pasted into prompt text. Describing the shape in prose AND attaching a schema is redundant — attach the schema and keep the prompt about the goal.

## Verification

For coding tasks, one decision rule suffices: run targeted unit tests, type checks, or lint checks when applicable. Do not wrap every prompt in a mandatory verification-loop block.

## Research and grounding

- Set a retrieval budget: start with one broad search; make another retrieval call only when the top results don't answer the core question.
- Use retrieved or provided facts for concrete product, metric, and date claims, and cite them. Do not invent specific names or metrics.
- Keep claims anchored to observed evidence; label inferences as inferences.

## Effort and model

- Leave `--effort` unset so the Codex config or default controls it. GPT-5.5 reasons efficiently — tighten the prompt before asking for higher effort; reach for `high`/`xhigh` only after a run proved insufficient.
- Leave the model unset by default; the plugin uses the Codex config's model and falls back to `gpt-5.5` on fresh threads when neither the user nor the config chooses.

## Long runs

Ask Codex for brief, outcome-based progress updates only when the task is long-running or tool-heavy.

Starting templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
