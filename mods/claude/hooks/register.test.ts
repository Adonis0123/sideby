// Run with `claude plugin test mods/claude`. Each `on` hook below stands for the engine, and `sideby` is faked
// through `process.run`.
import { expect, test } from 'claude-code/testing'

const ID = '61230c3d-0000-4000-8000-000000000000'
const OTHER = '9a8b7c6d-0000-4000-8000-000000000000'
const SESSIONS = {
  schemaVersion: 1,
  sessions: [
    {
      account: 'claude:work',
      family: 'claude',
      sessionId: ID,
      label: 'work · knip cleanup · 61230c3d',
      status: 'busy',
      cwd: '/demo/me/app',
      startedAt: '2026-10-20T09:00:00.000Z',
      updatedAt: '2026-10-20T09:00:00.000Z',
      guessed: false,
      reference: "work's session 61230c3d (knip cleanup)",
    },
    {
      account: 'claude:main',
      family: 'claude',
      sessionId: OTHER,
      label: 'main · docs · 9a8b7c6d',
      status: 'needs-you',
      cwd: '/demo/me/docs',
      startedAt: '2026-10-20T09:00:00.000Z',
      updatedAt: '2026-10-20T09:00:00.000Z',
      guessed: false,
      reference: "main's session 9a8b7c6d (docs)",
      run: {
        title: 'Docs pass',
        board: '/demo/state/boards/docs.html',
        url: 'file:///demo/state/boards/docs.html',
      },
    },
  ],
  problems: [],
}

const BAND = {
  plugin: 'sideby',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4 },
} as const
const PANE = {
  plugin: 'sideby',
  component: 'Pane',
  requestId: 'sideby-sessions',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type On = Parameters<Parameters<typeof test>[1]>[1]

/** The engine for these tests: `env` is the process environment, `sideby` answers `sideby sessions`. */
function engine(
  on: On,
  env: Record<string, string>,
  sideby: { exitCode: number; stdout: string } | 'missing' | (() => { exitCode: number; stdout: string }),
) {
  const seen = {
    toasts: [] as string[],
    copied: [] as string[],
    runs: [] as string[][],
    open: false,
    now: Date.parse('2026-10-20T09:05:00.000Z'),
  }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: ID }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => {
    seen.open = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: seen.open
      ? [{ id: 'sideby-sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('process.run', (_, e) => {
    seen.runs.push([...e.argv])
    if (sideby === 'missing') throw new Error('spawn sideby ENOENT')
    const answer = typeof sideby === 'function' ? sideby() : sideby
    return { value: { ...answer, stderr: '' } }
  })
  on('clock.now', () => ({ value: seen.now }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return seen
}

const SIDEBY_ENV = {
  SIDEBY_ACCOUNT: 'claude:work',
  SIDEBY_LABEL: 'work',
  HOME: '/demo/me',
  LANG: 'en_US.UTF-8',
}
const ANSWER = { exitCode: 0, stdout: JSON.stringify(SESSIONS) }
/** Lets the band's look, which a turn starts without waiting for it, finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('the band shows the Session Label of a session sideby started', async ($, on) => {
  const seen = engine(on, SIDEBY_ENV, ANSWER)
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /work/ }))?.text).toBe('work · knip cleanup · 61230c3d')
    await ui.unmount()
  }
  expect(seen.runs[0]).toEqual(['sideby', 'sessions', 'claude:work', '--json'])

  // Once two looks bring the same label, the band asks only every 5 minutes, not after every turn.
  const asked = seen.runs.length
  const turnAfter = async (ms: number) => {
    seen.now += ms
    await $.turn.complete(TURN)
    await settle()
  }
  await turnAfter(60_000)
  expect(seen.runs.length).toBe(asked + 1)
  await turnAfter(60_000)
  await turnAfter(60_000)
  expect(seen.runs.length).toBe(asked + 1)
  await turnAfter(5 * 60_000)
  expect(seen.runs.length).toBe(asked + 2)
})

test('the band keeps looking every 30 s while the label still changes', async ($, on) => {
  // The folder name first, then the title Claude Code gives after the first turn.
  const answers = ['work · app · 61230c3d', 'work · knip cleanup · 61230c3d']
  const seen = engine(on, SIDEBY_ENV, () => {
    const row = { ...SESSIONS.sessions[0], label: answers.shift() ?? 'work · knip cleanup · 61230c3d' }
    return { exitCode: 0, stdout: JSON.stringify({ ...SESSIONS, sessions: [row] }) }
  })
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })
  await settle()
  for (let i = 0; i < 3; i++) {
    seen.now += 31_000
    await $.turn.complete(TURN)
    await settle()
  }
  // The folder name at the start did not settle the band: the first two turns still looked, and the title held on the
  // second, so the third turn waits for the slow pace.
  expect(seen.runs.length).toBe(3)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /work/ }))?.text).toBe('work · knip cleanup · 61230c3d')
  await ui.unmount()
})

test('the band keeps the short label when sideby does not answer', async ($, on) => {
  engine(on, SIDEBY_ENV, 'missing')
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /work/ }))?.text).toBe('work · 61230c3d')
  await ui.unmount()
})

test('a session sideby did not start gets no band', async ($, on) => {
  engine(on, { HOME: '/demo/me' }, ANSWER)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'engine')
  })
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /work/ })).toBeUndefined()
  await ui.unmount()
})

test('an arriving sideby Message raises a toast and goes on unchanged', async ($, on) => {
  const seen = engine(on, { ...SIDEBY_ENV, LANG: 'zh_CN.UTF-8' }, ANSWER)
  const delivered: string[] = []
  on('session.receive', (_, e) => {
    delivered.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })

  const text = 'sideby message m1 from main · docs · 9a8b7c6d\nPlease review the plan.'
  await $.session.receive({ origin: { kind: 'peer' }, text })
  await $.session.receive({ origin: { kind: 'peer' }, text: 'an ordinary note' })
  // The same line relayed from elsewhere is not a sideby Message.
  await $.session.receive({ origin: { kind: 'unclassified' }, text })

  expect(seen.toasts).toEqual(['main · docs · 9a8b7c6d 发来一条消息'])
  expect(delivered).toEqual([text, 'an ordinary note', text])
})

test('/sessions opens a pane that copies a session for another AI', async ($, on) => {
  const seen = engine(on, SIDEBY_ENV, ANSWER)
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'sessions' })
  expect(ran.text).toBe('Sessions pane opened.')
  expect(seen.open).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /knip/ }))?.text).toBe(
      '● work · knip cleanup · 61230c3d (this session)',
    )
    expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toMatch(
      /^ {2}needs you · ~\/docs · .* · task: Docs pass$/,
    )
    await ui.press({ key: `ref-${OTHER}` })
    await ui.unmount()
  }
  expect(seen.copied).toEqual(["main's session 9a8b7c6d (docs)", "main's session 9a8b7c6d (docs)"])
})

test('the pane says what to do when sideby fails', async ($, on) => {
  engine(on, SIDEBY_ENV, {
    exitCode: 1,
    stdout: JSON.stringify({ schemaVersion: 1, error: 'Config is broken: fix it' }),
  })
  await $.session.start({ cwd: '/demo/me/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sessions' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /broken/ }))?.text).toBe('Config is broken: fix it')
  await ui.unmount()
})
