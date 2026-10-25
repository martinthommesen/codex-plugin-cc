// Live Codex activity inside Claude Code: a status line entry while Codex
// works, a toast (and, for long jobs, a native notification) when a job
// settles, and a `/codex-jobs` pane to inspect, cancel and reopen jobs.
//
// The companion script stays the single source of truth: this module only
// runs `codex-companion.mjs status --json` and draws what it reports.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { CodexJob } from '../types'
import {
  clip,
  durationMs,
  isActive,
  parseStatusSnapshot,
  settledMessage,
  settledSince,
  statusLine,
} from './jobs'

const PANE = 'codex-jobs'
const POLL_MS = 4_000
// A background launch registers its job a moment after the Bash call
// returns, so keep polling for a while after any companion call.
const LAUNCH_GRACE_MS = 30_000
const NOTIFY_AFTER_MS = 30_000

// Change the tag when CodexJob's fields change: a value stored by an earlier
// version outlives a reload and is then read as empty.
const jobs = atom({ plugin: 'codex', key: 'jobs' } as const, [], { shape: 'jobs-1' })

const GLYPH: Record<CodexJob['status'], string> = {
  queued: '…',
  running: '●',
  completed: '✓',
  failed: '✗',
  cancelled: '○',
}

const COLOR: Record<CodexJob['status'], 'warning' | 'success' | 'error' | 'inactive'> = {
  queued: 'warning',
  running: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'inactive',
}

type Timer = { cancel: () => void }

// Module state: a reload starts it over, and session.start polls again.
let isNotifying = true
let poller: Timer | null = null
let armedUntil = 0
let refreshing: Promise<void> | null = null
let hasFailed = false
let hasJobs = false

function companion($: EngineInterface, sessionId: string, args: string[]) {
  return $.process.run(['node', `${$.plugin.root}/scripts/codex-companion.mjs`, ...args], {
    env: { CODEX_COMPANION_SESSION_ID: sessionId },
    timeoutMs: 20_000,
  })
}

async function announce($: EngineInterface, job: CodexJob) {
  const message = settledMessage(job)
  $.ui.toast(message, { timeoutMs: 8_000 })
  if (isNotifying && job.status !== 'cancelled' && durationMs(job) >= NOTIFY_AFTER_MS) {
    await $.ui.notify(message, { title: 'Codex' }).catch(() => undefined)
  }
}

async function schedule($: EngineInterface, list: readonly CodexJob[]) {
  const isWanted = list.some(isActive) || (await $.clock.now()) < armedUntil
  if (isWanted && poller === null) {
    poller = $.clock.every(POLL_MS, () => void refresh($))
  } else if (!isWanted && poller !== null) {
    poller.cancel()
    poller = null
  }
}

function refresh($: EngineInterface): Promise<void> {
  refreshing ??= poll($).finally(() => {
    refreshing = null
  })
  return refreshing
}

async function poll($: EngineInterface) {
  try {
    const sessionId = await $.session.id()
    const ran = await companion($, sessionId, ['status', '--json', '--all'])
    if (ran.exitCode !== 0) {
      throw new Error(ran.stderr.trim() || `status exited ${ran.exitCode}`)
    }
    const next = parseStatusSnapshot(ran.stdout)
    let previous: readonly CodexJob[] = []
    await update($, jobs, list => {
      previous = list
      return next
    })
    hasFailed = false
    hasJobs = next.length > 0
    $.ui.status(statusLine(next))
    for (const job of settledSince(previous, next)) {
      await announce($, job)
    }
    await schedule($, next)
  } catch (error) {
    // Said once per failure streak; the next companion call retries.
    if (!hasFailed) {
      const reason = error instanceof Error ? error.message : String(error)
      $.ui.log(`codex: live status unavailable: ${reason}`, { to: 'debug' })
    }
    hasFailed = true
    poller?.cancel()
    poller = null
  }
}

async function arm($: EngineInterface) {
  armedUntil = (await $.clock.now()) + LAUNCH_GRACE_MS
  await refresh($)
}

async function cancel($: EngineInterface, job: CodexJob) {
  const ran = await companion($, await $.session.id(), ['cancel', job.id, '--json'])
  if (ran.exitCode !== 0) {
    $.ui.toast(`Could not cancel ${job.id}: ${ran.stderr.trim() || 'unknown error'}`)
  }
  await refresh($)
}

async function showResult($: EngineInterface, job: CodexJob) {
  try {
    await $.command.run({ command: 'codex:result', args: job.id })
  } catch {
    await $.prompt.fill({ text: `/codex:result ${job.id}`, mode: 'replace' })
  }
}

async function copyResume($: EngineInterface, job: CodexJob, surface: RenderSurface) {
  if (!job.threadId) return
  const copied = await $.ui.copy({ text: `codex resume ${job.threadId}`, surface })
  $.ui.toast(copied.isCopied ? 'Copied the codex resume command.' : `codex resume ${job.threadId}`)
}

export const register: Register = (on, options) => {
  isNotifying = options.systemNotifications !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex-jobs',
      description: 'Show Codex jobs for this session in a live pane',
    })
    const started = await next(e)
    if (e.isInteractive || e.surface !== null) {
      void refresh($)
    }
    return started
  })

  on('command.run', { command: 'codex-jobs' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Codex jobs' })
    return {
      text: opened.isPlaced
        ? 'Codex jobs pane opened.'
        : 'The Codex jobs pane will appear when there is room. Use /codex:status meanwhile.',
    }
  })

  // Any companion call (a review, a rescue's forwarder, a status check) may
  // start or settle a job: poll while it runs and briefly after.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.command.includes('codex-companion.mjs')) {
      return next(e)
    }
    void arm($)
    const ran = await next(e)
    void arm($)
    return ran
  }).catch(($, e, next) => next(e))

  // A safety net for launches the Bash hook cannot see: one check per turn,
  // only in sessions that have used Codex.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (hasJobs && poller === null) {
      void refresh($)
    }
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, jobs)
    const width = Math.max(20, e.props.bodyColumns)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No Codex jobs in this session yet.</Text>
          <Text dimColor>Try /codex:review --background or /codex:rescue.</Text>
        </Box>
      )
    }

    const active = list.filter(isActive).length
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{active > 0 ? `${active} running` : 'Idle'}</Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
        </Box>
        {list.map(job => {
          const state = isActive(job) && job.phase ? job.phase : job.status
          const meta = [job.id, state, job.elapsed].filter(Boolean).join(' · ')
          const detail = job.error ?? (job.summary || job.title)
          return (
            <Box key={`job:${job.id}`} flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                <Text color={COLOR[job.status]}>{GLYPH[job.status]}</Text> <Text bold>{job.kind}</Text>{' '}
                <Text dimColor>{meta}</Text>
              </Text>
              {detail ? <Text dimColor wrap="truncate-end">{clip(detail, width * 2)}</Text> : null}
              {isActive(job)
                ? job.progress.map(line => <Text dimColor wrap="truncate-end">{`  ${line}`}</Text>)
                : null}
              <Box flexDirection="row" gap={1}>
                {isActive(job) ? (
                  <Button key={`cancel:${job.id}`} label="Cancel" onPress={() => void cancel($, job)} />
                ) : (
                  <Button key={`result:${job.id}`} label="Result" onPress={() => void showResult($, job)} />
                )}
                {job.threadId ? (
                  <Button
                    key={`resume:${job.id}`}
                    label="Copy resume"
                    onPress={press => void copyResume($, job, press.surface)}
                  />
                ) : null}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
