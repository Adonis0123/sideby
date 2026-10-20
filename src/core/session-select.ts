// Which Live Session a target names (spec §3.32): one rule for `sideby sessions copy`, `sessions open-run` and
// `send`. A target is a session id (or its first 8 or more characters), else an Account whose single Live Session
// it is; several Sessions, or none, are a UserError that says what to run next.
import type { Runtime } from '../runtime.ts'
import { UserError } from './errors.ts'
import { type LiveSession, type LiveSessionsResult, listLiveSessions, shortId } from './live-sessions.ts'
import type { LiveSessionDeps } from './live-sessions-procs.ts'

/** How the candidates are offered when a target names several Sessions. */
export interface SessionNext {
  verb: string
  command: (id: string) => string
}

const COPY: SessionNext = { verb: 'copy', command: (id) => `sideby sessions copy ${id}` }

/**
 * The one Session `target` names: a session id (or its first 8 or more characters), else an Account whose single
 * Live Session it is. Several Sessions, or none, are a UserError that says what to run next.
 */
export function pickSession(
  target: string,
  sessions: readonly LiveSession[],
  account: { ref: string; label: string } | undefined,
  /** How the candidates are offered; `sessions copy` when left out. */
  next: SessionNext = COPY,
): LiveSession {
  const byId = sessions.filter(
    (s) => s.sessionId === target || (target.length >= 8 && s.sessionId.startsWith(target)),
  )
  if (byId.length === 1) return byId[0]!
  const list = byId.length ? byId : account ? sessions.filter((s) => s.account === account.ref) : []
  if (list.length === 1) return list[0]!
  if (!list.length) {
    if (account)
      throw new UserError(
        `${account.label} has no running session now; start one with \`sideby run ${account.label}\`, or run \`sideby sessions\` to see the others`,
        { code: 'no-session' },
      )
    throw new UserError(
      `no running session or account named ${target}; run \`sideby sessions\` to see the running sessions`,
      { code: 'no-session' },
    )
  }
  const who = account && !byId.length ? account.label : target
  const rows = list.map((s) => `  ${next.command(shortId(s.sessionId))}    ${s.label}`).join('\n')
  throw new UserError(`${who} runs ${list.length} sessions now; ${next.verb} one by its id:\n${rows}`, {
    code: 'several-sessions',
  })
}

/**
 * Lists the Live Sessions and picks the one `target` names, reading `target` as an Account (ref or alias) when it is
 * one. `onListed` sees the listing before the pick, so its problems can be shown also when the pick fails; the
 * listing is returned too, for callers that look for the sending Session in it.
 */
export async function selectSession(
  rt: Runtime,
  target: string,
  opts: { next?: SessionNext; deps?: LiveSessionDeps; onListed?: (listed: LiveSessionsResult) => void } = {},
): Promise<{ session: LiveSession; listed: LiveSessionsResult }> {
  const listed = await listLiveSessions(rt, {}, opts.deps)
  opts.onListed?.(listed)
  let account: { ref: string; label: string } | undefined
  try {
    account = { ref: (await rt.resolve(target)).ref, label: target }
  } catch {
    // not an Account: a session id
  }
  return { session: pickSession(target, listed.sessions, account, opts.next), listed }
}
