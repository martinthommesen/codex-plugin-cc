import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { buildEnv, buildHomeEnv, installFakeCodex, installNodeShim } from "./fake-codex-fixture.mjs";
import {
  cleanupBroker,
  initGitRepo,
  makeTempDir,
  readStateFixture,
  run,
  seedStateFixture,
  writeJobFixture
} from "./helpers.mjs";
import { createBrokerSocketHandler } from "../plugins/codex/scripts/app-server-broker.mjs";
import { BrokerCodexAppServerClient, CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  loadBrokerSession,
  saveBrokerSession,
  spawnBrokerProcess
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { BROKER_READY_TIMEOUT_ENV } from "../plugins/codex/scripts/lib/constants.mjs";
import { getProcessStartTime } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const BROKER_READY_TIMEOUT_MS = "30000";

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

class BrokerTestSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.output = "";
  }

  setEncoding() {}

  write(chunk) {
    if (!this.destroyed) {
      this.output += String(chunk);
    }
  }

  end() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.emit("close");
  }

  receive(message) {
    this.emit("data", JSON.stringify(message) + "\n");
  }

  message(id) {
    return (
      this.output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((message) => message.id === id) ?? null
    );
  }
}

async function brokerRequest(socket, message) {
  socket.receive(message);
  return waitFor(() => socket.message(message.id));
}

function runBrokerCommand(t, args, options = {}) {
  const { brokerReadyTimeout = false, ...runOptions } = options;
  const cwdFlagIndex = args.findIndex((arg) => arg === "--cwd");
  const inlineCwd = args.find((arg) => arg.startsWith("--cwd="));
  const commandCwd =
    cwdFlagIndex === -1 ? (inlineCwd ? inlineCwd.slice("--cwd=".length) : runOptions.cwd) : args[cwdFlagIndex + 1];
  cleanupBroker(t, commandCwd);
  const env = runOptions.env ?? process.env;
  const result = run("node", [SCRIPT, ...args], {
    ...runOptions,
    env: brokerReadyTimeout ? { ...env, [BROKER_READY_TIMEOUT_ENV]: BROKER_READY_TIMEOUT_MS } : env
  });
  cleanupBroker(t, commandCwd, loadBrokerSession(commandCwd));
  return result;
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function askEnv(binDir, sessionId) {
  const env = buildEnv(binDir);
  if (sessionId) {
    env.CODEX_COMPANION_SESSION_ID = sessionId;
  }
  return env;
}

export {
  assert,
  askEnv,
  brokerRequest,
  BrokerCodexAppServerClient,
  BrokerTestSocket,
  buildEnv,
  buildHomeEnv,
  cleanupBroker,
  CodexAppServerClient,
  createBrokerEndpoint,
  createBrokerSocketHandler,
  fs,
  getProcessStartTime,
  initGitRepo,
  installFakeCodex,
  installNodeShim,
  loadBrokerSession,
  makeTempDir,
  path,
  readFakeState,
  readStateFixture,
  resolveStateDir,
  ROOT,
  run,
  runBrokerCommand,
  saveBrokerSession,
  SCRIPT,
  seedStateFixture,
  SESSION_HOOK,
  spawn,
  spawnBrokerProcess,
  STOP_HOOK,
  test,
  waitFor,
  writeJobFixture
};
