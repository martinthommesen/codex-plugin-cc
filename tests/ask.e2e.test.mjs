import * as h from "./runtime-helpers.mjs";

h.test("ask creates a named read-only advisor thread", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);

  const result = h.runBrokerCommand(t, ["ask", "is this plan sound?"], {
    cwd: repo,
    env: h.askEnv(binDir, "sess-current")
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Handled the requested task\./);
  h.assert.match(result.stdout, /Codex advisor thread: thr_1 \(new\)/);
  const state = h.readFakeState(binDir);
  const thread = state.threads.find((candidate) => candidate.id === "thr_1");
  h.assert.ok(thread.name.startsWith("Codex Companion Advisor"));
  h.assert.equal(thread.ephemeral, false);
  h.assert.equal(thread.sandbox, "read-only");
});

h.test("ask auto-resumes the session advisor thread read-only with only the follow-up text", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const first = h.runBrokerCommand(t, ["ask", "first question"], { cwd: repo, env });
  h.assert.equal(first.status, 0, first.stderr);

  const second = h.runBrokerCommand(t, ["ask", "what about edge cases?"], { cwd: repo, env });
  h.assert.equal(second.status, 0, second.stderr);
  h.assert.match(second.stdout, /Codex advisor thread: thr_1 \(continued\)/);

  const state = h.readFakeState(binDir);
  h.assert.equal(state.lastTurnStart.threadId, "thr_1");
  h.assert.equal(state.lastTurnStart.prompt, "what about edge cases?");
  const lastResume = state.resumeRequests.at(-1);
  h.assert.equal(lastResume.threadId, "thr_1");
  h.assert.equal(lastResume.sandbox, "read-only");
});

h.test("ask --fresh starts a new advisor thread", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const first = h.runBrokerCommand(t, ["ask", "first question"], { cwd: repo, env });
  h.assert.equal(first.status, 0, first.stderr);

  const second = h.runBrokerCommand(t, ["ask", "--fresh", "unrelated topic"], { cwd: repo, env });
  h.assert.equal(second.status, 0, second.stderr);
  h.assert.match(second.stdout, /Codex advisor thread: thr_2 \(new\)/);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.threadId, "thr_2");
});

h.test("ask does not resume another session's advisor thread", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);

  const first = h.runBrokerCommand(t, ["ask", "other session question"], {
    cwd: repo,
    env: h.askEnv(binDir, "sess-other")
  });
  h.assert.equal(first.status, 0, first.stderr);

  const second = h.runBrokerCommand(t, ["ask", "current session question"], {
    cwd: repo,
    env: h.askEnv(binDir, "sess-current")
  });
  h.assert.equal(second.status, 0, second.stderr);
  h.assert.match(second.stdout, /Codex advisor thread: thr_2 \(new\)/);
});

h.test("ask rejects task-style execution flags instead of leaking them into the prompt", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  for (const flag of ["--background", "--wait", "--write", "--resume", "--resume-last"]) {
    const result = h.runBrokerCommand(t, ["ask", flag, "question"], { cwd: repo, env });
    h.assert.equal(result.status, 1, `${flag} should be rejected`);
    h.assert.match(result.stderr, new RegExp(`does not accept ${flag}`));
  }
  h.assert.equal(h.fs.existsSync(h.path.join(binDir, "fake-codex-state.json")), false);

  const spark = h.runBrokerCommand(t, ["ask", "-m", "spark", "quick question"], { cwd: repo, env });
  h.assert.equal(spark.status, 0, spark.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, "gpt-5.3-codex-spark");
});

h.test("ask supports --json, --prompt-file, and --cwd", (t) => {
  const repo = h.makeTempDir();
  const otherCwd = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const json = h.runBrokerCommand(t, ["ask", "--json", "structured question"], { cwd: repo, env });
  h.assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  h.assert.equal(payload.status, 0);
  h.assert.equal(payload.threadId, "thr_1");
  h.assert.equal(payload.resumed, false);
  h.assert.match(payload.rawOutput, /Handled the requested task\./);
  h.assert.equal(payload.failureMessage, "");

  const promptFile = h.path.join(repo, "question.txt");
  h.fs.writeFileSync(promptFile, "file question\n", "utf8");
  const fromFile = h.runBrokerCommand(t, ["ask", "--prompt-file", "question.txt"], { cwd: repo, env });
  h.assert.equal(fromFile.status, 0, fromFile.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.prompt, "file question");

  h.fs.writeFileSync(promptFile, " \n\t", "utf8");
  const blankFile = h.runBrokerCommand(t, ["ask", "--prompt-file", "question.txt"], { cwd: repo, env });
  h.assert.equal(blankFile.status, 1);
  h.assert.match(blankFile.stderr, /Provide a question/);

  const viaCwd = h.runBrokerCommand(t, ["ask", "--cwd", repo, "cwd question"], { cwd: otherCwd, env });
  h.assert.equal(viaCwd.status, 0, viaCwd.stderr);
  const stateDir = h.resolveStateDir(repo);
  const jobs = h.readStateFixture(stateDir).jobs;
  h.assert.equal(jobs[0].kind, "ask");
});

h.test("ask preflight failure leaves a failed tracked job that result renders generically", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installNodeShim(binDir);
  const env = {
    ...process.env,
    PATH: binDir,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const result = h.runBrokerCommand(t, ["ask", "will this fail?"], { cwd: repo, env });
  h.assert.equal(result.status, 1);
  h.assert.match(result.stderr, /Codex CLI is not installed/);

  const stateDir = h.resolveStateDir(repo);
  const state = h.readStateFixture(stateDir);
  const askJob = state.jobs.find((job) => job.jobClass === "ask");
  h.assert.equal(askJob.status, "failed");

  const stored = h.run("node", [h.SCRIPT, "result", askJob.id], { cwd: repo, env });
  h.assert.equal(stored.status, 0, stored.stderr);
  h.assert.match(stored.stdout, /Codex CLI is not installed/);
  h.assert.doesNotMatch(stored.stdout, /Codex advisor thread:/);
});

h.test("ask stays out of task resume and default result selection", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const task = h.runBrokerCommand(t, ["task", "implement the thing"], { cwd: repo, env });
  h.assert.equal(task.status, 0, task.stderr);

  const ask = h.runBrokerCommand(t, ["ask", "what do you think?"], { cwd: repo, env });
  h.assert.equal(ask.status, 0, ask.stderr);

  const candidate = h.run("node", [h.SCRIPT, "task-resume-candidate", "--json"], { cwd: repo, env });
  h.assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  h.assert.equal(candidatePayload.available, true);
  h.assert.equal(candidatePayload.candidate.threadId, "thr_1");

  const result = h.run("node", [h.SCRIPT, "result"], { cwd: repo, env });
  h.assert.equal(result.status, 0, result.stderr);
  h.assert.doesNotMatch(result.stdout, /Codex advisor thread:/);

  const stateDir = h.resolveStateDir(repo);
  const jobs = h.readStateFixture(stateDir).jobs;
  const askJob = jobs.find((job) => job.jobClass === "ask");
  const askResult = h.run("node", [h.SCRIPT, "result", askJob.id], { cwd: repo, env });
  h.assert.equal(askResult.status, 0, askResult.stderr);
  h.assert.match(askResult.stdout, /Codex advisor thread: thr_2/);
});

h.test("result without a job id explains when only advisor asks have finished", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const ask = h.runBrokerCommand(t, ["ask", "only an ask here"], { cwd: repo, env });
  h.assert.equal(ask.status, 0, ask.stderr);

  const result = h.run("node", [h.SCRIPT, "result"], { cwd: repo, env });
  h.assert.equal(result.status, 1);
  h.assert.match(result.stderr, /Latest finished jobs are advisor asks/);
});

h.test("status labels completed and running ask jobs as ask", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const ask = h.runBrokerCommand(t, ["ask", "status labelling question"], { cwd: repo, env });
  h.assert.equal(ask.status, 0, ask.stderr);

  const finished = h.run("node", [h.SCRIPT, "status", "--json"], { cwd: repo, env });
  h.assert.equal(finished.status, 0, finished.stderr);
  const finishedReport = JSON.parse(finished.stdout);
  h.assert.equal(finishedReport.latestFinished.kindLabel, "ask");

  const stateDir = h.resolveStateDir(repo);
  h.writeJobFixture(stateDir, {
    id: "ask-live",
    status: "running",
    title: "Codex Advisor",
    jobClass: "ask",
    sessionId: "sess-current",
    summary: "Live advisor question",
    updatedAt: "2099-01-01T00:00:00.000Z"
  });

  const running = h.run("node", [h.SCRIPT, "status", "--json"], { cwd: repo, env });
  h.assert.equal(running.status, 0, running.stderr);
  const runningReport = JSON.parse(running.stdout);
  h.assert.equal(runningReport.running[0].id, "ask-live");
  h.assert.equal(runningReport.running[0].kindLabel, "ask");
});

h.test("ask without a session id falls back to the advisor thread from thread/list", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, null);

  const first = h.runBrokerCommand(t, ["ask", "seed the advisor thread"], { cwd: repo, env });
  h.assert.equal(first.status, 0, first.stderr);

  h.fs.rmSync(h.resolveStateDir(repo), { recursive: true, force: true });

  const second = h.runBrokerCommand(t, ["ask", "resume without local jobs"], { cwd: repo, env });
  h.assert.equal(second.status, 0, second.stderr);
  h.assert.match(second.stdout, /Codex advisor thread: thr_1 \(continued, matched by thread name\)/);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.threadId, "thr_1");
});

h.test("stop hook labels a running ask job as ask", () => {
  const repo = h.makeTempDir();
  const stateDir = h.resolveStateDir(repo);
  const jobsDir = h.path.join(stateDir, "jobs");
  h.fs.mkdirSync(jobsDir, { recursive: true });
  const runningLog = h.path.join(jobsDir, "ask-live.log");
  h.fs.writeFileSync(runningLog, "running\n", "utf8");
  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stderr, /Codex ask ask-live is still running/i);
  h.assert.match(result.stderr, /\/codex:cancel ask-live/i);
});

h.test("ask self-heals around interrupted ask jobs", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");
  const stateDir = h.resolveStateDir(repo);

  // An ask killed before its thread was created leaves a running record without a
  // threadId — nothing to resume, so the next ask starts fresh.
  h.seedStateFixture(stateDir, {
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

  const fresh = h.runBrokerCommand(t, ["ask", "no resumable thread yet"], { cwd: repo, env });
  h.assert.equal(fresh.status, 0, fresh.stderr);
  h.assert.match(fresh.stdout, /Codex advisor thread: thr_1 \(new\)/);

  // An ask killed AFTER thread creation leaves a running record with a threadId.
  // The next ask must resume that thread so the conversation context survives.
  const state = h.readStateFixture(stateDir);
  for (const job of state.jobs) {
    if (job.threadId === "thr_1") {
      job.status = "running";
      job.updatedAt = "2099-01-02T00:00:00.000Z";
      h.writeJobFixture(stateDir, job);
    }
  }

  const resumed = h.runBrokerCommand(t, ["ask", "continue after the interruption"], { cwd: repo, env });
  h.assert.equal(resumed.status, 0, resumed.stderr);
  h.assert.match(resumed.stdout, /Codex advisor thread: thr_1 \(continued\)/);
});

h.test("ask falls back to gpt-5.5 on fresh threads and keeps null on auto-resume", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const first = h.runBrokerCommand(t, ["ask", "first question"], { cwd: repo, env });
  h.assert.equal(first.status, 0, first.stderr);
  const afterFirst = h.readFakeState(binDir);
  h.assert.equal(afterFirst.lastTurnStart.model, "gpt-5.5");
  const configReadsAfterFirst = afterFirst.configReadCount;

  const second = h.runBrokerCommand(t, ["ask", "follow up"], { cwd: repo, env });
  h.assert.equal(second.status, 0, second.stderr);
  const afterSecond = h.readFakeState(binDir);
  h.assert.equal(afterSecond.lastTurnStart.model, null);
  h.assert.equal(afterSecond.configReadCount, configReadsAfterFirst);
});

h.test("a failed ask turn renders loudly, keeps its thread, and stays resumable", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const failed = h.runBrokerCommand(t, ["ask", "FAIL_THIS_TURN please"], { cwd: repo, env });
  h.assert.equal(failed.status, 1);
  h.assert.match(failed.stdout, /Codex advisor turn failed\./);
  h.assert.match(failed.stdout, /Codex advisor thread: thr_1 \(new\)/);

  const stateDir = h.resolveStateDir(repo);
  const jobs = h.readStateFixture(stateDir).jobs;
  const askJob = jobs.find((job) => job.jobClass === "ask");
  h.assert.equal(askJob.status, "failed");
  h.assert.equal(askJob.threadId, "thr_1");

  // The failed ask's thread is resumed on the next healthy turn.
  const recovered = h.runBrokerCommand(t, ["ask", "try again"], { cwd: repo, env });
  h.assert.equal(recovered.status, 0, recovered.stderr);
  h.assert.match(recovered.stdout, /Codex advisor thread: thr_1 \(continued\)/);
});

h.test("result without a job id reports a first-ever running ask as still running", () => {
  const repo = h.makeTempDir();
  const stateDir = h.resolveStateDir(repo);
  h.fs.mkdirSync(h.path.join(stateDir, "jobs"), { recursive: true });
  h.seedStateFixture(stateDir, {
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

  const result = h.run("node", [h.SCRIPT, "result"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  h.assert.equal(result.status, 1);
  h.assert.match(result.stderr, /Job ask-live is still running/);
});
