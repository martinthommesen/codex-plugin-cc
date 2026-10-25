import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Several companion processes read these files while others write them, so write
// a sibling temp file and rename it into place: readers never see a partial file.
export function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameWithRetry(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

// Windows refuses to replace a file another process has open; retry briefly.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 20 || (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "EACCES")) {
        throw error;
      }
      sleepSync(10);
    }
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

// Hook payloads arrive as JSON on stdin; an empty payload means no fields.
export function readJsonStdin() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
