import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(
    source,
    /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/
  );
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "delegate.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("delegate command absorbs continue semantics", () => {
  const delegate = read("commands/delegate.md");
  const agent = read("agents/codex.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(delegate, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(delegate, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because the command named the routing with ambiguous prose ("Route this
  // request to the subagent") while running under `context: fork` — forked
  // general-purpose subagents do not expose the `Agent` tool, so the fork
  // fell back to `Skill` and re-entered this command. Pin the explicit
  // transport and the inline (no-fork) execution.
  assert.match(delegate, /subagent_type: "codex:codex"/);
  assert.match(delegate, /do not call `Skill\(codex:codex\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /--background\|--wait/);
  assert.match(delegate, /--resume\|--fresh/);
  assert.match(delegate, /--model <model\|spark>/);
  assert.match(delegate, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(delegate, /task-resume-candidate --json/);
  assert.match(delegate, /AskUserQuestion/);
  assert.match(delegate, /Continue current Codex thread/);
  assert.match(delegate, /Start a new Codex thread/);
  assert.match(delegate, /run the `codex:codex` subagent in the background/i);
  assert.match(delegate, /default to foreground/i);
  assert.match(delegate, /Do not forward them to `task`/i);
  assert.match(delegate, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(delegate, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(delegate, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(delegate, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(delegate, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(delegate, /If the user chooses continue, add `--resume`/i);
  assert.match(delegate, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(delegate, /thin forwarder only/i);
  assert.match(delegate, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(delegate, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(delegate, /return that command's stdout as-is/i);
  assert.match(delegate, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /^description: .*[Pp]roactively/m);
  assert.match(agent, /agentType: 'codex:codex'/);
  assert.match(
    agent,
    /StructuredOutput instruction \(as Workflow `agent\(\.\.\.\)` calls with a `schema` append\), include that instruction verbatim/i
  );
  assert.match(agent, /prefer foreground for a small, clearly bounded task/i);
  assert.match(
    agent,
    /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i
  );
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(
    agent,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(agent, /Do not call any companion subcommand other than `task`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(
    agent,
    /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i
  );
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return the command's error output verbatim/i);
  assert.match(agent, /codex-prompting/);
  assert.match(agent, /falling back to `gpt-5\.5` on fresh threads/i);
  assert.match(agent, /only to tighten the incoming request into a better Codex prompt/i);
  assert.match(
    agent,
    /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i
  );
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call any companion subcommand other than `task`/i);
  assert.match(
    runtimeSkill,
    /use the `codex-prompting` skill to rewrite the user's request into a tighter Codex prompt/i
  );
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(
    runtimeSkill,
    /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i
  );
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(
    runtimeSkill,
    /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i
  );
  assert.match(
    runtimeSkill,
    /If the Bash call fails or Codex cannot be invoked, return the command's error output verbatim/i
  );
  assert.match(readme, /`codex:codex` subagent/i);
  assert.match(
    readme,
    /if you do not pass `--model`, the plugin uses your Codex config's model; if neither sets one and your configured provider is OpenAI, it falls back to `gpt-5\.5` on fresh threads/i
  );
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:delegate`/);
  assert.match(readme, /### Ask Codex for advice/);
  assert.match(readme, /### Codex in workflows/);
  assert.match(readme, /agentType: 'codex:codex'/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(
    resultHandling,
    /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i
  );
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for delegated runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/codex-prompting/SKILL.md");
  const promptRecipes = read("skills/codex-prompting/references/codex-prompt-recipes.md");
  const promptAntipatterns = read("skills/codex-prompting/references/codex-prompt-antipatterns.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every delegated request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptingSkill, /Use `ask` for read-only advice on the persistent advisor thread/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
  // GPT-5.5 targeting: outcome-first guidance grounded in the official docs.
  assert.match(promptingSkill, /^name: codex-prompting$/m);
  assert.match(promptingSkill, /developers\.openai\.com\/api\/docs\/guides\/latest-model/);
  assert.match(promptingSkill, /developers\.openai\.com\/api\/docs\/guides\/prompt-guidance\?model=gpt-5\.5/);
  assert.match(promptingSkill, /outcome-first/i);
  assert.match(promptingSkill, /stop rules/i);
  // Workflow-appended StructuredOutput instructions are the contract, not an anti-pattern.
  assert.match(promptingSkill, /forward it verbatim/i);
  assert.match(promptAntipatterns, /forward it verbatim, never strip it/i);
  assert.doesNotMatch(promptingSkill, /<task>|<structured_output_contract>|<verification_loop>/);
  assert.match(promptAntipatterns, /legacy prompt-stack scaffolding/i);
  assert.match(promptAntipatterns, /escalating effort instead of tightening the prompt/i);
});

test("advisor skill is model-invocable and documents the ask contract", () => {
  const advisor = read("skills/advisor/SKILL.md");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");
  const pluginManifest = read(".claude-plugin/plugin.json");

  assert.match(advisor, /^name: advisor$/m);
  assert.doesNotMatch(advisor, /user-invocable:\s*false/);
  assert.match(advisor, /codex-companion\.mjs" ask "<question>"/);
  assert.match(advisor, /second opinion/i);
  assert.match(advisor, /read-only/i);
  assert.match(advisor, /--fresh/);
  assert.match(advisor, /agentType: 'codex:codex'/);
  assert.match(advisor, /always with `--fresh`/i);
  assert.match(runtimeSkill, /codex-companion\.mjs" ask "<question>"/);
  assert.match(runtimeSkill, /`ask` is always read-only/i);
  assert.match(runtimeSkill, /`--fresh` starts a new advisor thread/i);
  assert.match(runtimeSkill, /`--background`, `--wait`, `--write`, `--resume`, and `--resume-last` are rejected/i);
  assert.match(resultHandling, /advisor-thread line/i);
  assert.match(pluginManifest, /ask for advice/i);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*"\[--enable-review-gate\|--disable-review-gate\]"/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json "\$ARGUMENTS"/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});
