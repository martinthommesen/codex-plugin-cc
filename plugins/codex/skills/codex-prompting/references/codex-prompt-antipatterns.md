# Codex Prompt Anti-Patterns

Avoid these when prompting Codex (GPT-5.5).

## Over-specified process steps

Bad:

```text
First run the tests, then read the stack trace, then open the failing file, then check the imports, then...
```

Better:

```text
Goal: diagnose the failing test. Success criteria: root cause identified with actionable evidence.
```

GPT-5.5 plans its own process. Describe the destination, not the route.

## Absolute rules for judgment calls

Bad:

```text
ALWAYS run every test suite. NEVER touch more than one file.
```

Better:

```text
Run targeted tests when applicable. Prefer the smallest change that fixes the issue.
```

Reserve ALWAYS/NEVER for true invariants (e.g. "no unrelated refactors" on write tasks).

## Legacy prompt-stack scaffolding

Bad:

```text
<task>...</task>
<default_follow_through_policy>...</default_follow_through_policy>
<verification_loop>...</verification_loop>
<missing_context_gating>...</missing_context_gating>
```

Better:

```text
Goal, success criteria, output, stop rules — a few lines of prose.
```

Block catalogs built for weaker models add noise; 5.5 reads short outcome-first prompts more reliably.

## Duplicating runtime-attached schemas in prompt text

Bad:

```text
Reply with JSON: {"verdict": ..., "findings": [{"severity": ..., ...}]}   (pasted into a review prompt)
```

Better: the plugin's review commands already attach that schema through the runtime's `outputSchema` plumbing — keep the review prompt about the goal.

This anti-pattern is ONLY about duplicating a schema the runtime already enforces. A StructuredOutput instruction appended by a Workflow `agent(...)` call is the output contract for that task — forward it verbatim, never strip it.

## Vague stopping conditions

Bad:

```text
Investigate thoroughly and be comprehensive.
```

Better:

```text
After each result, ask: can I answer now with useful evidence? Stop when yes; state what remains unknown when evidence runs out.
```

## Missing evidence handling

Bad:

```text
Tell me exactly why production failed.
```

Better:

```text
Ground every claim in the provided context or tool outputs; label inferences as inferences; do not invent names or metrics.
```

## Escalating effort instead of tightening the prompt

Bad:

```text
Use xhigh effort and think very hard.
```

Better: state sharper success criteria and stop rules first; raise `--effort` only after a run proved insufficient.

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.
