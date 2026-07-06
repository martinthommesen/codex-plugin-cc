import test from "node:test";
import assert from "node:assert/strict";

import { resolveEffectiveModel } from "../plugins/codex/scripts/lib/codex.mjs";

function fakeClient(config, options = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (options.reject) {
        throw new Error(options.reject);
      }
      return { config };
    }
  };
}

test("resolveEffectiveModel returns an explicit model without reading config", async () => {
  const client = fakeClient({ model: "configured" });

  const model = await resolveEffectiveModel(client, "/repo", "gpt-explicit");

  assert.equal(model, "gpt-explicit");
  assert.deepEqual(client.calls, []);
});

test("resolveEffectiveModel falls back only when OpenAI config has no model", async () => {
  const client = fakeClient({ model_provider: "openai" });

  const model = await resolveEffectiveModel(client, "/repo", null);

  assert.equal(model, "gpt-5.5");
  assert.deepEqual(client.calls, [{ method: "config/read", params: { includeLayers: false, cwd: "/repo" } }]);
});

test("resolveEffectiveModel defers to configured model keys", async () => {
  const client = fakeClient({ model_provider: "openai", review_model: "gpt-review" });

  const model = await resolveEffectiveModel(client, "/repo", null, {
    configModelKeys: ["model", "review_model"]
  });

  assert.equal(model, null);
});

test("resolveEffectiveModel defers to non-OpenAI providers", async () => {
  const client = fakeClient({ model_provider: "local" });

  const model = await resolveEffectiveModel(client, "/repo", null);

  assert.equal(model, null);
});

test("resolveEffectiveModel leaves selection to Codex when config read fails", async () => {
  const client = fakeClient({}, { reject: "config unavailable" });
  const progress = [];

  const model = await resolveEffectiveModel(client, "/repo", null, {
    onProgress(update) {
      progress.push(update);
    }
  });

  assert.equal(model, null);
  assert.deepEqual(progress, [
    {
      message: "Codex config lookup failed (config unavailable); leaving model selection to Codex.",
      phase: "starting"
    }
  ]);
});
