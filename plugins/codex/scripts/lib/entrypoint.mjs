import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function realpath(filePath) {
  return fs.realpathSync.native(path.resolve(filePath));
}

export function isMainEntrypoint(metaUrl, argvPath) {
  if (!argvPath) {
    return false;
  }
  return realpath(argvPath) === realpath(fileURLToPath(metaUrl));
}
