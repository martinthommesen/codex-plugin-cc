import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("concurrent broker registrations keep every session", async () => {
  const net = await import("node:net");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { makeTempDir } = await import("./helpers.mjs");
  const { loadBrokerSession, saveBrokerSession } = await import("../plugins/codex/scripts/lib/broker-lifecycle.mjs");

  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    saveBrokerSession(workspace, { endpoint: `unix:${socketPath}`, pid: null, sessions: ["sess-a"] });
    const lifecycle = fileURLToPath(new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url));
    const register = (sessionId) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", `const m = await import(${JSON.stringify(lifecycle)}); await m.ensureBrokerSession(${JSON.stringify(workspace)});`],
          { env: { ...env, CODEX_COMPANION_SESSION_ID: sessionId }, stdio: "ignore" }
        );
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    await Promise.all(["sess-b", "sess-c", "sess-d", "sess-e"].map(register));
    assert.deepEqual([...loadBrokerSession(workspace).sessions].sort(), ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"]);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
