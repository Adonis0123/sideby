// Unattended Mode (spec §3.37, ADR-0058) for the CLI, the Runtime and the Panel: the full status, turning it on and
// off, editing the Schedule, and the hooks sideby adds to the sessions it starts. Whether it is on is decided in
// core/unattended-state.ts; Pending Decisions are kept by core/unattended-pending.ts; the end of a stretch is noticed by
// core/unattended-ended.ts.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Env } from '../types.ts'
import { editConfigUnattended } from './config.ts'
import { UserError } from './errors.ts'
import { ownedFolder, writeFileAtomic } from './fs-safe.ts'
import type { Paths } from './paths.ts'
import { type SessionHookPart, sidebyHookCommand } from './session-hooks.ts'
import { listPendingDecisions } from './unattended-pending.ts'
import {
  clearUnattendedOverride,
  clockText,
  ensureUnattendedDir,
  MAX_MANUAL_MS,
  parseClock,
  parseDays,
  parseSlot,
  readUnattendedConfig,
  readUnattendedOverride,
  scheduleStretchAt,
  slotEnd,
  UNATTENDED_ENV,
  type UnattendedOverride,
  type UnattendedSlot,
  type UnattendedState,
  unattendedState,
  writeUnattendedOverride,
} from './unattended-state.ts'

/** Families whose sessions Unattended Mode covers in v1. */
export const UNATTENDED_FAMILIES: readonly string[] = ['claude', 'codex']

/**
 * covered: sessions sideby starts get the hook; needs-trust: they get it, and Codex runs it once the user trusts it in
 * `/hooks`; not-covered: the Family has no hook sideby can add (Grok, pi), or the feature was never used.
 */
export type UnattendedCoverage = 'covered' | 'needs-trust' | 'not-covered'

/** Everything `sideby unattended --json` prints and the Panel shows. */
export interface UnattendedStatus extends UnattendedState {
  /** The config has an `unattended` section, so sessions sideby starts get the hook. */
  configured: boolean
  schedule: UnattendedSlot[]
  /** Open Pending Decisions. */
  pending: number
  coverage: Record<string, UnattendedCoverage>
  /** When `on --slot-end` would end: the end of the current or next Slot, when that is within 72 hours. */
  slotEnd?: string
  /** The manual state in effect now: on until, or paused until. */
  manual?: UnattendedOverride
  /**
   * Why sideby cannot keep its state: `<state>/unattended` is a link, someone else's, or others can write to it. The
   * message says what to do; until then the manual state and Pending Decisions are neither read nor written.
   */
  problem?: string
}

/** What a change did, and the command that puts back what was there. */
export interface UnattendedChange {
  changed: boolean
  status: UnattendedStatus
  undo?: string
}

const DEFAULT_HOURS = 12

/** The Weeknights preset: Monday to Friday, 23:00 to 08:00. */
export const WEEKNIGHTS: UnattendedSlot = {
  name: 'Weeknights',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '23:00',
  end: '08:00',
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Whether the manual state is in effect at `now`: started, not yet over. */
function activeManual(o: UnattendedOverride | undefined, now: number): UnattendedOverride | undefined {
  if (!o) return undefined
  // An open pause (no `until`) lasts until the user turns it on; the status shows it while the state says paused.
  if (!o.until) return o.mode === 'pause' && Date.parse(o.at) <= now ? o : undefined
  const end =
    o.mode === 'on' ? Math.min(Date.parse(o.until), Date.parse(o.at) + MAX_MANUAL_MS) : Date.parse(o.until)
  return Date.parse(o.at) <= now && now < end ? o : undefined
}

function coverageOf(families: readonly string[], configured: boolean): Record<string, UnattendedCoverage> {
  const out: Record<string, UnattendedCoverage> = {}
  for (const f of families)
    out[f] = !configured
      ? 'not-covered'
      : f === 'claude'
        ? 'covered'
        : f === 'codex'
          ? 'needs-trust'
          : 'not-covered'
  return out
}

/** The full status. `env` matters only for a session started with `--unattended`. */
export async function unattendedStatus(opts: {
  paths: Paths
  families: readonly string[]
  env?: Env
  now?: Date
  /** Only read: old done Pending Decisions are not deleted (a read-only Panel). */
  readOnly?: boolean
}): Promise<UnattendedStatus> {
  const now = opts.now ?? new Date()
  const { configured, schedule } = await readUnattendedConfig(opts.paths.configFile)
  const override = await readUnattendedOverride(opts.paths.stateDir)
  const state = unattendedState({ schedule, override, now, session: opts.env?.[UNATTENDED_ENV] === '1' })
  const end = slotEnd(schedule, now)
  const manual = activeManual(override, now.getTime())
  const problem = await ownedFolder(opts.paths.stateDir, ['unattended'], { create: false }).then(
    () => undefined,
    (err: Error) => err.message,
  )
  return {
    ...state,
    configured,
    schedule,
    pending: (await listPendingDecisions(opts.paths.stateDir, { now, prune: !opts.readOnly })).length,
    coverage: coverageOf(opts.families, configured),
    ...(end !== undefined && end - now.getTime() <= MAX_MANUAL_MS
      ? { slotEnd: new Date(end).toISOString() }
      : {}),
    ...(manual ? { manual } : {}),
    ...(problem ? { problem } : {}),
  }
}

/** How long to turn it on for, as the CLI and the Panel take it. At most one of the three. */
export interface OnChoice {
  /** `4h`, `90m` or `1h30m`. */
  for?: string
  /** `07:30` (the next time it is 07:30) or an ISO date and time. */
  until?: string
  /** Until the current or next Slot ends. */
  slotEnd?: boolean
}

/** `4h`, `90m`, `1h30m` in milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim().toLowerCase())
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

/**
 * When a manual "on" would end, or why it cannot (the message says what to do). Without a choice: until the current
 * or next Slot ends when that is within 72 hours, else 12 hours.
 */
export function onUntil(
  choice: OnChoice,
  schedule: readonly UnattendedSlot[],
  now: Date,
): { until: number } | { error: string } {
  const t = now.getTime()
  const given = [choice.for !== undefined, choice.until !== undefined, Boolean(choice.slotEnd)].filter(
    Boolean,
  )
  if (given.length > 1) return { error: 'choose one of --for, --until and --slot-end' }
  const end = slotEnd(schedule, now)
  if (choice.for !== undefined) {
    const ms = parseDuration(choice.for)
    if (!ms) return { error: `--for takes hours or minutes, such as 4h, 90m or 1h30m; use one of those` }
    if (ms > MAX_MANUAL_MS)
      return { error: 'use --for 72h or less: Unattended Mode stays on at most 72 hours' }
    return { until: t + ms }
  }
  if (choice.until !== undefined) {
    const clock = parseClock(choice.until)
    if (clock) {
      // The day first, then the time on it, so a clock change between now and then cannot move the hour: 02:30
      // asked at 03:45 on the day clocks go forward is 02:30 tomorrow, not 24 hours after a 02:30 that never was.
      const [h, m] = [Number(clock.slice(0, 2)), Number(clock.slice(3))]
      const [y, mo, d] = [now.getFullYear(), now.getMonth(), now.getDate()]
      const today = new Date(y, mo, d, h, m).getTime()
      return { until: today > t ? today : new Date(y, mo, d + 1, h, m).getTime() }
    }
    const at = /\d{4}-\d{2}-\d{2}/.test(choice.until) ? Date.parse(choice.until) : Number.NaN
    if (!Number.isFinite(at))
      return {
        error:
          '--until takes a time such as 07:30, or a date and time such as 2026-11-02T07:30; use one of those',
      }
    if (at <= t) return { error: `--until ${choice.until} is not in the future; use a later time` }
    if (at - t > MAX_MANUAL_MS)
      return { error: 'use an --until within 72 hours: Unattended Mode stays on at most 72 hours' }
    return { until: at }
  }
  if (choice.slotEnd) {
    if (end === undefined && scheduleStretchAt(schedule, t)?.endless)
      return {
        error:
          'your Schedule covers every hour, so its Slot never ends; use --for or --until, such as --for 12h',
      }
    if (end === undefined)
      return {
        error:
          '--slot-end needs a Slot; add one with `sideby unattended schedule add --days mon-fri --from 23:00 --to 08:00`, or use --for 12h',
      }
    if (end - t > MAX_MANUAL_MS)
      return { error: 'the next Slot ends more than 72 hours from now; use --for or --until instead' }
    return { until: end }
  }
  if (end !== undefined && end - t <= MAX_MANUAL_MS) return { until: end }
  return { until: t + DEFAULT_HOURS * 60 * 60 * 1000 }
}

/** The command that turns it back the way `before` had it, or undefined when there is none. */
function undoFor(before: UnattendedState, now: Date): string | undefined {
  if (before.on && before.reason !== 'session') {
    // On with no end (the Schedule covers every hour): any `on` replaces the pause, and the Schedule goes on after it.
    if (!before.until) return 'sideby unattended on'
    const until = Date.parse(before.until)
    if (!Number.isFinite(until) || until - now.getTime() > MAX_MANUAL_MS) return undefined
    return `sideby unattended on --until ${new Date(until).toISOString()}`
  }
  return 'sideby unattended off'
}

/** Makes the config section, which starts adding the hook to sessions sideby starts. */
export async function ensureUnattendedConfig(configFile: string): Promise<void> {
  await editConfigUnattended(configFile, (current) => (current === undefined ? {} : null))
}

/**
 * Turns it on until `until` (at most 72 hours), creating the config section the first time. A Slot that ends later
 * keeps it on longer. Callers then run `checkUnattendedEnded`, so a stretch this ends is noticed at once.
 */
export async function turnUnattendedOn(opts: {
  paths: Paths
  families: readonly string[]
  until: number
  now?: Date
}): Promise<UnattendedChange> {
  const now = opts.now ?? new Date()
  const t = now.getTime()
  if (!(opts.until > t) || opts.until - t > MAX_MANUAL_MS)
    throw new UserError('Unattended Mode can be turned on for at most 72 hours; choose an end within that', {
      code: 'bad-time',
    })
  await ensureUnattendedConfig(opts.paths.configFile)
  const before = await unattendedStatus({ ...opts, now })
  await writeUnattendedOverride(opts.paths.stateDir, {
    mode: 'on',
    at: now.toISOString(),
    until: new Date(opts.until).toISOString(),
  })
  const status = await unattendedStatus({ ...opts, now })
  const undo = undoFor(before, now)
  return { changed: true, status, ...(undo ? { undo } : {}) }
}

/**
 * Turns it off: outside a Slot it is off at once; in a Slot it pauses until that Slot ends, and the next Slot turns it
 * on as usual. Callers then run `checkUnattendedEnded`.
 */
export async function turnUnattendedOff(opts: {
  paths: Paths
  families: readonly string[]
  now?: Date
}): Promise<UnattendedChange> {
  const now = opts.now ?? new Date()
  const t = now.getTime()
  const before = await unattendedStatus({ ...opts, now })
  if (!before.on || before.reason === 'session') return { changed: false, status: before }
  const { schedule } = await readUnattendedConfig(opts.paths.configFile)
  const inSlot = scheduleStretchAt(schedule, t)
  // In a Schedule that covers every hour, the pause has no end: it lasts until the user turns it on again.
  if (inSlot)
    await writeUnattendedOverride(opts.paths.stateDir, {
      mode: 'pause',
      at: now.toISOString(),
      ...(inSlot.endless ? {} : { until: new Date(inSlot.stretch.end).toISOString() }),
    })
  else await clearUnattendedOverride(opts.paths.stateDir)
  const status = await unattendedStatus({ ...opts, now })
  const undo = undoFor(before, now)
  return { changed: true, status, ...(undo ? { undo } : {}) }
}

const sameSlot = (a: UnattendedSlot, b: UnattendedSlot) =>
  a.start === b.start && a.end === b.end && a.days.join() === b.days.join()

function addCommand(slot: UnattendedSlot, at?: number): string {
  return [
    'sideby unattended schedule add',
    `--days ${slot.days.join(',')}`,
    `--from ${slot.start}`,
    `--to ${slot.end}`,
    ...(slot.name ? [`--name ${quote(slot.name)}`] : []),
    ...(at !== undefined ? [`--at ${at}`] : []),
  ].join(' ')
}

/**
 * Adds a Slot (at position `at`, 1-based, else last), creating the config section. A Slot with the same days and
 * times is not added twice.
 */
export async function addUnattendedSlot(opts: {
  paths: Paths
  families: readonly string[]
  slot: UnattendedSlot
  at?: number
  now?: Date
}): Promise<UnattendedChange> {
  let index = -1
  const r = await editConfigUnattended(opts.paths.configFile, (current) => {
    const schedule = [...(current?.schedule ?? [])] as UnattendedSlot[]
    if (schedule.some((s) => sameSlot(s, opts.slot))) return null
    index = opts.at === undefined ? schedule.length : Math.max(0, Math.min(schedule.length, opts.at - 1))
    schedule.splice(index, 0, opts.slot)
    return { ...current, schedule }
  })
  const status = await unattendedStatus(opts)
  const added = r.changed && index >= 0
  return {
    changed: added,
    status,
    ...(added ? { undo: `sideby unattended schedule remove ${index + 1}` } : {}),
  }
}

/** Removes Slot `n` (1-based, as `sideby unattended` numbers them). Throws when there is none. */
export async function removeUnattendedSlot(opts: {
  paths: Paths
  families: readonly string[]
  n: number
  now?: Date
}): Promise<UnattendedChange> {
  let removed: UnattendedSlot | undefined
  await editConfigUnattended(opts.paths.configFile, (current) => {
    const schedule = [...(current?.schedule ?? [])] as UnattendedSlot[]
    if (opts.n < 1 || opts.n > schedule.length) return null
    removed = schedule.splice(opts.n - 1, 1)[0]
    return { ...current, schedule }
  })
  if (!removed) {
    const count = (await readUnattendedConfig(opts.paths.configFile)).schedule.length
    throw new UserError(
      count
        ? `there is no Slot ${opts.n}; choose 1 to ${count} (\`sideby unattended\` lists them)`
        : 'the Schedule has no Slot to remove; add one with `sideby unattended schedule add`',
      { code: 'no-slot' },
    )
  }
  return { changed: true, status: await unattendedStatus(opts), undo: addCommand(removed, opts.n) }
}

/**
 * Replaces the whole Schedule (the Panel's editor writes each change this way), creating the config section. Every
 * Slot is checked as the config schema does; a bad one is refused with what to fix. `previous` is the Schedule it
 * replaced, which the Panel's Undo writes back.
 */
export async function setUnattendedSchedule(opts: {
  paths: Paths
  families: readonly string[]
  schedule: readonly unknown[]
  now?: Date
}): Promise<UnattendedChange & { previous: UnattendedSlot[] }> {
  const schedule = opts.schedule.map((value, i) => {
    const slot = parseSlot(value)
    const name = (value as { name?: unknown } | null)?.name
    if (!slot || (name !== undefined && (typeof name !== 'string' || name.length > 60)))
      throw new UserError(
        `Slot ${i + 1} is not one: give days (mon…sun, each once), a start and an end such as 23:00 and 08:00, and a name of at most 60 characters`,
        { code: 'bad-slot' },
      )
    return slot
  })
  let previous: UnattendedSlot[] = []
  const r = await editConfigUnattended(opts.paths.configFile, (current) => {
    previous = (current?.schedule ?? []) as UnattendedSlot[]
    if (current && JSON.stringify(previous) === JSON.stringify(schedule)) return null
    return { ...current, schedule }
  })
  return { changed: r.changed, status: await unattendedStatus(opts), previous }
}

/** The preset names `schedule preset` takes, with what each adds. */
export const UNATTENDED_PRESETS: Readonly<Record<string, UnattendedSlot>> = { weeknights: WEEKNIGHTS }

/** The Slot `schedule add` was given, or why it cannot be one (the message says what to do). */
export function slotFromOptions(o: {
  days?: string
  from?: string
  to?: string
  name?: string
}): UnattendedSlot | { error: string } {
  const example = 'for example: sideby unattended schedule add --days mon-fri --from 23:00 --to 08:00'
  if (!o.days || !o.from || !o.to) return { error: `give --days, --from and --to, ${example}` }
  const days = parseDays(o.days)
  if (!days?.length)
    return { error: `--days takes mon…sun, ranges and lists such as mon-fri or sat,sun; ${example}` }
  const start = parseClock(o.from)
  const end = parseClock(o.to)
  if (!start || !end)
    return { error: `--from and --to take a 24-hour time such as 23:00 or 08:00; ${example}` }
  const name = o.name?.trim()
  if (name !== undefined && (!name || [...name].length > 60))
    return { error: 'use a --name of 1 to 60 characters, or leave it out' }
  return { ...(name ? { name } : {}), days, start, end }
}

/** How a time reads in the CLI (`08:00`, `tomorrow 08:00`, `Mon 08:00`). */
export const unattendedClock = (iso: string, now: Date, zh = false): string =>
  clockText(Date.parse(iso), now.getTime(), zh)

/**
 * Unattended Mode's session hooks: before the ask tool and when the model ends its turn (`Stop`, which keeps a turn
 * that ended on a question going once) in Claude and Codex; and in Claude on every permission request Claude Code is
 * about to show and every MCP server form (`Elicitation`). Codex has no such events for them; its own approval
 * prompts are not covered.
 */
export function unattendedHookPart(): SessionHookPart {
  const command = (family: string, event = 'PreToolUse') =>
    sidebyHookCommand('unattended-hook', family, event)
  const claude = (event: string) => [{ type: 'command', command: command('claude', event) }]
  const codex = (event: string) => `hooks=[{type="command",command="${command('codex', event)}"}]`
  return {
    id: 'unattended',
    claude: {
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: claude('PreToolUse') }],
      PermissionRequest: [{ matcher: '*', hooks: claude('PermissionRequest') }],
      Stop: [{ hooks: claude('Stop') }],
      Elicitation: [{ matcher: '*', hooks: claude('Elicitation') }],
    },
    codex: {
      PreToolUse: [`{matcher="^request_user_input$",${codex('PreToolUse')}}`],
      Stop: [`{${codex('Stop')}}`],
    },
  }
}

function prefersChinese(env: Env): boolean {
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '')
}

/** The line a Claude Launch prints when the user's own `--settings` leaves no room for the hook. */
export function unattendedSettingsLine(env: Env): string {
  return prefersChinese(env)
    ? 'sideby：已经给了 `--settings`，无人值守管不到这个会话（它的 hook 要通过 `--settings` 加入）。'
    : 'sideby: `--settings` is already given, so Unattended Mode does not cover this session (its hook goes in through `--settings`).'
}

/** The line a Launch prints when `--unattended` asks for a Family Unattended Mode does not cover. */
export function unattendedFamilyLine(family: string, env: Env): string {
  return prefersChinese(env)
    ? `sideby：无人值守只管 Claude 和 Codex 会话，这个 ${family} 会话不受影响。`
    : `sideby: Unattended Mode covers Claude and Codex sessions only; this ${family} session is not covered.`
}

/**
 * What a Codex Account has been told about, in `codex-trust-notices.json`: its ref once told to trust the hook before
 * questions, `<ref>#stop` once also told about the `Stop` hook (added later, and trusted on its own in `/hooks`).
 */
const trustNoticeKey = (ref: string): string => `${ref}#stop`

/** Once per Codex Account: Codex runs the hooks only after the user trusts them in `/hooks`. */
export async function codexUnattendedTrustLine(
  stateDir: string,
  ref: string,
  env: Env,
): Promise<string | undefined> {
  const file = join(stateDir, 'unattended', 'codex-trust-notices.json')
  let seen: string[] = []
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as { refs?: unknown }
    if (Array.isArray(v.refs)) seen = v.refs.filter((r): r is string => typeof r === 'string')
  } catch {
    // first notice
  }
  const key = trustNoticeKey(ref)
  if (seen.includes(key)) return undefined
  try {
    await ensureUnattendedDir(stateDir)
    await writeFileAtomic(file, `${JSON.stringify({ refs: [...seen, key] })}\n`, 0o600)
  } catch {
    // shown again next time
  }
  return prefersChinese(env)
    ? `sideby：Codex 要先信任 hook，无人值守才拦得住它的提问：在 ${ref} 里输入 /hooks，信任两个 \`unattended-hook\`（提问前和回合结束时各一个）。`
    : `sideby: Codex runs Unattended Mode's hooks only after you trust them: in ${ref}, type /hooks and trust both \`unattended-hook\` entries (before a question and at the end of a turn). Until then its questions are not stopped.`
}
