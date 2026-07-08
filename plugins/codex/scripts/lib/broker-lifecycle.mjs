import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { BROKER_READY_TIMEOUT_ENV } from "./constants.mjs";
import { ensureStateDir, resolveStateDir, writeFileAtomic } from "./state.mjs";
import { getProcessStartTime } from "./process.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      let finished = false;
      const socket = connectToEndpoint(endpoint);
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        finish();
      }, 1500);
      timer.unref?.();
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
      });
      socket.on("data", () => {
        socket.end();
        finish();
      });
      socket.on("error", finish);
      socket.on("close", finish);
    })
  );
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a", 0o600);
  try {
    if (process.platform !== "win32") {
      fs.fchmodSync(logFd, 0o600);
    }
    const child = spawn(
      process.execPath,
      [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile],
      {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd]
      }
    );
    child.unref();
    return child;
  } finally {
    fs.closeSync(logFd);
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`);
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

/**
 * @typedef {{
 *   scriptPath?: string,
 *   platform?: NodeJS.Platform,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   createBrokerEndpoint?: (sessionDir: string, platform?: NodeJS.Platform) => string,
 *   killProcess?: ((pid: number, options?: object) => unknown) | null
 * }} EnsureBrokerSessionOptions
 */

/**
 * @param {string} cwd
 * @param {EnsureBrokerSessionOptions} [options]
 */
export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      pidStartTime: existing.pidStartTime ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  const pid = child.pid ?? null;
  const pidStartTime = getProcessStartTime(pid ?? Number.NaN);

  const env = options.env ?? process.env;
  const configured = Number(env[BROKER_READY_TIMEOUT_ENV]);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : 2000);
  const ready = await waitForBrokerEndpoint(endpoint, timeoutMs);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid,
      pidStartTime,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    pidStartTime
  };
  saveBrokerSession(cwd, session);
  return session;
}

/**
 * @param {{
 *   endpoint?: string | null,
 *   pidFile?: string | null,
 *   logFile?: string | null,
 *   sessionDir?: string | null,
 *   pid?: number | null,
 *   pidStartTime?: string | null,
 *   killProcess?: ((pid: number, options?: object) => unknown) | null
 * }} session
 */
export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidStartTime = null,
  killProcess = null
}) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(/** @type {number} */ (pid), { expectedStartTime: pidStartTime, requireIdentity: true });
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
