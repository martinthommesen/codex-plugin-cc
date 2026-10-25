import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { createTempDir, readJsonFile, writeJsonFile } from "./fs.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir, SESSION_ID_ENV } from "./state.mjs";

const BROKER_STATE_FILE = "broker.json";
const BROKER_SHUTDOWN_TIMEOUT_MS = 1000;

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
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
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    // Don't let an unresponsive broker consume the SessionEnd hook's time budget.
    socket.setTimeout(BROKER_SHUTDOWN_TIMEOUT_MS, () => socket.destroy());
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve(undefined);
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
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
    return readJsonFile(stateFile);
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  writeJsonFile(resolveBrokerStateFile(cwd), session);
}

export function clearBrokerSession(cwd) {
  fs.rmSync(resolveBrokerStateFile(cwd), { force: true });
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

// The broker is shared by every Claude session in the workspace; record which
// sessions use it so SessionEnd only shuts it down for the last one.
function registerBrokerUser(cwd, session, sessionId) {
  const sessions = Array.isArray(session.sessions) ? session.sessions : [];
  if (!sessionId || sessions.includes(sessionId)) {
    return session;
  }
  const next = { ...session, sessions: [...sessions, sessionId] };
  saveBrokerSession(cwd, next);
  return next;
}

export async function ensureBrokerSession(cwd, options = {}) {
  const sessionId = (options.env ?? process.env)[SESSION_ID_ENV] || null;
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return registerBrokerUser(cwd, existing, sessionId);
  }

  if (existing) {
    teardownBrokerSession({ ...existing, killProcess: options.killProcess ?? null });
    clearBrokerSession(cwd);
  }

  const sessionDir = createTempDir("cxc-");
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const spawned = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // This broker is ours and unrecorded: stop it rather than leave it running.
    teardownBrokerSession({ ...spawned, killProcess: options.killProcess ?? terminateProcessTree });
    return null;
  }

  // Another companion may have started a broker for this workspace meanwhile; keep
  // the recorded one so SessionEnd can reach every broker it has to stop.
  const raced = loadBrokerSession(cwd);
  if (raced?.endpoint && raced.endpoint !== endpoint && (await isBrokerEndpointReady(raced.endpoint))) {
    await sendBrokerShutdown(endpoint);
    teardownBrokerSession({ ...spawned, killProcess: options.killProcess ?? terminateProcessTree });
    return registerBrokerUser(cwd, raced, sessionId);
  }

  const session = { ...spawned, sessions: sessionId ? [sessionId] : [] };
  saveBrokerSession(cwd, session);
  return session;
}

// Returns the sessions other than `sessionId` still using the workspace broker.
export function releaseBrokerSession(cwd, session, sessionId) {
  const sessions = Array.isArray(session?.sessions) ? session.sessions : [];
  if (!sessionId) {
    return [];
  }
  const remaining = sessions.filter((id) => id !== sessionId);
  if (remaining.length > 0 && remaining.length !== sessions.length) {
    saveBrokerSession(cwd, { ...session, sessions: remaining });
  }
  return remaining;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  for (const filePath of [pidFile, logFile]) {
    if (filePath) {
      fs.rmSync(filePath, { force: true });
    }
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix") {
        fs.rmSync(target.path, { force: true });
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
