import * as h from "./runtime-helpers.mjs";

h.test("task runs when the active provider does not require OpenAI login", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "provider-no-auth");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "check auth preflight"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Handled the requested task/);
});

h.test("task forwards model selection and reasoning effort to app-server turn/start", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  const statePath = h.path.join(binDir, "fake-codex-state.json");
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(h.fs.readFileSync(statePath, "utf8"));
  h.assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  h.assert.equal(fakeState.lastTurnStart.effort, "low");
});

h.test("task without --model falls back to gpt-5.5 when config sets no model", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);

  const result = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, "gpt-5.5");

  const status = h.run("node", [h.SCRIPT, "status", "--json"], { cwd: repo, env: h.buildEnv(binDir) });
  h.assert.equal(status.status, 0, status.stderr);
  h.assert.equal(JSON.parse(status.stdout).latestFinished.kindLabel, "task");
});

h.test("task without --model defers to a config-set model", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-with-model");

  const result = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, null);
});

h.test("explicit --model skips the config lookup entirely", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);

  const result = h.runBrokerCommand(t, ["task", "--model", "spark", "do the thing"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const state = h.readFakeState(binDir);
  h.assert.equal(state.lastTurnStart.model, "gpt-5.3-codex-spark");
  h.assert.equal(state.configReadCount ?? 0, 0);
});

h.test("task survives a config/read failure and keeps the null model", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-read-fails");

  const result = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, null);
});

h.test("review without a model falls back to gpt-5.5 when config sets none", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const result = h.runBrokerCommand(t, ["review"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastThreadStart.model, "gpt-5.5");
});

h.test("review_model in config suppresses the review fallback but not the task fallback", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-with-review-model");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const review = h.runBrokerCommand(t, ["review"], { cwd: repo, env: h.buildEnv(binDir) });
  h.assert.equal(review.status, 0, review.stderr);
  h.assert.equal(h.readFakeState(binDir).lastThreadStart.model, null);

  const task = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });
  h.assert.equal(task.status, 0, task.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, "gpt-5.5");
});

h.test("task --resume-last keeps the null model on the resumed thread", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  const env = h.askEnv(binDir, "sess-current");

  const first = h.runBrokerCommand(t, ["task", "initial task"], { cwd: repo, env });
  h.assert.equal(first.status, 0, first.stderr);

  const resumed = h.runBrokerCommand(t, ["task", "--resume-last", "follow up"], { cwd: repo, env });
  h.assert.equal(resumed.status, 0, resumed.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, null);

  const explicitResume = h.runBrokerCommand(t, ["task", "--resume-last", "--model", "spark", "one more"], {
    cwd: repo,
    env
  });
  h.assert.equal(explicitResume.status, 0, explicitResume.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, "gpt-5.3-codex-spark");
});

h.test("alternate model providers never receive the gpt-5.5 fallback", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "provider-no-auth");

  const result = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, null);
});

h.test("adversarial review honors a config-set review_model", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-with-review-model");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const result = h.runBrokerCommand(t, ["adversarial-review"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastThreadStart.model, null);
});

h.test("a whitespace-only config model still triggers the gpt-5.5 fallback", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-with-blank-model");

  const result = h.runBrokerCommand(t, ["task", "do the thing"], { cwd: repo, env: h.buildEnv(binDir) });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.equal(h.readFakeState(binDir).lastTurnStart.model, "gpt-5.5");
});
