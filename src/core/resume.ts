// `sideby resume`: which Account holds the session a bare Host command resumes (spec §3.15, ADR-0007).
import type { Account, FamilyDef } from '../types.ts'

export interface ResumeRoute {
  /** The session the Host arguments resume by id; absent when they resume none. */
  sessionId?: string
  /** The Account that last wrote that session; absent when no Account holds it. */
  account?: Account
}

/** Asks every Account of the Family for the session and picks the one that wrote it last. */
export async function findResumeRoute(
  family: FamilyDef,
  accounts: readonly Account[],
  args: readonly string[],
): Promise<ResumeRoute> {
  const sessionId = family.resumedSession?.(args)
  if (!sessionId || !family.sessionWrittenAt) return {}
  const own = accounts.filter((a) => a.family === family.id)
  const written = await Promise.all(
    own.map((a) => family.sessionWrittenAt!(a, sessionId).catch(() => undefined)),
  )
  let best: { account: Account; at: number } | undefined
  own.forEach((account, i) => {
    const at = written[i]
    if (at !== undefined && (!best || at > best.at)) best = { account, at }
  })
  return best ? { sessionId, account: best.account } : { sessionId }
}
