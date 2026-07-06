import path from "node:path";

import { ensureGitRepository } from "./git.mjs";

const workspaceRootCache = new Map();

export function resolveWorkspaceRoot(cwd) {
  const key = path.resolve(cwd);
  if (workspaceRootCache.has(key)) {
    return workspaceRootCache.get(key);
  }
  let workspaceRoot;
  try {
    workspaceRoot = ensureGitRepository(cwd);
  } catch {
    workspaceRoot = cwd;
  }
  workspaceRootCache.set(key, workspaceRoot);
  return workspaceRoot;
}
