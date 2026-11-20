// Pending Decisions by Project, and whether the user wrote in the session afterwards (spec §3.37 "按项目看",
// ADR-0078): the Project of each folder (a worktree, also a deleted one, folds into its repository), what counts as
// the user's reply in a Claude or Codex session record (sideby's and Claude Code's own lines do not), and that only
// times are kept and no Host file is written.
import assert from 'node:assert/strict'
import { readFile, utimes } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import {
  endTurnMessage,
  firstPrompt,
  idleThresholdMessage,
  prepareMessage,
  sessionStartMessage,
  stopMessage,
  thresholdMessage,
  waitNotice,
} from '../handoff/messages.ts'
import { reminderMessage } from '../progress/hook.ts'
import type { Account } from '../types.ts'
import { permissionReason, questionReason, stopReason } from '../unattended/hook.ts'
import { memoCachePath, memoStore, resetMemoStores } from './memo-store.ts'
import { pendingOverview, pendingProjectsNamed, typedReply } from './unattended-followup.ts'
import { addPendingDecision, markPendingDone, type PendingDecision } from './unattended-pending.ts'
import { retryMessage } from './unattended-retry.ts'

// A day ago, so every record written by the test is later than its decisions.
const T0 = Math.floor(Date.now() / 60_000) * 60_000 - 24 * 60 * 60_000
const min = (n: number) => new Date(T0 + n * 60_000)
const iso = (n: number) => min(n).toISOString()

const account = (h: FakeHome, family: string, name: string): Account => ({
  family,
  name,
  ref: `${family}:${name}`,
  dir: h.path(name === 'main' ? `.${family}` : `.${family}-${name}`),
  isMain: name === 'main',
  kind: 'subscription',
})

const jsonl = (recs: object[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

/** A `user` line of a Claude Code session record, as a person typed it unless `extra` says otherwise. */
const user = (sid: string, at: number, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  sessionId: sid,
  timestamp: iso(at),
  origin: { kind: 'human' },
  message: { role: 'user', content },
  ...extra,
})
const assistant = (sid: string, at: number, text: string) => ({
  type: 'assistant',
  sessionId: sid,
  timestamp: iso(at),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

const S1 = '5e550001-0000-4000-8000-000000000001'
const S2 = '5e550002-0000-4000-8000-000000000002'
const S3 = '5e550003-0000-4000-8000-000000000003'
const S4 = '5e550004-0000-4000-8000-000000000004'
const S6 = '5e550006-0000-4000-8000-000000000006'
const CODEX = '5e550005-0000-4000-8000-000000000005'
const REPLY = 'Go with the recommendation and ship it.'

describe('Pending Decisions by Project, with replies in the session (ADR-0078)', () => {
  it('counts only what the user typed after a decision, never sideby’s or Claude Code’s own lines', async () => {
    await withFakeHome(async (h) => {
      resetMemoStores()
      const state = h.path('.local/state/sideby')
      const work = account(h, 'claude', 'work')
      const main = account(h, 'claude', 'main')
      const codex = account(h, 'codex', 'main')
      await h.mkdir('code/shop/.git')
      await h.write(
        `.claude-work/projects/-code-shop/${S1}.jsonl`,
        jsonl([
          // Typed before the first decision: not a reply to it.
          user(S1, -10, 'Get the checkout ready.'),
          assistant(S1, -5, 'Ship tonight or wait?'),
          // sideby's own `Stop` reason, kept by Claude Code as meta.
          user(
            S1,
            1,
            "Stop hook feedback: Nobody is here to answer: sideby's Unattended Mode is on until 08:00.",
            {
              isMeta: true,
              origin: undefined,
            },
          ),
          // A background hook's wake-up (Turn Retry, Answer Wait, a Progress Reminder).
          user(S1, 2, '<task-notification><summary>Stop hook feedback</summary></task-notification>', {
            origin: { kind: 'task-notification' },
          }),
          // A tool's result.
          user(S1, 3, [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }], {
            toolUseResult: { stdout: 'done' },
            origin: undefined,
          }),
          // A compaction summary, flagged, and as an older Claude Code wrote it without the flag.
          user(
            S1,
            4,
            'This session is being continued from a previous conversation that ran out of context.',
            {
              isCompactSummary: true,
              isVisibleInTranscriptOnly: true,
            },
          ),
          user(S1, 4.5, 'This session is being continued from a previous conversation.', {
            origin: undefined,
          }),
          // A slash command, a Message `sideby send` delivered, a subagent's line and sideby's note as plain text.
          user(S1, 5, '<command-name>/compact</command-name><command-args></command-args>'),
          user(S1, 6, 'From the build session: tests pass (sideby message 1a2b3c4d)', {
            origin: { kind: 'peer' },
          }),
          user(S1, 6.5, 'A subagent prompt.', { isSidechain: true }),
          user(
            S1,
            7,
            "Nobody is here to answer: sideby's Unattended Mode is on until 08:00, and sideby kept it.",
          ),
          // The user's reply, then another message.
          user(S1, 8, REPLY),
          assistant(S1, 8.2, 'Shipping.'),
          user(S1, 9, [{ type: 'text', text: 'Also tag the release.' }]),
        ]),
      )
      // After its decision only sideby's and Claude Code's own lines.
      await h.write(
        `.claude/projects/-code-shop/${S2}.jsonl`,
        jsonl([
          user(S2, -3, 'Clean up the old branches.'),
          user(S2, 2, "Stop hook feedback: Nobody is here to answer: sideby's Unattended Mode is on.", {
            isMeta: true,
          }),
          user(S2, 3, '<task-notification>sideby progress reminder: you are waiting</task-notification>', {
            origin: { kind: 'task-notification' },
          }),
        ]),
      )
      await h.write(
        `.codex/sessions/2026/11/16/rollout-2026-11-16T01-00-00-${CODEX}.jsonl`,
        jsonl([
          { timestamp: iso(-2), type: 'session_meta', payload: { id: CODEX, cwd: h.path('code/shop') } },
          {
            timestamp: iso(4),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Yes, do it.' }],
            },
          },
        ]),
      )
      const cwd = h.path('code/shop')
      const add = (
        at: number,
        d: Omit<PendingDecision, 'id' | 'at' | 'kind' | 'text'>,
        text = 'Which one?',
      ) => addPendingDecision(state, { kind: 'question', text, cwd, ...d }, min(at))
      const d1 = await add(0, { family: 'claude', account: 'claude:work', sessionId: S1 })
      const d2 = await add(8.5, { family: 'claude', account: 'claude:work', sessionId: S1 })
      const d3 = await add(10, { family: 'claude', account: 'claude:work', sessionId: S1 })
      // Kept by another Account than the one that holds the record: still found.
      const d4 = await add(1, { family: 'claude', account: 'claude:work', sessionId: S2 })
      const d5 = await add(1, { family: 'claude', account: 'claude:main', sessionId: S3 })
      const d6 = await add(1, { family: 'grok', account: 'grok:main', sessionId: S3 })
      const d7 = await add(1, { family: 'codex', account: 'codex:main', sessionId: CODEX })
      const d8 = await add(1, { family: 'claude', account: 'claude:main', sessionId: '../../x' })
      const d9 = await add(0.5, { family: 'claude', account: 'claude:work', sessionId: S1 })
      await markPendingDone(state, d9.id, min(30))

      const decisions = [d1, d2, d3, d4, d5, d6, d7, d8, { ...d9, doneAt: iso(30) }]
      const hosts = ['.claude', '.claude-work', '.codex']
      const before = await Promise.all(hosts.map((d) => snapshot(h.path(d))))
      const { rows, projects } = await pendingOverview({
        decisions,
        accounts: [main, work, codex],
        stateDir: state,
      })
      const by = (d: PendingDecision) => rows.find((r) => r.id === d.id)!
      assert.deepEqual(
        rows.map((r) => r.id),
        decisions.map((d) => d.id),
      )
      assert.equal(by(d1).state, 'replied')
      assert.equal(by(d1).repliedAt, iso(8))
      assert.equal(by(d2).repliedAt, iso(9))
      assert.equal(by(d3).state, 'open')
      assert.equal(by(d3).replyCheck, undefined)
      assert.equal(by(d4).state, 'open')
      assert.equal(by(d4).replyCheck, undefined)
      assert.deepEqual([by(d5).state, by(d5).replyCheck], ['open', 'no-record'])
      assert.deepEqual([by(d6).state, by(d6).replyCheck], ['open', 'unsupported'])
      assert.deepEqual([by(d7).state, by(d7).repliedAt], ['replied', iso(4)])
      // An id that is not plain is never put into a path.
      assert.deepEqual([by(d8).state, by(d8).replyCheck], ['open', 'no-record'])
      assert.equal(by(d9).state, 'done')
      assert.equal(by(d9).repliedAt, undefined)
      assert.deepEqual(projects, [
        { project: h.path('code/shop'), projectName: 'shop', open: 5, replied: 3, done: 1 },
      ])
      // Read only, and only times are kept: nothing of the records' text in the rows or the memo cache.
      const after = await Promise.all(hosts.map((d) => snapshot(h.path(d))))
      for (const [i, b] of before.entries()) assert.deepEqual(diffSnapshots(b, after[i]!), [])
      assert.ok(!JSON.stringify(rows).includes(REPLY))
      await memoStore(state).save()
      const cache = await readFile(memoCachePath(state), 'utf8')
      assert.ok(cache.includes('pending-replies'))
      assert.ok(!cache.includes(REPLY) && !cache.includes('Yes, do it.'))
    })
  })

  it('counts a line only when Claude Code says a person made it, or says nothing (ADR-0078)', async () => {
    await withFakeHome(async (h) => {
      resetMemoStores()
      const state = h.path('.local/state/sideby')
      const brief = h.path('.local/state/sideby/handoffs/x/1-claude-work.md')
      await h.write(
        `.claude/projects/-x/${S4}.jsonl`,
        jsonl([
          // Plain text, but Claude Code says a peer or a notification made it.
          user(S4, 2, 'Looks good, merge it.', { origin: { kind: 'peer' } }),
          user(S4, 3, 'The build finished.', { origin: { kind: 'task-notification' } }),
          // sideby's own words, should a Host keep them as the user's.
          user(S4, 4, firstPrompt('claude:work', brief, 'threshold')),
          user(S4, 5, stopMessage(brief)),
        ]),
      )
      // An older record with no origin at all: what a person typed still counts.
      await h.write(`.claude/projects/-x/${S6}.jsonl`, jsonl([user(S6, 2, 'Yes.', { origin: undefined })]))
      const add = (sessionId: string) =>
        addPendingDecision(
          state,
          { kind: 'question', family: 'claude', account: 'claude:main', sessionId, text: 'Which?' },
          min(1),
        )
      const [a, b] = [await add(S4), await add(S6)]
      const { rows } = await pendingOverview({
        decisions: [a, b],
        accounts: [account(h, 'claude', 'main')],
        stateDir: state,
      })
      assert.deepEqual(
        rows.map((r) => [r.state, r.replyCheck]),
        [
          ['open', undefined],
          ['replied', undefined],
        ],
      )
    })
  })

  it('finds records by the names listed, also a Codex one not named by a UUID', async () => {
    await withFakeHome(async (h) => {
      resetMemoStores()
      const state = h.path('.local/state/sideby')
      const codex = account(h, 'codex', 'main')
      const id = 'demo-session-7'
      await h.write(
        `.codex/sessions/2026/11/16/rollout-demo-${id}.jsonl`,
        jsonl([
          { timestamp: iso(-2), type: 'session_meta', payload: { id } },
          {
            timestamp: iso(4),
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it.' }] },
          },
        ]),
      )
      // A Claude record in a second project folder of the same Account, and one the Account does not have.
      await h.write(`.claude/projects/-a/${S1}.jsonl`, jsonl([user(S1, -1, 'Start.')]))
      await h.write(`.claude/projects/-b/${S2}.jsonl`, jsonl([user(S2, 3, 'Go on.')]))
      const add = (family: string, sessionId: string) =>
        addPendingDecision(
          state,
          { kind: 'deferred', family, account: `${family}:main`, sessionId, text: 'Left.' },
          min(1),
        )
      const decisions = [await add('codex', id), await add('claude', S2), await add('claude', S3)]
      const { rows } = await pendingOverview({
        decisions,
        accounts: [codex, account(h, 'claude', 'main')],
        stateDir: state,
      })
      assert.deepEqual(
        rows.map((r) => [r.state, r.replyCheck]),
        [
          ['replied', undefined],
          ['replied', undefined],
          ['open', 'no-record'],
        ],
      )
    })
  })

  it('does not open a record that was not written after the decision', async () => {
    await withFakeHome(async (h) => {
      resetMemoStores()
      const state = h.path('.local/state/sideby')
      const file = await h.write(
        `.claude/projects/-x/${S1}.jsonl`,
        jsonl([user(S1, 5, 'A line whose time is later than the file itself.')]),
      )
      await utimes(file, min(-60), min(-60))
      const d = await addPendingDecision(
        state,
        { kind: 'deferred', family: 'claude', account: 'claude:main', sessionId: S1, text: 'Left.' },
        min(0),
      )
      const { rows } = await pendingOverview({
        decisions: [d],
        accounts: [account(h, 'claude', 'main')],
        stateDir: state,
      })
      assert.equal(rows[0]!.state, 'open')
    })
  })

  it('groups by repository: a worktree, also a deleted one, folds into it; no folder is “other”, listed last', async () => {
    await withFakeHome(async (h) => {
      resetMemoStores()
      const state = h.path('.local/state/sideby')
      await h.mkdir('code/shop/.git')
      await h.mkdir('code/shop/web')
      await h.mkdir('code/blog')
      await h.write('code/wt/fix/.git', `gitdir: ${h.path('code/shop/.git/worktrees/fix')}\n`)
      const add = (at: number, cwd?: string) =>
        addPendingDecision(
          state,
          { kind: 'deferred', family: 'claude', text: 'Left.', ...(cwd ? { cwd: h.path(cwd) } : {}) },
          min(at),
        )
      const inRepo = await add(1, 'code/shop/web')
      const worktree = await add(2, 'code/wt/fix')
      const deleted = await add(3, 'code/shop/.worktrees/gone-branch')
      const goneOutside = await add(4, 'code/gone-app')
      const plain = await add(5, 'code/blog')
      const none = await add(6)
      const decisions = [inRepo, worktree, deleted, goneOutside, plain, none]
      const { rows, projects } = await pendingOverview({ decisions, accounts: [], stateDir: state })
      const by = (d: PendingDecision) => rows.find((r) => r.id === d.id)!
      for (const d of [inRepo, worktree, deleted]) {
        assert.equal(by(d).project, h.path('code/shop'))
        assert.equal(by(d).projectName, 'shop')
      }
      assert.equal(by(goneOutside).project, h.path('code/gone-app'))
      assert.equal(by(plain).projectName, 'blog')
      assert.deepEqual([by(none).project, by(none).projectName], ['', ''])
      // Newest open one first; the group without a folder last, though its one is the newest.
      assert.deepEqual(
        projects.map((p) => [p.projectName, p.open]),
        [
          ['blog', 1],
          ['gone-app', 1],
          ['shop', 3],
          ['', 1],
        ],
      )
      assert.deepEqual(await pendingProjectsNamed(projects, 'shop', h.home), [h.path('code/shop')])
      assert.deepEqual(await pendingProjectsNamed(projects, '~/code/shop/web', h.home), [h.path('code/shop')])
      assert.deepEqual(await pendingProjectsNamed(projects, 'code/blog', h.home), [h.path('code/blog')])
      assert.deepEqual(await pendingProjectsNamed(projects, 'nope', h.home), [])
    })
  })

  it('knows every note sideby puts into a session, in both languages', () => {
    const state = { on: true, reason: 'manual' as const, until: '2026-11-16T08:00:00.000Z' }
    const now = new Date('2026-11-16T01:00:00.000Z')
    for (const zh of [false, true]) {
      for (const waited of [undefined, 10]) {
        assert.equal(typedReply(stopReason(state, now, zh, true, waited)), false)
        assert.equal(typedReply(questionReason(state, now, zh, true, waited)), false)
      }
      assert.equal(typedReply(retryMessage('server_error', 'Overloaded', 1, zh)), false)
    }
    for (const waited of [undefined, 10])
      assert.equal(typedReply(permissionReason(state, now, true, waited)), false)
    assert.equal(typedReply(reminderMessage({ tasks: [], since: now.toISOString(), now, every: 30 })), false)
    // Auto Handoff's notes and the first prompt of the session a task was handed to (src/handoff/messages.ts).
    const brief = '/tmp/handoffs/x/1-claude-work.md'
    const w = { label: '5h', usedPercent: 91, resetsAt: '2026-11-16T05:00:00.000Z' }
    for (const text of [
      prepareMessage(brief, w),
      thresholdMessage(brief, w),
      idleThresholdMessage(brief, w),
      endTurnMessage(w),
      stopMessage(brief),
      sessionStartMessage('claude:work', brief),
      waitNotice('claude:work', '2026-11-16T05:00:00.000Z'),
      waitNotice('claude:work', '2026-11-16T05:00:00.000Z', 95),
      ...(['threshold', 'limit', 'manual'] as const).map((why) => firstPrompt('claude:work', brief, why)),
    ])
      assert.equal(typedReply(text), false, text.slice(0, 60))
    for (const text of [
      '/compact',
      '!git status',
      '  ',
      'see (sideby message 0a1b2c3d)',
      '<task-notification>x',
    ])
      assert.equal(typedReply(text), false, text)
    for (const text of ['go with the recommendation', '按推荐的来', '[Image #1] 这里空白太多'])
      assert.equal(typedReply(text), true, text)
  })
})
