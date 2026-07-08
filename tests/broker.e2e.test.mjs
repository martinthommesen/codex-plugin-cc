import * as h from "./runtime-helpers.mjs";

h.test("task using the shared broker still completes when Codex spawns subagents", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-subagent");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const env = h.buildEnv(binDir);
  const review = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });
  h.assert.equal(review.status, 0, review.stderr);

  h.assert.ok(h.loadBrokerSession(repo), "broker should have started");

  const result = h.runBrokerCommand(t, ["task", "challenge the current design"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

h.test("brokered app-server errors expose the child stderr tail on the broker client", async () => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "turn-errors-with-stderr");
  h.initGitRepo(repo);

  const env = h.buildEnv(binDir);
  let appClient = null;
  try {
    appClient = await h.CodexAppServerClient.connect(repo, { env, disableBroker: true });
    const socket = new h.BrokerTestSocket();
    h.createBrokerSocketHandler(appClient).attach(socket);

    const threadResponse = await h.brokerRequest(socket, {
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

    const turnResponse = await h.brokerRequest(socket, {
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

    h.assert.equal(turnResponse.error.message, "turn/start failed with stderr");
    h.assert.ok(appClient.stderr.length <= 64 * 1024);
    h.assert.match(turnResponse.error.data.stderr, /broker stderr tail marker/);
    h.assert.doesNotMatch(turnResponse.error.data.stderr, /broker stderr head marker/);

    const brokerClient = new h.BrokerCodexAppServerClient(repo, { brokerEndpoint: "unix:/unused.sock" });
    const rejection = new Promise((resolve, reject) => {
      brokerClient.pending.set(2, { resolve, reject, method: "turn/start" });
      brokerClient.handleLine(JSON.stringify(turnResponse));
    });
    await h.assert.rejects(rejection, (error) => {
      h.assert.match(error.message, /turn\/start failed with stderr/);
      h.assert.match(error.data?.data?.stderr ?? "", /broker stderr tail marker/);
      return true;
    });
    h.assert.equal(brokerClient.stderr, turnResponse.error.data.stderr);
  } finally {
    await appClient?.close().catch(() => {});
  }
});

h.test("broker interrupts an active turn when the owning client disconnects", async () => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const fakeStatePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir, "interruptible-delayed-turn-start");
  h.initGitRepo(repo);

  const env = h.buildEnv(binDir);
  let appClient = null;
  try {
    appClient = await h.CodexAppServerClient.connect(repo, { env, disableBroker: true });
    const socket = new h.BrokerTestSocket();
    h.createBrokerSocketHandler(appClient).attach(socket);

    const threadResponse = await h.brokerRequest(socket, {
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
    const startedTurn = await h.waitFor(() => {
      const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
      return fakeState.lastTurnStart ?? null;
    });

    socket.end();

    const interrupt = await h.waitFor(() => {
      const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
      return fakeState.lastInterrupt ?? null;
    });

    h.assert.deepEqual(interrupt, { threadId, turnId: startedTurn.turnId });
  } finally {
    await appClient?.close().catch(() => {});
  }
});

h.test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const fakeStatePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir, "interruptible-slow-task");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = h.buildEnv(binDir);
  const launched = h.runBrokerCommand(t, ["task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  h.assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  h.assert.ok(jobId);

  const stateDir = h.resolveStateDir(repo);
  const runningJob = await h.waitFor(
    () => {
      const state = h.readStateFixture(stateDir);
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status === "running" && job.threadId && job.turnId) {
        return job;
      }
      return null;
    },
    { timeoutMs: 15000 }
  );

  const cancelResult = h.runBrokerCommand(t, ["cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  h.assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  h.assert.equal(cancelPayload.status, "cancelled");
  h.assert.equal(cancelPayload.turnInterruptAttempted, true);
  h.assert.equal(cancelPayload.turnInterrupted, true);

  await h.waitFor(() => {
    const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
  h.assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = h.run("node", [h.SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  h.assert.equal(cleanup.status, 0, cleanup.stderr);
});

h.test("broker process log file is created private", { skip: process.platform === "win32" }, async () => {
  const repo = h.makeTempDir();
  const scriptPath = h.path.join(repo, "broker-exit.mjs");
  const logFile = h.path.join(repo, "broker.log");
  h.fs.writeFileSync(scriptPath, "process.exit(0);\n", "utf8");

  const child = h.spawnBrokerProcess({
    scriptPath,
    cwd: repo,
    endpoint: "unused",
    pidFile: h.path.join(repo, "broker.pid"),
    logFile
  });

  await h.waitFor(() => child.exitCode !== null || child.signalCode !== null);

  const mode = h.fs.statSync(logFile).mode & 0o777;
  h.assert.equal(mode, 0o600, `broker log should be 0600, got ${mode.toString(8)}`);
});

h.test("commands lazily start and reuse one shared app-server after first use", async (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const fakeStatePath = h.path.join(binDir, "fake-codex-state.json");

  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const env = h.buildEnv(binDir);

  const review = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });
  h.assert.equal(review.status, 0, review.stderr);

  h.assert.ok(h.loadBrokerSession(repo), "broker should have started");

  const adversarial = h.runBrokerCommand(t, ["adversarial-review"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });
  h.assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
  h.assert.equal(fakeState.appServerStarts, 1);

  const cleanup = h.run("node", [h.SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  h.assert.equal(cleanup.status, 0, cleanup.stderr);
});

h.test("review respawns when broker.json points at a dead endpoint", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const dead = h.createBrokerEndpoint(h.makeTempDir());
  h.saveBrokerSession(repo, { endpoint: dead, pid: 999999 });

  const result = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env: h.buildEnv(binDir),
    brokerReadyTimeout: true
  });

  h.assert.equal(result.status, 0, result.stderr);
  const session = h.loadBrokerSession(repo);
  h.assert.ok(session, "broker should have started");
  h.assert.notEqual(session.endpoint, dead);
});

h.test("task respawns the shared broker after the backend app-server dies", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const fakeStatePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir, "exit-on-first-turn");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = h.buildEnv(binDir);
  const failed = h.runBrokerCommand(t, ["task", "first attempt"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });

  h.assert.notEqual(failed.status, 0);
  h.assert.match(failed.stderr, /app-server exited unexpectedly|connection closed|closed/i);

  const recovered = h.runBrokerCommand(t, ["task", "second attempt"], {
    cwd: repo,
    env,
    brokerReadyTimeout: true
  });

  h.assert.equal(recovered.status, 0, recovered.stderr);
  h.assert.match(recovered.stdout, /Handled the requested task/);
  const fakeState = JSON.parse(h.fs.readFileSync(fakeStatePath, "utf8"));
  h.assert.equal(fakeState.appServerStarts, 2);
});

h.test("status reports shared session runtime when a lazy broker is active", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const review = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env: h.buildEnv(binDir),
    brokerReadyTimeout: true
  });
  h.assert.equal(review.status, 0, review.stderr);

  h.assert.ok(h.loadBrokerSession(repo), "broker should have started");

  const result = h.runBrokerCommand(t, ["status"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Session runtime: shared session/);
});
