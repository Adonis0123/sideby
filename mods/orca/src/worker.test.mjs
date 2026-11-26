// ADR-0088: unit tests for the Orca worker (run via `orca plugin test mods/orca`).
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.mjs'

let activeWorker

afterEach(async () => {
  if (activeWorker) {
    await activeWorker.deactivate()
    activeWorker = undefined
  }
  main.setWorkerDepsForTest(null)
})

const SAMPLE_RAW = [
  {
    account: 'agy:main',
    accountLabel: 'agy:main',
    family: 'agy',
    sessionId: '61230c3d-1111-4111-8111-111111111111',
    title: 'Fix login',
    label: 'agy:main · Fix login · 61230c3d',
    status: 'busy',
    cwd: '/work/demo-repo',
    pid: 4242,
    transcript: '/tmp/fake-transcript.jsonl',
    startedFrom: 'orca',
    orcaSessionId: 'orca-chat-1',
    guessed: false,
    reference: "agy:main's session 61230c3d (Fix login), working directory /work/demo-repo.",
    resumeCommand: 'sideby run agy:main -- --conversation 61230c3d-1111-4111-8111-111111111111',
  },
  {
    account: 'claude:work',
    accountLabel: 'claude:work',
    family: 'claude',
    sessionId: 'a4b5c6d7-2222-4222-8222-222222222222',
    title: 'Docs pass',
    label: 'claude:work · Docs pass · a4b5c6d7',
    status: 'idle',
    cwd: '/work/demo-repo',
    pid: 5151,
    startedFrom: 'orca',
    guessed: false,
    reference: "claude:work's session a4b5c6d7 (Docs pass), working directory /work/demo-repo.",
    resumeCommand: 'sideby resume claude -- --resume a4b5c6d7-2222-4222-8222-222222222222',
  },
]

test('projects only minimal panel fields and stays on session count without host focus confirmation', async () => {
  main.setWorkerDepsForTest({
    readSessions: async () => ({ sessions: [SAMPLE_RAW[0]], error: null }),
    copyText: async () => true,
    pollIntervalMs: 0,
  })
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'main',
        displayName: 'demo-repo',
        terminals: [],
      },
      'agents.list': {
        agents: [
          {
            terminalId: null,
            title: 'Fix login',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: 100,
            sessionId: SAMPLE_RAW[0].sessionId,
          },
        ],
      },
    },
  })

  activeWorker = await mountWorker(main, { host })
  const snapshot = await activeWorker.request('sessions.list')

  assert.equal(snapshot.error, null)
  assert.equal(snapshot.sessions.length, 1)
  assert.deepEqual(Object.keys(snapshot.sessions[0]).sort(), [
    'cwd',
    'guessed',
    'isCurrent',
    'label',
    'reference',
    'sessionId',
    'startedFrom',
    'status',
  ])
  assert.equal('orcaSessionId' in snapshot.sessions[0], false)
  assert.equal('transcript' in snapshot.sessions[0], false)
  assert.equal('pid' in snapshot.sessions[0], false)
  assert.equal(snapshot.sessions[0].isCurrent, false)

  const statusUpdates = host.callsOf('statusBar.update')
  assert.ok(statusUpdates.length >= 1)
  const lastUpdate = statusUpdates.at(-1)
  assert.equal(lastUpdate.id, 'current-session')
  assert.equal(lastUpdate.text, 'sideby · 1 session')
  assert.equal(lastUpdate.tone, 'neutral')
  assert.match(lastUpdate.tooltip, /sidebar panel/i)

  const focusedBar = main.buildStatusBarUpdate({
    sessions: [{ ...snapshot.sessions[0], isCurrent: true }],
    error: null,
  })
  assert.equal(focusedBar.text, 'agy:main · Fix login · 61230c3d')
  assert.equal(focusedBar.tone, 'accent')
  assert.deepEqual(activeWorker.refusals, [])
})

test('falls back to session count when no Chat matches and handles sideby errors cleanly', async () => {
  let failing = false
  main.setWorkerDepsForTest({
    readSessions: async () =>
      failing ? { sessions: [], error: 'Could not run sideby.' } : { sessions: SAMPLE_RAW, error: null },
    copyText: async () => true,
    pollIntervalMs: 0,
  })
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-2',
        branch: 'feat/other',
        displayName: 'other-repo',
        terminals: [],
      },
      'agents.list': { agents: [] },
    },
  })

  activeWorker = await mountWorker(main, { host })
  const snapshot = await activeWorker.request('sessions.list')
  assert.equal(
    snapshot.sessions.every((s) => !s.isCurrent),
    true,
  )
  const idleUpdate = host.callsOf('statusBar.update').at(-1)
  assert.equal(idleUpdate.text, 'sideby · 2 sessions')

  failing = true
  const errSnapshot = await activeWorker.request('sessions.refresh')
  assert.equal(errSnapshot.error, 'Could not run sideby.')
  const errUpdate = host.callsOf('statusBar.update').at(-1)
  assert.equal(errUpdate.text, 'sideby · unavailable')
  assert.equal(errUpdate.tone, 'warning')
  assert.deepEqual(activeWorker.refusals, [])
})

test('copies reference or id through worker and supports copy-current command', async () => {
  const copiedValues = []
  let clipboardAvailable = true
  let currentSessions = SAMPLE_RAW
  main.setWorkerDepsForTest({
    readSessions: async () => ({ sessions: currentSessions, error: null }),
    copyText: async (text) => {
      copiedValues.push(text)
      return clipboardAvailable
    },
    pollIntervalMs: 0,
  })
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'main',
        displayName: 'demo-repo',
        terminals: [],
      },
      'agents.list': {
        agents: [
          {
            terminalId: null,
            title: 'Fix login',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: 200,
            sessionId: SAMPLE_RAW[0].sessionId,
          },
        ],
      },
    },
  })

  activeWorker = await mountWorker(main, { host })
  await activeWorker.request('sessions.list')

  const copyRef = await activeWorker.request('sessions.copy', {
    sessionId: SAMPLE_RAW[0].sessionId,
    as: 'reference',
  })
  assert.equal(copyRef.ok, true)
  assert.equal(copyRef.copied, true)
  assert.equal(copiedValues[0], SAMPLE_RAW[0].reference)

  clipboardAvailable = false
  const copyId = await activeWorker.request('sessions.copy', {
    sessionId: SAMPLE_RAW[1].sessionId,
    as: 'id',
  })
  assert.equal(copyId.ok, true)
  assert.equal(copyId.copied, false)
  assert.equal(copyId.text, SAMPLE_RAW[1].sessionId)

  clipboardAvailable = true
  currentSessions = [SAMPLE_RAW[0]]
  await activeWorker.request('sessions.refresh')
  const cmdOut = await activeWorker.command('sideby-sessions.copy-current')
  assert.match(String(cmdOut), /sidebar panel/i)
  assert.equal(copiedValues.length, 2)
  assert.equal(
    main.findCurrentSessionId([SAMPLE_RAW[0]], [{ sessionId: 'orca-chat-1', state: 'done' }]),
    null,
  )
  assert.equal(
    main.findCurrentSessionId([SAMPLE_RAW[0]], [{ sessionId: 'orca-chat-1', state: 'done', focused: true }]),
    SAMPLE_RAW[0].sessionId,
  )
  assert.equal(
    main.findCurrentSessionId(SAMPLE_RAW, [{ sessionId: SAMPLE_RAW[0].sessionId, state: 'working' }]),
    null,
  )
  assert.equal(
    main.findCurrentSessionId(SAMPLE_RAW, [
      { sessionId: SAMPLE_RAW[0].sessionId, state: 'working', focused: true },
    ]),
    SAMPLE_RAW[0].sessionId,
  )
  assert.equal(
    main.findCurrentSessionId(SAMPLE_RAW, [
      { sessionId: SAMPLE_RAW[0].sessionId, state: 'working', focused: true },
      { sessionId: SAMPLE_RAW[1].sessionId, state: 'done', focused: true },
    ]),
    null,
  )
  assert.deepEqual(activeWorker.refusals, [])
})

test('does not guess current Chat when a workspace has both an active and an idle session', async () => {
  const copiedValues = []
  main.setWorkerDepsForTest({
    readSessions: async () => ({ sessions: SAMPLE_RAW, error: null }),
    copyText: async (text) => {
      copiedValues.push(text)
      return true
    },
    pollIntervalMs: 0,
  })
  const host = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'main',
        displayName: 'demo-repo',
        terminals: [],
      },
      'agents.list': {
        agents: [
          {
            terminalId: null,
            title: 'Fix login',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: 200,
            sessionId: SAMPLE_RAW[0].sessionId,
          },
          {
            terminalId: null,
            title: 'Docs pass',
            agent: 'claude',
            state: 'done',
            stateStartedAt: 100,
            sessionId: SAMPLE_RAW[1].sessionId,
          },
        ],
      },
    },
  })

  activeWorker = await mountWorker(main, { host })
  const snapshot = await activeWorker.request('sessions.list')
  assert.equal(
    snapshot.sessions.every((s) => !s.isCurrent),
    true,
  )
  const bar = host.callsOf('statusBar.update').at(-1)
  assert.equal(bar.text, 'sideby · 2 sessions')
  assert.match(bar.tooltip, /sidebar panel/i)

  await activeWorker.emit('agent.status.changed', {
    workspaceId: 'ws-1',
    paneKey: 'tab-1:pane-1',
    state: 'working',
    receivedAt: 1000,
    sessionId: SAMPLE_RAW[0].sessionId,
  })
  assert.equal(host.callsOf('statusBar.update').at(-1).text, 'sideby · 2 sessions')

  const cmdOut = await activeWorker.command('sideby-sessions.copy-current')
  assert.match(String(cmdOut), /sidebar panel/i)
  assert.deepEqual(copiedValues, [])

  host.respond('workspace.readContext', {
    workspaceId: 'ws-9',
    branch: 'main',
    displayName: 'other',
    terminals: [],
  })
  host.respond('agents.list', {
    agents: [
      {
        terminalId: null,
        title: 'Fix login',
        agent: 'antigravity',
        state: 'working',
        stateStartedAt: 300,
        sessionId: SAMPLE_RAW[0].sessionId,
      },
    ],
  })
  await activeWorker.emit('workspace.changed', {
    context: {
      workspaceId: 'ws-9',
      branch: 'main',
      displayName: 'other',
      terminals: [],
    },
  })
  // WHY: even if agents.list reports only A while B is also live without host focus confirmation,
  // status bar stays at session count rather than risking copying A while the user views B (ADR-0088).
  assert.equal(host.callsOf('statusBar.update').at(-1).text, 'sideby · 2 sessions')
  const stillNoCopy = await activeWorker.command('sideby-sessions.copy-current')
  assert.match(String(stillNoCopy), /sidebar panel/i)
  assert.deepEqual(copiedValues, [])
  assert.deepEqual(activeWorker.refusals, [])
})
