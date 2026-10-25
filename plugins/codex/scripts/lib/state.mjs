import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./fs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const SESSION_POINTERS_DIR = path.join(FALLBACK_STATE_ROOT_DIR, "sessions");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

export function nowIso() {
  return new Date().toISOString();
}

export function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// Claude Code sets CLAUDE_PLUGIN_DATA for hooks and commands, but not for the
// plugin's hooks module. SessionStart records the directory per session so the
// module can reach the same state by passing only the session id.
function resolveSessionPointerFile(sessionId) {
  const digest = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(SESSION_POINTERS_DIR, `${digest}.json`);
}

export function writeSessionPointer(sessionId, pluginDataDir) {
  if (!sessionId || !pluginDataDir || !path.isAbsolute(pluginDataDir)) {
    return null;
  }
  fs.mkdirSync(SESSION_POINTERS_DIR, { recursive: true, mode: 0o700 });
  const pointerFile = resolveSessionPointerFile(sessionId);
  fs.writeFileSync(pointerFile, `${JSON.stringify({ pluginDataDir })}\n`, { encoding: "utf8", mode: 0o600 });
  return pointerFile;
}

export function removeSessionPointer(sessionId) {
  if (sessionId) {
    fs.rmSync(resolveSessionPointerFile(sessionId), { force: true });
  }
}

export function readSessionPointer(sessionId) {
  if (!sessionId) {
    return null;
  }
  const pointerFile = resolveSessionPointerFile(sessionId);
  try {
    const stat = fs.statSync(pointerFile);
    // The fallback root can sit in a shared temp directory: trust only our own file.
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return null;
    }
    if ((stat.mode & 0o022) !== 0) {
      return null;
    }
    const { pluginDataDir } = readJsonFile(pointerFile);
    return typeof pluginDataDir === "string" && path.isAbsolute(pluginDataDir) ? pluginDataDir : null;
  } catch {
    return null;
  }
}

function resolvePluginDataDir() {
  return process.env[PLUGIN_DATA_ENV] || readSessionPointer(process.env[SESSION_ID_ENV]);
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = resolvePluginDataDir();
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = readJsonFile(stateFile);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return sortJobsNewestFirst(jobs).slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath) {
    fs.rmSync(filePath, { force: true });
  }
}

export function saveState(cwd, state, previousJobs = loadState(cwd).jobs) {
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonFile(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  const previousJobs = [...state.jobs];
  mutate(state);
  return saveState(cwd, state, previousJobs);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonFile(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return readJsonFile(jobFile);
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
