import * as h from "./runtime-helpers.mjs";

h.test("task --background enqueues a detached worker and exposes per-job status", async (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "slow-task");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = h.runBrokerCommand(t, ["task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  h.assert.equal(launchPayload.status, "queued");
  h.assert.match(launchPayload.jobId, /^task-/);
  const queuedJob = await h.waitFor(() => {
    const job = h
      .readStateFixture(h.resolveStateDir(repo))
      .jobs.find((candidate) => candidate.id === launchPayload.jobId);
    return Number.isFinite(job?.pid) ? job : null;
  });
  h.assert.ok(queuedJob.pid > 0);

  const waitedStatus = h.runBrokerCommand(
    t,
    ["status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: h.buildEnv(binDir)
    }
  );

  h.assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  h.assert.equal(waitedPayload.job.id, launchPayload.jobId);
  h.assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await h.waitFor(() => {
    const result = h.runBrokerCommand(t, ["result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: h.buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  h.assert.equal(resultPayload.job.id, launchPayload.jobId);
  h.assert.equal(resultPayload.job.status, "completed");
  h.assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

h.test("status shows phases, hints, and the latest finished job", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = h.path.join(jobsDir, "review-live.log");
  h.fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = h.path.join(jobsDir, "review-done.json");
  h.fs.writeFileSync(
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

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "status"], {
    cwd: workspace
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Active jobs:/);
  h.assert.match(
    result.stdout,
    /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/
  );
  h.assert.match(
    result.stdout,
    /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/
  );
  h.assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  h.assert.match(result.stdout, /Live details:/);
  h.assert.match(result.stdout, /Latest finished:/);
  h.assert.match(result.stdout, /Progress:/);
  h.assert.match(result.stdout, /Session runtime: direct startup/);
  h.assert.match(result.stdout, /Phase: reviewing/);
  h.assert.match(result.stdout, /Codex session ID: thr_1/);
  h.assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  h.assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  h.assert.match(result.stdout, /Reviewer started: current changes/);
  h.assert.match(result.stdout, /Duration: 1m 5s/);
  h.assert.match(result.stdout, /Codex session ID: thr_done/);
  h.assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

h.test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = h.path.join(jobsDir, "review-current.log");
  const otherLog = h.path.join(jobsDir, "review-other.log");
  h.fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  h.fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.deepEqual([...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])], ["review-current"]);
});

h.test("status preserves adversarial review kind labels", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = h.path.join(jobsDir, "review-adv.log");
  h.fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "status"], {
    cwd: workspace
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  h.assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  h.assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  h.assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

h.test("status --wait times out cleanly when a job is still active", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = h.path.join(jobsDir, "task-live.log");
  h.fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  h.fs.writeFileSync(
    h.path.join(jobsDir, "task-live.json"),
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

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.job.id, "task-live");
  h.assert.equal(payload.job.status, "running");
  h.assert.equal(payload.waitTimedOut, true);
});

h.test("result returns the stored output for the latest finished job by default", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  h.fs.writeFileSync(
    h.path.join(jobsDir, "review-finished.json"),
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

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "result"], {
    cwd: workspace
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

h.test("stop-gate reviews are hidden from default result/status but visible with --all", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const env = { ...process.env, CODEX_COMPANION_SESSION_ID: "sess-current" };
  h.seedStateFixture(stateDir, {
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

  const status = h.run("node", [h.SCRIPT, "status", "--json"], { cwd: workspace, env });
  h.assert.equal(status.status, 0, status.stderr);
  const statusReport = JSON.parse(status.stdout);
  h.assert.equal(statusReport.latestFinished.id, "task-real");
  h.assert.equal(
    [statusReport.latestFinished.id, ...statusReport.recent.map((job) => job.id)].includes("task-stopgate"),
    false
  );

  const statusAll = h.run("node", [h.SCRIPT, "status", "--all", "--json"], { cwd: workspace, env });
  const statusAllReport = JSON.parse(statusAll.stdout);
  h.assert.equal(
    [statusAllReport.latestFinished?.id, ...statusAllReport.recent.map((job) => job.id)].includes("task-stopgate"),
    true
  );

  const result = h.run("node", [h.SCRIPT, "result"], { cwd: workspace, env });
  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Real task output\./);
  h.assert.doesNotMatch(result.stdout, /ALLOW: looks good/);
});

h.test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  h.fs.writeFileSync(
    h.path.join(jobsDir, "review-current.json"),
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

  h.fs.writeFileSync(
    h.path.join(jobsDir, "review-other.json"),
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

  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

h.test("result for a finished write-capable task returns the raw Codex final response", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = h.runBrokerCommand(t, ["task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });
  h.assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = h.run("node", [h.SCRIPT, "result"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  h.assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  h.assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

h.test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = h.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
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

  const logFile = h.path.join(jobsDir, "task-live.log");
  const jobFile = h.path.join(jobsDir, "task-live.json");
  h.fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  h.fs.writeFileSync(
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
  h.seedStateFixture(stateDir, {
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

  const cancelResult = h.run("node", [h.SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  h.assert.equal(cancelResult.status, 0, cancelResult.stderr);
  h.assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await h.waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = h.readStateFixture(stateDir);
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  h.assert.equal(cancelled.status, "cancelled");
  h.assert.equal(cancelled.pid, null);

  const stored = JSON.parse(h.fs.readFileSync(jobFile, "utf8"));
  h.assert.equal(stored.status, "cancelled");
  h.assert.match(h.fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

h.test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = h.path.join(jobsDir, "task-other.log");
  h.fs.writeFileSync(logFile, "", "utf8");
  h.seedStateFixture(stateDir, {
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
  const status = h.run("node", [h.SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  h.assert.equal(status.status, 0, status.stderr);
  h.assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = h.run("node", [h.SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  h.assert.equal(cancel.status, 1);
  h.assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = h.readStateFixture(stateDir);
  h.assert.equal(state.jobs[0].status, "running");
});

h.test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = h.makeTempDir();
  const stateDir = h.resolveStateDir(workspace);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = h.path.join(jobsDir, "task-other.log");
  h.fs.writeFileSync(logFile, "", "utf8");
  h.seedStateFixture(stateDir, {
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
  const cancel = h.run("node", [h.SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  h.assert.equal(cancel.status, 0, cancel.stderr);
  h.assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = h.readStateFixture(stateDir);
  h.assert.equal(state.jobs[0].status, "cancelled");
});
