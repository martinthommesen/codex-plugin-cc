import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  clearStopReviewGatePause,
  isStopReviewGatePaused,
  parseStopReviewOutput,
  pauseStopReviewGate
} from "../plugins/codex/scripts/lib/stop-review.mjs";

test("parseStopReviewOutput allows ALLOW responses", () => {
  assert.deepEqual(parseStopReviewOutput("ALLOW: no issues found\nextra detail"), {
    ok: true,
    blocked: false,
    reason: null
  });
});

test("parseStopReviewOutput blocks with the first BLOCK reason", () => {
  const result = parseStopReviewOutput("BLOCK: missing regression test\nMore context");

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /missing regression test/);
});

test("parseStopReviewOutput treats empty and unexpected output as blocking", () => {
  assert.deepEqual(parseStopReviewOutput("").ok, false);
  assert.equal(parseStopReviewOutput("").blocked, false);
  const unexpected = parseStopReviewOutput("looks fine");
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.blocked, false);
  assert.match(unexpected.reason, /unexpected answer/);
});

test("stop review hook module is import safe", async () => {
  await import("../plugins/codex/scripts/stop-review-gate-hook.mjs");
});

test("codex companion module is import safe", async () => {
  await import("../plugins/codex/scripts/codex-companion.mjs");
});

test("stop review gate pause markers are session scoped and clearable", () => {
  const cwd = makeTempDir();
  const sessionId = "../unsafe/session";

  assert.equal(isStopReviewGatePaused(cwd, sessionId), false);
  assert.equal(pauseStopReviewGate(cwd, sessionId), true);
  assert.equal(isStopReviewGatePaused(cwd, sessionId), true);
  assert.equal(isStopReviewGatePaused(cwd, "other-session"), false);
  assert.equal(clearStopReviewGatePause(cwd, sessionId), true);
  assert.equal(isStopReviewGatePaused(cwd, sessionId), false);
});
