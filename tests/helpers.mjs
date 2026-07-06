import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadBrokerSession, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

// Hermetic tests: drop ambient plugin session vars (CODEX_COMPANION_*,
// CLAUDE_PLUGIN_DATA) so the suite behaves identically inside a Claude Code
// session (where the plugin exports them) and in clean CI. Stripping here — not
// only in buildEnv — also keeps the test process's own resolveStateDir() in
// sync with the CLI subprocesses it spawns (both then use the /tmp fallback).
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEX_COMPANION_") || key === "CLAUDE_PLUGIN_DATA") {
    delete process.env[key];
  }
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

const brokerCleanupReposByTest = new WeakMap();
const brokerCleanupRepos = new Set();
const brokerCleanupSessions = [];

function cleanupBrokerRecords(repos, sessions) {
  const records = [...sessions];
  for (const cleanupRepo of repos) {
    records.push(loadBrokerSession(cleanupRepo) ?? {});
  }

  const seen = new Set();
  for (const cleanupSession of records) {
    const key = `${cleanupSession.pid ?? ""}:${cleanupSession.sessionDir ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    teardownBrokerSession({
      ...cleanupSession,
      killProcess: terminateProcessTree
    });
    if (Number.isFinite(cleanupSession.pid) && process.platform !== "win32") {
      try {
        process.kill(-cleanupSession.pid, "SIGKILL");
      } catch {
        // Best-effort test cleanup only.
      }
    }
  }
}

function reapOrphanedTestBrokers() {
  if (process.platform === "win32") {
    return;
  }
  const result = run("ps", ["-eo", "pid=,command="]);
  if (result.status !== 0) {
    return;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.includes("app-server-broker.mjs serve") || !line.includes("codex-plugin-test-")) {
      continue;
    }
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!Number.isFinite(pid)) {
      continue;
    }
    try {
      // ponytail: POSIX-only test cleanup sweep; add a Windows taskkill branch if CI ever shows broker leaks there.
      process.kill(-pid, "SIGKILL");
    } catch {
      // Best-effort test cleanup only.
    }
  }
}

process.once("exit", () => {
  cleanupBrokerRecords(brokerCleanupRepos, brokerCleanupSessions);
  reapOrphanedTestBrokers();
});

export function cleanupBroker(t, repo, session = null) {
  if (!repo) {
    return;
  }
  let cleanup = brokerCleanupReposByTest.get(t);
  if (!cleanup) {
    cleanup = { repos: new Set(), sessions: [] };
    brokerCleanupReposByTest.set(t, cleanup);
    t.after(() => cleanupBrokerRecords(cleanup.repos, cleanup.sessions));
  }
  cleanup.repos.add(repo);
  brokerCleanupRepos.add(repo);
  if (session) {
    cleanup.sessions.push(session);
    brokerCleanupSessions.push(session);
  }
}

// --- state fixtures (single per-job store) ---------------------------------
// The plugin stores each job as <stateDir>/jobs/<id>.json and the review-gate
// setting in <stateDir>/config.json. These helpers seed and read that layout,
// mirroring listJobs() (scan + cancel-marker overlay + newest-first sort).

export function seedStateFixture(stateDir, state = {}) {
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const config = state.config ?? { stopReviewGate: false };
  fs.writeFileSync(path.join(stateDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  for (const job of state.jobs ?? []) {
    // Merge onto any record already written (the single store now holds fields
    // the old model split between the index and the per-job file, e.g. result).
    const jobFile = path.join(jobsDir, `${job.id}.json`);
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    } catch {
      existing = {};
    }
    fs.writeFileSync(jobFile, `${JSON.stringify({ ...existing, ...job }, null, 2)}\n`, "utf8");
  }
}

export function writeJobFixture(stateDir, job) {
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

export function readStateFixture(stateDir) {
  const jobsDir = path.join(stateDir, "jobs");
  let jobs = [];
  try {
    jobs = fs
      .readdirSync(jobsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const job = JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8"));
        const marker = path.join(jobsDir, `${name.slice(0, -".json".length)}.cancelled`);
        return fs.existsSync(marker) ? { ...job, status: "cancelled" } : job;
      })
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  } catch {
    jobs = [];
  }
  let config = { stopReviewGate: false };
  try {
    config = JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8"));
  } catch {
    /* default config */
  }
  return { version: 1, config, jobs };
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
