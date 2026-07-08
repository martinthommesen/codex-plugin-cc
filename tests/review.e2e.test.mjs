import * as h from "./runtime-helpers.mjs";

h.test("review renders a no-findings result from app-server review/start", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.mkdirSync(h.path.join(repo, "src"));
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = 1;\n");
  h.run("git", ["add", "src/app.js"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0);
  h.assert.match(result.stdout, /Reviewed uncommitted changes/);
  h.assert.match(result.stdout, /No material issues found/);
});

h.test("review accepts the quoted raw argument style for built-in base-branch review", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.mkdirSync(h.path.join(repo, "src"));
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = 1;\n");
  h.run("git", ["add", "src/app.js"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = h.runBrokerCommand(t, ["review", "--base main"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0);
  h.assert.match(result.stdout, /Reviewed changes against main/);
  h.assert.match(result.stdout, /No material issues found/);
});

h.test("adversarial review renders structured findings over app-server turn/start", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.mkdirSync(h.path.join(repo, "src"));
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  h.run("git", ["add", "src/app.js"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = h.runBrokerCommand(t, ["adversarial-review"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0);
  h.assert.match(result.stdout, /Missing empty-state guard/);
});

h.test("adversarial review accepts the same base-branch targeting as review", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.mkdirSync(h.path.join(repo, "src"));
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  h.run("git", ["add", "src/app.js"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = h.runBrokerCommand(t, ["adversarial-review", "--base", "main"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Branch review against main|against main/i);
  h.assert.match(result.stdout, /Missing empty-state guard/);
});

h.test("adversarial review asks Codex to inspect larger diffs itself", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.mkdirSync(h.path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    h.fs.writeFileSync(h.path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  h.run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  h.fs.writeFileSync(h.path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  h.fs.writeFileSync(h.path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = h.runBrokerCommand(t, ["adversarial-review"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(h.fs.readFileSync(h.path.join(binDir, "fake-codex-state.json"), "utf8"));
  h.assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  h.assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  h.assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

h.test("review includes reasoning output when the app server returns it", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-reasoning");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const result = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  h.assert.match(result.stdout, /Reasoning:/);
  h.assert.match(
    result.stdout,
    /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i
  );
});

h.test("review logs reasoning summaries and review output to the job log", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir, "with-reasoning");
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const result = h.runBrokerCommand(t, ["review"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status, 0, result.stderr);
  const stateDir = h.resolveStateDir(repo);
  const state = h.readStateFixture(stateDir);
  const log = h.fs.readFileSync(state.jobs[0].logFile, "utf8");
  h.assert.match(log, /Reasoning summary/);
  h.assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  h.assert.match(log, /Review output/);
  h.assert.match(log, /Reviewed uncommitted changes\./);
});

h.test("review rejects focus text because it is native-review only", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const result = h.runBrokerCommand(t, ["review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status > 0, true);
  h.assert.match(result.stderr, /does not support custom focus text/i);
  h.assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

h.test("review rejects staged-only scope because it is native-review only", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");
  h.run("git", ["add", "README.md"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["review", "--scope", "staged"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status > 0, true);
  h.assert.match(result.stderr, /Unsupported review scope "staged"/i);
  h.assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

h.test("adversarial review rejects staged-only scope to match review target selection", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");
  h.run("git", ["add", "README.md"], { cwd: repo });

  const result = h.runBrokerCommand(t, ["adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(result.status > 0, true);
  h.assert.match(result.stderr, /Unsupported review scope "staged"/i);
  h.assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

h.test("review accepts --background while still running as a tracked review job", (t) => {
  const repo = h.makeTempDir();
  const binDir = h.makeTempDir();
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello\n");
  h.run("git", ["add", "README.md"], { cwd: repo });
  h.run("git", ["commit", "-m", "init"], { cwd: repo });
  h.fs.writeFileSync(h.path.join(repo, "README.md"), "hello again\n");

  const launched = h.runBrokerCommand(t, ["review", "--background", "--json"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  h.assert.equal(launchPayload.review, "Review");
  h.assert.match(launchPayload.codex.stdout, /No material issues found/);

  const status = h.runBrokerCommand(t, ["status"], {
    cwd: repo,
    env: h.buildEnv(binDir)
  });

  h.assert.equal(status.status, 0, status.stderr);
  h.assert.match(status.stdout, /# Codex Status/);
  h.assert.match(status.stdout, /Codex Review/);
  h.assert.match(status.stdout, /completed/);
});
