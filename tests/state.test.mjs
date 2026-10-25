import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  readSessionPointer,
  removeSessionPointer,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeSessionPointer
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

function withEnv(overrides, body) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveStateDir follows the session pointer when CLAUDE_PLUGIN_DATA is missing", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const sessionId = `sess-state-${process.pid}-${Date.now()}`;
  const pointerFile = writeSessionPointer(sessionId, pluginDataDir);

  try {
    assert.equal(fs.statSync(pointerFile).mode & 0o777, 0o600);
    const stateDir = withEnv({ CLAUDE_PLUGIN_DATA: null, CODEX_COMPANION_SESSION_ID: sessionId }, () =>
      resolveStateDir(workspace)
    );
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);

    const withoutSession = withEnv({ CLAUDE_PLUGIN_DATA: null, CODEX_COMPANION_SESSION_ID: null }, () =>
      resolveStateDir(workspace)
    );
    assert.equal(withoutSession.startsWith(os.tmpdir()), true);
  } finally {
    removeSessionPointer(sessionId);
  }
  assert.equal(fs.existsSync(pointerFile), false);
});

test("readSessionPointer ignores pointers others could have written", () => {
  const sessionId = `sess-shared-${process.pid}-${Date.now()}`;
  const pointerFile = writeSessionPointer(sessionId, makeTempDir());

  try {
    fs.chmodSync(pointerFile, 0o622);
    assert.equal(readSessionPointer(sessionId), null);
    fs.chmodSync(pointerFile, 0o600);
    fs.writeFileSync(pointerFile, JSON.stringify({ pluginDataDir: "relative/dir" }));
    assert.equal(readSessionPointer(sessionId), null);
  } finally {
    removeSessionPointer(sessionId);
  }
  assert.equal(writeSessionPointer(sessionId, "relative/dir"), null);
  assert.equal(readSessionPointer(""), null);
});

test("loadState reports an active job whose process is gone as failed", async () => {
  const { currentPidNamespace, loadState } = await import("../plugins/codex/scripts/lib/state.mjs");
  // Real job records carry the writer's PID namespace (null outside Linux).
  const pidNamespace = currentPidNamespace();
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // Spawn and reap a process to get a pid that no longer exists.
  const { spawnSync } = await import("node:child_process");
  const deadPid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [
        { id: "task-dead", status: "running", pid: Number(deadPid), pidNamespace, updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "task-live", status: "running", pid: process.pid, pidNamespace, updatedAt: "2026-01-01T00:00:00.000Z" },
        // Recorded in another PID namespace: its pid can't be checked from here.
        { id: "task-elsewhere", status: "running", pid: Number(deadPid), pidNamespace: "pid:[0]", updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    })
  );

  const { jobs, config } = loadState(workspace);
  assert.equal(config.stopReviewGate, true);
  assert.equal(jobs.find((job) => job.id === "task-dead").status, "failed");
  assert.match(jobs.find((job) => job.id === "task-dead").errorMessage, /exited before the job finished/);
  assert.equal(jobs.find((job) => job.id === "task-live").status, "running");
  assert.equal(jobs.find((job) => job.id === "task-elsewhere").status, "running");
});
