// Handoff (spec §3.13): which Account of one Family to move on to when the current one runs low. Pure:
// the Runtime gathers login states and Quota, this ranks them. sideby recommends; a person starts it.
import type { Account, LoginState, QuotaResult, QuotaWindow } from '../types.ts'
import {
  DEFAULT_TAKEOVER_LIMITS,
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
  quota: QuotaResult
  /** The other Accounts of its Same Login (spec §3.21). */
  sameLogin?: readonly string[]
}

export interface HandoffEntry {
  ref: string
  kind: Account['kind']
  state: HandoffState
  /** Quota Pressure in percent; null when the Account has no Quota. */
  pressure: number | null
  /**
   * Limit Use: the percent of its own Takeover Limit that the closest window has used (a weekly window at 87% under
   * 95 is 91.6), null when the Account has no Quota. Ready Accounts rank by it, lowest first.
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
  e.state === 'full' && !e.sameLoginAs && e.pressure !== null && e.pressure < 100

function entry(c: HandoffCandidate, now: Date, limits: TakeoverLimits, lastResort: boolean): HandoffEntry {
  const pressure = quotaPressure(c.quota, now)
  const use = limitUse(c.quota, now, limits)
  const base = {
    ref: c.ref,
    kind: c.kind,
    pressure,
    limitUse: use?.percent ?? null,
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
  if (pressure === null) return { ...base, state: 'unknown' }
  // Full once any window reaches its own Takeover Limit: 85 for a Short Window, 95 for a Long one by default.
  const level = (w: QuotaWindow) => limitOf(w, limits)
  if (!openWindows(c.quota, now)?.some((w) => w.usedPercent >= level(w))) return { ...base, state: 'ready' }
  // Usable again only when every full window has reset: the latest of their reset times. For a Last Resort a window
  // used up is what stops an Account, so its reset is when it can start again.
  const last = lastReset(c.quota, now, lastResort && pressure >= 100 ? () => 100 : level)
  return { ...base, state: 'full', ...(last === undefined ? {} : { resetsAt: new Date(last).toISOString() }) }
}

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
   */
  opts: { includeApi?: boolean; from?: string; limits?: TakeoverLimits; lastResort?: boolean } = {},
): HandoffPlan {
  const limits = opts.limits ?? DEFAULT_TAKEOVER_LIMITS
  const current = opts.from ? candidates.find((c) => c.ref === opts.from) : undefined
  const byRef = new Map(candidates.map((c) => [c.ref, c]))
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
      const e = entry(c, now, limits, Boolean(opts.lastResort))
      return current?.sameLogin?.includes(c.ref) ? { ...e, sameLoginAs: current.ref } : e
    })
    .sort(
      (a, b) =>
        // A Same Login partner of the current Account can never be picked, so it goes with the others that cannot.
        Number(Boolean(a.sameLoginAs)) - Number(Boolean(b.sameLoginAs)) ||
        rank(a) - rank(b) ||
        (a.state === 'ready' || rank(a) === 1.5 ? a.limitUse! - b.limitUse! : 0) ||
        (a.state === 'full' ? resetTime(a) - resetTime(b) || 0 : 0) ||
        tie(a, b),
    )
  const usable = (e: HandoffEntry) =>
    !e.sameLoginAs &&
    (e.state === 'ready' ||
      e.state === 'unknown' ||
      (opts.lastResort && lastResortOk(e)) ||
      (e.state === 'api' && Boolean(opts.includeApi)))
  const picked = accounts.find(usable)
  const pick = picked?.ref ?? null
  const hasQuota = accounts.some((e) => e.state === 'ready' || e.state === 'full')
  const plan: HandoffPlan = { family, ...(current ? { from: current.ref } : {}), pick, accounts, hasQuota }
  if (picked?.state === 'full') plan.tight = { limit: limits.short, longLimit: limits.long }
  if (pick === null) {
    const first = accounts.find((e) => e.state === 'full' && e.resetsAt)
    if (first?.resetsAt) plan.earliestReset = { ref: first.ref, at: first.resetsAt }
  }
  return plan
}
