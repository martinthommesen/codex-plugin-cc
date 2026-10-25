# Codex plugin for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- live job status: a status line entry while Codex works, a toast (and, in the terminal, a system notification for long jobs) when a job finishes, and a `/codex-jobs` pane to cancel, open, or resume jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 22 or later** (Node.js 24 LTS recommended)
- **A current Codex CLI**. This release is validated against Codex 0.164.0.
- **Claude Code with plugin support**. Manifest validation was checked with Claude Code 2.1.310.
  Live job status uses Claude Code's hooks module API (early access), validated with 2.1.310.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add openai/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@openai-codex
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace**, enter `openai/codex-plugin-cc`, then **Add plugin**.

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`
- `/codex-jobs` in the command list

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Update an existing installation

Update Codex and refresh the plugin from your configured marketplace:

```bash
npm install -g @openai/codex@latest
claude plugin marketplace update openai-codex
claude plugin update codex@openai-codex
```

Then run `/reload-plugins` and `/codex:setup` inside Claude Code. Updating the
marketplace installs its published version; to try this checkout's changes, start
Claude Code with `claude --plugin-dir ./plugins/codex` from the repository root.

Several models have retired from Codex with ChatGPT sign-in. If your Codex config,
a `--model` flag, or a saved prompt still names one, switch to its replacement:

| Retired model | Retired | Replacement |
| --- | --- | --- |
| `gpt-5.4` | August 31, 2026 | `gpt-6-sol` |
| `gpt-5.4-mini` | August 31, 2026 | `gpt-6-luna` |
| `gpt-5.3-codex-spark` (the `spark` shortcut) | September 14, 2026 | none; omit `--model` or pick one with Codex `/model` |
| `gpt-5.5` | October 14, 2026 | `gpt-6.1-sol` on paid plans, `gpt-6-luna` on Free and Go |

The GPT-5.4 and GPT-5.5 retirements do not affect API-key sessions. Current examples below use
GPT-6.1 Sol and GPT-6 Luna when available to your account. Explicit model names are
passed through, including custom provider models; the plugin leaves the model and
effort unset by default. See the [current model guidance](https://learn.chatgpt.com/docs/models).

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-6-luna --effort medium investigate the flaky integration test
/codex:rescue --model gpt-6.1-sol --effort high investigate the regression
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- model availability and supported efforts depend on your account, provider, and Codex version; use Codex `/model` to see available choices
- `--effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; Codex validates support for the selected model
- the retired `spark` shortcut now returns guidance instead of selecting GPT-5.3-Codex-Spark
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate uses additional Codex capacity on each normal stop. It skips repeat stops while Claude is responding to stop-hook feedback to avoid a review loop.

### Live job status and `/codex-jobs`

You don't have to poll `/codex:status` while Codex works. In the terminal and in the desktop app:

- **Status line.** While a review or rescue runs, a `codex: review reviewing 1m 12s` entry sits under the prompt. With several jobs it reads `codex: 2 jobs running`.
- **Completion alerts.** When a job finishes, fails, or is cancelled, a toast names the job and the follow-up command, such as `/codex:result review-…`. If the job ran 30 seconds or longer and you're in the terminal, you also get a system notification through your configured notification channel. The desktop app doesn't receive these.
- **`/codex-jobs` pane.** Opens a live panel beside the chat. It lists this session's jobs with their phase, duration, summary, and latest progress lines. Each job has buttons:
  - **Cancel** for running jobs
  - **Result** for finished jobs, which runs `/codex:result <id>`
  - **Copy resume**, which copies `codex resume <thread-id>` so you can continue in Codex

To turn system notifications off, open `/config` and set the plugin's **System notifications** option to off. Toasts and the status line stay on.

The pane and status line read the same job records as `/codex:status`. The plugin checks once when an interactive session starts. After that it polls only while a Codex job is running, or briefly after a companion command.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-6-luna` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-6-luna"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Development and compatibility

```bash
npm ci
npm run check-version
npm test
npm run test:mod
npm run build
claude plugin validate plugins/codex
claude plugin validate .
```

`npm run test:mod` validates and tests the live-status hooks module
(`plugins/codex/hooks/register.tsx`) with `claude plugin test`. It needs the
`claude` CLI, so CI does not run it. To try the module interactively, start
`claude --plugin-dir ./plugins/codex`. Edits reload when the turn ends, and
Claude Code writes the API types to `plugins/codex/.claude-plugin/types/`.

The development dependency pins Codex 0.164.0 so protocol type generation and
native import tests are reproducible. Installed plugins continue to use the
user's global Codex CLI. CI tests Node.js 22, 24, and 26. The runtime suite covers
reviews, tasks, cancellation, shared brokers, transfer, and lifecycle hooks;
native tests use synthetic transcripts in an isolated home without model inference.

Compatibility was researched on October 25, 2026 against the
[Codex app-server protocol](https://learn.chatgpt.com/docs/app-server),
[Codex models](https://learn.chatgpt.com/docs/models),
[Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference),
[Claude Code hooks](https://code.claude.com/docs/en/hooks), and
[Node.js release support](https://nodejs.org/en/about/previous-releases).
