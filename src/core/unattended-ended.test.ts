// `unattended.ended` (spec §3.37): each stretch is reported, by the first process that notices, with the open
// Pending Decisions kept during it and a stable id; a stretch nobody saw is still found, however long ago, and one
// noticed late says so. Delivery is at least once: an event whose plugins did not finish is delivered again.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import type { UnattendedEndedContext } from '../types.ts'
import { resolvePaths } from './paths.ts'
import {
  checkUnattendedEnded,
  claimUnattendedEnded,
  MAX_OUTBOX,
  readEndedCheckpoint,
} from './unattended-ended.ts'
import { addPendingDecision, markPendingDone } from './unattended-pending.ts'
import { clearUnattendedOverride, type UnattendedSlot, writeUnattendedOverride } from './unattended-state.ts'

// 2026-10-26 is a Monday, in this computer's own time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)
const monNight: UnattendedSlot = { name: 'Night', days: ['mon'], start: '23:00', end: '08:00' }

async function setup(h: FakeHome, schedule?: UnattendedSlot[]) {
  await h.write('.config/sideby/config.json', JSON.stringify({ unattended: schedule ? { schedule } : {} }))
  const paths = resolvePaths(h.env)
  const events: UnattendedEndedContext[] = []
  const look = (now: Date) => checkUnattendedEnded(paths, (ctx) => void events.push(ctx), now)
  const manual = (from: Date, until: Date) =>
    writeUnattendedOverride(paths.stateDir, {
      mode: 'on',
      at: from.toISOString(),
      until: until.toISOString(),
    })
  return { paths, events, look, manual }
}

describe('unattended.ended', () => {
  it('reports a manual stretch once, with the open decisions kept during it', async () => {
    await withFakeHome(async (h) => {
      const { paths, events, look, manual } = await setup(h)
      await manual(at(26, 12), at(26, 13))
      await look(at(26, 12))
      const add = (text: string, when: Date) =>
        addPendingDecision(paths.stateDir, { kind: 'deferred', family: 'claude', text }, when)
      await add('before', at(26, 11))
      const kept = await add('during', at(26, 12, 10))
      const done = await add('done', at(26, 12, 20))
      await markPendingDone(paths.stateDir, done.id, at(26, 12, 30))
      await add('after', at(26, 14))
      await look(at(26, 14))
      await look(at(26, 15))
      assert.equal(events.length, 1)
      assert.deepEqual(events[0], {
        id: `${at(26, 12).toISOString()}/${at(26, 13).toISOString()}`,
        startedAt: at(26, 12).toISOString(),
        endedAt: at(26, 13).toISOString(),
        reason: 'manual',
        pending: [kept],
      })
    })
  })

  it('finds a whole Slot that ran while no sideby process did, and marks it late', async () => {
    await withFakeHome(async (h) => {
      const { events, look } = await setup(h, [monNight])
      await look(at(26, 12))
      await look(at(27, 21))
      await look(at(28, 12))
      assert.equal(events.length, 1)
      assert.equal(events[0]!.startedAt, at(26, 23).toISOString())
      assert.equal(events[0]!.endedAt, at(27, 8).toISOString())
      assert.equal(events[0]!.reason, 'slot')
      assert.equal(events[0]!.late, true)
    })
  })

  it('ends when the user turns it off, at that moment, and only once', async () => {
    await withFakeHome(async (h) => {
      const { paths, events, look, manual } = await setup(h)
      await manual(at(26, 12), at(26, 18))
      await look(at(26, 12))
      await clearUnattendedOverride(paths.stateDir)
      await look(at(26, 14))
      await look(at(26, 19))
      assert.equal(events.length, 1)
      assert.equal(events[0]!.endedAt, at(26, 14).toISOString())
    })
  })

  it('ends a Slot where the user paused it', async () => {
    await withFakeHome(async (h) => {
      const { paths, events, look } = await setup(h, [monNight])
      await look(at(27, 1))
      await writeUnattendedOverride(paths.stateDir, {
        mode: 'pause',
        at: at(27, 2).toISOString(),
        until: at(27, 8).toISOString(),
      })
      await look(at(27, 2, 1))
      await look(at(27, 9))
      assert.equal(events.length, 1)
      assert.equal(events[0]!.startedAt, at(26, 23).toISOString())
      assert.equal(events[0]!.endedAt, at(27, 2).toISOString())
    })
  })

  it('treats a manual stretch joined to a Slot as one, ending when both have', async () => {
    await withFakeHome(async (h) => {
      const { events, look, manual } = await setup(h, [monNight])
      await manual(at(26, 22), at(26, 23))
      await look(at(26, 22))
      await look(at(27, 2))
      assert.equal(events.length, 0)
      await look(at(27, 9))
      assert.equal(events.length, 1)
      assert.equal(events[0]!.startedAt, at(26, 22).toISOString())
      assert.equal(events[0]!.endedAt, at(27, 8).toISOString())
    })
  })

  it('does nothing and writes nothing when the feature was never used', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      let called = 0
      await checkUnattendedEnded(paths, () => void called++, at(26, 12))
      assert.equal(called, 0)
      await assert.rejects(readFile(`${paths.stateDir}/unattended/ended.json`))
    })
  })

  it('reports a stretch once when several processes look at the same moment', async () => {
    await withFakeHome(async (h) => {
      const { paths, look, manual } = await setup(h)
      await manual(at(26, 12), at(26, 13))
      await look(at(26, 12))
      const out = h.path('events.jsonl')
      const module = new URL('./unattended-ended.ts', import.meta.url).href
      const script = `import { appendFile } from 'node:fs/promises'
import { checkUnattendedEnded } from ${JSON.stringify(module)}
await checkUnattendedEnded(${JSON.stringify(paths)}, (ctx) => appendFile(${JSON.stringify(out)}, JSON.stringify(ctx) + '\\n'), new Date(${at(26, 14).getTime()}))`
      const run = () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            env: h.env as NodeJS.ProcessEnv,
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          let err = ''
          child.stderr.on('data', (c) => (err += c))
          child.on('error', reject)
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))))
        })
      await Promise.all([run(), run(), run(), run()])
      assert.equal((await readFile(out, 'utf8')).trim().split('\n').length, 1)
    })
  })

  it('catches up on every stretch since the last look, however long sideby did not run, oldest first', async () => {
    await withFakeHome(async (h) => {
      const weeknights: UnattendedSlot = {
        name: 'Weeknights',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '23:00',
        end: '08:00',
      }
      const { events, look } = await setup(h, [weeknights])
      await look(at(26, 12))
      // 20 days later (Sunday 2026-11-15): the nights from Monday 10-26 to Friday 11-13 all ended meanwhile.
      await look(new Date(2026, 10, 15, 12))
      const ends = events.map((e) => e.endedAt)
      assert.equal(events.length, 15)
      assert.equal(ends[0], at(27, 8).toISOString())
      assert.equal(ends.at(-1), new Date(2026, 10, 14, 8).toISOString())
      assert.deepEqual([...ends].sort(), ends)
      assert.ok(events.every((e) => e.late))
      await look(new Date(2026, 10, 15, 13))
      assert.equal(events.length, 15)
    })
  })

  it(`takes at most ${MAX_OUTBOX} a look and keeps the rest for the next`, async () => {
    await withFakeHome(async (h) => {
      const daily: UnattendedSlot = {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '01:00',
        end: '02:00',
      }
      const { events, look } = await setup(h, [daily])
      await look(at(26, 12))
      // 80 nights later.
      const later = new Date(2026, 9, 26 + 80, 12)
      await look(later)
      assert.equal(events.length, MAX_OUTBOX)
      await look(new Date(later.getTime() + 60_000))
      assert.equal(events.length, 80)
      assert.equal(new Set(events.map((e) => e.id)).size, 80)
      assert.deepEqual(
        events.map((e) => e.startedAt),
        Array.from({ length: 80 }, (_, i) => new Date(2026, 9, 27 + i, 1).toISOString()),
      )
    })
  })

  it('delivers again an event whose plugins did not finish, with the same id', async () => {
    await withFakeHome(async (h) => {
      const { paths, manual } = await setup(h)
      await manual(at(26, 12), at(26, 13))
      const got: UnattendedEndedContext[] = []
      let fail = true
      const emit = (ctx: UnattendedEndedContext) => {
        got.push(ctx)
        if (fail) throw new Error('the notifier is down')
      }
      await checkUnattendedEnded(paths, emit, at(26, 12))
      await checkUnattendedEnded(paths, emit, at(26, 14))
      assert.equal(got.length, 1)
      // Still in the outbox, claimed: within the lease nobody takes it again.
      assert.equal((await readEndedCheckpoint(paths.stateDir))?.outbox.length, 1)
      await checkUnattendedEnded(paths, emit, at(26, 14, 1))
      assert.equal(got.length, 1)
      fail = false
      await checkUnattendedEnded(paths, emit, at(26, 14, 5))
      assert.equal(got.length, 2)
      assert.equal(got[1]?.id, got[0]?.id)
      const c = await readEndedCheckpoint(paths.stateDir)
      assert.deepEqual(c?.outbox, [])
      assert.deepEqual(c?.emitted, [got[0]?.id])
      await checkUnattendedEnded(paths, emit, at(26, 15))
      assert.equal(got.length, 2)
    })
  })

  it('delivers an event a process claimed and never finished, once the lease runs out', async () => {
    await withFakeHome(async (h) => {
      const { paths, events, look, manual } = await setup(h)
      await manual(at(26, 12), at(26, 13))
      await look(at(26, 12))
      // A process claims the event and is ended before its plugins run.
      assert.equal((await claimUnattendedEnded(paths, at(26, 14))).length, 1)
      await look(at(26, 14, 1))
      assert.equal(events.length, 0)
      await look(at(26, 14, 3))
      assert.equal(events.length, 1)
      assert.equal(events[0]?.id, `${at(26, 12).toISOString()}/${at(26, 13).toISOString()}`)
    })
  })
})
