import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

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
        stdout: "ERROR: The process \"1234\" not found.",
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

test("terminateProcessTree signals the pid when it is not a process-group leader", () => {
  const calls = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("kill ESRCH");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(calls, [
    [-4321, "SIGTERM"],
    [4321, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree runs taskkill without a shell and trusts its not-found exit code", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = options;
      return { command, args, status: 128, signal: null, stdout: "FEHLER: Prozess wurde nicht gefunden.", stderr: "", error: null };
    }
  });

  assert.equal(captured.shell, false);
  assert.equal(outcome.delivered, false);
});
