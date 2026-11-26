// ADR-0088: component tests for the sideby Sessions Orca panel (run via `orca plugin test mods/orca`).
import { afterEach, assert, mockHost, mount, type TestPanel, test } from 'orca/testing'
import * as panelModule from './panel'

let panel: TestPanel | undefined

afterEach(async () => {
  await panel?.unmount()
  panel = undefined
})

const SESSIONS = [
  {
    label: 'agy:main · Fix login · 61230c3d',
    sessionId: '61230c3d-1111-4111-8111-111111111111',
    reference: "agy:main's session 61230c3d (Fix login), working directory /work/demo-repo.",
    status: 'busy',
    cwd: '/work/demo-repo',
    startedFrom: 'orca',
    guessed: false,
    isCurrent: true,
  },
  {
    label: 'codex:main · Lint pass · 99887766',
    sessionId: '99887766-3333-4333-8333-333333333333',
    reference: "codex:main's session 99887766 (Lint pass) (its newest session, a guess).",
    status: 'needs-you',
    cwd: '/work/other-repo',
    guessed: true,
    isCurrent: false,
  },
]

test('shows empty state cleanly when no sessions are running', async () => {
  const host = mockHost({
    requests: {
      'sessions.list': () => ({ sessions: [], error: null, updatedAt: 1_700_000_000_000 }),
    },
  })
  panel = await mount(panelModule, { host })

  assert.equal(panel.find({ type: 'EmptyState' })?.props.title, 'No running sessions')
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('renders sessions, copies reference and id, and falls back when clipboard is unavailable', async () => {
  const calls: Array<{ sessionId: string; as: string }> = []
  const host = mockHost({
    requests: {
      'sessions.list': () => ({ sessions: SESSIONS, error: null, updatedAt: 1_700_000_000_000 }),
      'sessions.copy': (input) => {
        const req = input as { sessionId: string; as: 'reference' | 'id' }
        calls.push(req)
        if (req.as === 'reference') {
          return {
            ok: true,
            copied: true,
            text: SESSIONS[0].reference,
            label: SESSIONS[0].label,
            as: 'reference',
          }
        }
        return {
          ok: true,
          copied: false,
          text: SESSIONS[0].sessionId,
          label: SESSIONS[0].label,
          as: 'id',
        }
      },
    },
  })

  panel = await mount(panelModule, { host })

  assert.ok(panel.find({ text: 'agy:main · Fix login · 61230c3d' }))
  assert.ok(panel.find({ text: 'This chat' }))
  assert.ok(panel.find({ text: 'Orca' }))
  assert.ok(panel.find({ text: 'Guessed' }))
  assert.ok(panel.find({ text: 'Needs you' }))

  const copyRefButtons = panel.findAll({ role: 'button', text: 'Copy for AI' })
  assert.equal(copyRefButtons.length, 2)
  await panel.press(copyRefButtons[0])
  assert.deepEqual(calls[0], { sessionId: SESSIONS[0].sessionId, as: 'reference' })
  assert.equal(panel.find({ type: 'Callout' })?.props.title, 'Copied for AI')

  const copyIdButtons = panel.findAll({ role: 'button', text: 'Copy session id' })
  await panel.press(copyIdButtons[0])
  assert.deepEqual(calls[1], { sessionId: SESSIONS[0].sessionId, as: 'id' })
  assert.equal(panel.find({ type: 'Callout' })?.props.title, 'Copy manually (no clipboard tool found)')
  assert.ok(panel.find({ text: SESSIONS[0].sessionId }))

  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('renders error callout and updates when worker posts sessions.updated', async () => {
  const host = mockHost({
    requests: {
      'sessions.list': () => ({
        sessions: [],
        error: 'Could not run sideby.',
        updatedAt: 1_700_000_000_000,
      }),
    },
  })

  panel = await mount(panelModule, { host })
  assert.equal(panel.find({ type: 'Callout' })?.props.title, 'Could not read sideby sessions')
  assert.ok(panel.find({ text: 'Could not run sideby.' }))

  await panel.post('sessions.updated', {
    sessions: [SESSIONS[0]],
    error: null,
    updatedAt: 1_700_000_005_000,
  })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.ok(panel.find({ text: 'agy:main · Fix login · 61230c3d' }))
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})
