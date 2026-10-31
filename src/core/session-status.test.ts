// A Live Session's status (spec §3.32 step 1): one test per row of the ordered table, the order where two rows match,
// which Pending Decisions and Messages count for which Session, and the whole listing against a fake HOME with fake
// processes. No test looks at the machine's real processes or sessions.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { listLiveSessions } from './live-sessions.ts'
import type { LiveSessionDeps, ProcessInfo } from './live-sessions-procs.ts'
import type { MessageReceipt } from './messages.ts'
import { sendMessage } from './messages.ts'
import {
  type NeedsYouReason,
  type SessionAttention,
  STATUS_RULES,
  type StatusSignals,
  type StatusTarget,
  sessionStatus,
  signalsOf,
  withStatus,
} from './session-status.ts'
import { addPendingDecision, markPendingDone, type PendingDecision } from './unattended-pending.ts'

const none: StatusSignals = { host: 'unknown', pendingDecisions: 0, messagesToApprove: 0, messagesToPaste: 0 }
const sig = (o: Partial<StatusSignals>): StatusSignals => ({ ...none, ...o })

describe('the status table, one row each', () => {
  it('lists its rows in order, ending in a row that always matches', () => {
    assert.deepEqual(
      STATUS_RULES.map((r) => (r.reason ? `${r.status}/${r.reason}` : r.status)),
      [
        'needs-you/host-waits',
        'needs-you/pending-decision',
        'needs-you/message-to-approve',
        'needs-you/message-to-paste',
        'busy',
        'idle',
        'unknown',
      ],
    )
    assert.equal(STATUS_RULES.at(-1)!.when(none), true)
  })

  it('row 1: the Host says it waits for the user', () => {
    assert.deepEqual(sessionStatus(sig({ host: 'needs-you' })), { status: 'needs-you', reason: 'host-waits' })
  })

  it('row 2: an open Pending Decision names the Session', () => {
    assert.deepEqual(sessionStatus(sig({ pendingDecisions: 1 })), {
      status: 'needs-you',
      reason: 'pending-decision',
    })
  })

  it('row 3: a Message to it waits for the user to approve it in its terminal', () => {
    assert.deepEqual(sessionStatus(sig({ messagesToApprove: 2 })), {
      status: 'needs-you',
      reason: 'message-to-approve',
    })
  })

  it('row 4: a Message to it waits to be pasted', () => {
    assert.deepEqual(sessionStatus(sig({ messagesToPaste: 1 })), {
      status: 'needs-you',
      reason: 'message-to-paste',
    })
  })

  it('row 5: the Host says it is working', () => {
    assert.deepEqual(sessionStatus(sig({ host: 'busy' })), { status: 'busy' })
  })

  it('row 6: the Host says it waits for a prompt', () => {
    assert.deepEqual(sessionStatus(sig({ host: 'idle' })), { status: 'idle' })
  })

  it('row 7: everything else is unknown', () => {
    assert.deepEqual(sessionStatus(none), { status: 'unknown' })
  })
})

describe('the status table, when two rows match the first wins', () => {
  it('the Host asking wins over a Pending Decision and Messages', () => {
    assert.equal(
      sessionStatus(sig({ host: 'needs-you', pendingDecisions: 1, messagesToApprove: 1, messagesToPaste: 1 }))
        .reason,
      'host-waits',
    )
  })

  it('a Pending Decision wins over Messages, and over a working Host', () => {
    assert.deepEqual(sessionStatus(sig({ host: 'busy', pendingDecisions: 1, messagesToPaste: 1 })), {
      status: 'needs-you',
      reason: 'pending-decision',
    })
  })

  it('a Message to approve wins over one to paste', () => {
    assert.equal(
      sessionStatus(sig({ messagesToApprove: 1, messagesToPaste: 1 })).reason,
      'message-to-approve',
    )
  })

  it('a Message to paste wins over an idle Host', () => {
    assert.deepEqual(sessionStatus(sig({ host: 'idle', messagesToPaste: 1 })), {
      status: 'needs-you',
      reason: 'message-to-paste',
    })
  })
})

const ID = '61230c3d-1111-4111-8111-111111111111'
const OTHER = '0799701d-2222-4222-8222-222222222222'
const target: StatusTarget = {
  account: 'claude:002',
  family: 'claude',
  sessionId: ID,
  status: 'idle',
  transcript: '/work/record.jsonl',
}
const decision = (o: Partial<PendingDecision>): PendingDecision => ({
  id: 'mvwjs1dw-abcdef',
  at: '2026-10-31T10:00:00.000Z',
  kind: 'question',
  family: 'claude',
  account: 'claude:002',
  sessionId: ID,
  text: 'Which branch?',
  ...o,
})
const receipt = (o: Partial<MessageReceipt>): MessageReceipt => ({
  id: '0a1b2c3d',
  to: 'cc002 · fix · 61230c3d',
  toSessionId: ID,
  toAccount: 'claude:002',
  status: 'paste-needed',
  file: '/state/messages/x.md',
  attachments: [],
  pasteText: 'Read the message',
  sentAt: '2026-10-31T10:00:00.000Z',
  ...o,
})
const kept = (o: Partial<SessionAttention>): SessionAttention => ({ decisions: [], receipts: [], ...o })

describe('what counts for a Session', () => {
  it('counts open Pending Decisions of its Family and session id, and of its Account when one is named', () => {
    const s = signalsOf(
      target,
      kept({
        decisions: [
          decision({}),
          decision({ id: 'mvwjs1dw-000001', account: undefined, kind: 'deferred' }),
          decision({ id: 'mvwjs1dw-000002', doneAt: '2026-10-31T11:00:00.000Z' }),
          decision({ id: 'mvwjs1dw-000003', account: 'claude:main' }),
          decision({ id: 'mvwjs1dw-000004', family: 'codex' }),
          decision({ id: 'mvwjs1dw-000005', sessionId: OTHER }),
          decision({ id: 'mvwjs1dw-000006', sessionId: undefined }),
        ],
      }),
    )
    assert.equal(s.pendingDecisions, 2)
  })

  it('counts Messages to its Account and session id that wait for approval or a paste, nothing else', () => {
    const s = signalsOf(
      target,
      kept({
        receipts: [
          receipt({}),
          receipt({ status: 'delivered', needsApproval: true }),
          receipt({ status: 'delivered' }),
          receipt({ status: 'read' }),
          receipt({ status: 'unknown' }),
          receipt({ status: 'stored' }),
          receipt({ toAccount: 'claude:main' }),
          receipt({ toSessionId: OTHER }),
        ],
      }),
    )
    assert.equal(s.messagesToPaste, 1)
    assert.equal(s.messagesToApprove, 1)
    assert.equal(s.host, 'idle')
  })

  it('leaves a Message to paste out where the Session has no record that would show the paste', () => {
    const { transcript: _, ...noRecord } = target
    assert.equal(signalsOf(noRecord, kept({ receipts: [receipt({})] })).messagesToPaste, 0)
  })

  it('sets reason only on needs-you, and drops one a Session no longer needs', () => {
    const list: (StatusTarget & { reason?: NeedsYouReason })[] = [
      target,
      { ...target, sessionId: OTHER, status: 'busy', reason: 'message-to-paste' },
    ]
    const [a, b] = withStatus(list, kept({ decisions: [decision({})] }))
    assert.deepEqual([a!.status, a!.reason], ['needs-you', 'pending-decision'])
    assert.equal(b!.status, 'busy')
    assert.equal('reason' in b!, false)
  })
})

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const PI_ID = '01a11fc9-6666-4666-8666-666666666666'
const proc = (pid: number, command: string): ProcessInfo => ({ pid, ppid: 1, startMs: START, command })

function fakeDeps(procs: ProcessInfo[], env: Record<number, Record<string, string>> = {}): LiveSessionDeps {
  return {
    processes: async () => procs,
    envVar: async (pid, name) => env[pid]?.[name],
    openFiles: async () => [],
  }
}

describe('listLiveSessions applies the table', () => {
  it('marks a working Session with an open Pending Decision, and a Session with a Message to paste, until each is done', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-002/settings.json', '{}')
      await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:002' } }))
      await h.write(
        '.claude-002/sessions/4102.json',
        JSON.stringify({ pid: 4102, sessionId: ID, cwd: '/work/b', status: 'busy', procStart: PROC_START }),
      )
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      const piRecord = await h.write(
        `.pi/agent/sessions/--work-p--/2026-10-09T08-31-17-282Z_${PI_ID}.jsonl`,
        `${JSON.stringify({ type: 'session', id: PI_ID, cwd: '/work/p' })}\n`,
      )
      const deps = fakeDeps([proc(4102, 'claude'), proc(800, 'node /usr/local/bin/pi')], { 800: {} })
      const rt = await createRuntime({ env: h.env })
      const stateDir = rt.readContext().stateDir
      const statusOf = async () =>
        Object.fromEntries(
          (await listLiveSessions(rt, {}, deps)).sessions.map((s) => [s.account, [s.status, s.reason]]),
        )

      assert.deepEqual(await statusOf(), {
        'claude:002': ['busy', undefined],
        'pi:main': ['unknown', undefined],
      })

      const d = await addPendingDecision(stateDir, {
        kind: 'question',
        family: 'claude',
        account: 'claude:002',
        sessionId: ID,
        text: 'Which branch should it use?',
      })
      // pi has no channel: the Message waits for the user to paste it.
      const sent = await sendMessage(
        rt,
        'pi:main',
        { text: 'look at the tests' },
        { procs: deps, selfPid: 999_999 },
      )
      assert.equal(sent.status, 'paste-needed')
      const listed = await listLiveSessions(rt, {}, deps)
      assert.deepEqual(Object.fromEntries(listed.sessions.map((s) => [s.account, [s.status, s.reason]])), {
        'claude:002': ['needs-you', 'pending-decision'],
        'pi:main': ['needs-you', 'message-to-paste'],
      })
      assert.deepEqual(listed.problems, [])

      // Marked done, and pasted (its id shows in the record): back to what the Host says.
      await markPendingDone(stateDir, d.id)
      await fsp.appendFile(piRecord, `${JSON.stringify({ type: 'user', text: sent.pasteText })}\n`)
      assert.deepEqual(await statusOf(), {
        'claude:002': ['busy', undefined],
        'pi:main': ['unknown', undefined],
      })
    })
  })
})
