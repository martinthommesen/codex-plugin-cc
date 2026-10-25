// Pure helpers for the live-status module: reading the companion's
// `status --json` snapshot and deciding what the status line and alerts say.
import type { CodexJob } from '../types'

const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const

type RawJob = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function textOrNull(value: unknown): string | null {
  return text(value) || null
}

function toJob(raw: RawJob): CodexJob | null {
  const id = text(raw.id)
  const status = STATUSES.find(one => one === raw.status)
  if (!id || !status) {
    return null
  }
  const progress = Array.isArray(raw.progressPreview)
    ? raw.progressPreview.map(text).filter(Boolean).slice(-4)
    : []

  return {
    id,
    kind: text(raw.kindLabel) || text(raw.kind) || 'job',
    title: text(raw.title),
    status,
    phase: text(raw.phase),
    elapsed: text(raw.duration) || text(raw.elapsed),
    summary: text(raw.summary),
    progress,
    threadId: textOrNull(raw.threadId),
    error: textOrNull(raw.errorMessage),
    startedAt: textOrNull(raw.startedAt) ?? textOrNull(raw.createdAt),
    completedAt: textOrNull(raw.completedAt),
  }
}

// The companion splits jobs into running, latestFinished and recent; the
// module keeps one list, newest first, with running jobs leading.
export function parseStatusSnapshot(stdout: string): CodexJob[] {
  const snapshot: unknown = JSON.parse(stdout)
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new Error('status --json did not return an object')
  }
  const { running, latestFinished, recent } = snapshot as Record<string, unknown>
  const raws: unknown[] = [
    ...(Array.isArray(running) ? running : []),
    latestFinished,
    ...(Array.isArray(recent) ? recent : []),
  ]
  const seen = new Set<string>()
  const jobs: CodexJob[] = []
  for (const raw of raws) {
    if (raw === null || typeof raw !== 'object') continue
    const job = toJob(raw as RawJob)
    if (job && !seen.has(job.id)) {
      seen.add(job.id)
      jobs.push(job)
    }
  }
  return jobs
}

export function isActive(job: CodexJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

// Review and stop-gate threads are ephemeral, so `codex resume` cannot open them.
export function canResume(job: CodexJob): boolean {
  return job.threadId !== null && !job.kind.includes('review')
}

// Companion subcommands that start, settle or cancel a job.
const JOB_COMMAND = /codex-companion\.mjs["']?\s+["']?(?:review|adversarial-review|task|cancel)(?=["'\s]|$)/

export function startsOrSettlesJob(command: string): boolean {
  return JOB_COMMAND.test(command)
}

// Jobs that settled since the previous snapshot: ones that were active then, and,
// once a baseline snapshot exists, ones that started and finished between polls.
// Stop-gate reviews run inside the Stop hook, so only announce those seen running.
export function settledSince(
  previous: readonly CodexJob[],
  next: readonly CodexJob[],
  { hasBaseline = false }: { hasBaseline?: boolean } = {},
): CodexJob[] {
  const wasActive = new Set(previous.filter(isActive).map(job => job.id))
  const wasKnown = new Set(previous.map(job => job.id))
  return next.filter(
    job =>
      !isActive(job) &&
      (wasActive.has(job.id) || (hasBaseline && !wasKnown.has(job.id) && job.kind !== 'stop-review')),
  )
}

export function statusLine(jobs: readonly CodexJob[]): string | undefined {
  const active = jobs.filter(isActive)
  const [only] = active
  if (only === undefined) {
    return undefined
  }
  if (active.length === 1) {
    const what = only.phase && only.phase !== only.status ? only.phase : only.status
    return `codex: ${only.kind} ${what}${only.elapsed ? ` ${only.elapsed}` : ''}`
  }
  return `codex: ${active.length} jobs running`
}

export function durationMs(job: CodexJob): number {
  const start = Date.parse(job.startedAt ?? '')
  const end = Date.parse(job.completedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

export function settledMessage(job: CodexJob): string {
  const label = `Codex ${job.kind}`
  if (job.status === 'completed') {
    return `${label} finished${job.elapsed ? ` in ${job.elapsed}` : ''}. /codex:result ${job.id}`
  }
  if (job.status === 'cancelled') {
    return `${label} cancelled.`
  }
  return `${label} failed${job.error ? `: ${job.error}` : ''}. /codex:status ${job.id}`
}

export function clip(value: string, width: number): string {
  if (width <= 1) return ''
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}
