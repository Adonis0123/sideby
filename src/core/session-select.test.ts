// A session id an Auto Handoff chain passed on (spec §3.32 step 2, ADR-0057): `selectSession` follows the chain's
// run files to the newest later hop that still runs, across Accounts, and reads nothing else of the chain.
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { UserError } from './errors.ts'
import type { LiveSession } from './live-sessions.ts'
import type { LiveSessionDeps, ProcessInfo } from './live-sessions-procs.ts'
import { earlierHops, readHandoffChains } from './session-handoffs.ts'
import { pickSession, selectSession } from './session-select.ts'

const OLD = '05966d31-1111-4111-8111-111111111111'
const MID = 'aefc5086-2222-4222-8222-222222222222'
const LAST = '4f8629a0-3333-4333-8333-333333333333'
const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const CHAIN = '.local/state/sideby/handoffs/mvt4ly8k-1'

const deps = (pids: number[]): LiveSessionDeps => ({
  processes: async () =>
    pids.map((pid): ProcessInfo => ({ pid, ppid: 1, startMs: START, command: 'claude' })),
  envVar: async () => undefined,
  openFiles: async () => [],
})

/**
 * A chain OLD (claude:main) → MID (claude:work) → LAST (claude:003), with run files written out of order, one that is
 * not JSON, one whose sessionId is not a string, and a Brief that must not be read. MID runs as pid 4101, LAST as 4102.
 */
async function setUp(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-work/settings.json', '{}')
  await h.write('.claude-003/settings.json', '{}')
  const rec = (dir: string, pid: number, sessionId: string) =>
    h.write(
      `${dir}/sessions/${pid}.json`,
      JSON.stringify({ pid, sessionId, procStart: PROC_START, cwd: '/work/repo', status: 'idle' }),
    )
  await rec('.claude-work', 4101, MID)
  await rec('.claude-003', 4102, LAST)
  await h.write(`${CHAIN}/run-mvt4lz00-c.json`, JSON.stringify({ sessionId: LAST, stopBlocked: true }))
  await h.write(
    `${CHAIN}/run-mvt4ly8k-a.json`,
    JSON.stringify({ sessionId: OLD, transcriptPath: '/x.jsonl' }),
  )
  await h.write(`${CHAIN}/run-mvt4lyzz-b.json`, JSON.stringify({ sessionId: MID }))
  await h.write(`${CHAIN}/run-mvt4m000-d.json`, '{not json')
  await h.write(`${CHAIN}/run-mvt4m001-e.json`, JSON.stringify({ sessionId: 42 }))
  await h.write(`${CHAIN}/brief-1.md`, '# Brief')
  return createRuntime({ env: h.env })
}

const session = (sessionId: string, account: string): LiveSession =>
  ({ sessionId, account, label: `${account} · ${sessionId.slice(0, 8)}` }) as LiveSession

/** One chain of `ids`, one hop a second apart from `start`. */
const hops = (...ids: string[]) => ids.map((sessionId, i) => ({ sessionId, at: 1000 + i * 1000 }))

describe('handed-over session ids', () => {
  it('reads each chain in run-id order, skipping run files it cannot read or parse', async () => {
    await withFakeHome(async (h) => {
      await setUp(h)
      const chains = await readHandoffChains(h.path('.local/state/sideby'))
      assert.deepEqual(
        chains.map((c) => c.map((hop) => hop.sessionId)),
        [[OLD, MID, LAST]],
      )
      assert.deepEqual(
        chains[0]!.map((hop) => hop.at),
        ['mvt4ly8k', 'mvt4lyzz', 'mvt4lz00'].map((t) => Number.parseInt(t, 36)),
      )
      assert.deepEqual(await readHandoffChains(h.path('nowhere')), [])
    })
  })

  it('follows an old id and its first 8 characters to the newest later hop that runs, across accounts, writing nothing', async () => {
    await withFakeHome(async (h) => {
      const rt = await setUp(h)
      const before = await snapshot(h.home)
      for (const target of [OLD, OLD.slice(0, 8)]) {
        const newest = await selectSession(rt, target, { deps: deps([4101, 4102]) })
        assert.equal(newest.session.sessionId, LAST)
        assert.equal(newest.session.account, 'claude:003')
        assert.equal(newest.handedOverFrom, OLD)
        assert.deepEqual(newest.session.handedOverFrom, [OLD, MID])
        // LAST has ended: the hop before it still runs.
        const mid = await selectSession(rt, target, { deps: deps([4101]) })
        assert.equal(mid.session.sessionId, MID)
        assert.equal(mid.session.account, 'claude:work')
        assert.equal(mid.handedOverFrom, OLD)
        assert.deepEqual(mid.session.handedOverFrom, [OLD])
      }
      // A live id is picked as before, without handedOverFrom.
      const live = await selectSession(rt, MID, { deps: deps([4101]) })
      assert.equal(live.session.sessionId, MID)
      assert.equal(live.handedOverFrom, undefined)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('names the last hop, and its account when the Host still has its record, when no later hop runs', async () => {
    await withFakeHome(async (h) => {
      const rt = await setUp(h)
      const before = await snapshot(h.home)
      await assert.rejects(selectSession(rt, OLD, { deps: deps([]) }), (e: unknown) => {
        assert.ok(e instanceof UserError && e.code === 'no-session', String(e))
        assert.ok(e.message.includes(`05966d31 was handed over to session ${LAST},`), e.message)
        assert.doesNotMatch(e.message, /claude:003/)
        assert.match(e.message, /run `sideby sessions`/)
        return true
      })
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      await h.write(`.claude-003/projects/-work-repo/${LAST}.jsonl`, '{}\n')
      const withRecord = await snapshot(h.home)
      await assert.rejects(
        selectSession(rt, OLD, { deps: deps([]) }),
        (e: unknown) =>
          e instanceof UserError &&
          e.code === 'no-session' &&
          e.message.includes(`handed over to session ${LAST} of claude:003, which is not running now`),
      )
      assert.deepEqual(diffSnapshots(withRecord, await snapshot(h.home)), [])
    })
  })

  it('keeps no-session as before for an id in no chain, a too short prefix, and a chain whose last hop it is', async () => {
    await withFakeHome(async (h) => {
      const rt = await setUp(h)
      for (const target of ['0123456789abcdef', OLD.slice(0, 7), LAST])
        await assert.rejects(
          selectSession(rt, target, { deps: deps([]) }),
          (e: unknown) =>
            e instanceof UserError &&
            e.code === 'no-session' &&
            e.message ===
              `no running session or account named ${target}; run \`sideby sessions\` to see the running sessions`,
        )
    })
  })

  it('picks the newest successor when a resumed session was handed over again in a new chain', async () => {
    await withFakeHome(async (h) => {
      const rt = await setUp(h)
      // OLD was resumed and handed over again, later, to LAST in a chain whose folder sorts first.
      await rm(h.path(CHAIN), { recursive: true })
      const t = (ms: number) => ms.toString(36)
      const base = Date.UTC(2026, 9, 29)
      await h.write(
        `.local/state/sideby/handoffs/b-first/run-${t(base)}-a.json`,
        JSON.stringify({ sessionId: OLD }),
      )
      await h.write(
        `.local/state/sideby/handoffs/b-first/run-${t(base + 60_000)}-b.json`,
        JSON.stringify({ sessionId: MID }),
      )
      await h.write(
        `.local/state/sideby/handoffs/a-later/run-${t(base + 120_000)}-a.json`,
        JSON.stringify({ sessionId: OLD }),
      )
      await h.write(
        `.local/state/sideby/handoffs/a-later/run-${t(base + 180_000)}-b.json`,
        JSON.stringify({ sessionId: LAST }),
      )
      const r = await selectSession(rt, OLD, { deps: deps([4101, 4102]) })
      assert.equal(r.session.sessionId, LAST)
      assert.equal(r.handedOverFrom, OLD)
      // Each successor came from OLD only; the other branch is not an earlier hop.
      assert.deepEqual(
        r.listed.sessions.map((s) => [s.sessionId, s.handedOverFrom]).sort(),
        [
          [LAST, [OLD]],
          [MID, [OLD]],
        ].sort(),
      )
      assert.equal((await selectSession(rt, OLD, { deps: deps([4101]) })).session.sessionId, MID)
    })
  })

  it('follows a session resumed and handed over again, oldest first in handedOverFrom', () => {
    const chains = [
      hops(OLD, MID),
      [
        { sessionId: MID, at: 5000 },
        { sessionId: LAST, at: 6000 },
      ],
    ]
    const live = [session(LAST, 'claude:003')]
    assert.deepEqual(pickSession(OLD, live, undefined, undefined, { chains }), {
      session: live[0],
      handedOverFrom: OLD,
    })
    assert.deepEqual(earlierHops(chains, LAST), [OLD, MID])
    assert.equal(earlierHops(chains, OLD), undefined)
  })

  it('lists the full ids when a prefix matches several handed-over sessions', () => {
    const other = `${OLD.slice(0, 8)}-9999-4999-8999-999999999999`
    const chains = [hops(OLD, MID), hops(other, LAST)]
    const live = [session(MID, 'claude:work'), session(LAST, 'claude:003')]
    assert.throws(
      () => pickSession(OLD.slice(0, 8), live, undefined, undefined, { chains }),
      (e: unknown) =>
        e instanceof UserError &&
        e.code === 'several-sessions' &&
        e.message.includes(`sideby sessions copy ${OLD}`) &&
        e.message.includes(`sideby sessions copy ${other}`),
    )
    assert.deepEqual(pickSession(other, live, undefined, undefined, { chains }), {
      session: live[1],
      handedOverFrom: other,
    })
  })
})
