import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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
