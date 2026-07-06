import * as h from "./runtime-helpers.mjs";

h.test("task runs without auth preflight so Codex can refresh an expired session", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "refreshable-auth");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "check refreshable auth"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Handled the requested task/);
});

h.test("task reports the actual Codex auth error when the run is rejected", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "auth-run-fails");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "check failed auth"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.notEqual(result.status, 0);
  h.assert.match(result.stderr, /authentication expired; run codex login/);
});

h.test("task --resume-last resumes the latest persisted task thread", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = h.runBrokerCommand(t, ["task", "initial task"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = h.runBrokerCommand(t, ["task", "--resume-last", "follow up"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

h.test("task-resume-candidate returns the latest task thread from the current session", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.available, true);
  h.assert.equal(payload.sessionId, "sess-current");
  h.assert.equal(payload.candidate.id, "task-current");
  h.assert.equal(payload.candidate.threadId, "thr_current");
});

h.test("task --resume-last does not resume a task from another Claude session", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const statePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...h.buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...h.buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = h.runBrokerCommand(t, ["task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  h.assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = h.run("node", [h.SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  h.assert.equal(candidate.status, 0, candidate.stderr);
  h.assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = h.runBrokerCommand(t, ["task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  h.assert.equal(resume.status, 1);
  h.assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(h.fs.readFileSync(statePath, "utf8"));
  h.assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  h.assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

h.test("task --resume-last ignores running tasks from other Claude sessions", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = h.resolveStateDir(repo);
  h.fs.mkdirSync(h.path.join(stateDir, "jobs"), { recursive: true });
  h.seedStateFixture(stateDir, {
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
    ...h.buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = h.run("node", [h.SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  h.assert.equal(status.status, 0, status.stderr);
  h.assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = h.runBrokerCommand(t, ["task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  h.assert.equal(resume.status, 1);
  h.assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

h.test("write task output focuses on the Codex result without generic follow-up hints", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "--write", "fix the failing test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

h.test("task --resume acts like --resume-last without leaking the flag into the prompt", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const statePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = h.runBrokerCommand(t, ["task", "initial task"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = h.runBrokerCommand(t, ["task", "--resume", "follow up"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(h.fs.readFileSync(statePath, "utf8"));
  h.assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  h.assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

h.test("task --fresh is treated as routing control and does not leak into the prompt", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const statePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(h.fs.readFileSync(statePath, "utf8"));
  h.assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

h.test("task logs reasoning summaries and assistant messages to the job log", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-reasoning");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "investigate the failing test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const stateDir = h.resolveStateDir(repo);
  const state = h.readStateFixture(stateDir);
  const log = h.fs.readFileSync(state.jobs[0].logFile, "utf8");
  h.assert.match(log, /Reasoning summary/);
  h.assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  h.assert.match(log, /Assistant message/);
  h.assert.match(log, /Handled the requested task/);
});

h.test("task logs subagent reasoning and messages with a subagent prefix", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-subagent");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "challenge the current design"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const stateDir = h.resolveStateDir(repo);
  const state = h.readStateFixture(stateDir);
  const log = h.fs.readFileSync(state.jobs[0].logFile, "utf8");
  h.assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  h.assert.match(log, /Subagent design-challenger reasoning:/);
  h.assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  h.assert.match(log, /Subagent design-challenger:/);
  h.assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

h.test("task waits for the main thread to complete before returning the final result", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-subagent");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "challenge the current design"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

h.test("task ignores later subagent messages when choosing the final returned output", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-late-subagent-message");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "challenge the current design"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

h.test("task can finish after subagent work even if the parent turn/completed event is missing", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "challenge the current design"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});
