# Codex Prompt Recipes

Use these as starting templates for Codex task prompts.
Copy the smallest recipe that fits the task, then trim anything you do not need.
In `codex:codex`, run diagnosis and fix-oriented recipes in write mode by default unless the user explicitly asked for read-only behavior.

## Diagnosis

```text
Goal: diagnose why <the failing test/command> is breaking in this repository.

Success criteria: the most likely root cause is identified with enough evidence to act on it confidently.

Output: 1. most likely root cause  2. evidence  3. smallest safe next step.

Stop rules: after each finding, ask whether the evidence already explains the failure — stop when it does. Do not guess missing repository facts; if required context is absent, state exactly what remains unknown.
```

## Narrow Fix

```text
Goal: implement the smallest safe fix for <the identified issue> in this repository, preserving existing behavior outside the failing path.

Success criteria: the fix is applied (not just identified), the changed code is coherent, and targeted tests, type checks, or lint checks pass where applicable.

Constraints: keep changes tightly scoped to the stated task; no unrelated refactors or cleanup.

Output: 1. summary of the fix  2. touched files  3. verification performed  4. residual risks or follow-ups.

Stop rules: default to the most reasonable low-risk interpretation and keep going; stop to ask only when a missing detail changes correctness materially.
```

## Root-Cause Review

```text
Goal: analyze this change for the most likely correctness or regression issues, using the provided repository context only.

Success criteria: every finding is material, actionable, and grounded in the repository context or tool outputs; inferences are labeled as inferences.

Output: 1. findings ordered by severity  2. supporting evidence for each  3. brief next steps.

Stop rules: before finalizing, check second-order failures — empty-state handling, retries, stale state, rollback paths — then stop; do not pad with speculative findings.
```

## Research Or Recommendation

```text
Goal: research the available options and recommend the best path for <the task>.

Success criteria: the recommendation follows from observed facts; important claims cite the sources inspected, preferring primary sources.

Output: 1. observed facts  2. reasoned recommendation  3. tradeoffs  4. open questions.

Stop rules: start with one broad pass; go deeper only where the evidence would change the recommendation. Separate observed facts, reasoned inferences, and open questions.
```
