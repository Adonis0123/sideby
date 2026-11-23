// Handoff (spec §3.13): which Account of one Family to move on to when the current one runs low. Pure:
// the Runtime gathers login states and Quota, this ranks them. sideby recommends; a person starts it.
import type { Account, LoginProblem, LoginState, QuotaResult, QuotaWindow } from '../types.ts'
import {
  DEFAULT_TAKEOVER_LIMITS,
  isLongWindow,
  limitOf,
  limitUse,
  openWindows,
  quotaPressure,
  type TakeoverLimits,
  windowReset,
} from './quota-levels.ts'

export type HandoffState = 'ready' | 'unknown' | 'api' | 'full' | 'logged-out'

export interface HandoffCandidate {
  ref: string
  name: string
  isMain: boolean
  kind: Account['kind']
  login: LoginState | 'not-needed'
  /** Its Expired Login (ADR-0071): such an Account is never picked. */
  loginProblem?: LoginProblem
  quota: QuotaResult
  /** The other Accounts of its Same Login (spec §3.21). */
  sameLogin?: readonly string[]
  /** Its own Live Sessions now (ADR-0083); the ranking sums them over its Same Login. Left out: none. */
  liveSessions?: number
}

/**
 * A Pick Record (ADR-0083): a pick that just started `ref`, with the Live Sessions its login had then. Until the
 * login's Live Sessions rise above `liveAtPick` or `PICK_RECORD_MS` pass, it counts as one Live Session of that login.
 */
export interface PickRecord {
  ref: string
  /** ISO timestamp of the pick. */
  at: string
  liveAtPick: number
}

/** How long a Pick Record counts at most: the time a new Session takes to show up as a Live Session. */
export const PICK_RECORD_MS = 120_000
/** A counted Long Window that resets within this many hours puts a `ready` Account first (ADR-0083). Fixed. */
export const EXPIRING_HOURS = 24
/**
 * Points every open window must still have under its own Takeover Limit for the expiring tier: with less, a new
 * Session soon reaches the limit and hands over again, so the Account ranks by Room per Session instead. Fixed.
 */
export const EXPIRING_MIN_ROOM = 10

/** Why an Account that could otherwise be picked is left out, and the command that fixes it (ADR-0071). */
export interface HandoffSkip {
  reason: 'login-expired'
  /** The command that signs it in again: `sideby login <ref>`. */
  command: string
}

export interface HandoffEntry {
  ref: string
  kind: Account['kind']
  state: HandoffState
  /** Quota Pressure in percent; null when the Account has no Quota. */
  pressure: number | null
  /**
   * Limit Use: the percent of its own Takeover Limit that the closest window has used (a weekly window at 87% under
   * 95 is 91.6), null when the Account has no Quota. Ready Accounts rank by the room it leaves per Live Session
   * (`liveSessions`), Last Resorts by it, lowest first.
   */
  limitUse: number | null
  /** That window: its label (`5h`, `7d`), used percent and own Takeover Limit; absent when no window is open. */
  window?: { label: string; usedPercent: number; limit: number }
  /**
   * For `full`: when the last window at or over its own Takeover Limit resets, so the Account is usable again. In a
   * plan for a start the user asks for (`lastResort`), an Account with a window used up is usable again once those
   * windows reset, and one with none used up is under the Takeover Limits again at this time.
   */
  resetsAt?: string
  /** When the Quota was recorded; it is only as fresh as the Account's last session. */
  observedAt?: string
  /** The Account the Quota was read from, when it is another Account of the same login (spec §3.21). */
  quotaFrom?: string
  /**
   * The current Account, when this one is signed in as the same login (spec §3.21): it shares that Quota, so it is
   * never picked.
   */
  sameLoginAs?: string
  /** Set when the Account is never picked for a reason its state does not show: its login expired (ADR-0071). */
  skip?: HandoffSkip
  /**
   * The Live Sessions of its Same Login group, its unexpired Pick Records included (ADR-0083). A `ready` Account
   * ranks by its Room per Session: (100 − `limitUse`) / (`liveSessions` + 1).
   */
  liveSessions: number
  /**
   * For `ready`: its counted Long Window that resets within 24 hours (the soonest), whose room would be lost at the
   * reset, so the Account goes before every other `ready` one (ADR-0083).
   */
  expiring?: { label: string; usedPercent: number; resetsAt: string }
}

export interface HandoffPlan {
  family: string
  /** The Account this process runs in (`SIDEBY_ACCOUNT`), when it belongs to the Family. */
  from?: string
  /** The recommended Account, or null when none can be used now. */
  pick: string | null
  /** Every Account, best first; the ones that cannot be picked come last. */
  accounts: HandoffEntry[]
  /**
   * Whether any Account has Quota data. Without any, the pick is only a guess (often the Account that just ran
   * out), so `sideby next` does not start it and the Panel shows no recommendation.
   */
  hasQuota: boolean
  /**
   * Set when the pick is a Last Resort (spec §3.13): no Subscription Account was below its Takeover Limits (`limit` for
   * Short Windows, `longLimit` for Long ones), so the pick is the signed-in one with the lowest Limit Use that has no
   * window used up. Only starts a person asks for (`sideby next`, Pick Commands, the Panel) allow one; Auto Handoff
   * never does.
   */
  tight?: { limit: number; longLimit: number }
  /** Set when nothing can be picked and some Accounts are full: the first to come back. */
  earliestReset?: { ref: string; at: string }
  /**
   * Why a `ready` pick goes first (ADR-0083): `expiring`, its weekly room resets within 24 hours; `room`, it has the
   * most Room per Session.
   */
  reason?: 'expiring' | 'room'
}

const ORDER: Record<HandoffState, number> = { ready: 0, unknown: 1, api: 2, full: 3, 'logged-out': 4 }
/** A full Account without a readable reset time sorts after every one that has one. */
const resetTime = (e: HandoffEntry) => (e.resetsAt ? Date.parse(e.resetsAt) : Number.POSITIVE_INFINITY)

/**
 * The latest reset among the counted windows at or above their `level` that have not reset yet: when the Account is
 * under it again.
 */
function lastReset(quota: QuotaResult, now: Date, level: (w: QuotaWindow) => number): number | undefined {
  let last: number | undefined
  if (quota.status === 'ok')
    for (const w of quota.windows) {
      const t = Date.parse(w.resetsAt)
      if (!w.name && w.usedPercent >= level(w) && !windowReset(w.resetsAt, now) && Number.isFinite(t))
        last = Math.max(last ?? t, t)
    }
  return last
}

/** A full Subscription Account a Last Resort may start: no window used up (pressure under 100). */
const lastResortOk = (e: HandoffEntry) =>
  e.state === 'full' && !blocked(e) && e.pressure !== null && e.pressure < 100

/** An entry that can never be picked whatever its state: the current Account's Same Login, or an Expired Login. */
export const blocked = (e: HandoffEntry): boolean => Boolean(e.sameLoginAs || e.skip)

function entry(
  c: HandoffCandidate,
  now: Date,
  limits: TakeoverLimits,
  lastResort: boolean,
  liveSessions: number,
): HandoffEntry {
  const pressure = quotaPressure(c.quota, now)
  const use = limitUse(c.quota, now, limits)
  const base = {
    ref: c.ref,
    kind: c.kind,
    pressure,
    limitUse: use?.percent ?? null,
    liveSessions,
    ...(use?.window
      ? {
          window: {
            label: use.window.label,
            usedPercent: Math.round(use.window.usedPercent),
            limit: limitOf(use.window, limits),
          },
        }
      : {}),
    ...(c.quota.status === 'ok' ? { observedAt: c.quota.observedAt } : {}),
    ...(c.quota.status === 'ok' && c.quota.from ? { quotaFrom: c.quota.from } : {}),
  }
  if (c.kind === 'api') return { ...base, state: 'api' }
  if (c.login === 'logged-out') return { ...base, state: 'logged-out' }
  return withSkip(c, stateOfQuota(c, base, pressure, now, limits, lastResort))
}

function withSkip(c: HandoffCandidate, e: HandoffEntry): HandoffEntry {
  return c.loginProblem?.kind === 'expired'
    ? { ...e, skip: { reason: 'login-expired', command: `sideby login ${c.ref}` } }
    : e
}

function stateOfQuota(
  c: HandoffCandidate,
  base: Omit<HandoffEntry, 'state'>,
  pressure: number | null,
  now: Date,
  limits: TakeoverLimits,
  lastResort: boolean,
): HandoffEntry {
  if (pressure === null) return { ...base, state: 'unknown' }
  // Full once any window reaches its own Takeover Limit: 85 for a Short Window, 95 for a Long one by default.
  const level = (w: QuotaWindow) => limitOf(w, limits)
  const open = openWindows(c.quota, now)
  if (!open?.some((w) => w.usedPercent >= level(w))) {
    const roomy = open?.every((w) => level(w) - w.usedPercent >= EXPIRING_MIN_ROOM) ?? false
    const soon = roomy ? open?.filter((w) => isLongWindow(w) && expiresSoon(w.resetsAt, now)) : []
    const w = soon?.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt))[0]
    return {
      ...base,
      state: 'ready',
      ...(w
        ? { expiring: { label: w.label, usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt } }
        : {}),
    }
  }
  // Usable again only when every full window has reset: the latest of their reset times. For a Last Resort a window
  // used up is what stops an Account, so its reset is when it can start again.
  const last = lastReset(c.quota, now, lastResort && pressure >= 100 ? () => 100 : level)
  return { ...base, state: 'full', ...(last === undefined ? {} : { resetsAt: new Date(last).toISOString() }) }
}

/** Whether a reset time falls within `EXPIRING_HOURS` from now; an unreadable one never does. */
function expiresSoon(resetsAt: string, now: Date): boolean {
  const t = Date.parse(resetsAt)
  return Number.isFinite(t) && t - now.getTime() <= EXPIRING_HOURS * 3_600_000
}

/** An Account and the other Accounts of its Same Login. */
const groupOf = (c: HandoffCandidate | undefined, ref: string): string[] => [ref, ...(c?.sameLogin ?? [])]

/**
 * Live Sessions per Account, also of Accounts that are not candidates (a Same Login partner the Panel is still
 * reading); without it, each candidate's own `liveSessions`.
 */
export type LiveCounts = ReadonlyMap<string, number>

/** The Live Sessions of each candidate's Same Login group, without Pick Records: what tells that a pick has arrived. */
function groupLiveSessions(
  candidates: readonly HandoffCandidate[],
  counts?: LiveCounts,
): Map<string, number> {
  const own = counts ?? new Map(candidates.map((c) => [c.ref, c.liveSessions ?? 0]))
  return new Map(candidates.map((c) => [c.ref, groupOf(c, c.ref).reduce((n, r) => n + (own.get(r) ?? 0), 0)]))
}

/**
 * Whether a record's time still counts: younger than `PICK_RECORD_MS`. A time a little after `now` counts too: a pick
 * that waited for the lock reads its clock after a peer that wrote one, and the Panel ranks with a time read earlier.
 */
export const pickRecordFresh = (at: string, now: Date): boolean => {
  const age = now.getTime() - Date.parse(at)
  return age > -PICK_RECORD_MS && age < PICK_RECORD_MS
}

/**
 * The Pick Records that still count (ADR-0083): fresh, and the login's Live Sessions have not risen above
 * `liveAtPick`. A record of an Account that is not a candidate is kept as it is.
 */
export function activePicks(
  records: readonly PickRecord[],
  candidates: readonly HandoffCandidate[],
  now: Date,
  counts?: LiveCounts,
): PickRecord[] {
  const live = groupLiveSessions(candidates, counts)
  return records.filter((r) => {
    if (!pickRecordFresh(r.at, now)) return false
    const n = live.get(r.ref)
    return n === undefined || n <= r.liveAtPick
  })
}

/**
 * The load of each candidate's login (ADR-0083): the Live Sessions of its Same Login group plus its Pick Records that
 * still count. A new Pick Record keeps its pick's load as `liveAtPick`, so of two picks of one login that have not
 * arrived yet, the first Session to show up ends only the first record.
 */
export function loginLoad(
  candidates: readonly HandoffCandidate[],
  picks: readonly PickRecord[],
  now: Date,
  counts?: LiveCounts,
): Map<string, number> {
  const live = groupLiveSessions(candidates, counts)
  const picked = new Map<string, number>()
  for (const r of activePicks(picks, candidates, now, counts)) picked.set(r.ref, (picked.get(r.ref) ?? 0) + 1)
  return new Map(
    candidates.map((c) => [
      c.ref,
      (live.get(c.ref) ?? 0) + groupOf(c, c.ref).reduce((n, r) => n + (picked.get(r) ?? 0), 0),
    ]),
  )
}

/** Room per Session (ADR-0083): the room under the Takeover Limits shared by the login's Live Sessions and one more. */
export const roomPerSession = (e: HandoffEntry): number => (100 - (e.limitUse ?? 0)) / (e.liveSessions + 1)

export function planHandoff(
  family: string,
  candidates: readonly HandoffCandidate[],
  now: Date,
  /**
   * `limits`: the Takeover Limits, at or above which a window makes an Account full (default 85 for Short Windows and
   * 95 for Long ones, the limits at threshold 95).
   * `lastResort`: a start the user asks for; when no Subscription Account is `ready` or `unknown`, pick the full one
   * with the lowest Limit Use and no window used up, before any API Account (`tight` says so). Auto Handoff leaves it
   * off.
   * `picks`: Pick Records; the unexpired ones count as Live Sessions of their login (ADR-0083).
   * `live`: Live Sessions per Account, also of Accounts left out of `candidates`, for the Same Login sums.
   */
  opts: {
    includeApi?: boolean
    from?: string
    limits?: TakeoverLimits
    lastResort?: boolean
    picks?: readonly PickRecord[]
    live?: LiveCounts
  } = {},
): HandoffPlan {
  const limits = opts.limits ?? DEFAULT_TAKEOVER_LIMITS
  const current = opts.from ? candidates.find((c) => c.ref === opts.from) : undefined
  const byRef = new Map(candidates.map((c) => [c.ref, c]))
  // A Live Session counts for the whole login, and so does a Pick Record that has not arrived yet.
  const loads = loginLoad(candidates, opts.picks ?? [], now, opts.live)
  const load = (c: HandoffCandidate) => loads.get(c.ref) ?? 0
  const tie = (a: HandoffEntry, b: HandoffEntry) => {
    const x = byRef.get(a.ref)!
    const y = byRef.get(b.ref)!
    return Number(y.isMain) - Number(x.isMain) || x.name.localeCompare(y.name, undefined, { numeric: true })
  }
  // With `lastResort`, a full Account with no window used up ranks after `unknown` and before `api`, lowest Limit Use
  // first.
  const rank = (e: HandoffEntry) => (opts.lastResort && lastResortOk(e) ? 1.5 : ORDER[e.state])
  const accounts = candidates
    .map((c) => {
      const e = entry(c, now, limits, Boolean(opts.lastResort), load(c))
      return current?.sameLogin?.includes(c.ref) ? { ...e, sameLoginAs: current.ref } : e
    })
    .sort(
      (a, b) =>
        // A Same Login partner of the current Account or an Expired Login can never be picked, so it goes with the
        // others that cannot.
        Number(blocked(a)) - Number(blocked(b)) ||
        rank(a) - rank(b) ||
        // Ready: weekly room about to be lost at its reset first, then the most Room per Session (ADR-0083).
        (a.state === 'ready' ? Number(Boolean(b.expiring)) - Number(Boolean(a.expiring)) : 0) ||
        (a.state === 'ready' ? roomPerSession(b) - roomPerSession(a) : 0) ||
        (rank(a) === 1.5 ? a.limitUse! - b.limitUse! : 0) ||
        (a.state === 'full' ? resetTime(a) - resetTime(b) || 0 : 0) ||
        tie(a, b),
    )
  const usable = (e: HandoffEntry) =>
    !blocked(e) &&
    (e.state === 'ready' ||
      e.state === 'unknown' ||
      (opts.lastResort && lastResortOk(e)) ||
      (e.state === 'api' && Boolean(opts.includeApi)))
  const chosen = accounts.find(usable)
  const pick = chosen?.ref ?? null
  const hasQuota = accounts.some((e) => e.state === 'ready' || e.state === 'full')
  const plan: HandoffPlan = { family, ...(current ? { from: current.ref } : {}), pick, accounts, hasQuota }
  if (chosen?.state === 'full') plan.tight = { limit: limits.short, longLimit: limits.long }
  if (chosen?.state === 'ready') plan.reason = chosen.expiring ? 'expiring' : 'room'
  if (pick === null) {
    const first = accounts.find((e) => e.state === 'full' && e.resetsAt && !e.skip)
    if (first?.resetsAt) plan.earliestReset = { ref: first.ref, at: first.resetsAt }
  }
  return plan
}
