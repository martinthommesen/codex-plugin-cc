import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("pinned Codex imports and deduplicates a synthetic Claude session without inference", (t) => {
  const home = makeTempDir("codex-native-test-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, ".claude", "projects", "smoke");
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome);
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(sourcePath, JSON.stringify({
    type: "user",
    uuid: "fdb006d8-1a35-494a-8263-a7d28ff64e73",
    sessionId: "a79da78c-7d7c-40b6-a819-8a829f13bcbb",
    timestamp: "2026-10-25T10:00:00.000Z",
    cwd: home,
    message: { role: "user", content: "Synthetic compatibility check; do not perform any work." }
  }) + "\n");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    PATH: path.join(ROOT, "node_modules", ".bin") + path.delimiter + process.env.PATH
  };
  let firstThreadId;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run(process.execPath, [
      path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs"),
      "transfer", "--source", sourcePath, "--json"
    ], { cwd: home, env, timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.threadId, /^[0-9a-f-]{36}$/);
    assert.equal(payload.resumeCommand, `codex resume ${payload.threadId}`);
    firstThreadId ??= payload.threadId;
    assert.equal(payload.threadId, firstThreadId);
  }
});
