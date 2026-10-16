// Which Account an Auto Handoff moves on to (spec §3.17 "选号"). Pure: the Runtime gathers every Account's login,
// Quota and identity, this decides. Each Account's state and the pressure ranking come from `planHandoff` (§3.13).
import type { Account, AccountIdentity, LoginState, QuotaResult } from '../types.ts'
import type { HandoffSettings } from './config.ts'
import { type HandoffEntry, planHandoff } from './handoff.ts'
import { windowReset } from './quota-levels.ts'

export interface SelectCandidate {
  ref: string
  family: string
  name: string
  isMain: boolean
  kind: Account['kind']
  login: LoginState | 'not-needed'
  quota: QuotaResult
  identity?: AccountIdentity
  /** The other Accounts of its Same Login (spec §3.21); they share its Quota. */
  sameLogin?: readonly string[]
  /** Whether the Account's Host is on PATH. */
  installed: boolean
  /** Whether its Family can start as the next Account (has `handoff`, and the run would be eligible). */
  receive: boolean
  /** A session stopped at the limit continues by itself at the reset (`FamilyHandoff.resumesAtReset`); set for the origin. */
  resumesAtReset?: boolean
}

/** An Account the Handoff Order lists that was left out, and why (spec §3.21). */
export interface SkippedAccount {
  ref: string
  reason: string
}

export type HandoffDecision =
  | { kind: 'pick'; ref: string; skipped?: SkippedAccount[] }
  | { kind: 'wait'; until: string }
  | {
      kind: 'none'
      reason: string
      earliestReset?: { ref: string; at: string }
      skipped?: SkippedAccount[]
    }

const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

/** Organizations when both have one, else email domains when both have one, else the same. */
export function sameOrganization(a?: AccountIdentity, b?: AccountIdentity): boolean {
  if (a?.org && b?.org) return a.org.toLowerCase() === b.org.toLowerCase()
  if (a?.email && b?.email) return domain(a.email) === domain(b.email)
  return true
}

/**
 * The latest reset of the origin's full windows, when they all reset in time to wait. Full means at the threshold;
 * `ahead` also counts the fullest window once it is past `prepareAt`, since it answers what happens when that window
 * reaches the threshold (spec §3.17 "选号" 1: plan.json and the Panel, decided before the moment comes).
 */
function waitUntil(
  origin: SelectCandidate,
  s: HandoffSettings,
  now: Date,
  ahead: boolean,
): string | undefined {
  // Waiting only makes sense when the session goes on by itself at the reset (ADR-0018).
  if (origin.quota.status !== 'ok' || s.waitIfResetWithinMinutes <= 0 || origin.resumesAtReset !== true)
    return undefined
  const open = origin.quota.windows.filter((w) => !windowReset(w.resetsAt, now))
  const top = Math.max(0, ...open.map((w) => w.usedPercent))
  let last: number | undefined
  for (const w of open) {
    if (w.usedPercent < s.threshold && !(ahead && w.usedPercent === top && top >= s.prepareAt)) continue
    const t = Date.parse(w.resetsAt)
    if (!Number.isFinite(t)) return undefined
    last = Math.max(last ?? t, t)
  }
  if (last === undefined || last - now.getTime() > s.waitIfResetWithinMinutes * 60_000) return undefined
  return new Date(last).toISOString()
}

/**
 * One candidate's §3.13 state; API accounts are pickable here, as the last resort. An Account already at the user's
 * threshold counts as full even below §3.13's 85%, or it would hand over again on its first tool call.
 */
function stateOf(c: SelectCandidate, s: HandoffSettings, now: Date): HandoffEntry {
  const e = planHandoff(c.family, [c], now, { includeApi: true }).accounts[0]!
  if (e.state !== 'ready' || e.pressure === null || e.pressure < s.threshold || c.quota.status !== 'ok')
    return e
  const resets = c.quota.windows
    .filter((w) => w.usedPercent >= s.threshold && !windowReset(w.resetsAt, now))
    .map((w) => Date.parse(w.resetsAt))
    .filter(Number.isFinite)
  return {
    ...e,
    state: 'full',
    ...(resets.length ? { resetsAt: new Date(Math.max(...resets)).toISOString() } : {}),
  }
}

export function selectNext(input: {
  origin: SelectCandidate
  candidates: readonly SelectCandidate[]
  settings: HandoffSettings
  /** Short command → Account ref, so lists may name either. */
  aliases: Readonly<Record<string, string>>
  /** Accounts this chain already used, the origin included. */
  used: readonly string[]
  now: Date
  /** Decide now what happens when the origin's fullest window reaches the threshold (see `waitUntil`). */
  ahead?: boolean
  /**
   * `sideby handoff ready --to`: the only candidate, which may be an Account this chain already used (handing back to
   * an Account whose Quota came back); every other rule still applies.
   */
  to?: string
  /** The user asked to hand over (`sideby handoff ready`): never wait for a reset (ADR-0018). */
  manual?: boolean
}): HandoffDecision {
  const { origin, settings: s, now } = input
  const refOf = (name: string) => input.aliases[name] ?? name
  const byRef = new Map(input.candidates.map((c) => [c.ref, c]))
  if (input.to !== undefined) {
    const target = byRef.get(refOf(input.to))
    if (!target) return { kind: 'none', reason: `${input.to} is not an account sideby can find` }
    return toTarget(origin, target, s, new Set(s.crossOrganization.map(refOf)), now)
  }
  const until = input.manual ? undefined : waitUntil(origin, s, now, input.ahead === true)
  if (until) return { kind: 'wait', until }

  const allowed = new Set(s.crossOrganization.map(refOf))
  const used = new Set([origin.ref, ...input.used])
  const family = s.families[origin.family]

  let list: SelectCandidate[]
  if (family?.policy === 'order') {
    list = family.order.map(refOf).flatMap((r) => (byRef.has(r) ? [byRef.get(r)!] : []))
  } else {
    // The Family by §3.13's ranking, then other Families' API accounts.
    const own = input.candidates.filter((c) => c.family === origin.family)
    const ranked = planHandoff(origin.family, own, now, { includeApi: true }).accounts.map(
      (e) => byRef.get(e.ref)!,
    )
    list = [...ranked, ...input.candidates.filter((c) => c.family !== origin.family && c.kind === 'api')]
  }

  // The same login shares the origin's Quota, so taking over there gains nothing (spec §3.21).
  const sameLogin = new Set(origin.sameLogin ?? [])
  const skipped: SkippedAccount[] = list
    .filter((c) => sameLogin.has(c.ref))
    .map((c) => ({ ref: c.ref, reason: `same login as ${origin.ref}, so it shares the same quota` }))
  const withSkipped = skipped.length ? { skipped } : {}
  const eligible = list.filter(
    (c) =>
      !sameLogin.has(c.ref) &&
      !used.has(c.ref) &&
      c.installed &&
      c.receive &&
      // An API account pays per request, so it gets past no vendor's limit: sameFamily does not apply to it.
      (s.sameFamily || c.family !== origin.family || c.kind === 'api') &&
      (allowed.has(c.ref) || sameOrganization(origin.identity, c.identity)),
  )
  const states = eligible.map((c) => ({ c, e: stateOf(c, s, now) }))
  const first =
    states.find(({ e }) => e.state === 'ready' || e.state === 'unknown') ??
    states.find(({ e }) => e.state === 'api')
  if (first) return { kind: 'pick', ref: first.c.ref, ...withSkipped }

  const full = states
    .filter(({ e }) => e.state === 'full' && e.resetsAt)
    .sort((a, b) => Date.parse(a.e.resetsAt!) - Date.parse(b.e.resetsAt!))[0]
  return {
    kind: 'none',
    reason: eligible.length
      ? 'every account that may take over is full or signed out'
      : 'no account may take over',
    ...(full ? { earliestReset: { ref: full.c.ref, at: full.e.resetsAt! } } : {}),
    ...withSkipped,
  }
}

/** Why `target` may not take over from `origin`, or null when it may; the same rules as `selectNext` but `used`. */
function refusal(
  origin: SelectCandidate,
  target: SelectCandidate,
  s: HandoffSettings,
  allowed: ReadonlySet<string>,
): string | null {
  if (target.ref === origin.ref) return 'it is the account this session runs in'
  if (origin.sameLogin?.includes(target.ref))
    return `it is the same login as ${origin.ref}, so it shares the same quota`
  if (!target.installed) return 'its host is not installed'
  if (!target.receive) return 'it cannot take over a task'
  if (!s.sameFamily && target.family === origin.family && target.kind !== 'api')
    return 'handing over within one host is off; turn on `handoff.sameFamily`'
  if (!allowed.has(target.ref) && !sameOrganization(origin.identity, target.identity))
    return `it is signed in to another organization; add it to \`handoff.crossOrganization\` to allow it`
  return null
}

function toTarget(
  origin: SelectCandidate,
  target: SelectCandidate,
  s: HandoffSettings,
  allowed: ReadonlySet<string>,
  now: Date,
): HandoffDecision {
  const why = refusal(origin, target, s, allowed)
  if (why) return { kind: 'none', reason: `${target.ref} may not take over: ${why}` }
  const e = stateOf(target, s, now)
  if (e.state === 'ready' || e.state === 'unknown' || e.state === 'api')
    return { kind: 'pick', ref: target.ref }
  return {
    kind: 'none',
    reason: `${target.ref} cannot take over now: ${e.state === 'full' ? 'its quota is full' : 'it is signed out'}`,
    ...(e.state === 'full' && e.resetsAt ? { earliestReset: { ref: target.ref, at: e.resetsAt } } : {}),
  }
}
