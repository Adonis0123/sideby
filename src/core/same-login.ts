// Same Login (spec §3.21, ADR-0016): Subscription Accounts of one Family signed in as the same Identity share one
// vendor Quota. Pure: the Runtime gathers each Account's Identity and own Quota reading, this groups and picks.
import type { Account, AccountIdentity, QuotaResult } from '../types.ts'

/** Families whose Accounts can be a Same Login (ADR-0016, ADR-0028). */
export const SAME_LOGIN_FAMILIES: ReadonlySet<string> = new Set(['claude', 'codex'])

/**
 * Families whose Identity alone does not tell one Quota apart, so two Accounts also need equal Login Keys. Codex: one
 * email can belong to several ChatGPT workspaces, each with its own Quota (ADR-0028).
 */
export const LOGIN_KEY_FAMILIES: ReadonlySet<string> = new Set(['codex'])

export interface LoginMember {
  ref: string
  family: string
  kind: Account['kind']
  identity?: AccountIdentity
  /** The opaque Login Key (ADR-0028), only for comparing here; never put into an output. */
  loginKey?: string
}

const norm = (s: string | undefined) => s?.trim().toLowerCase()

/**
 * Whether two Accounts are the same login: same Family (one that groups), both subscriptions, the same email, and the
 * same organization (both have one and it is equal, or neither has one). Without an email nothing groups. In a Family
 * of `LOGIN_KEY_FAMILIES` both must also have a Login Key, and the keys must be equal.
 */
export function isSameLogin(a: LoginMember, b: LoginMember): boolean {
  if (a.ref === b.ref || a.family !== b.family || !SAME_LOGIN_FAMILIES.has(a.family)) return false
  if (a.kind !== 'subscription' || b.kind !== 'subscription') return false
  const ea = norm(a.identity?.email)
  if (!ea || ea !== norm(b.identity?.email)) return false
  if (LOGIN_KEY_FAMILIES.has(a.family) && (!a.loginKey || a.loginKey !== b.loginKey)) return false
  return norm(a.identity?.org) === norm(b.identity?.org)
}

/** Ref → the other refs of its Same Login, in the order given; Accounts without one are left out. */
export function sameLoginGroups(members: readonly LoginMember[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of members) {
    const peers = members.filter((b) => isSameLogin(a, b)).map((b) => b.ref)
    if (peers.length) out.set(a.ref, peers)
  }
  return out
}

/**
 * The Quota an Account of a Same Login shows: the freshest `ok` reading of the group (its own wins a tie), marked
 * with `from` when it is another member's. Without any `ok` reading the Account keeps its own result.
 */
export function sharedQuota(
  ref: string,
  readings: ReadonlyMap<string, QuotaResult>,
  peers: readonly string[],
): QuotaResult {
  const own = readings.get(ref) ?? { status: 'unavailable', reason: 'unrecognized' }
  let best: { ref: string; q: Extract<QuotaResult, { status: 'ok' }>; t: number } | undefined
  for (const r of [ref, ...peers]) {
    const q = readings.get(r)
    if (q?.status !== 'ok') continue
    const t = Date.parse(q.observedAt)
    if (!Number.isFinite(t)) continue
    if (!best || t > best.t) best = { ref: r, q, t }
  }
  if (!best || best.ref === ref) return own
  const { from: _from, ...reading } = best.q
  return { ...reading, from: best.ref }
}
