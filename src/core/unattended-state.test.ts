// When Unattended Mode is on (spec §3.37): the Schedule in local time, the manual state, the session flag.
import assert from 'node:assert/strict'
import { readdir, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  clearUnattendedOverride,
  daysText,
  parseClock,
  parseDays,
  parseSchedule,
  readUnattendedConfig,
  readUnattendedOverride,
  scheduleStretchAt,
  slotEnd,
  type UnattendedOverride,
  type UnattendedSlot,
  unattendedState,
  unattendedTimeline,
  writeUnattendedOverride,
} from './unattended-state.ts'

// 2026-10-25 is a Sunday, 2026-10-26 a Monday; all in this computer's own time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)
const iso = (d: Date) => d.toISOString()
const weeknights: UnattendedSlot = {
  name: 'Weeknights',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '23:00',
  end: '08:00',
}
const state = (schedule: UnattendedSlot[], now: Date, override?: UnattendedOverride, session = false) =>
  unattendedState({ schedule, override, now, session })

describe('the Schedule', () => {
  it('is on inside a Slot that runs past midnight, which belongs to its start day', () => {
    const s = state([weeknights], at(27, 2))
    assert.equal(s.on, true)
    assert.equal(s.reason, 'slot')
    assert.equal(s.slot, 'Weeknights')
    assert.equal(s.until, iso(at(27, 8)))
    // Sunday 23:00 is not a weeknight, so Monday 02:00 is off; Saturday 02:00 still belongs to Friday night.
    assert.equal(state([weeknights], at(26, 2)).on, false)
    assert.equal(state([weeknights], at(31, 2)).on, true)
    assert.equal(state([weeknights], at(31, 9)).on, false)
  })

  it('wraps from Sunday to Monday', () => {
    const sunday: UnattendedSlot = { days: ['sun'], start: '22:00', end: '06:00' }
    const s = state([sunday], at(26, 5))
    assert.equal(s.on, true)
    assert.equal(s.until, iso(at(26, 6)))
    assert.equal(s.slot, 'sun 22:00-06:00')
    assert.equal(state([sunday], at(25, 21)).next?.at, iso(at(25, 22)))
  })

  it('takes a Slot whose end equals its start as the whole day', () => {
    const allSaturday: UnattendedSlot = { days: ['sat'], start: '00:00', end: '00:00' }
    assert.equal(state([allSaturday], at(31, 0)).on, true)
    assert.equal(state([allSaturday], at(31, 23, 59)).until, iso(new Date(2026, 10, 1, 0, 0)))
    assert.equal(state([allSaturday], at(30, 23, 59)).on, false)
  })

  it('joins overlapping and touching Slots into one stretch with the latest end', () => {
    const a: UnattendedSlot = { days: ['mon'], start: '20:00', end: '23:00' }
    const b: UnattendedSlot = { days: ['mon'], start: '22:00', end: '01:00' }
    const c: UnattendedSlot = { days: ['tue'], start: '01:00', end: '03:00' }
    const s = state([a, b, c], at(26, 21))
    assert.equal(s.until, iso(at(27, 3)))
    const t = unattendedTimeline([a, b, c], undefined, at(26, 0).getTime(), at(28, 0).getTime())
    assert.deepEqual(
      t.map((x) => [new Date(x.start).toISOString(), new Date(x.end).toISOString()]),
      [[iso(at(26, 20)), iso(at(27, 3))]],
    )
  })

  it('says when a Slot turns it on next, after the current stretch', () => {
    const off = state([weeknights], at(26, 12))
    assert.deepEqual(off, {
      on: false,
      reason: 'off',
      next: { at: iso(at(26, 23)), slot: 'Weeknights', slotNumber: 1 },
    })
    // In a Slot: its label and its number in the Schedule.
    const second = state([{ ...weeknights, days: ['sat'] }, weeknights], at(26, 23, 30))
    assert.equal(second.slot, 'Weeknights')
    assert.equal(second.slotNumber, 2)
    // Friday night is the last one: the next is Monday.
    assert.equal(state([weeknights], at(31, 2)).next?.at, iso(new Date(2026, 10, 2, 23)))
    assert.deepEqual(state([], at(26, 12)), { on: false, reason: 'off' })
  })

  it('knows when `--slot-end` ends', () => {
    assert.equal(slotEnd([weeknights], at(26, 12)), at(27, 8).getTime())
    assert.equal(slotEnd([weeknights], at(27, 2)), at(27, 8).getTime())
    assert.equal(slotEnd([], at(26, 12)), undefined)
  })
})

describe('the manual state', () => {
  const manual = (from: Date, until: Date): UnattendedOverride => ({
    mode: 'on',
    at: iso(from),
    until: iso(until),
  })

  it('is on until the chosen time, then off by itself', () => {
    const o = manual(at(26, 12), at(26, 16))
    assert.deepEqual({ ...state([], at(26, 13), o) }, { on: true, reason: 'manual', until: iso(at(26, 16)) })
    assert.equal(state([], at(26, 16), o).on, false)
  })

  it('overlapping a Slot keeps the later end, either way', () => {
    // Manual ends inside the Slot: the Slot's end wins.
    assert.equal(state([weeknights], at(26, 22), manual(at(26, 21), at(27, 1))).until, iso(at(27, 8)))
    // Manual goes past the Slot: it stays on after 08:00.
    const longer = manual(at(26, 21), at(27, 11))
    assert.equal(state([weeknights], at(27, 2), longer).until, iso(at(27, 11)))
    const after = state([weeknights], at(27, 9), longer)
    assert.equal(after.on, true)
    assert.equal(after.reason, 'manual')
  })

  it('lasts at most 72 hours, whatever the file says', () => {
    const o = manual(at(26, 0), at(31, 0))
    assert.equal(state([], at(28, 23), o).on, true)
    assert.equal(state([], at(29, 0), o).on, false)
    assert.equal(state([], at(28, 0), o).until, iso(at(29, 0)))
  })

  it('pauses a Slot until it ends, and the next Slot turns it on again', () => {
    const pause: UnattendedOverride = { mode: 'pause', at: iso(at(27, 1)), until: iso(at(27, 8)) }
    const s = state([weeknights], at(27, 2), pause)
    assert.equal(s.on, false)
    assert.equal(s.reason, 'paused')
    assert.equal(s.until, iso(at(27, 8)))
    assert.equal(s.slot, 'Weeknights')
    assert.equal(s.next?.at, iso(at(27, 23)))
    assert.equal(state([weeknights], at(27, 23, 30), pause).on, true)
  })

  it('a session started with --unattended is on whatever the rest says', () => {
    assert.deepEqual(state([], at(26, 12), undefined, true), { on: true, reason: 'session' })
    const pause: UnattendedOverride = { mode: 'pause', at: iso(at(27, 1)), until: iso(at(27, 8)) }
    assert.equal(state([weeknights], at(27, 2), pause, true).on, true)
    assert.equal(state([weeknights], at(27, 2), undefined, true).reason, 'slot')
  })

  it('is kept in a file of the user only (600), read leniently', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      assert.equal(await readUnattendedOverride(dir), undefined)
      const o = manual(at(26, 12), at(26, 16))
      await writeUnattendedOverride(dir, o)
      assert.deepEqual(await readUnattendedOverride(dir), o)
      assert.equal((await stat(join(dir, 'unattended/override.json'))).mode & 0o777, 0o600)
      assert.equal((await stat(join(dir, 'unattended'))).mode & 0o777, 0o700)
      await h.write('state/unattended/override.json', '{"mode":"on","at":"x","until":"y"}')
      assert.equal(await readUnattendedOverride(dir), undefined)
      await clearUnattendedOverride(dir)
      assert.equal(await readUnattendedOverride(dir), undefined)
    })
  })
})

describe('reading the config by hand', () => {
  it('leaves out a malformed Slot and keeps the rest', () => {
    assert.deepEqual(
      parseSchedule([
        weeknights,
        { days: ['mon'], start: '25:00', end: '08:00' },
        { days: [], start: '23:00', end: '08:00' },
        { days: ['mon', 'mon'], start: '23:00', end: '08:00' },
        'x',
        { days: ['sat', 'xyz', 'sun'], start: '01:00', end: '02:00' },
      ]),
      [weeknights],
    )
    assert.deepEqual(parseSchedule({}), [])
  })

  it('tells a config with the section from one without, and survives a broken file', async () => {
    await withFakeHome(async (h) => {
      const file = h.path('.config/sideby/config.json')
      assert.deepEqual(await readUnattendedConfig(file), { configured: false, schedule: [] })
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      assert.deepEqual(await readUnattendedConfig(file), { configured: true, schedule: [] })
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [weeknights] } }))
      assert.deepEqual(await readUnattendedConfig(file), { configured: true, schedule: [weeknights] })
      await h.write('.config/sideby/config.json', '{not json')
      assert.deepEqual(await readUnattendedConfig(file), { configured: false, schedule: [] })
    })
  })
})

describe('days and times as the CLI takes them', () => {
  it('reads ranges (also past Sunday), lists and words', () => {
    assert.deepEqual(parseDays('mon-fri'), ['mon', 'tue', 'wed', 'thu', 'fri'])
    assert.deepEqual(parseDays('fri-mon'), ['mon', 'fri', 'sat', 'sun'])
    assert.deepEqual(parseDays('Sat,Sunday'), ['sat', 'sun'])
    assert.deepEqual(parseDays('weekdays,sat'), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
    assert.equal(parseDays('daily')?.length, 7)
    for (const bad of ['bad', 'mo', 'mon-', 'mon-tue-wed', '', 'mon,,tue'])
      assert.equal(parseDays(bad), undefined, bad)
  })

  it('writes days back the short way', () => {
    assert.equal(daysText(['mon', 'tue', 'wed', 'thu', 'fri']), 'mon-fri')
    assert.equal(daysText(['mon', 'fri', 'sat', 'sun']), 'fri-mon')
    assert.equal(daysText(['sat', 'sun']), 'sat,sun')
    assert.equal(daysText(['mon', 'wed']), 'mon,wed')
    assert.equal(daysText(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'daily')
  })

  it('reads a 24-hour time', () => {
    assert.equal(parseClock('8:05'), '08:05')
    assert.equal(parseClock('23:59'), '23:59')
    for (const bad of ['24:00', '7', '07:60', 'x']) assert.equal(parseClock(bad), undefined, bad)
  })

  it('reads and writes the manual state only in a real folder of the user', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const outside = await h.write(
        'elsewhere/override.json',
        JSON.stringify({ mode: 'on', at: iso(at(26, 11)), until: iso(at(26, 13)) }),
      )
      await h.mkdir('state')
      await symlink(join(outside, '..'), join(dir, 'unattended'))
      assert.equal(await readUnattendedOverride(dir), undefined)
      await assert.rejects(
        writeUnattendedOverride(dir, { mode: 'on', at: iso(at(26, 11)), until: iso(at(26, 14)) }),
        /real folder you own/,
      )
      await assert.rejects(clearUnattendedOverride(dir), /real folder you own/)
      assert.deepEqual(await readdir(h.path('elsewhere')), ['override.json'])
    })
  })
})

describe('a Schedule that covers every hour', () => {
  const always: UnattendedSlot = {
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    start: '00:00',
    end: '00:00',
  }
  const evenings: UnattendedSlot = { ...always, start: '18:00', end: '18:00' }

  it('is on with no end, and has no Slot end to stop at', () => {
    const schedules: UnattendedSlot[][] = [
      [always],
      [evenings],
      [weeknights, { ...always, end: '23:00' }, { ...always, days: ['sat', 'sun'] }],
    ]
    for (const schedule of schedules) {
      const s = state(schedule, at(26, 12))
      assert.equal(s.on, true)
      assert.equal(s.reason, 'slot')
      assert.equal(s.until, undefined, JSON.stringify(schedule))
      assert.equal(slotEnd(schedule, at(26, 12)), undefined)
      assert.equal(scheduleStretchAt(schedule, at(26, 12).getTime())?.endless, true)
    }
    // One minute free a week is enough for an end.
    const gap = [
      { ...always, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
      { days: ['sun'], start: '00:00', end: '23:59' },
    ] as UnattendedSlot[]
    assert.equal(state(gap, at(26, 12)).until, iso(new Date(2026, 10, 1, 23, 59)))
  })

  it('pauses until turned on: a pause made in it has no end of its own', () => {
    const pause: UnattendedOverride = { mode: 'pause', at: iso(at(26, 12)) }
    for (const now of [at(26, 13), new Date(2026, 11, 26, 12)]) {
      const s = state([always], now, pause)
      assert.equal(s.on, false)
      assert.equal(s.reason, 'paused')
      assert.equal(s.until, undefined)
    }
    assert.equal(state([always], at(26, 11), pause).on, true)
  })
})
