// Handoff (spec §3.13): which Account of one Family to move on to when the current one runs low. Pure:
// the Runtime gathers login states and Quota, this ranks them. sideby recommends; a person starts it.
import type { Account, LoginState, QuotaResult } from '../types.ts'
import { QUOTA_FAIL_PERCENT, quotaPressure, windowReset } from './quota-levels.ts'

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
  /** For `full`: when the last full window resets, so the Account is usable again. */
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
  /** Set when nothing can be picked and some Accounts are full: the first to come back. */
  earliestReset?: { ref: string; at: string }
}

const ORDER: Record<HandoffState, number> = { ready: 0, unknown: 1, api: 2, full: 3, 'logged-out': 4 }
/** A full Account without a readable reset time sorts after every one that has one. */
const resetTime = (e: HandoffEntry) => (e.resetsAt ? Date.parse(e.resetsAt) : Number.POSITIVE_INFINITY)

function entry(c: HandoffCandidate, now: Date): HandoffEntry {
  const pressure = quotaPressure(c.quota, now)
  const base = {
    ref: c.ref,
    kind: c.kind,
    pressure,
    ...(c.quota.status === 'ok' ? { observedAt: c.quota.observedAt } : {}),
    ...(c.quota.status === 'ok' && c.quota.from ? { quotaFrom: c.quota.from } : {}),
  }
  if (c.kind === 'api') return { ...base, state: 'api' }
  if (c.login === 'logged-out') return { ...base, state: 'logged-out' }
  if (pressure === null) return { ...base, state: 'unknown' }
  if (pressure < QUOTA_FAIL_PERCENT) return { ...base, state: 'ready' }
  // Usable again only when every full window has reset: the latest of their reset times.
  let last: number | undefined
  if (c.quota.status === 'ok')
    for (const w of c.quota.windows) {
      const t = Date.parse(w.resetsAt)
      if (w.usedPercent >= QUOTA_FAIL_PERCENT && !windowReset(w.resetsAt, now) && Number.isFinite(t))
        last = Math.max(last ?? t, t)
    }
  return { ...base, state: 'full', ...(last === undefined ? {} : { resetsAt: new Date(last).toISOString() }) }
}

export function planHandoff(
  family: string,
  candidates: readonly HandoffCandidate[],
  now: Date,
  opts: { includeApi?: boolean; from?: string } = {},
): HandoffPlan {
  const current = opts.from ? candidates.find((c) => c.ref === opts.from) : undefined
  const byRef = new Map(candidates.map((c) => [c.ref, c]))
  const tie = (a: HandoffEntry, b: HandoffEntry) => {
    const x = byRef.get(a.ref)!
    const y = byRef.get(b.ref)!
    return Number(y.isMain) - Number(x.isMain) || x.name.localeCompare(y.name, undefined, { numeric: true })
  }
  const accounts = candidates
    .map((c) => {
      const e = entry(c, now)
      return current?.sameLogin?.includes(c.ref) ? { ...e, sameLoginAs: current.ref } : e
    })
    .sort(
      (a, b) =>
        // A Same Login partner of the current Account can never be picked, so it goes with the others that cannot.
        Number(Boolean(a.sameLoginAs)) - Number(Boolean(b.sameLoginAs)) ||
        ORDER[a.state] - ORDER[b.state] ||
        (a.state === 'ready' ? a.pressure! - b.pressure! : 0) ||
        (a.state === 'full' ? resetTime(a) - resetTime(b) || 0 : 0) ||
        tie(a, b),
    )
  const usable = (e: HandoffEntry) =>
    !e.sameLoginAs &&
    (e.state === 'ready' || e.state === 'unknown' || (e.state === 'api' && Boolean(opts.includeApi)))
  const pick = accounts.find(usable)?.ref ?? null
  const hasQuota = accounts.some((e) => e.state === 'ready' || e.state === 'full')
  const plan: HandoffPlan = { family, ...(current ? { from: current.ref } : {}), pick, accounts, hasQuota }
  if (pick === null) {
    const first = accounts.find((e) => e.state === 'full' && e.resetsAt)
    if (first?.resetsAt) plan.earliestReset = { ref: first.ref, at: first.resetsAt }
  }
  return plan
}
