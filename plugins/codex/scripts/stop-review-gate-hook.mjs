#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  isStopReviewGatePaused,
  parseStopReviewOutput,
  pauseStopReviewGate,
  STOP_REVIEW_GATE_PAUSED_MESSAGE
} from "./lib/stop-review.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { filterJobsForCurrentSession, getCurrentSessionId, getJobTypeLabel } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/constants.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });

  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const sessionId = getCurrentSessionId({ input, env: process.env });

  const jobs = filterJobsForCurrentSession(listJobs(workspaceRoot), { input, env: process.env });
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const jobLabel = runningJob ? getJobTypeLabel(runningJob) : null;
  const runningJobNote = runningJob
    ? `Codex ${jobLabel} ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningJobNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningJobNote);
    return;
  }

  if (isStopReviewGatePaused(workspaceRoot, sessionId)) {
    logNote(STOP_REVIEW_GATE_PAUSED_MESSAGE);
    logNote(runningJobNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    const paused = review.blocked ? pauseStopReviewGate(workspaceRoot, sessionId) : false;
    const pauseNote = paused ? ` ${STOP_REVIEW_GATE_PAUSED_MESSAGE}` : "";
    emitDecision({
      decision: "block",
      reason: runningJobNote ? `${runningJobNote} ${review.reason}${pauseNote}` : `${review.reason}${pauseNote}`
    });
    return;
  }

  logNote(runningJobNote);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
