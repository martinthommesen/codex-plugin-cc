import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'codex',
  component: 'Pane',
  requestId: 'codex-jobs',
  props: {
    title: 'Codex jobs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const COMPANION = 'node "/plugin/scripts/codex-companion.mjs" review --background'

const running = {
  id: 'review-abc',
  kind: 'review',
  kindLabel: 'review',
  title: 'Codex review',
  status: 'running',
  phase: 'reviewing',
  elapsed: '12s',
  threadId: 'thr-1',
  startedAt: '2026-10-25T10:00:00.000Z',
  progressPreview: ['Reading src/app.ts'],
}

const completed = {
  ...running,
  status: 'completed',
  phase: 'done',
  duration: '1m 5s',
  summary: 'No material issues found.',
  completedAt: '2026-10-25T10:01:05.000Z',
  progressPreview: [],
}

function snapshot(jobs: Array<Record<string, unknown>>) {
  const active = jobs.filter(job => job.status === 'running' || job.status === 'queued')
  const finished = jobs.filter(job => !active.includes(job))
  return JSON.stringify({ running: active, latestFinished: finished[0] ?? null, recent: finished.slice(1) })
}

// Stands for the engine and the companion beneath the plugin.
function world(on: On) {
  const seen = {
    stdout: snapshot([]),
    exitCode: 0,
    argv: [] as string[][],
    env: [] as Array<Record<string, string> | undefined>,
    toasts: [] as string[],
    statuses: [] as Array<string | undefined>,
    notices: [] as string[],
  }
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    seen.argv.push([...e.argv])
    seen.env.push(e.init?.env)
    return { value: { exitCode: seen.exitCode, stdout: seen.stdout, stderr: seen.exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    seen.notices.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  return seen
}

test('a companion run shows in the status line and announces when it settles', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  seen.stdout = snapshot([running])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()

  expect(seen.argv[0]?.slice(-3)).toEqual(['status', '--json', '--all'])
  expect(seen.env[0]).toEqual({ CODEX_COMPANION_SESSION_ID: 'sess-1' })
  expect(seen.statuses.at(-1)).toBe('codex: review reviewing 12s')

  seen.stdout = snapshot([completed])
  await clock.advance(4_000)

  expect(seen.statuses.at(-1)).toBeUndefined()
  expect(seen.toasts).toEqual(['Codex review finished in 1m 5s. /codex:result review-abc'])
  expect(seen.notices).toEqual(['Codex review finished in 1m 5s. /codex:result review-abc'])

  // Settled jobs are announced once; polling stops after the launch window.
  await clock.advance(60_000)
  const calls = seen.argv.length
  await clock.advance(60_000)
  expect(seen.toasts.length).toBe(1)
  expect(seen.argv.length).toBe(calls)
})

test('a failed status poll keeps watching a running job', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  seen.stdout = snapshot([running])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()
  expect(seen.statuses.at(-1)).toBe('codex: review reviewing 12s')

  // Past the launch window, so only the running job keeps the poller alive.
  seen.exitCode = 1
  await clock.advance(40_000)
  expect(seen.statuses.at(-1)).toBeUndefined()

  seen.exitCode = 0
  seen.stdout = snapshot([completed])
  await clock.advance(4_000)
  expect(seen.toasts).toEqual(['Codex review finished in 1m 5s. /codex:result review-abc'])
})

test('a job that starts and finishes between polls is still announced', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  seen.stdout = snapshot([])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()

  seen.stdout = snapshot([completed])
  await clock.advance(4_000)
  expect(seen.toasts).toEqual(['Codex review finished in 1m 5s. /codex:result review-abc'])

  await clock.advance(4_000)
  expect(seen.toasts.length).toBe(1)
})

test('history in the first snapshot is not announced', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  seen.stdout = snapshot([completed])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.advance(10_000)
  expect(seen.toasts).toEqual([])
})

test('system notifications follow the plugin option', { options: { systemNotifications: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  seen.stdout = snapshot([running])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()
  seen.stdout = snapshot([completed])
  await clock.advance(4_000)

  expect(seen.toasts.length).toBe(1)
  expect(seen.notices).toEqual([])
})

test('other Bash calls do not run the companion', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.advance(10_000)

  expect(seen.argv).toEqual([])
})

test('read-only companion calls do not start the launch window', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)

  await $.tool.call({ tool: 'Bash', command: 'node "/plugin/scripts/codex-companion.mjs" status "" ' })
  await clock.advance(60_000)

  // No jobs seen yet, so a status call does not poll at all.
  expect(seen.argv).toEqual([])
})

test('the pane lists jobs with their actions, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  seen.stdout = snapshot([
    running,
    { ...completed, id: 'task-xyz', kind: 'task', kindLabel: 'rescue', threadId: 'thr-2' },
    { ...completed, id: 'task-old', kind: 'task', kindLabel: 'rescue', threadId: null },
  ])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 running/ }))?.text).toBe('1 running')
    expect(await ui.find({ key: 'cancel:review-abc' })).toBeDefined()
    // Review threads are ephemeral: nothing to resume.
    expect(await ui.find({ key: 'resume:review-abc' })).toBeUndefined()
    expect(await ui.find({ key: 'result:task-xyz' })).toBeDefined()
    expect(await ui.find({ key: 'resume:task-xyz' })).toBeDefined()
    expect(await ui.find({ key: 'resume:task-old' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'cancel:review-abc' })
  expect(seen.argv.some(argv => argv.includes('cancel') && argv.includes('review-abc'))).toBe(true)
  await ui.unmount()
})

test('the pane explains itself before any job runs', async ($, on) => {
  world(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No Codex jobs/ }))?.text).toBe('No Codex jobs in this session yet.')
    await ui.unmount()
  }
})

const TURN = {
  answer: 'ok',
  durationMs: 1_000,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
  category: null,
  explanation: null,
} as const

test('a finished turn checks again only once the session has Codex jobs', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete(TURN)
  await clock.settle()
  expect(seen.argv).toEqual([])

  seen.stdout = snapshot([completed])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  // Past the launch window the poller is idle.
  await clock.advance(60_000)
  const calls = seen.argv.length

  await $.turn.complete(TURN)
  await clock.settle()
  expect(seen.argv.length).toBe(calls + 1)
})

test('Result runs /codex:result, or drafts it when the command cannot run', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  const commands: string[] = []
  const drafts: string[] = []
  let isRunnable = true
  on('command.run', (_, e) => {
    if (!isRunnable) throw new Error('unknown command')
    commands.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  on('prompt.fill', (_, e) => {
    drafts.push(e.text)
    return { isFilled: true }
  })
  seen.stdout = snapshot([completed])
  await $.tool.call({ tool: 'Bash', command: COMPANION })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'result:review-abc' })
  expect(commands).toEqual(['codex:result review-abc'])

  isRunnable = false
  await ui.press({ key: 'result:review-abc' })
  expect(drafts).toEqual(['/codex:result review-abc'])
  await ui.unmount()
})
