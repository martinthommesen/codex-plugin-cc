import * as h from "./runtime-helpers.mjs";

h.test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, true);
  h.assert.match(payload.codex.detail, /advanced runtime available/);
  h.assert.equal(payload.sessionRuntime.mode, "direct");
});

h.test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.installNodeShim(binDir);

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, true);
  h.assert.equal(payload.npm.available, false);
  h.assert.equal(payload.codex.available, true);
  h.assert.equal(payload.auth.loggedIn, true);
});

h.test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "api-key-account-only");

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, true);
  h.assert.equal(payload.auth.loggedIn, true);
  h.assert.equal(payload.auth.authMethod, "apiKey");
  h.assert.equal(payload.auth.source, "app-server");
  h.assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

h.test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "provider-no-auth");

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, true);
  h.assert.equal(payload.auth.loggedIn, true);
  h.assert.equal(payload.auth.authMethod, null);
  h.assert.equal(payload.auth.source, "app-server");
  h.assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

h.test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "env-key-provider");

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, true);
  h.assert.equal(payload.auth.loggedIn, true);
  h.assert.equal(payload.auth.authMethod, null);
  h.assert.equal(payload.auth.source, "app-server");
  h.assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

h.test("setup reports not ready when app-server config read fails", () => {
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "config-read-fails");

  const result = h.run("node", [h.SCRIPT, "setup", "--json"], {
    cwd: h.ROOT,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  h.assert.equal(payload.ready, false);
  h.assert.equal(payload.auth.loggedIn, false);
  h.assert.equal(payload.auth.source, "app-server");
  h.assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

h.test("setup reuses an existing shared app-server without starting another one", (t) => {
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

  const setup = h.runBrokerCommand(t, ["setup", "--json"], {
    cwd: repo,
    env
  });
  h.assert.equal(setup.status, 0, setup.stderr);

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

h.test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = h.makeTempDir();
  const invocationWorkspace = h.makeTempDir();

  h.saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = h.run("node", [h.SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  h.assert.equal(status.status, 0, status.stderr);
  h.assert.match(status.stdout, /Session runtime: shared session/);

  const setup = h.run("node", [h.SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  h.assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  h.assert.equal(payload.sessionRuntime.mode, "shared");
  h.assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});
