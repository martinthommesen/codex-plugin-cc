#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  releaseBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { readJsonStdin } from "./lib/fs.mjs";
import {
  isActiveJob,
  loadState,
  PLUGIN_DATA_ENV,
  removeSessionPointer,
  resolveStateFile,
  updateState,
  writeSessionPointer
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs.filter(isActiveJob)) {
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  updateState(workspaceRoot, (latest) => {
    latest.jobs = latest.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  try {
    writeSessionPointer(input.session_id, process.env[PLUGIN_DATA_ENV]);
  } catch {
    // The live-status module falls back to the temp state root without it.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const brokerSession =
    loadBrokerSession(cwd) ?? (process.env[BROKER_ENDPOINT_ENV] ? { endpoint: process.env[BROKER_ENDPOINT_ENV] } : {});
  // Other Claude sessions in this workspace may still be using the shared broker.
  const keepBroker = releaseBrokerSession(cwd, brokerSession, sessionId).length > 0;

  if (brokerSession.endpoint && !keepBroker) {
    await sendBrokerShutdown(brokerSession.endpoint);
  }

  cleanupSessionJobs(cwd, sessionId);
  try {
    removeSessionPointer(sessionId);
  } catch {
    // Not fatal; the broker still has to be torn down below.
  }
  if (!keepBroker) {
    teardownBrokerSession({ ...brokerSession, killProcess: terminateProcessTree });
    clearBrokerSession(cwd);
  }
}

async function main() {
  const input = readJsonStdin();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
