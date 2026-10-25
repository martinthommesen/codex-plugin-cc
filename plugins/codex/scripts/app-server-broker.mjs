#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, buildJsonRpcError, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

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
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamTurn = null;
  const sockets = new Set();

  // With a direct app-server a turn dies with its client; give brokered turns the
  // same lifetime instead of letting them run (and edit files) with no owner.
  function interruptOrphanedTurn(turn) {
    if (!turn?.threadId || !turn?.turnId) {
      return;
    }
    try {
      appClient.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }).catch(() => {});
    } catch {
      // The runtime is already closing.
    }
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      interruptOrphanedTurn(activeStreamTurn);
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeStreamTurn = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeStreamTurn = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  // Idempotent: a signal, broker/shutdown, and the runtime exiting can all trigger it.
  let shutdownPromise = null;
  function shutdown(server) {
    shutdownPromise ??= (async () => {
      for (const socket of sockets) {
        socket.end();
      }
      await appClient.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      if (listenTarget.kind === "unix") {
        fs.rmSync(listenTarget.path, { force: true });
      }
      if (pidFile) {
        fs.rmSync(pidFile, { force: true });
      }
    })();
    return shutdownPromise;
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
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
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
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
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            const turn = {
              threadId: result?.reviewThreadId ?? message.params?.threadId ?? null,
              turnId: result?.turn?.id ?? null
            };
            if (socket.destroyed) {
              // The client left while the turn was starting: nobody will read it.
              interruptOrphanedTurn(turn);
            } else {
              activeStreamSocket = socket;
              activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
              activeStreamTurn = turn;
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          // A failed side request (e.g. thread/turns/list on an ephemeral thread) does
          // not end the socket's running turn, so keep routing its notifications.
        }
      }
    });

    const forgetSocket = () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    };
    socket.on("close", forgetSocket);
    socket.on("error", forgetSocket);
  });

  // Do not leave clients waiting forever if the underlying runtime exits.
  void appClient.exitPromise.then(async () => {
    if (!shutdownPromise) {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
    await shutdown(server);
    process.exit(0);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      await shutdown(server);
      process.exit(0);
    });
  }

  // e.g. the session dir was removed because readiness timed out: don't linger unreachable.
  server.on("error", async (error) => {
    process.stderr.write(`Broker could not listen on ${listenTarget.path}: ${error.message}\n`);
    await shutdown(server).catch(() => {});
    process.exit(1);
  });
  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
