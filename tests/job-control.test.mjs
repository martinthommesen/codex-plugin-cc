import test from "node:test";
import assert from "node:assert/strict";

import { SESSION_ID_ENV } from "../plugins/codex/scripts/lib/constants.mjs";
import {
  filterJobsForCurrentSession,
  getCurrentSessionId,
  getJobTypeLabel
} from "../plugins/codex/scripts/lib/job-control.mjs";

test("getCurrentSessionId resolves explicit, input, and injected env session ids", () => {
  assert.equal(getCurrentSessionId({ sessionId: "explicit" }), "explicit");
  assert.equal(getCurrentSessionId({ input: { session_id: "hook" } }), "hook");
  assert.equal(getCurrentSessionId({ env: { [SESSION_ID_ENV]: "env" } }), "env");
});

test("filterJobsForCurrentSession scopes to the current session when present", () => {
  const jobs = [
    { id: "a", sessionId: "current" },
    { id: "b", sessionId: "other" },
    { id: "c", sessionId: null }
  ];

  assert.deepEqual(filterJobsForCurrentSession(jobs, { env: { [SESSION_ID_ENV]: "current" } }), [jobs[0]]);
  assert.deepEqual(filterJobsForCurrentSession(jobs, { env: {} }), jobs);
});

test("getJobTypeLabel derives labels from current job fields", () => {
  assert.equal(getJobTypeLabel({ jobClass: "stop-review", kindLabel: "task" }), "stop-review");
  assert.equal(getJobTypeLabel({ jobClass: "ask" }), "ask");
  assert.equal(getJobTypeLabel({ kind: "review", kindLabel: "task" }), "review");
  assert.equal(getJobTypeLabel({}), "job");
});
