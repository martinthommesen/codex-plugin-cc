import * as h from "./runtime-helpers.mjs";

h.test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = h.makeTempDir();
  const envFile = h.path.join(h.makeTempDir(), "claude-env.sh");
  h.fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = h.makeTempDir();
  const transcriptPath = h.path.join(repo, "session.jsonl");

  const result = h.run("node", [h.SESSION_HOOK, "SessionStart"], {
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

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(
    h.fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

h.test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = h.makeTempDir();
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = h.resolveStateDir(repo);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = h.path.join(jobsDir, "completed.log");
  const runningLog = h.path.join(jobsDir, "running.log");
  const otherSessionLog = h.path.join(jobsDir, "other.log");
  const completedJobFile = h.path.join(jobsDir, "review-completed.json");
  const runningJobFile = h.path.join(jobsDir, "review-running.json");
  const otherJobFile = h.path.join(jobsDir, "review-other.json");
  h.fs.writeFileSync(completedLog, "completed\n", "utf8");
  h.fs.writeFileSync(runningLog, "running\n", "utf8");
  h.fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  h.fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  h.fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = h.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  h.fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

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

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SESSION_HOOK, "SessionEnd"], {
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

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.fs.existsSync(otherSessionLog), true);
  h.assert.equal(h.fs.existsSync(otherJobFile), true);
  h.assert.deepEqual(
    h.fs.readdirSync(h.path.dirname(otherJobFile)).sort(),
    [h.path.basename(otherJobFile), h.path.basename(otherSessionLog)].sort()
  );

  await h.waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = h.readStateFixture(stateDir);
  h.assert.deepEqual(
    state.jobs.map((job) => job.id),
    ["review-other"]
  );
  const otherJob = state.jobs[0];
  h.assert.equal(otherJob.logFile, otherSessionLog);
});

h.test(
  "session end tears down the broker process group with stored pid identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const repo = h.makeTempDir();
    const childPidFile = h.path.join(repo, "child.pid");
    let childPid = null;
    const parent = h.spawn(
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

    childPid = await h.waitFor(() => {
      if (!h.fs.existsSync(childPidFile)) {
        return null;
      }
      return Number(h.fs.readFileSync(childPidFile, "utf8"));
    });
    const pidStartTime = await h.waitFor(() => h.getProcessStartTime(parent.pid));
    h.saveBrokerSession(repo, {
      pid: parent.pid,
      pidStartTime
    });

    const result = h.run("node", [h.SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: repo
      })
    });
    h.assert.equal(result.status, 0, result.stderr);

    await h.waitFor(() => parent.exitCode !== null || parent.signalCode !== null);
    h.assert.equal(parent.signalCode, "SIGTERM");
  }
);

h.test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const fakeStatePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = h.run("node", [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  h.assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = h.runBrokerCommand(t, ["task", "--write", "fix the issue"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: h.buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  h.assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  h.assert.equal(blockedPayload.decision, "block");
  h.assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  h.assert.match(blockedPayload.reason, /Missing empty-state guard/i);
  h.assert.match(blockedPayload.reason, /review gate auto-paused after one block for this session/i);

  const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
  h.assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  h.assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  h.assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  h.assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  // Stop-gate reviews are internal: hidden from the default view, visible with --all.
  const status = h.run("node", [h.SCRIPT, "status", "--all"], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  h.assert.equal(status.status, 0, status.stderr);
  h.assert.match(status.stdout, /Codex Stop Gate Review/);

  const skipped = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    },
    input: JSON.stringify({
      cwd: repo,
      last_assistant_message: "This stop should be allowed without another review."
    })
  });
  h.assert.equal(skipped.status, 0, skipped.stderr);
  h.assert.equal(skipped.stdout.trim(), "");
  h.assert.match(skipped.stderr, /review gate auto-paused after one block for this session/i);

  const freshSession = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: h.buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review-fresh",
      last_assistant_message: "A fresh session should still be reviewed."
    })
  });
  h.assert.equal(freshSession.status, 0, freshSession.stderr);
  h.assert.equal(JSON.parse(freshSession.stdout).decision, "block");

  const reenable = h.run("node", [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  h.assert.equal(reenable.status, 0, reenable.stderr);

  const reviewedAgain = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: h.buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "Re-enabled review gate should review this stop."
    })
  });
  h.assert.equal(reviewedAgain.status, 0, reviewedAgain.stderr);
  h.assert.equal(JSON.parse(reviewedAgain.stdout).decision, "block");
});

h.test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = h.makeTempDir();
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = h.resolveStateDir(repo);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = h.path.join(jobsDir, "task-running.log");
  const otherRunningLog = h.path.join(jobsDir, "task-other.log");
  h.fs.writeFileSync(runningLog, "running\n", "utf8");
  h.fs.writeFileSync(otherRunningLog, "other running\n", "utf8");

  h.seedStateFixture(stateDir, {
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
      },
      {
        id: "task-other",
        status: "running",
        title: "Codex Task",
        jobClass: "task",
        sessionId: "sess-other",
        logFile: otherRunningLog,
        createdAt: "2026-03-18T15:34:00.000Z",
        updatedAt: "2026-03-18T15:35:00.000Z"
      }
    ]
  });

  const blocked = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(blocked.status, 0, blocked.stderr);
  h.assert.equal(blocked.stdout.trim(), "");
  h.assert.match(blocked.stderr, /Codex task task-live is still running/i);
  h.assert.doesNotMatch(blocked.stderr, /task-other/i);
  h.assert.match(blocked.stderr, /\/codex:status/i);
  h.assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

h.test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "adversarial-clean");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = h.run("node", [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(setup.status, 0, setup.stderr);

  const allowed = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: h.buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  h.assert.equal(allowed.status, 0, allowed.stderr);
  h.assert.equal(allowed.stdout.trim(), "");
});

h.test("stop hook does not auto-pause the gate on unexpected review output", () => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "stop-review-unexpected");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = h.run("node", [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(setup.status, 0, setup.stderr);

  for (const message of ["first stop", "second stop"]) {
    const blocked = h.run("node", [h.STOP_HOOK], {
      cwd: repo,
      env: h.buildEnv(binDir),
      input: JSON.stringify({
        cwd: repo,
        session_id: "sess-stop-unexpected",
        last_assistant_message: message
      })
    });
    h.assert.equal(blocked.status, 0, blocked.stderr);
    const payload = JSON.parse(blocked.stdout);
    h.assert.equal(payload.decision, "block");
    h.assert.match(payload.reason, /unexpected answer/i);
    h.assert.doesNotMatch(payload.reason, /auto-paused/i);
  }
});

h.test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = h.makeTempDir();
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = h.run(process.execPath, [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  h.assert.equal(setup.status, 0, setup.stderr);

  const allowed = h.run(process.execPath, [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(allowed.status, 0, allowed.stderr);
  h.assert.equal(allowed.stdout.trim(), "");
  h.assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  h.assert.match(allowed.stderr, /Run \/codex:setup/i);
});

h.test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "refreshable-auth");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = h.run("node", [h.SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(setup.status, 0, setup.stderr);

  const allowed = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: h.buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(allowed.status, 0, allowed.stderr);
  h.assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  h.assert.equal(payload.decision, "block");
  h.assert.match(payload.reason, /Missing empty-state guard/i);
});

h.test("stop hook labels a running review job as review", () => {
  const repo = h.makeTempDir();
  const stateDir = h.resolveStateDir(repo);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = h.path.join(jobsDir, "review-live.log");
  h.fs.writeFileSync(runningLog, "running\n", "utf8");
  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stderr, /Codex review review-live is still running/i);
});

h.test("stop hook falls back to legacy job kind when jobClass is absent", () => {
  const repo = h.makeTempDir();
  const stateDir = h.resolveStateDir(repo);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = h.path.join(jobsDir, "review-live.log");
  h.fs.writeFileSync(runningLog, "running\n", "utf8");
  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stderr, /Codex review legacy-review-live is still running/i);
});
