import * as h from "./runtime-helpers.mjs";

h.test("transfer delegates the current Claude session directly to native import", () => {
  const home = h.makeTempDir();
  const repo = h.path.join(home, "repo");
  const binDir = h.makeTempDir();
  const sessionId = "sess-native-transfer";
  h.fs.mkdirSync(repo, { recursive: true });
  const projectDir = h.path.join(home, ".claude", "projects", "-repo");
  const sourcePath = h.path.join(projectDir, `${sessionId}.jsonl`);
  h.fs.mkdirSync(projectDir, { recursive: true });
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);

  h.fs.writeFileSync(
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
  const result = h.run("node", [h.SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      ...h.buildHomeEnv(home),
      CODEX_HOME: h.path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  h.assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = h.fs.realpathSync(sourcePath);
  h.assert.equal(payload.threadId, "thr_1");
  h.assert.equal(payload.resumeCommand, "codex resume thr_1");
  h.assert.equal(payload.sourcePath, canonicalSourcePath);
  h.assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(h.fs.readFileSync(h.path.join(binDir, "fake-codex-state.json"), "utf8"));
  h.assert.equal(fakeState.threads.length, 1);
  h.assert.equal(fakeState.threads[0].ephemeral, false);
  h.assert.equal(fakeState.threads[0].name, "Native transfer");
  h.assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  h.assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

h.test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = h.makeTempDir();
  const repo = h.path.join(home, "repo");
  const binDir = h.makeTempDir();
  const projectDir = h.path.join(home, ".claude", "projects", "-repo");
  const sourcePath = h.path.join(projectDir, "session.jsonl");
  h.fs.mkdirSync(repo, { recursive: true });
  h.fs.mkdirSync(projectDir, { recursive: true });
  h.installFakeCodex(binDir, "external-import-unsupported");
  h.initGitRepo(repo);
  h.fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = h.run("node", [h.SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      ...h.buildHomeEnv(home),
      CODEX_HOME: h.path.join(home, ".codex")
    }
  });

  h.assert.notEqual(result.status, 0);
  h.assert.match(result.stderr, /does not support Claude session transfer/);
  h.assert.match(result.stderr, /@openai\/codex@latest/);
});

h.test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = h.makeTempDir();
  const repo = h.path.join(home, "repo");
  const binDir = h.makeTempDir();
  const projectDir = h.path.join(home, ".claude", "projects", "-repo");
  const sourcePath = h.path.join(projectDir, "session.jsonl");
  h.fs.mkdirSync(repo, { recursive: true });
  h.fs.mkdirSync(projectDir, { recursive: true });
  h.installFakeCodex(binDir, "external-import-fails");
  h.initGitRepo(repo);
  h.fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = h.run("node", [h.SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...h.buildEnv(binDir),
      ...h.buildHomeEnv(home),
      CODEX_HOME: h.path.join(home, ".codex")
    }
  });

  h.assert.notEqual(result.status, 0);
  h.assert.match(result.stderr, /did not record an imported thread/);
});

h.test("transfer rejects sources outside the Claude projects directory", () => {
  const home = h.makeTempDir();
  const repo = h.path.join(home, "repo");
  const binDir = h.makeTempDir();
  const sourcePath = h.path.join(home, "session.jsonl");
  h.fs.mkdirSync(repo, { recursive: true });
  h.fs.mkdirSync(h.path.join(home, ".claude", "projects"), { recursive: true });
  h.installFakeCodex(binDir);
  h.initGitRepo(repo);
  h.fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = h.run("node", [h.SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...h.buildEnv(binDir), ...h.buildHomeEnv(home) }
  });

  h.assert.notEqual(result.status, 0);
  h.assert.match(result.stderr, /only from .*\.claude.*projects/);
});
