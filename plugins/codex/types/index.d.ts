// The live-status module's state: the session's Codex jobs as the companion
// last reported them, newest first.
export type CodexJob = {
  id: string
  kind: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  phase: string
  elapsed: string
  summary: string
  progress: string[]
  threadId: string | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    codex: { jobs: Shaped<CodexJob[]> }
  }
}
