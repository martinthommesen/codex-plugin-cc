import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { getProcessStartTime } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { PLUGIN_DATA_ENV } from "./constants.mjs";

const CONFIG_FILE_NAME = "config.json";
const LEGACY_STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const CANCEL_MARKER_SUFFIX = ".cancelled";
const CRASH_MARKER_SUFFIX = ".crashed";
const LEGACY_FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "codex-companion");
const MAX_TERMINAL_JOBS = 50;
// A queued job that never records a worker pid within this window is treated as
// a crashed launch and reaped by sweepJobs.
const STALE_QUEUED_MS = 2 * 60 * 1000;
const migratedLegacyCwds = new Set();

function nowIso() {
  return new Date().toISOString();
}

function defaultConfig() {
  return { stopReviewGate: false };
}

/**
 * Reject anything that could escape the jobs directory when interpolated into a
 * path. Job ids are generated as `[a-z0-9-]` so this only ever fires on tampered
 * or hostile input (e.g. a crafted `--job-id`).
 * @param {unknown} jobId
 * @returns {string}
 */
export function assertJobId(jobId) {
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    jobId === "." ||
    jobId.includes("/") ||
    jobId.includes("\\") ||
    jobId.includes("..") ||
    jobId.includes("\0") ||
    path.basename(jobId) !== jobId
  ) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
  return jobId;
}

// --- user scoping + secure directory creation -----------------------------

const USER_SCOPE = (() => {
  try {
    const info = os.userInfo();
    if (typeof info.uid === "number" && info.uid >= 0) {
      return { uid: info.uid, tag: String(info.uid) };
    }
    const name = String(info.username || "user").replace(/[^a-zA-Z0-9._-]+/g, "-") || "user";
    return { uid: null, tag: name };
  } catch {
    return { uid: null, tag: "user" };
  }
})();

function resolveStateRoot() {
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    return path.join(pluginDataDir, "state");
  }
  // uid-scoped so a predictable /tmp path cannot be pre-planted by another user.
  return path.join(os.tmpdir(), `codex-companion-${USER_SCOPE.tag}`);
}

function workspaceStateDirName(cwd) {
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
  return `${slug}-${hash}`;
}

function resolveStateDirForRoot(cwd, stateRoot) {
  return path.join(stateRoot, workspaceStateDirName(cwd));
}

export function resolveStateDir(cwd) {
  return resolveStateDirForRoot(cwd, resolveStateRoot());
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

function lstatSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isSecureExistingDir(dir) {
  const info = lstatSafe(dir);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    return false;
  }
  return process.platform === "win32" || USER_SCOPE.uid == null || info.uid === USER_SCOPE.uid;
}

// Create/verify a single directory level we own. On POSIX, refuse to descend
// into a symlink or a directory owned by another user (symlink pre-plant
// defense). Windows relies on the per-user profile temp + default ACLs.
function ensureSecureDir(dir) {
  const info = lstatSafe(dir);
  if (info) {
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlinked state directory: ${dir}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`State path exists and is not a directory: ${dir}`);
    }
    if (process.platform !== "win32" && USER_SCOPE.uid != null && info.uid !== USER_SCOPE.uid) {
      throw new Error(`Refusing to use a state directory owned by another user: ${dir}`);
    }
    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o700);
    }
    return;
  }
  fs.mkdirSync(dir, { mode: 0o700 });
}

const ensuredDirs = new Set();

export function ensureStateDir(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (ensuredDirs.has(jobsDir)) {
    return;
  }
  const root = resolveStateRoot();
  // The root's parent is a system/user dir we do not own; create it plainly.
  fs.mkdirSync(path.dirname(root), { recursive: true });
  ensureSecureDir(root);
  ensureSecureDir(resolveStateDir(cwd));
  ensureSecureDir(jobsDir);
  ensuredDirs.add(jobsDir);
}

// --- atomic write ----------------------------------------------------------

const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

function sleepSync(ms) {
  Atomics.wait(sleepView, 0, 0, ms);
}

/**
 * Write `data` to `file` atomically and privately: a same-directory temp file
 * created at `mode`, then renamed over the target. Never leaves a torn/partial
 * or world-readable file. Retries the rename on Windows EPERM/EBUSY (a reader
 * holding the target open can transiently block the replace).
 * @param {string} file
 * @param {string} data
 * @param {number} [mode]
 */
export function writeFileAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  let tmp;
  for (;;) {
    tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    let fd;
    try {
      fd = fs.openSync(tmp, "wx", mode); // exclusive create at mode (umask can only lower it)
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
        continue; // vanishingly rare name collision; pick another
      }
      throw error;
    }
    try {
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    break;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const errorCode = /** @type {NodeJS.ErrnoException} */ (error).code;
      const transient = errorCode === "EPERM" || errorCode === "EBUSY" || errorCode === "EACCES";
      if (transient && attempt < 20) {
        sleepSync(Math.min(100, 5 * (attempt + 1)));
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw error;
    }
  }
}

// --- legacy state migration -------------------------------------------------

function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function legacyStateSources(cwd) {
  const currentRoot = resolveStateRoot();
  const currentDir = resolveStateDirForRoot(cwd, currentRoot);
  const sources = [];

  const currentStateFile = path.join(currentDir, LEGACY_STATE_FILE_NAME);
  if (fs.existsSync(currentStateFile) && isSecureExistingDir(currentRoot) && isSecureExistingDir(currentDir)) {
    sources.push({ stateFile: currentStateFile, stateDir: currentDir });
  }

  if (!process.env[PLUGIN_DATA_ENV] && LEGACY_FALLBACK_STATE_ROOT !== currentRoot) {
    const dir = resolveStateDirForRoot(cwd, LEGACY_FALLBACK_STATE_ROOT);
    const stateFile = path.join(dir, LEGACY_STATE_FILE_NAME);
    if (fs.existsSync(stateFile) && isSecureExistingDir(LEGACY_FALLBACK_STATE_ROOT) && isSecureExistingDir(dir)) {
      sources.push({ stateFile, stateDir: dir });
    }
  }

  return sources;
}

function migrateLegacyJob(cwd, legacyStateDir, legacyJob) {
  if (!legacyJob || typeof legacyJob !== "object" || Array.isArray(legacyJob)) {
    return;
  }

  let jobId;
  try {
    jobId = assertJobId(legacyJob.id);
  } catch {
    return;
  }

  const legacyJobFile = path.join(legacyStateDir, JOBS_DIR_NAME, `${jobId}.json`);
  const targetJobFile = path.join(resolveJobsDir(cwd), `${jobId}.json`);
  const legacyPayload = readJsonObject(legacyJobFile) ?? {};
  const currentPayload = readJsonObject(targetJobFile) ?? {};
  const record = {
    ...legacyJob,
    ...legacyPayload,
    ...currentPayload,
    id: jobId
  };
  if (!record.updatedAt) {
    record.updatedAt = record.createdAt ?? nowIso();
  }
  if (!record.createdAt) {
    record.createdAt = record.updatedAt;
  }
  writeFileAtomic(targetJobFile, `${JSON.stringify(record, null, 2)}\n`);
}

function migrateLegacyState(cwd) {
  const key = path.resolve(cwd);
  if (migratedLegacyCwds.has(key)) {
    return;
  }
  migratedLegacyCwds.add(key);
  for (const source of legacyStateSources(cwd)) {
    const legacyState = readJsonObject(source.stateFile);
    if (!legacyState) {
      continue;
    }

    ensureStateDir(cwd);
    if (
      !fs.existsSync(resolveConfigFile(cwd)) &&
      legacyState.config &&
      typeof legacyState.config === "object" &&
      !Array.isArray(legacyState.config)
    ) {
      writeFileAtomic(
        resolveConfigFile(cwd),
        `${JSON.stringify({ ...defaultConfig(), ...legacyState.config }, null, 2)}\n`
      );
    }

    if (Array.isArray(legacyState.jobs)) {
      for (const job of legacyState.jobs) {
        migrateLegacyJob(cwd, source.stateDir, job);
      }
    }

    try {
      fs.unlinkSync(source.stateFile);
    } catch {
      /* ignore: migration already materialized the replacement files */
    }
  }
}

// --- config (persistent user setting; migrates once from legacy state.json) --

function readConfigRaw(cwd) {
  migrateLegacyState(cwd);
  const configFile = resolveConfigFile(cwd);
  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      // A corrupt config is NOT silently reset without a trace. The gate is an
      // opt-in workflow convenience (default off), not a security boundary, so
      // defaulting off here is safe — but we surface it.
      process.stderr.write(`[codex] Warning: ${configFile} is unreadable; using default config.\n`);
      return null;
    }
  }

  return null;
}

export function getConfig(cwd) {
  return { ...defaultConfig(), ...(readConfigRaw(cwd) ?? {}) };
}

export function setConfig(cwd, key, value) {
  ensureStateDir(cwd);
  const next = { ...getConfig(cwd), [key]: value };
  writeFileAtomic(resolveConfigFile(cwd), `${JSON.stringify(next, null, 2)}\n`);
  // The legacy index is fully superseded once config is persisted separately.
  const legacyFile = path.join(resolveStateDir(cwd), LEGACY_STATE_FILE_NAME);
  try {
    fs.unlinkSync(legacyFile);
  } catch {
    /* ignore: no legacy file */
  }
  return next;
}

// --- jobs (per-file store; the index is derived by scanning) ---------------

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${assertJobId(jobId)}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${assertJobId(jobId)}.log`);
}

function resolveCancelMarker(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${assertJobId(jobId)}${CANCEL_MARKER_SUFFIX}`);
}

function resolveCrashMarker(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${assertJobId(jobId)}${CRASH_MARKER_SUFFIX}`);
}

/**
 * Read one per-job record. The durable `<id>.cancelled` marker is authoritative:
 * if present it overlays `status:"cancelled"`, so a worker's in-flight
 * completion write can never un-cancel a job (no lock, no TOCTOU).
 * @param {string} jobFile
 */
export function readJobFile(jobFile) {
  const parsed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (parsed && typeof parsed === "object" && jobFile.endsWith(".json")) {
    const base = jobFile.slice(0, -".json".length);
    const cancelMarker = `${base}${CANCEL_MARKER_SUFFIX}`;
    if (fs.existsSync(cancelMarker)) {
      return { ...parsed, status: "cancelled" };
    }
    const crashMarker = `${base}${CRASH_MARKER_SUFFIX}`;
    if ((parsed.status === "queued" || parsed.status === "running") && fs.existsSync(crashMarker)) {
      const crashedAt = fs.readFileSync(crashMarker, "utf8").trim() || parsed.updatedAt;
      return {
        ...parsed,
        status: "failed",
        phase: "failed",
        pid: null,
        pidStartTime: null,
        updatedAt: crashedAt,
        completedAt: parsed.completedAt ?? crashedAt,
        errorMessage: parsed.errorMessage ?? "Codex process exited without finalizing the job."
      };
    }
  }
  return parsed;
}

export function listJobs(cwd) {
  migrateLegacyState(cwd);
  const jobsDir = resolveJobsDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }

  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const jobId = name.slice(0, -".json".length);
    try {
      assertJobId(jobId);
    } catch {
      continue; // ignore tampered/foreign filenames
    }
    try {
      const job = readJobFile(path.join(jobsDir, name));
      if (job && typeof job === "object" && job.id) {
        jobs.push(job);
      }
    } catch {
      // skip an individual unparseable/torn file rather than losing all history
    }
  }
  jobs.sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  return jobs;
}

/** Full atomic write of a job record; always stamps `updatedAt`. */
export function writeJobFile(cwd, jobId, payload) {
  const now = nowIso();
  const record = { createdAt: now, ...payload, id: assertJobId(jobId), updatedAt: now };
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Merge `patch` onto an existing record. No-op if the record is absent (never creates a partial). */
export function updateJobFile(cwd, jobId, patch) {
  assertJobId(jobId);
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  let current;
  try {
    current = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
  const record = { ...current, ...patch, id: jobId, updatedAt: nowIso() };
  writeFileAtomic(jobFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Write the durable cancel marker (before killing the process). */
export function writeCancelMarker(cwd, jobId) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveCancelMarker(cwd, jobId), `${nowIso()}\n`);
}

/** Write the subordinate crash marker. A terminal job record always wins over it. */
export function writeCrashMarker(cwd, jobId) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveCrashMarker(cwd, jobId), `${nowIso()}\n`);
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore ENOENT / races */
  }
}

export function removeJob(cwd, jobId) {
  assertJobId(jobId);
  const jobsDir = resolveJobsDir(cwd);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  // Also remove a stored logFile even if it isn't the canonical <id>.log path.
  try {
    removeFileIfExists(JSON.parse(fs.readFileSync(jobFile, "utf8")).logFile);
  } catch {
    /* no record or unreadable */
  }
  removeFileIfExists(jobFile);
  removeFileIfExists(path.join(jobsDir, `${jobId}.log`));
  removeFileIfExists(path.join(jobsDir, `${jobId}${CANCEL_MARKER_SUFFIX}`));
  removeFileIfExists(path.join(jobsDir, `${jobId}${CRASH_MARKER_SUFFIX}`));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = gone; EPERM = exists but owned by someone we can't signal.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

function isStaleQueuedWithoutPid(job) {
  if (job.pid != null) {
    return false;
  }
  const created = Date.parse(job.createdAt ?? job.updatedAt ?? "");
  return Number.isFinite(created) && Date.now() - created > STALE_QUEUED_MS;
}

/**
 * Bound the jobs directory: keep all live-active jobs plus the latest
 * MAX_TERMINAL_JOBS terminal ones. Reaps active records whose process is gone
 * (crash) so they stop masquerading as running. Called at job-creation cadence.
 *
 * `isJobAlive` is injectable for tests; production checks pid liveness and,
 * when recorded, the pid start-time so recycled pids are not treated as ours.
 */
export function sweepJobs(cwd, options = {}) {
  const isProcessAlive = options.isProcessAlive ?? isPidAlive;
  const getProcessStartTimeImpl = options.getProcessStartTime ?? getProcessStartTime;
  const isJobAlive =
    options.isJobAlive ??
    ((job) => {
      if (job.pid == null || !isProcessAlive(job.pid)) {
        return false;
      }
      if (job.pidStartTime == null) {
        return true;
      }
      const liveStartTime = getProcessStartTimeImpl(job.pid);
      return liveStartTime == null || liveStartTime === job.pidStartTime;
    });

  const jobs = listJobs(cwd);
  let wroteCrashMarker = false;
  for (const job of jobs) {
    const active = job.status === "queued" || job.status === "running";
    if (!active) {
      continue;
    }
    const dead = job.pid != null ? !isJobAlive(job) : isStaleQueuedWithoutPid(job);
    if (dead) {
      writeCrashMarker(cwd, job.id);
      wroteCrashMarker = true;
    }
  }

  const terminalSource = wroteCrashMarker ? listJobs(cwd) : jobs;
  const terminal = terminalSource.filter((job) => job.status !== "queued" && job.status !== "running");
  for (const job of terminal.slice(MAX_TERMINAL_JOBS)) {
    removeJob(cwd, job.id);
  }
}
