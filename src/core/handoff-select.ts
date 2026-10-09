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
  /** Whether the Account's Host is on PATH. */
  installed: boolean
  /** Whether its Family can start as the next Account (has `handoff`, and the run would be eligible). */
  receive: boolean
}

export type HandoffDecision =
  | { kind: 'pick'; ref: string }
  | { kind: 'wait'; until: string }
  | { kind: 'none'; reason: string; earliestReset?: { ref: string; at: string } }

const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

/** Organizations when both have one, else email domains when both have one, else the same. */
export function sameOrganization(a?: AccountIdentity, b?: AccountIdentity): boolean {
  if (a?.org && b?.org) return a.org.toLowerCase() === b.org.toLowerCase()
  if (a?.email && b?.email) return domain(a.email) === domain(b.email)
  return true
}

/** The latest reset of the origin's windows at or above the threshold, when they all reset in time to wait. */
function waitUntil(origin: SelectCandidate, s: HandoffSettings, now: Date): string | undefined {
  if (origin.quota.status !== 'ok' || s.waitIfResetWithinMinutes <= 0) return undefined
  let last: number | undefined
  for (const w of origin.quota.windows) {
    if (w.usedPercent < s.threshold || windowReset(w.resetsAt, now)) continue
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
}): HandoffDecision {
  const { origin, settings: s, now } = input
  const until = waitUntil(origin, s, now)
  if (until) return { kind: 'wait', until }

  const refOf = (name: string) => input.aliases[name] ?? name
  const allowed = new Set(s.crossOrganization.map(refOf))
  const used = new Set([origin.ref, ...input.used])
  const byRef = new Map(input.candidates.map((c) => [c.ref, c]))
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

  const eligible = list.filter(
    (c) =>
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
  if (first) return { kind: 'pick', ref: first.c.ref }

  const full = states
    .filter(({ e }) => e.state === 'full' && e.resetsAt)
    .sort((a, b) => Date.parse(a.e.resetsAt!) - Date.parse(b.e.resetsAt!))[0]
  return {
    kind: 'none',
    reason: eligible.length
      ? 'every account that may take over is full or signed out'
      : 'no account may take over',
    ...(full ? { earliestReset: { ref: full.c.ref, at: full.e.resetsAt! } } : {}),
  }
}
