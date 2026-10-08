// `sideby resume`: which Account holds the session a bare Host command resumes (spec §3.15, ADR-0007).
import type { Account, FamilyDef } from '../types.ts'

export interface ResumeRoute {
  /** The session the Host arguments resume by id; absent when they resume none. */
  sessionId?: string
  /** The Account that last wrote that session, or else the newest that started it; absent when none did. */
  account?: Account
  /** Set when `account` only started the session: the Host never saved it, so there is nothing to resume. */
  neverSaved?: true
}

/** The Account whose `at` is newest, skipping those without one. */
async function newest(
  accounts: readonly Account[],
  at: (a: Account) => Promise<number | undefined>,
): Promise<Account | undefined> {
  const times = await Promise.all(accounts.map((a) => at(a).catch(() => undefined)))
  let best: { account: Account; at: number } | undefined
  accounts.forEach((account, i) => {
    const t = times[i]
    if (t !== undefined && (!best || t > best.at)) best = { account, at: t }
  })
  return best?.account
}

/**
 * Asks every Account of the Family for the session and picks the one that wrote it last. When none holds it, picks
 * the one that started it last, if the Family can tell (ADR-0009).
 */
export async function findResumeRoute(
  family: FamilyDef,
  accounts: readonly Account[],
  args: readonly string[],
): Promise<ResumeRoute> {
  const sessionId = family.resumedSession?.(args)
  if (!sessionId || !family.sessionWrittenAt) return {}
  const own = accounts.filter((a) => a.family === family.id)
  const holder = await newest(own, (a) => family.sessionWrittenAt!(a, sessionId))
  if (holder) return { sessionId, account: holder }
  const starter = family.sessionStartedAt
    ? await newest(own, (a) => family.sessionStartedAt!(a, sessionId))
    : undefined
  return starter ? { sessionId, account: starter, neverSaved: true } : { sessionId }
}
