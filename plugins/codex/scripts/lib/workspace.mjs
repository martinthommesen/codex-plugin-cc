import { ensureGitRepository } from "./git.mjs";

// Every state path lookup resolves the workspace, so cache the git probe per process.
const workspaceRoots = new Map();

export function resolveWorkspaceRoot(cwd) {
  let workspaceRoot = workspaceRoots.get(cwd);
  if (workspaceRoot === undefined) {
    try {
      workspaceRoot = ensureGitRepository(cwd);
    } catch {
      workspaceRoot = cwd;
    }
    workspaceRoots.set(cwd, workspaceRoot);
  }
  return workspaceRoot;
}
