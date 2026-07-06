import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureStateDir, resolveStateDir, writeFileAtomic } from "./state.mjs";

export const STOP_REVIEW_GATE_PAUSED_MESSAGE =
  "review gate auto-paused after one block for this session; re-enable with `/codex:setup --enable-review-gate`.";

function pauseMarkerFile(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  const digest = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(resolveStateDir(cwd), `stop-review-gate-${digest}.paused`);
}

export function isStopReviewGatePaused(cwd, sessionId) {
  const marker = pauseMarkerFile(cwd, sessionId);
  return marker ? fs.existsSync(marker) : false;
}

export function pauseStopReviewGate(cwd, sessionId) {
  const marker = pauseMarkerFile(cwd, sessionId);
  if (!marker) {
    return false;
  }
  ensureStateDir(cwd);
  writeFileAtomic(marker, `${new Date().toISOString()}\n`);
  return true;
}

export function clearStopReviewGatePause(cwd, sessionId) {
  const marker = pauseMarkerFile(cwd, sessionId);
  if (!marker) {
    return false;
  }
  fs.rmSync(marker, { force: true });
  return true;
}

export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      blocked: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, blocked: false, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      blocked: true,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    blocked: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}
