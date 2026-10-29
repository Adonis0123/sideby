// Unattended Mode (spec §3.37, ADR-0057): whether it is on now. One pure function decides it for the CLI, the Panel and
// `unattended-hook`, from the Schedule (config `unattended.schedule`), the manual state kept in
// `<state>/unattended/override.json` and the session flag. A leaf module (Node built-ins and core/fs-safe.ts only):
// `unattended-hook` runs it on every tool call.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, readSmallFile, writeFileAtomic } from './fs-safe.ts'

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Day = (typeof DAYS)[number]

/** One entry of the Schedule: local days, start and end (`HH:MM`); an end before the start runs past midnight. */
export interface UnattendedSlot {
  name?: string
  days: Day[]
  start: string
  end: string
}

/**
 * The manual state: on until `until`, or paused (during a Slot) until `until`. A pause without `until` was made while
 * the Schedule covers every hour: it lasts until the user turns it on again, or until the Schedule changes so that the
 * stretch it was made in ends. `at` is when the user chose it.
 */
export interface UnattendedOverride {
  mode: 'on' | 'pause'
  /** Always set for `on`. */
  until?: string
  at: string
}

export type UnattendedReason = 'slot' | 'manual' | 'session' | 'paused' | 'off'

export interface UnattendedState {
  on: boolean
  /** slot: a Slot turned it on; manual: the user did; session: only this session (`--unattended`); paused: off until the Slot ends. */
  reason: UnattendedReason
  /**
   * When it turns off (on), or comes back (paused). Absent for a session alone, and when the Schedule covers every hour:
   * then it is on with no end, or paused until the user turns it on.
   */
  until?: string
  /** The Slot it is in: its name, or its days and times when it has none. */
  slot?: string
  /** That Slot's number in the Schedule, from 1 (as `sideby unattended` numbers them). */
  slotNumber?: number
  /** The next time a Slot turns it on by itself, and which Slot (its label and number). */
  next?: { at: string; slot: string; slotNumber?: number }
}

/** A stretch of time it is on, in milliseconds since epoch. */
export interface Stretch {
  start: number
  end: number
  reason: 'slot' | 'manual'
  slot?: string
  /** The Slot's number in the Schedule, from 1. */
  slotNumber?: number
}

/** Set in the environment of a session started with `--unattended`: on for that session, whatever the Schedule says. */
export const UNATTENDED_ENV = 'SIDEBY_UNATTENDED'
/** The longest the user can turn it on by hand. */
export const MAX_MANUAL_MS = 72 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * How far around a moment the Schedule is laid out. A weekly Schedule with any gap has one in every 7 days (8 with a
 * clock change), so a stretch that fills this whole window never ends: the Schedule covers every hour.
 */
const BACK_MS = 8 * DAY_MS
const AHEAD_MS = 9 * DAY_MS
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const NAME_MAX = 60

export const unattendedDir = (stateDir: string): string => join(stateDir, 'unattended')
const overrideFile = (stateDir: string) => join(unattendedDir(stateDir), 'override.json')

/** `8:05` or `08:05` as `08:05`; undefined for anything else. */
export function parseClock(text: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return undefined
  const value = `${m[1]!.padStart(2, '0')}:${m[2]}`
  return TIME.test(value) ? value : undefined
}

/**
 * Days as the CLI takes them: `mon-fri`, `sat,sun`, `fri-mon` (a range may wrap past Sunday), `weekdays`, `weekends`,
 * `daily`. In week order; undefined when a part is not a day.
 */
export function parseDays(text: string): Day[] | undefined {
  const words: Record<string, readonly Day[]> = {
    weekdays: DAYS.slice(0, 5),
    weekends: DAYS.slice(5),
    weekend: DAYS.slice(5),
    daily: DAYS,
    everyday: DAYS,
    all: DAYS,
  }
  const out = new Set<Day>()
  const parts = text
    .toLowerCase()
    .split(',')
    .map((p) => p.trim())
  if (parts.some((p) => !p)) return undefined
  for (const part of parts) {
    if (words[part]) {
      for (const d of words[part]) out.add(d)
      continue
    }
    const range = part.split('-').map((p) => p.trim())
    if (range.length > 2) return undefined
    const from = dayOf(range[0]!)
    const to = range.length === 2 ? dayOf(range[1]!) : from
    if (!from || !to) return undefined
    for (let i = DAYS.indexOf(from); ; i = (i + 1) % 7) {
      out.add(DAYS[i]!)
      if (DAYS[i] === to) break
    }
  }
  return DAYS.filter((d) => out.has(d))
}

const LONG_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
/** `mon`, `mond` and `monday` are Monday; `mo` and `monx` are not a day. */
function dayOf(s: string): Day | undefined {
  const i = s.length >= 3 ? LONG_DAYS.findIndex((d) => d.startsWith(s)) : -1
  return i < 0 ? undefined : DAYS[i]
}

/** `mon-fri`, `sat,sun`, `fri-mon`: the shortest way to write the days, in week order (a run may wrap past Sunday). */
export function daysText(days: readonly Day[]): string {
  const on = DAYS.map((d) => days.includes(d))
  if (on.every(Boolean)) return 'daily'
  // Start right after a day that is off, so a run past Sunday (fri-mon) stays one run.
  const first = on.indexOf(false)
  const runs: Day[][] = []
  for (let k = 1; k <= 7; k++) {
    const i = (first + k) % 7
    if (!on[i]) continue
    const prev = (i + 6) % 7
    if (k > 1 && on[prev] && runs.length) runs.at(-1)!.push(DAYS[i]!)
    else runs.push([DAYS[i]!])
  }
  runs.sort((a, b) => DAYS.indexOf(a[0]!) - DAYS.indexOf(b[0]!))
  return runs
    .map((r) => (r.length === 1 ? r[0] : r.length === 2 ? `${r[0]},${r[1]}` : `${r[0]}-${r.at(-1)}`))
    .join(',')
}

/** What a Slot is called on screen: its name, or its days and times. */
export function slotLabel(slot: UnattendedSlot): string {
  return slot.name || `${daysText(slot.days)} ${slot.start}-${slot.end}`
}

/** A Slot checked by hand, the way `unattended-hook` reads the config: anything malformed is left out. */
export function parseSlot(value: unknown): UnattendedSlot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.start !== 'string' || typeof v.end !== 'string' || !TIME.test(v.start) || !TIME.test(v.end))
    return undefined
  if (!Array.isArray(v.days)) return undefined
  const days = DAYS.filter((d) => (v.days as unknown[]).includes(d))
  // Every entry a day, none twice.
  if (!days.length || days.length !== v.days.length) return undefined
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, NAME_MAX) : undefined
  return { ...(name ? { name } : {}), days, start: v.start, end: v.end }
}

/** The Schedule from config's `unattended.schedule`; a malformed Slot is left out, a malformed list is empty. */
export function parseSchedule(value: unknown): UnattendedSlot[] {
  if (!Array.isArray(value)) return []
  return value.map(parseSlot).filter((s): s is UnattendedSlot => s !== undefined)
}

/** The manual state from its file's content; undefined when it is not one. */
export function parseOverride(value: unknown): UnattendedOverride | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (v.mode !== 'on' && v.mode !== 'pause') return undefined
  if (typeof v.at !== 'string') return undefined
  const at = Date.parse(v.at)
  if (!Number.isFinite(at)) return undefined
  if (v.until === undefined && v.mode === 'pause') return { mode: 'pause', at: new Date(at).toISOString() }
  if (typeof v.until !== 'string') return undefined
  const until = Date.parse(v.until)
  if (!Number.isFinite(until) || until <= at) return undefined
  return { mode: v.mode, until: new Date(until).toISOString(), at: new Date(at).toISOString() }
}

const clockMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/**
 * Every time a Slot is on that overlaps `[from, to)`, in local time: a Slot whose end is before its start runs past
 * midnight and belongs to its start day; one whose end equals its start lasts the whole day (24 hours).
 */
export function slotOccurrences(schedule: readonly UnattendedSlot[], from: number, to: number): Stretch[] {
  const out: Stretch[] = []
  if (!schedule.length || to <= from) return out
  const base = new Date(from)
  const [y, m, d] = [base.getFullYear(), base.getMonth(), base.getDate() - 1]
  for (let i = 0; ; i++) {
    const day = new Date(y, m, d + i)
    if (day.getTime() >= to) break
    const name = DAYS[(day.getDay() + 6) % 7]!
    for (const [n, slot] of schedule.entries()) {
      if (!slot.days.includes(name)) continue
      const s = clockMinutes(slot.start)
      const e = clockMinutes(slot.end)
      const start = new Date(y, m, d + i, Math.floor(s / 60), s % 60).getTime()
      const end = new Date(y, m, d + i + (e <= s ? 1 : 0), Math.floor(e / 60), e % 60).getTime()
      if (end > from && start < to)
        out.push({ start, end, reason: 'slot', slot: slotLabel(slot), slotNumber: n + 1 })
    }
  }
  return out
}

/** Joins stretches that overlap or touch; each keeps how its first part began. */
export function mergeStretches(list: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = []
  for (const s of [...list].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = out.at(-1)
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

function withoutPause(
  list: readonly Stretch[],
  pause: { start: number; end: number } | undefined,
): Stretch[] {
  if (!pause) return [...list]
  return list.flatMap((s) => {
    if (s.end <= pause.start || s.start >= pause.end) return [s]
    const parts: Stretch[] = []
    if (s.start < pause.start) parts.push({ ...s, end: pause.start })
    if (s.end > pause.end) parts.push({ ...s, start: pause.end })
    return parts
  })
}

/** The manual "on" as a stretch, at most 72 hours long whatever the file says. */
function manualStretch(o: UnattendedOverride | undefined): Stretch | undefined {
  if (o?.mode !== 'on' || !o.until) return undefined
  const start = Date.parse(o.at)
  return { start, end: Math.min(Date.parse(o.until), start + MAX_MANUAL_MS), reason: 'manual' }
}

/**
 * The Schedule's stretch running at `at` (joined Slots count as one), and whether it never ends: it fills the whole
 * window laid out around `at`, so the Schedule covers every hour.
 */
export function scheduleStretchAt(
  schedule: readonly UnattendedSlot[],
  at: number,
): { stretch: Stretch; endless: boolean } | undefined {
  const [from, to] = [at - BACK_MS, at + AHEAD_MS]
  const stretch = mergeStretches(slotOccurrences(schedule, from, to)).find((s) => s.start <= at && at < s.end)
  return stretch ? { stretch, endless: stretch.start <= from && stretch.end >= to } : undefined
}

/** The pause as a span; an open pause (no `until`) ends with the Schedule's stretch it was made in, which may be never. */
function pauseSpan(
  o: UnattendedOverride | undefined,
  schedule: readonly UnattendedSlot[],
): { start: number; end: number } | undefined {
  if (o?.mode !== 'pause') return undefined
  const start = Date.parse(o.at)
  if (o.until) return { start, end: Date.parse(o.until) }
  const s = scheduleStretchAt(schedule, start)
  return { start, end: !s ? start : s.endless ? Number.POSITIVE_INFINITY : s.stretch.end }
}

/**
 * When it was or will be on for the whole computer within `[from, to)`: the Slots and the manual "on" joined (the
 * later end wins), the pause taken out. A stretch that runs past the window is cut at its edge.
 */
export function unattendedTimeline(
  schedule: readonly UnattendedSlot[],
  override: UnattendedOverride | undefined,
  from: number,
  to: number,
): Stretch[] {
  const manual = manualStretch(override)
  const pieces = [...slotOccurrences(schedule, from, to), ...(manual ? [manual] : [])]
  return withoutPause(mergeStretches(pieces), pauseSpan(override, schedule)).filter(
    (s) => s.end > from && s.start < to,
  )
}

/**
 * When `on --slot-end` ends: the end of the Slot it is in now, else of the next one (joined Slots count as one).
 * Undefined when there is no Slot, or when the Schedule covers every hour and so never ends.
 */
export function slotEnd(schedule: readonly UnattendedSlot[], now: Date): number | undefined {
  const t = now.getTime()
  const [from, to] = [t - BACK_MS, t + AHEAD_MS]
  const s = mergeStretches(slotOccurrences(schedule, from, to)).find((x) => x.end > t)
  return !s || (s.start <= from && s.end >= to) ? undefined : s.end
}

/** Whether it is on now, why, until when, and when a Slot turns it on next. */
export function unattendedState(input: {
  schedule: readonly UnattendedSlot[]
  override?: UnattendedOverride | undefined
  now: Date
  /** The session was started with `--unattended` (`SIDEBY_UNATTENDED=1`). */
  session?: boolean
}): UnattendedState {
  const t = input.now.getTime()
  const [from, to] = [t - BACK_MS, t + AHEAD_MS]
  const override = input.override
  const pieces = slotOccurrences(input.schedule, from, to)
  const pause = pauseSpan(override, input.schedule)
  const current = unattendedTimeline(input.schedule, override, from, to).find(
    (s) => s.start <= t && t < s.end,
  )
  const inSlot = pieces.find((s) => s.start <= t && t < s.end)
  const slotNow = inSlot?.slot
  const slotHere = inSlot ? { slot: inSlot.slot!, slotNumber: inSlot.slotNumber! } : {}
  const after = current ? current.end : t
  const upcoming = withoutPause(mergeStretches(pieces), pause).find((s) => s.start > t && s.start >= after)
  const next = upcoming
    ? {
        next: {
          at: iso(upcoming.start),
          slot: upcoming.slot ?? '',
          ...(upcoming.slotNumber ? { slotNumber: upcoming.slotNumber } : {}),
        },
      }
    : {}
  if (current) {
    const manual = manualStretch(override)
    const byHand = manual !== undefined && manual.start <= t && t < manual.end
    // A stretch that reaches the end of the window is the Schedule covering every hour: it has no end.
    return {
      on: true,
      reason: byHand ? 'manual' : 'slot',
      ...(current.end < to ? { until: iso(current.end) } : {}),
      ...(slotNow ? slotHere : {}),
      ...next,
    }
  }
  if (input.session) return { on: true, reason: 'session', ...next }
  if (pause && pause.start <= t && t < pause.end)
    return {
      on: false,
      reason: 'paused',
      ...(Number.isFinite(pause.end) ? { until: iso(pause.end) } : {}),
      ...(slotNow ? slotHere : {}),
      ...next,
    }
  return { on: false, reason: 'off', ...next }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Reads a small JSON file that must be a plain file (opened without following a link); undefined otherwise. */
export async function readSmallJson(file: string, max = 1024 * 1024): Promise<unknown> {
  const text = await readSmallFile(file, max)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** What the config file says about Unattended Mode, read by hand (no schema): whether it has the section, and its Schedule. */
export async function readUnattendedConfig(
  configFile: string,
): Promise<{ configured: boolean; schedule: UnattendedSlot[] }> {
  // The config may be a link a dotfiles manager keeps; reading through it is fine.
  try {
    const text = await readFile(configFile, 'utf8')
    if (text.length > 4 * 1024 * 1024) return { configured: false, schedule: [] }
    const config = JSON.parse(text) as { unattended?: { schedule?: unknown } } | null
    const section = config && typeof config === 'object' ? config.unattended : undefined
    if (!section || typeof section !== 'object') return { configured: false, schedule: [] }
    return { configured: true, schedule: parseSchedule(section.schedule) }
  } catch {
    return { configured: false, schedule: [] }
  }
}

/**
 * The manual state as the file holds it, expired or not; undefined when there is none, it is not one, or
 * `<state>/unattended` is not a real folder of the user that nobody else can write to.
 */
export async function readUnattendedOverride(stateDir: string): Promise<UnattendedOverride | undefined> {
  const dir = await ownedFolder(stateDir, ['unattended'], { create: false }).catch(() => null)
  return dir ? parseOverride(await readSmallJson(overrideFile(stateDir), 4096)) : undefined
}

/**
 * `<state>/unattended`, made (mode 700) when missing and narrowed to 700 when others can read it. Throws
 * `UnsafeFolderError` (its message says what to do) when it is a link, someone else's, or writable by others: nothing
 * of Unattended Mode is written through such a folder.
 */
export async function ensureUnattendedDir(stateDir: string): Promise<string> {
  return (await ownedFolder(stateDir, ['unattended'], { create: true, private: true }))!
}

/** Writes the manual state (mode 600, atomically). */
export async function writeUnattendedOverride(stateDir: string, override: UnattendedOverride): Promise<void> {
  await ensureUnattendedDir(stateDir)
  await writeFileAtomic(overrideFile(stateDir), `${JSON.stringify(override)}\n`, 0o600)
}

/** Removes the manual state. */
export async function clearUnattendedOverride(stateDir: string): Promise<void> {
  if (!(await ownedFolder(stateDir, ['unattended'], { create: false }))) return
  await rm(overrideFile(stateDir), { force: true })
}

/** A time as the user reads it: `08:00` today, `tomorrow 08:00`, else `Mon 08:00` (or in Chinese). */
export function clockText(at: number, now: number, zh = false): string {
  const d = new Date(at)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(new Date(now))) / DAY_MS)
  if (diff === 0) return hhmm
  if (diff === 1) return zh ? `明天 ${hhmm}` : `tomorrow ${hhmm}`
  const names = zh
    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const date =
    diff > 6 || diff < 0
      ? zh
        ? ` ${d.getMonth() + 1}月${d.getDate()}日`
        : ` ${d.getMonth() + 1}/${d.getDate()}`
      : ''
  return `${names[d.getDay()]}${date} ${hhmm}`
}
