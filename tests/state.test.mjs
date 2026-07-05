import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  assertJobId,
  ensureStateDir,
  getConfig,
  listJobs,
  readJobFile,
  resolveConfigFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  setConfig,
  sweepJobs,
  updateJobFile,
  writeCancelMarker,
  writeFileAtomic,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const isPosix = process.platform !== "win32";

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
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("state directory and job files are created private (POSIX 0700/0600)", { skip: !isPosix }, () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const dirMode = fs.statSync(resolveStateDir(workspace)).mode & 0o777;
  assert.equal(dirMode & 0o077, 0, `state dir must not be group/other accessible, got ${dirMode.toString(8)}`);

  writeJobFile(workspace, "task-abc-1", { status: "queued" });
  const fileMode = fs.statSync(resolveJobFile(workspace, "task-abc-1")).mode & 0o777;
  assert.equal(fileMode & 0o077, 0, `job file must not be group/other accessible, got ${fileMode.toString(8)}`);
});

test("writeFileAtomic never leaves a torn file and overwrites atomically", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "atomic.json");
  writeFileAtomic(target, "first\n");
  writeFileAtomic(target, "second\n");
  assert.equal(fs.readFileSync(target, "utf8"), "second\n");
  // No leftover temp files.
  assert.deepEqual(fs.readdirSync(dir), ["atomic.json"]);
});

test("assertJobId rejects path traversal and separators", () => {
  assert.equal(assertJobId("task-abc-123"), "task-abc-123");
  for (const bad of ["../evil", "a/b", "a\\b", "..", ".", "", "with\0null"]) {
    assert.throws(() => assertJobId(bad), /Invalid job id/, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  const workspace = makeTempDir();
  assert.throws(() => resolveJobFile(workspace, "../escape"), /Invalid job id/);
});

test("listJobs scans per-job files newest-first and skips unparseable ones", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "job-old", { status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" });
  writeJobFile(workspace, "job-new", { status: "completed", updatedAt: "2026-02-01T00:00:00.000Z" });
  fs.writeFileSync(path.join(resolveStateDir(workspace), "jobs", "job-broken.json"), "{not json", "utf8");

  const jobs = listJobs(workspace);
  assert.deepEqual(
    jobs.map((job) => job.id),
    ["job-new", "job-old"]
  );
});

test("listJobs migrates legacy state jobs and stored output into per-job files", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const legacyJob = {
    id: "review-legacy",
    status: "completed",
    summary: "legacy summary",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  };
  fs.writeFileSync(
    path.join(jobsDir, "review-legacy.json"),
    JSON.stringify({ result: { status: 0 }, rendered: "legacy output\n" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [legacyJob] }),
    "utf8"
  );

  const jobs = listJobs(workspace);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "review-legacy");
  assert.equal(jobs[0].summary, "legacy summary");
  assert.deepEqual(jobs[0].result, { status: 0 });
  assert.equal(jobs[0].rendered, "legacy output\n");
  assert.equal(getConfig(workspace).stopReviewGate, true);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);
});

test("the cancel marker is authoritative on read", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "job-x", { status: "running" });
  writeCancelMarker(workspace, "job-x");

  // Even a later completion write cannot un-cancel.
  writeJobFile(workspace, "job-x", { status: "completed" });
  assert.equal(readJobFile(resolveJobFile(workspace, "job-x")).status, "cancelled");
  assert.equal(listJobs(workspace)[0].status, "cancelled");
});

test("updateJobFile stamps updatedAt and no-ops on a missing record", () => {
  const workspace = makeTempDir();
  assert.equal(updateJobFile(workspace, "job-missing", { phase: "x" }), null);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-missing")), false);

  writeJobFile(workspace, "job-y", { status: "running", updatedAt: "2000-01-01T00:00:00.000Z" });
  const updated = updateJobFile(workspace, "job-y", { phase: "investigating" });
  assert.equal(updated.phase, "investigating");
  assert.notEqual(updated.updatedAt, "2000-01-01T00:00:00.000Z");
});

test("getConfig defaults when missing, warns-and-defaults when corrupt, migrates legacy state.json", () => {
  const missing = makeTempDir();
  assert.deepEqual(getConfig(missing), { stopReviewGate: false });

  const corrupt = makeTempDir();
  ensureStateDir(corrupt);
  fs.writeFileSync(resolveConfigFile(corrupt), "{ not json", "utf8");
  assert.deepEqual(getConfig(corrupt), { stopReviewGate: false });

  const legacy = makeTempDir();
  ensureStateDir(legacy);
  fs.writeFileSync(
    path.join(resolveStateDir(legacy), "state.json"),
    JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }),
    "utf8"
  );
  assert.equal(getConfig(legacy).stopReviewGate, true, "legacy config should migrate");
  setConfig(legacy, "stopReviewGate", true);
  assert.equal(
    fs.existsSync(path.join(resolveStateDir(legacy), "state.json")),
    false,
    "legacy file removed after write"
  );
  assert.equal(getConfig(legacy).stopReviewGate, true);
});

test("getConfig migrates the old fallback state root into the uid-scoped root", (t) => {
  const workspace = makeTempDir();
  const newStateDir = resolveStateDir(workspace);
  const oldStateDir = path.join(os.tmpdir(), "codex-companion", path.basename(newStateDir));
  t.after(() => fs.rmSync(oldStateDir, { recursive: true, force: true }));
  fs.mkdirSync(oldStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldStateDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [{ id: "task-legacy", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }]
    }),
    "utf8"
  );

  assert.equal(getConfig(workspace).stopReviewGate, true);
  assert.equal(listJobs(workspace)[0].id, "task-legacy");
  assert.equal(resolveStateDir(workspace), newStateDir);
  assert.equal(fs.existsSync(path.join(oldStateDir, "state.json")), false);
});

test("sweepJobs caps terminal jobs at 50 keeping the newest", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 51; index += 1) {
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    writeJobFile(workspace, `job-${index}`, { status: "completed", updatedAt });
    // stamp the log too so pruning removes both
    fs.writeFileSync(resolveJobLogFile(workspace, `job-${index}`), "log\n", "utf8");
  }

  sweepJobs(workspace);

  const jobs = listJobs(workspace);
  assert.equal(jobs.length, 50);
  assert.equal(
    jobs.some((job) => job.id === "job-0"),
    false,
    "the oldest terminal job should be pruned"
  );
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-0")), false);
});

test("sweepJobs reaps a crashed active job but preserves a live one", () => {
  const dead = makeTempDir();
  writeJobFile(dead, "job-dead", { status: "running", pid: 424242, updatedAt: "2026-01-01T00:00:00.000Z" });
  sweepJobs(dead, { isJobAlive: () => false });
  assert.equal(listJobs(dead)[0].status, "failed");

  const live = makeTempDir();
  writeJobFile(live, "job-live", { status: "running", pid: 424242, updatedAt: "2026-01-01T00:00:00.000Z" });
  sweepJobs(live, { isJobAlive: () => true });
  assert.equal(listJobs(live)[0].status, "running");
});
