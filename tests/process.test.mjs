import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  getProcessStartTime,
  resolveExecutable,
  spawnConfigFor,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("spawnConfigFor runs shell-free off Windows", () => {
  assert.deepEqual(spawnConfigFor("git", { platform: "linux" }), { command: "git", shell: false });
  assert.deepEqual(spawnConfigFor("codex", { platform: "darwin" }), { command: "codex", shell: false });
});

test("resolveExecutable prefers a real .exe over a .cmd on the Windows PATH", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "git.cmd"), "");
  fs.writeFileSync(path.join(dir, "git.exe"), "");
  const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
  assert.equal(resolveExecutable("git", { platform: "win32", env }), path.join(dir, "git.exe"));
});

test("resolveExecutable ignores matching directories on the Windows PATH", () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, "git.exe"));
  fs.writeFileSync(path.join(dir, "git.cmd"), "");
  const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
  assert.equal(resolveExecutable("git", { platform: "win32", env }), path.join(dir, "git.cmd"));
});

test("spawnConfigFor: a real Windows exe runs shell-free, a .cmd shim runs through a shell", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "git.exe"), "");
  fs.writeFileSync(path.join(dir, "codex"), "");
  fs.writeFileSync(path.join(dir, "codex.cmd"), "");
  const env = { PATH: dir, PATHEXT: ".exe;.cmd" };

  // git.exe -> shell-free with the resolved absolute path (no shell metacharacter interpretation).
  assert.deepEqual(spawnConfigFor("git", { platform: "win32", env }), {
    command: path.join(dir, "git.exe"),
    shell: false
  });
  // codex.cmd (npm shim) -> keeps the bare name + a shell; only static args are ever passed.
  assert.deepEqual(spawnConfigFor("codex", { platform: "win32", env }), { command: "codex", shell: true });
});

test("resolveExecutable leaves an explicit path untouched", () => {
  const explicit = "C:\\tools\\git.exe";
  assert.equal(resolveExecutable(explicit, { platform: "win32", env: { PATH: "", PATHEXT: ".EXE" } }), explicit);
});

test("getProcessStartTime returns a value from a platform process lookup", () => {
  const startTime = getProcessStartTime(4242, {
    platform: "darwin",
    runCommandImpl: () => ({ stdout: "Mon Jan  1 00:00:00 2024\n" })
  });
  assert.equal(startTime, "posix:Mon Jan  1 00:00:00 2024");
});

test("terminateProcessTree group-kills when the process identity matches", () => {
  const signals = [];
  const outcome = terminateProcessTree(4242, {
    platform: "linux",
    expectedStartTime: "linux:111",
    getStartTime: () => "linux:111",
    killImpl: (pid) => signals.push(pid)
  });
  assert.deepEqual(signals, [-4242]); // whole process group
  assert.equal(outcome.method, "process-group");
});

test("terminateProcessTree skips the kill when the identity does not match (recycled pid)", () => {
  let killed = false;
  const outcome = terminateProcessTree(4242, {
    platform: "linux",
    expectedStartTime: "linux:111",
    getStartTime: () => "linux:999",
    killImpl: () => {
      killed = true;
    }
  });
  assert.equal(killed, false);
  assert.equal(outcome.identity, "mismatch");
  assert.equal(outcome.delivered, false);
});

test("terminateProcessTree treats a vanished process as nothing to kill", () => {
  let killed = false;
  const outcome = terminateProcessTree(4242, {
    platform: "linux",
    expectedStartTime: "linux:111",
    getStartTime: () => null,
    killImpl: () => {
      killed = true;
    }
  });
  assert.equal(killed, false);
  assert.equal(outcome.identity, "gone");
});

test("terminateProcessTree without a stored identity restricts to the single pid", () => {
  const signals = [];
  terminateProcessTree(4242, {
    platform: "linux",
    requireIdentity: true,
    killImpl: (pid) => signals.push(pid)
  });
  assert.deepEqual(signals, [4242]); // single pid, never the group
});
