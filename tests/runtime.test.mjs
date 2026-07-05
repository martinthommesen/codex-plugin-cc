import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, readStateFixture, run, seedStateFixture, writeJobFixture } from "./helpers.mjs";
import { createBrokerSocketHandler } from "../plugins/codex/scripts/app-server-broker.mjs";
import { BrokerCodexAppServerClient, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessStartTime } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

class BrokerTestSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.output = "";
  }

  setEncoding() {}

  write(chunk) {
    if (!this.destroyed) {
      this.output += String(chunk);
    }
  }

  end() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.emit("close");
  }

  receive(message) {
    this.emit("data", `${JSON.stringify(message)}\n`);
  }

  message(id) {
    return (
      this.output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((message) => message.id === id) ?? null
    );
  }
}

async function brokerRequest(socket, message) {
  socket.receive(message);
  return waitFor(() => socket.message(message.id));
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(
    result.stdout,
    /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i
  );
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = readStateFixture(stateDir);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task-resume-candidate returns the latest task thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-current",
        status: "completed",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-current",
        threadId: "thr_current",
        summary: "Investigate the flaky test",
        updatedAt: "2026-03-24T20:00:00.000Z"
      },
      {
        id: "task-other-session",
        status: "completed",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Old task run",
        updatedAt: "2026-03-24T20:05:00.000Z"
      },
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-current",
        threadId: "thr_review",
        summary: "Review main...HEAD",
        updatedAt: "2026-03-24T20:10:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-other-running",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Other session active task",
        updatedAt: "2026-03-24T20:05:00.000Z"
      }
    ]
  });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = readStateFixture(stateDir);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = readStateFixture(stateDir);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("brokered app-server errors expose the child stderr tail on the broker client", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-errors-with-stderr");
  initGitRepo(repo);

  const env = buildEnv(binDir);
  let appClient = null;
  try {
    appClient = await CodexAppServerClient.connect(repo, { env, disableBroker: true });
    const socket = new BrokerTestSocket();
    createBrokerSocketHandler(appClient).attach(socket);

    const threadResponse = await brokerRequest(socket, {
      id: 1,
      method: "thread/start",
      params: {
        cwd: repo,
        model: null,
        sandbox: "read-only",
        ephemeral: true
      }
    });
    const threadId = threadResponse.result.thread.id;

    const turnResponse = await brokerRequest(socket, {
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "FAIL_THIS_TURN" }],
        model: null,
        effort: null,
        outputSchema: null
      }
    });

    assert.equal(turnResponse.error.message, "turn/start failed with stderr");
    assert.match(turnResponse.error.data.stderr, /broker stderr tail marker/);
    assert.doesNotMatch(turnResponse.error.data.stderr, /broker stderr head marker/);

    const brokerClient = new BrokerCodexAppServerClient(repo, { brokerEndpoint: "unix:/unused.sock" });
    const rejection = new Promise((resolve, reject) => {
      brokerClient.pending.set(2, { resolve, reject, method: "turn/start" });
      brokerClient.handleLine(JSON.stringify(turnResponse));
    });
    await assert.rejects(rejection, (error) => {
      assert.match(error.message, /turn\/start failed with stderr/);
      assert.match(error.data?.data?.stderr ?? "", /broker stderr tail marker/);
      return true;
    });
    assert.equal(brokerClient.stderr, turnResponse.error.data.stderr);
  } finally {
    await appClient?.close().catch(() => {});
  }
});

test("broker interrupts an active turn when the owning client disconnects", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-delayed-turn-start");
  initGitRepo(repo);

  const env = buildEnv(binDir);
  let appClient = null;
  try {
    appClient = await CodexAppServerClient.connect(repo, { env, disableBroker: true });
    const socket = new BrokerTestSocket();
    createBrokerSocketHandler(appClient).attach(socket);

    const threadResponse = await brokerRequest(socket, {
      id: 1,
      method: "thread/start",
      params: {
        cwd: repo,
        model: null,
        sandbox: "workspace-write",
        ephemeral: true
      }
    });
    const threadId = threadResponse.result.thread.id;
    socket.receive({
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "keep working until interrupted" }],
        model: null,
        effort: null,
        outputSchema: null
      }
    });
    const startedTurn = await waitFor(() => {
      const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return fakeState.lastTurnStart ?? null;
    });

    socket.end();

    const interrupt = await waitFor(() => {
      const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return fakeState.lastInterrupt ?? null;
    });

    assert.deepEqual(interrupt, { threadId, turnId: startedTurn.turnId });
  } finally {
    await appClient?.close().catch(() => {});
  }
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);
  const queuedJob = await waitFor(() => {
    const job = readStateFixture(resolveStateDir(repo)).jobs.find((candidate) => candidate.id === launchPayload.jobId);
    return Number.isFinite(job?.pid) ? job : null;
  });
  assert.ok(queuedJob.pid > 0);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Codex Status/);
  assert.match(status.stdout, /Codex Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-live",
        kind: "review",
        kindLabel: "review",
        status: "running",
        title: "Codex Review",
        jobClass: "review",
        phase: "reviewing",
        threadId: "thr_1",
        summary: "Review working tree diff",
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:30:03.000Z"
      },
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        threadId: "thr_done",
        summary: "Review main...HEAD",
        createdAt: "2026-03-18T15:10:00.000Z",
        startedAt: "2026-03-18T15:10:05.000Z",
        completedAt: "2026-03-18T15:11:10.000Z",
        updatedAt: "2026-03-18T15:11:10.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(
    result.stdout,
    /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/
  );
  assert.match(
    result.stdout,
    /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/
  );
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-current",
        kind: "review",
        kindLabel: "review",
        status: "running",
        title: "Codex Review",
        jobClass: "review",
        phase: "reviewing",
        sessionId: "sess-current",
        threadId: "thr_current",
        summary: "Current session review",
        logFile: currentLog,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:30:00.000Z"
      },
      {
        id: "review-other",
        kind: "review",
        kindLabel: "review",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Previous session review",
        createdAt: "2026-03-18T15:20:00.000Z",
        startedAt: "2026-03-18T15:20:05.000Z",
        completedAt: "2026-03-18T15:21:00.000Z",
        updatedAt: "2026-03-18T15:21:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])], ["review-current"]);
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-adv-live",
        kind: "adversarial-review",
        status: "running",
        title: "Codex Adversarial Review",
        jobClass: "review",
        phase: "reviewing",
        threadId: "thr_adv_live",
        summary: "Adversarial review current changes",
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:30:00.000Z"
      },
      {
        id: "review-adv",
        kind: "adversarial-review",
        status: "completed",
        title: "Codex Adversarial Review",
        jobClass: "review",
        threadId: "thr_adv_done",
        summary: "Adversarial review working tree diff",
        createdAt: "2026-03-18T15:10:00.000Z",
        startedAt: "2026-03-18T15:10:05.000Z",
        completedAt: "2026-03-18T15:11:10.000Z",
        updatedAt: "2026-03-18T15:11:10.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        threadId: "thr_review_finished",
        summary: "Review working tree diff",
        createdAt: "2026-03-18T15:00:00.000Z",
        updatedAt: "2026-03-18T15:01:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("stop-gate reviews are hidden from default result/status but visible with --all", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" };
  seedStateFixture(stateDir, {
    jobs: [
      {
        id: "task-real",
        status: "completed",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-current",
        threadId: "thr_task",
        summary: "Real user task",
        rendered: "Real task output.\n",
        createdAt: "2026-03-18T15:10:00.000Z",
        updatedAt: "2026-03-18T15:11:00.000Z"
      },
      {
        // Newer than the real task — must NOT displace it in the default view.
        id: "task-stopgate",
        status: "completed",
        title: "Codex Stop Gate Review",
        jobClass: "stop-review",
        sessionId: "sess-current",
        threadId: "thr_stop",
        summary: "Stop-gate review",
        rendered: "ALLOW: looks good\n",
        createdAt: "2026-03-18T15:12:00.000Z",
        updatedAt: "2026-03-18T15:13:00.000Z"
      }
    ]
  });

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env });
  assert.equal(status.status, 0, status.stderr);
  const statusReport = JSON.parse(status.stdout);
  assert.equal(statusReport.latestFinished.id, "task-real");
  assert.equal(
    [statusReport.latestFinished.id, ...statusReport.recent.map((job) => job.id)].includes("task-stopgate"),
    false
  );

  const statusAll = run("node", [SCRIPT, "status", "--all", "--json"], { cwd: workspace, env });
  const statusAllReport = JSON.parse(statusAll.stdout);
  assert.equal(
    [statusAllReport.latestFinished?.id, ...statusAllReport.recent.map((job) => job.id)].includes("task-stopgate"),
    true
  );

  const result = run("node", [SCRIPT, "result"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Real task output\./);
  assert.doesNotMatch(result.stdout, /ALLOW: looks good/);
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-current",
        threadId: "thr_current",
        summary: "Current session review",
        createdAt: "2026-03-18T15:10:00.000Z",
        updatedAt: "2026-03-18T15:11:00.000Z"
      },
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Old session review",
        createdAt: "2026-03-18T15:20:00.000Z",
        updatedAt: "2026-03-18T15:21:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        summary: "Investigate flaky test",
        pid: sleeper.pid,
        logFile,
        createdAt: "2026-03-18T15:30:00.000Z",
        startedAt: "2026-03-18T15:30:01.000Z",
        updatedAt: "2026-03-18T15:30:02.000Z"
      }
    ]
  });

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = readStateFixture(stateDir);
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-other",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-other",
        summary: "Other session run",
        updatedAt: "2026-03-24T20:05:00.000Z",
        logFile
      }
    ]
  });

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = readStateFixture(stateDir);
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-other",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-other",
        summary: "Other session run",
        updatedAt: "2026-03-24T20:05:00.000Z",
        logFile
      }
    ]
  });

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = readStateFixture(stateDir);
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(
    () => {
      const state = readStateFixture(stateDir);
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status === "running" && job.threadId && job.turnId) {
        return job;
      }
      return null;
    },
    { timeoutMs: 15000 }
  );

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-completed",
        status: "completed",
        title: "Codex Review",
        sessionId: "sess-current",
        logFile: completedLog,
        createdAt: "2026-03-18T15:30:00.000Z",
        updatedAt: "2026-03-18T15:31:00.000Z"
      },
      {
        id: "review-running",
        status: "running",
        title: "Codex Review",
        sessionId: "sess-current",
        pid: sleeper.pid,
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      },
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        sessionId: "sess-other",
        logFile: otherSessionLog,
        createdAt: "2026-03-18T15:34:00.000Z",
        updatedAt: "2026-03-18T15:35:00.000Z"
      }
    ]
  });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = readStateFixture(stateDir);
  assert.deepEqual(
    state.jobs.map((job) => job.id),
    ["review-other"]
  );
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test(
  "session end tears down the broker process group with stored pid identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = makeTempDir();
    const childPidFile = path.join(repo, "child.pid");
    let childPid = null;
    const parent = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "fs.writeFileSync(process.argv[1], String(child.pid));",
          "setInterval(() => {}, 1000);"
        ].join("\n"),
        childPidFile
      ],
      { cwd: repo, detached: true, stdio: "ignore" }
    );
    parent.unref();

    t.after(() => {
      for (const pid of [-parent.pid, parent.pid, childPid]) {
        try {
          if (Number.isFinite(pid)) {
            process.kill(pid, "SIGTERM");
          }
        } catch {
          // Ignore missing cleanup processes.
        }
      }
    });

    childPid = await waitFor(() => {
      if (!fs.existsSync(childPidFile)) {
        return null;
      }
      return Number(fs.readFileSync(childPidFile, "utf8"));
    });
    const pidStartTime = await waitFor(() => getProcessStartTime(parent.pid));
    saveBrokerSession(repo, {
      pid: parent.pid,
      pidStartTime
    });

    const result = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: repo
      })
    });
    assert.equal(result.status, 0, result.stderr);

    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    });
  }
);

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  // Stop-gate reviews are internal: hidden from the default view, visible with --all.
  const status = run("node", [SCRIPT, "status", "--all"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  seedStateFixture(stateDir, {
    version: 1,
    config: {
      stopReviewGate: false
    },
    jobs: [
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-current",
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]
  });

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function askEnv(binDir, sessionId) {
  const env = { ...buildEnv(binDir) };
  delete env.CODEX_COMPANION_SESSION_ID;
  if (sessionId) {
    env.CODEX_COMPANION_SESSION_ID = sessionId;
  }
  return env;
}

test("ask creates a named read-only advisor thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "ask", "is this plan sound?"], {
    cwd: repo,
    env: askEnv(binDir, "sess-current")
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  assert.match(result.stdout, /Codex advisor thread: thr_1 \(new\)/);
  const state = readFakeState(binDir);
  const thread = state.threads.find((candidate) => candidate.id === "thr_1");
  assert.ok(thread.name.startsWith("Codex Companion Advisor"));
  assert.equal(thread.ephemeral, false);
  assert.equal(thread.sandbox, "read-only");
});

test("ask auto-resumes the session advisor thread read-only with only the follow-up text", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const first = run("node", [SCRIPT, "ask", "first question"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const second = run("node", [SCRIPT, "ask", "what about edge cases?"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Codex advisor thread: thr_1 \(continued\)/);

  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.threadId, "thr_1");
  assert.equal(state.lastTurnStart.prompt, "what about edge cases?");
  const lastResume = state.resumeRequests.at(-1);
  assert.equal(lastResume.threadId, "thr_1");
  assert.equal(lastResume.sandbox, "read-only");
});

test("ask --fresh starts a new advisor thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const first = run("node", [SCRIPT, "ask", "first question"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const second = run("node", [SCRIPT, "ask", "--fresh", "unrelated topic"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Codex advisor thread: thr_2 \(new\)/);
  assert.equal(readFakeState(binDir).lastTurnStart.threadId, "thr_2");
});

test("ask does not resume another session's advisor thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const first = run("node", [SCRIPT, "ask", "other session question"], {
    cwd: repo,
    env: askEnv(binDir, "sess-other")
  });
  assert.equal(first.status, 0, first.stderr);

  const second = run("node", [SCRIPT, "ask", "current session question"], {
    cwd: repo,
    env: askEnv(binDir, "sess-current")
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Codex advisor thread: thr_2 \(new\)/);
});

test("ask rejects task-style execution flags instead of leaking them into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  for (const flag of ["--background", "--wait", "--write", "--resume", "--resume-last"]) {
    const result = run("node", [SCRIPT, "ask", flag, "question"], { cwd: repo, env });
    assert.equal(result.status, 1, `${flag} should be rejected`);
    assert.match(result.stderr, new RegExp(`does not accept ${flag}`));
  }
  assert.equal(fs.existsSync(path.join(binDir, "fake-codex-state.json")), false);

  const spark = run("node", [SCRIPT, "ask", "-m", "spark", "quick question"], { cwd: repo, env });
  assert.equal(spark.status, 0, spark.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, "gpt-5.3-codex-spark");
});

test("ask supports --json, --prompt-file, and --cwd", () => {
  const repo = makeTempDir();
  const otherCwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const json = run("node", [SCRIPT, "ask", "--json", "structured question"], { cwd: repo, env });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.status, 0);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumed, false);
  assert.match(payload.rawOutput, /Handled the requested task\./);
  assert.equal(payload.failureMessage, "");

  const promptFile = path.join(repo, "question.txt");
  fs.writeFileSync(promptFile, "file question\n", "utf8");
  const fromFile = run("node", [SCRIPT, "ask", "--prompt-file", "question.txt"], { cwd: repo, env });
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.prompt, "file question");

  fs.writeFileSync(promptFile, " \n\t", "utf8");
  const blankFile = run("node", [SCRIPT, "ask", "--prompt-file", "question.txt"], { cwd: repo, env });
  assert.equal(blankFile.status, 1);
  assert.match(blankFile.stderr, /Provide a question/);

  const viaCwd = run("node", [SCRIPT, "ask", "--cwd", repo, "cwd question"], { cwd: otherCwd, env });
  assert.equal(viaCwd.status, 0, viaCwd.stderr);
  const stateDir = resolveStateDir(repo);
  const jobs = readStateFixture(stateDir).jobs;
  assert.equal(jobs[0].kind, "ask");
});

test("ask preflight failure leaves a failed tracked job that result renders generically", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  const env = {
    ...process.env,
    PATH: binDir,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const result = run("node", [SCRIPT, "ask", "will this fail?"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex CLI is not installed/);

  const stateDir = resolveStateDir(repo);
  const state = readStateFixture(stateDir);
  const askJob = state.jobs.find((job) => job.jobClass === "ask");
  assert.equal(askJob.status, "failed");

  const stored = run("node", [SCRIPT, "result", askJob.id], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /Codex CLI is not installed/);
  assert.doesNotMatch(stored.stdout, /Codex advisor thread:/);
});

test("ask stays out of task resume and default result selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const task = run("node", [SCRIPT, "task", "implement the thing"], { cwd: repo, env });
  assert.equal(task.status, 0, task.stderr);

  const ask = run("node", [SCRIPT, "ask", "what do you think?"], { cwd: repo, env });
  assert.equal(ask.status, 0, ask.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });
  assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(candidatePayload.available, true);
  assert.equal(candidatePayload.candidate.threadId, "thr_1");

  const result = run("node", [SCRIPT, "result"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Codex advisor thread:/);

  const stateDir = resolveStateDir(repo);
  const jobs = readStateFixture(stateDir).jobs;
  const askJob = jobs.find((job) => job.jobClass === "ask");
  const askResult = run("node", [SCRIPT, "result", askJob.id], { cwd: repo, env });
  assert.equal(askResult.status, 0, askResult.stderr);
  assert.match(askResult.stdout, /Codex advisor thread: thr_2/);
});

test("result without a job id explains when only advisor asks have finished", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const ask = run("node", [SCRIPT, "ask", "only an ask here"], { cwd: repo, env });
  assert.equal(ask.status, 0, ask.stderr);

  const result = run("node", [SCRIPT, "result"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Latest finished jobs are advisor asks/);
});

test("status labels completed and running ask jobs as ask", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const ask = run("node", [SCRIPT, "ask", "status labelling question"], { cwd: repo, env });
  assert.equal(ask.status, 0, ask.stderr);

  const finished = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(finished.status, 0, finished.stderr);
  const finishedReport = JSON.parse(finished.stdout);
  assert.equal(finishedReport.latestFinished.kindLabel, "ask");

  const stateDir = resolveStateDir(repo);
  writeJobFixture(stateDir, {
    id: "ask-live",
    status: "running",
    title: "Codex Advisor",
    jobClass: "ask",
    sessionId: "sess-current",
    summary: "Live advisor question",
    updatedAt: "2099-01-01T00:00:00.000Z"
  });

  const running = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(running.status, 0, running.stderr);
  const runningReport = JSON.parse(running.stdout);
  assert.equal(runningReport.running[0].id, "ask-live");
  assert.equal(runningReport.running[0].kindLabel, "ask");
});

test("ask without a session id falls back to the advisor thread from thread/list", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, null);

  const first = run("node", [SCRIPT, "ask", "seed the advisor thread"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  fs.rmSync(resolveStateDir(repo), { recursive: true, force: true });

  const second = run("node", [SCRIPT, "ask", "resume without local jobs"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Codex advisor thread: thr_1 \(continued, matched by thread name\)/);
  assert.equal(readFakeState(binDir).lastTurnStart.threadId, "thr_1");
});

test("stop hook labels a running ask job as ask", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = path.join(jobsDir, "ask-live.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "ask-live",
        status: "running",
        title: "Codex Advisor",
        jobClass: "ask",
        sessionId: "sess-current",
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]
  });

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Codex ask ask-live is still running/i);
  assert.match(result.stderr, /\/codex:cancel ask-live/i);
});

test("ask self-heals around interrupted ask jobs", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");
  const stateDir = resolveStateDir(repo);

  // An ask killed before its thread was created leaves a running record without a
  // threadId — nothing to resume, so the next ask starts fresh.
  seedStateFixture(stateDir, {
    jobs: [
      {
        id: "ask-stuck-no-thread",
        status: "running",
        title: "Codex Advisor",
        jobClass: "ask",
        sessionId: "sess-current",
        summary: "Interrupted before thread creation",
        updatedAt: "2099-01-01T00:00:00.000Z"
      }
    ]
  });

  const fresh = run("node", [SCRIPT, "ask", "no resumable thread yet"], { cwd: repo, env });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Codex advisor thread: thr_1 \(new\)/);

  // An ask killed AFTER thread creation leaves a running record with a threadId.
  // The next ask must resume that thread so the conversation context survives.
  const state = readStateFixture(stateDir);
  for (const job of state.jobs) {
    if (job.threadId === "thr_1") {
      job.status = "running";
      job.updatedAt = "2099-01-02T00:00:00.000Z";
      writeJobFixture(stateDir, job);
    }
  }

  const resumed = run("node", [SCRIPT, "ask", "continue after the interruption"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Codex advisor thread: thr_1 \(continued\)/);
});

test("task without --model falls back to gpt-5.5 when config sets no model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, "gpt-5.5");

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).latestFinished.kindLabel, "task");
});

test("task without --model defers to a config-set model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-with-model");

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, null);
});

test("explicit --model skips the config lookup entirely", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--model", "spark", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.equal(state.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(state.configReadCount ?? 0, 0);
});

test("task survives a config/read failure and keeps the null model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, null);
});

test("review without a model falls back to gpt-5.5 when config sets none", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.model, "gpt-5.5");
});

test("review_model in config suppresses the review fallback but not the task fallback", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-with-review-model");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.model, null);

  const task = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(task.status, 0, task.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, "gpt-5.5");
});

test("ask falls back to gpt-5.5 on fresh threads and keeps null on auto-resume", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const first = run("node", [SCRIPT, "ask", "first question"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = readFakeState(binDir);
  assert.equal(afterFirst.lastTurnStart.model, "gpt-5.5");
  const configReadsAfterFirst = afterFirst.configReadCount;

  const second = run("node", [SCRIPT, "ask", "follow up"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = readFakeState(binDir);
  assert.equal(afterSecond.lastTurnStart.model, null);
  assert.equal(afterSecond.configReadCount, configReadsAfterFirst);
});

test("task --resume-last keeps the null model on the resumed thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const first = run("node", [SCRIPT, "task", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, null);

  const explicitResume = run("node", [SCRIPT, "task", "--resume-last", "--model", "spark", "one more"], {
    cwd: repo,
    env
  });
  assert.equal(explicitResume.status, 0, explicitResume.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, "gpt-5.3-codex-spark");
});

test("alternate model providers never receive the gpt-5.5 fallback", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, null);
});

test("a failed ask turn renders loudly, keeps its thread, and stays resumable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = askEnv(binDir, "sess-current");

  const failed = run("node", [SCRIPT, "ask", "FAIL_THIS_TURN please"], { cwd: repo, env });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Codex advisor turn failed\./);
  assert.match(failed.stdout, /Codex advisor thread: thr_1 \(new\)/);

  const stateDir = resolveStateDir(repo);
  const jobs = readStateFixture(stateDir).jobs;
  const askJob = jobs.find((job) => job.jobClass === "ask");
  assert.equal(askJob.status, "failed");
  assert.equal(askJob.threadId, "thr_1");

  // The failed ask's thread is resumed on the next healthy turn.
  const recovered = run("node", [SCRIPT, "ask", "try again"], { cwd: repo, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /Codex advisor thread: thr_1 \(continued\)/);
});

test("adversarial review honors a config-set review_model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-with-review-model");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.model, null);
});

test("a whitespace-only config model still triggers the gpt-5.5 fallback", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-with-blank-model");

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastTurnStart.model, "gpt-5.5");
});

test("stop hook labels a running review job as review", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "review-live",
        status: "running",
        title: "Codex Review",
        jobClass: "review",
        sessionId: "sess-current",
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]
  });

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Codex review review-live is still running/i);
});

test("stop hook falls back to legacy job kind when jobClass is absent", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "legacy-review-live",
        kind: "review",
        kindLabel: "task",
        status: "running",
        title: "Codex Review",
        sessionId: "sess-current",
        logFile: runningLog,
        createdAt: "2026-03-18T15:32:00.000Z",
        updatedAt: "2026-03-18T15:33:00.000Z"
      }
    ]
  });

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Codex review legacy-review-live is still running/i);
});

test("result without a job id reports a first-ever running ask as still running", () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  seedStateFixture(stateDir, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "ask-live",
        status: "running",
        title: "Codex Advisor",
        jobClass: "ask",
        sessionId: "sess-current",
        summary: "Live advisor question",
        updatedAt: "2099-01-01T00:00:00.000Z"
      }
    ]
  });

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Job ask-live is still running/);
});
