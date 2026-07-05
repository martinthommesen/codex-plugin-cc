---
name: advisor
description: Consult Codex (GPT-5.x) as a peer advisor for a second opinion. Use proactively before committing to a non-trivial plan or architecture, after forming a diagnosis of a tricky bug, or when reviewing your own significant work — and whenever the user says "ask codex" or wants a second opinion.
---

# Codex Advisor

Ask Codex a question directly from the main loop — no subagent, no job polling:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ask "<question>"
```

The full invocation contract (flags, rejections, thread mechanics) lives in the `codex-cli-runtime` skill. What matters here:

- **Read-only.** Codex advises; it never edits through `ask`. For work that should produce edits, delegate to the `codex:codex` subagent instead.
- **The conversation persists.** Each `ask` auto-resumes this session's advisor thread, so follow-ups send only the new question or delta. Pass `--fresh` to start an unrelated topic. Auto-resume is best-effort: job pruning in long sessions or session end silently starts a fresh thread.
- **Treat the answer as a peer opinion.** When Codex disagrees with your view, reconcile the disagreement explicitly in your response — don't silently adopt either side.
- **Keep the thread line.** The output ends with `Codex advisor thread: <id> (continued|new)`; preserve it so the user can continue the conversation.

## When to consult

- Before committing to a non-trivial plan, design, or architecture decision.
- After forming a diagnosis of a tricky bug — ask Codex to refute it.
- When reviewing significant work you produced yourself.
- Whenever the user asks for Codex's opinion in any words.

## In workflows and parallel contexts

- Fan out implementation work with `agent(prompt, { agentType: 'codex:codex' })` — Workflow `schema` options compose with it, so structured output works.
- Workflow subagents with Bash may call `ask` directly for advice — but always with `--fresh`: the auto-resumed thread belongs to the main conversation, and two concurrent asks resolving the same thread make the second turn fail on a busy thread.
