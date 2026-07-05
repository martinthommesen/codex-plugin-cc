import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// On Windows, spawn() without a shell needs the exact executable path and cannot
// run .cmd/.bat scripts at all. Resolve `command` against PATH + PATHEXT so real
// executables (git.exe, taskkill.exe) run shell-free — their args then reach the
// process as argv with no shell-metacharacter interpretation.
export function resolveExecutable(command, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const dir of (env.PATH || "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

// Decide how to spawn `command`. Real executables run shell-free (argv-safe,
// closing shell injection for user/repo-derived args such as git refs). Script
// shims (.cmd/.bat/.ps1 — e.g. the codex npm shim) require a shell; the plugin
// only ever invokes those with static, non-user args, so that stays injection-safe.
export function spawnConfigFor(command, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") {
    return { command, shell: false };
  }
  const resolved = resolveExecutable(command, { platform, env });
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    return { command, shell: true };
  }
  return { command: resolved, shell: false };
}

export function runCommand(command, args = [], options = {}) {
  const spawnConfig = spawnConfigFor(command, { env: options.env ?? process.env });
  const result = spawnSync(spawnConfig.command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: spawnConfig.shell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

// A durable-enough identity token for a pid: its OS start-time. Paired with the
// pid it distinguishes "still our process" from "pid recycled to a stranger".
// Returns null when the process is gone or the platform lookup is unavailable.
export function getProcessStartTime(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  try {
    if (platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime). comm (field 2) may contain spaces/parens, so index
      // from after the final ')'; starttime is the 20th field that follows.
      const afterComm = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return afterComm[19] ? `linux:${afterComm[19]}` : null;
    }
    if (platform === "win32") {
      const result = runCommandImpl(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`],
        {}
      );
      const out = String(result.stdout ?? "").trim();
      return out ? `win:${out}` : null;
    }
    // macOS / BSD.
    const result = runCommandImpl("ps", ["-o", "lstart=", "-p", String(pid)], {});
    const out = String(result.stdout ?? "").trim();
    return out ? `posix:${out}` : null;
  } catch {
    return null;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const getStartTime = options.getStartTime ?? getProcessStartTime;

  // Fail-closed identity check. A stored pid can be recycled to an unrelated
  // process; when the caller supplies the expected start-time, verify it and only
  // reap on a match. When a persisted pid carries no stored identity (a
  // pre-upgrade record: requireIdentity without expectedStartTime), restrict the
  // kill to the single pid rather than blindly signalling a whole group.
  let killGroup = true;
  if (options.expectedStartTime != null) {
    const live = getStartTime(pid, { platform, runCommandImpl });
    if (live == null) {
      return { attempted: true, delivered: false, method: "identity", identity: "gone" };
    }
    if (live !== options.expectedStartTime) {
      return { attempted: false, delivered: false, method: "identity", identity: "mismatch" };
    }
  } else if (options.requireIdentity) {
    killGroup = false;
  }

  if (platform === "win32") {
    const result = runCommandImpl(
      "taskkill",
      killGroup ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"],
      {
        cwd: options.cwd,
        env: options.env
      }
    );

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (/** @type {NodeJS.ErrnoException | null} */ (result.error)?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  if (!killGroup) {
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" };
      }
      throw error;
    }
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (/** @type {NodeJS.ErrnoException} */ (innerError).code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
