#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const STDERR_TAIL_CHARS = 4000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function tailOf(value, length = STDERR_TAIL_CHARS) {
  const text = String(value ?? "");
  return text.length > length ? text.slice(-length) : text;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function buildAppClientError(error, appClient) {
  return buildJsonRpcError(error.rpcCode ?? -32000, error.message, { stderr: tailOf(appClient.stderr) });
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

export function createBrokerSocketHandler(appClient, options = {}) {
  let activeRequestSocket = null;
  let activeStream = null;
  const sockets = new Set();

  function clearActiveStream(stream = activeStream) {
    if (activeStream === stream) {
      activeStream = null;
    }
  }

  function createActiveStream(socket, method, params) {
    return {
      socket,
      threadIds: buildStreamThreadIds(method, params, null),
      threadId: params?.threadId ?? null,
      turnId: null,
      ownerClosed: false,
      interrupting: false
    };
  }

  function streamOwnsThread(stream, threadId) {
    return !threadId || stream.threadIds.size === 0 || stream.threadIds.has(threadId);
  }

  async function interruptActiveStream(stream = activeStream) {
    if (!stream || activeStream !== stream || stream.interrupting || !stream.ownerClosed || !stream.threadId || !stream.turnId) {
      return;
    }

    stream.interrupting = true;
    try {
      await appClient.request("turn/interrupt", {
        threadId: stream.threadId,
        turnId: stream.turnId
      });
    } catch {
      // Best effort: the owning client is already gone, so there is no caller to report to.
    } finally {
      clearActiveStream(stream);
    }
  }

  function rememberActiveTurn(stream, threadId, turnId) {
    if (!stream || !turnId || !streamOwnsThread(stream, threadId)) {
      return;
    }
    if (threadId) {
      stream.threadIds.add(threadId);
      stream.threadId = stream.threadId ?? threadId;
    }
    stream.turnId = stream.turnId ?? turnId;
    if (stream.ownerClosed) {
      void interruptActiveStream(stream);
    }
  }

  function rememberTurnFromResult(stream, method, params, result) {
    for (const threadId of buildStreamThreadIds(method, params, result)) {
      stream.threadIds.add(threadId);
    }
    if (method === "turn/start") {
      rememberActiveTurn(stream, params?.threadId ?? null, result?.turn?.id ?? null);
    }
  }

  function rememberTurnFromNotification(message) {
    if (!activeStream || (message.method !== "turn/started" && message.method !== "turn/completed")) {
      return;
    }
    rememberActiveTurn(activeStream, message.params?.threadId ?? null, message.params?.turn?.id ?? null);
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStream?.socket === socket) {
      activeStream.ownerClosed = true;
      void interruptActiveStream(activeStream);
    }
  }

  function routeNotification(message) {
    rememberTurnFromNotification(message);
    const target = activeRequestSocket ?? activeStream?.socket ?? null;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStream) {
      const threadId = message.params?.threadId ?? null;
      if (streamOwnsThread(activeStream, threadId)) {
        clearActiveStream(activeStream);
      }
    }
  }

  appClient.setNotificationHandler(routeNotification);

  function attach(socket) {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          if (options.shutdown) {
            await options.shutdown();
            options.exit?.(0);
          }
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStream?.socket && activeStream.socket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStream?.socket && activeStream.socket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildAppClientError(error, appClient)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        const stream = isStreaming ? createActiveStream(socket, message.method, message.params ?? {}) : null;
        if (stream) {
          activeStream = stream;
        }
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (stream && activeStream === stream) {
            rememberTurnFromResult(stream, message.method, message.params ?? {}, result);
          }
          if (stream?.ownerClosed) {
            void interruptActiveStream(stream);
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildAppClientError(error, appClient)
          });
          if (activeStream === stream) {
            clearActiveStream(stream);
          }
        } finally {
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    return socket;
  }

  return { attach, sockets };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let server;
  let broker;

  async function shutdown() {
    for (const socket of broker.sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  broker = createBrokerSocketHandler(appClient, {
    shutdown,
    exit: (code) => process.exit(code)
  });

  server = net.createServer((socket) => {
    broker.attach(socket);
  });

  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
