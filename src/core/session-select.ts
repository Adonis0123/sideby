// Which Live Session a target names (spec §3.32): one rule for `sideby sessions copy`, `sessions open-run` and
// `send`. A target is a session id (or its first 8 or more characters), else an Account whose single Live Session
// it is; several Sessions, or none, are a UserError that says what to run next. A session id that an Auto Handoff
// chain passed on reaches the newest later hop that still runs (ADR-0057).
import type { Runtime } from '../runtime.ts'
import { UserError } from './errors.ts'
import {
  accountLabels,
  type LiveSession,
  type LiveSessionsResult,
  listLiveSessions,
  shortId,
} from './live-sessions.ts'
import type { LiveSessionDeps } from './live-sessions-procs.ts'
import {
  chainIdsMatching,
  type HandoffChain,
  laterHops,
  readHandoffChains,
  withHandoffs,
} from './session-handoffs.ts'

/** How the candidates are offered when a target names several Sessions. */
export interface SessionNext {
  verb: string
  command: (id: string) => string
}

const COPY: SessionNext = { verb: 'copy', command: (id) => `sideby sessions copy ${id}` }

/** The Session picked, and the original id when an Auto Handoff chain led from it to this Session (ADR-0057). */
export interface PickedSession {
  session: LiveSession
  handedOverFrom?: string
}

export interface Handoffs {
  chains: readonly HandoffChain[]
  /** The Account label of a session id that no longer runs, when the Host still has its record. */
  accountOf?: (sessionId: string) => string | undefined
}

/** The one session id of a Handoff chain `target` names, when it names exactly one and a later hop exists. */
function handedOverId(
  target: string,
  chains: readonly HandoffChain[],
  next: SessionNext,
): string | undefined {
  const ids = chainIdsMatching(chains, target)
  if (ids.length > 1) {
    const rows = ids.map((id) => `  ${next.command(id)}`).join('\n')
    throw new UserError(
      `${target} matches ${ids.length} sessions that were handed over; ${next.verb} one by its full id:\n${rows}`,
      { code: 'several-sessions' },
    )
  }
  const id = ids[0]
  return id && laterHops(chains, id).length ? id : undefined
}

/**
 * Follows a session id an Auto Handoff chain passed on: the newest later hop that is a Live Session. Undefined when
 * the id is in no chain or is its last hop; a UserError naming the last hop when no later hop still runs.
 */
function followHandoff(
  target: string,
  sessions: readonly LiveSession[],
  next: SessionNext,
  handoffs: Handoffs,
): PickedSession | undefined {
  const from = handedOverId(target, handoffs.chains, next)
  if (!from) return undefined
  const later = laterHops(handoffs.chains, from)
  for (const id of later) {
    const live = sessions.find((s) => s.sessionId === id)
    if (live) return { session: live, handedOverFrom: from }
  }
  const last = later[0]!
  const account = handoffs.accountOf?.(last)
  throw new UserError(
    `${shortId(from)} was handed over to session ${last}${account ? ` of ${account}` : ''}, which is not running now; run \`sideby sessions\` to see the running sessions`,
    { code: 'no-session' },
  )
}

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
  /** The Handoff chains, and the Account label of a session id whose record the Host still has. */
  handoffs: Handoffs = { chains: [] },
): PickedSession {
  const byId = sessions.filter(
    (s) => s.sessionId === target || (target.length >= 8 && s.sessionId.startsWith(target)),
  )
  if (byId.length === 1) return { session: byId[0]! }
  const list = byId.length ? byId : account ? sessions.filter((s) => s.account === account.ref) : []
  if (list.length === 1) return { session: list[0]! }
  if (!list.length) {
    if (!account) {
      const followed = followHandoff(target, sessions, next, handoffs)
      if (followed) return followed
    }
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
 * one, and following a Handoff chain when it is a session id that no longer runs (ADR-0057). `onListed` sees the
 * listing before the pick, so its problems can be shown also when the pick fails; the listing is returned too, for
 * callers that look for the sending Session in it. Its Sessions carry `handedOverFrom` where a chain led to them.
 */
export async function selectSession(
  rt: Runtime,
  target: string,
  opts: { next?: SessionNext; deps?: LiveSessionDeps; onListed?: (listed: LiveSessionsResult) => void } = {},
): Promise<{ session: LiveSession; listed: LiveSessionsResult; handedOverFrom?: string }> {
  const raw = await listLiveSessions(rt, {}, opts.deps)
  const chains = await readHandoffChains(rt.paths.stateDir)
  const listed = { ...raw, sessions: withHandoffs(chains, raw.sessions) }
  opts.onListed?.(listed)
  let account: { ref: string; label: string } | undefined
  try {
    account = { ref: (await rt.resolve(target)).ref, label: target }
  } catch {
    // not an Account: a session id
  }
  const handoffs: Handoffs = { chains }
  if (!account) {
    // Only when the pick would end at a chain whose later hops all ended: which Account still has the last one.
    const last = endedLastHop(target, listed.sessions, chains)
    if (last) {
      const label = await recordAccount(rt, last)
      handoffs.accountOf = (id) => (id === last ? label : undefined)
    }
  }
  const picked = pickSession(target, listed.sessions, account, opts.next, handoffs)
  return { ...picked, listed }
}

/** The last hop of the chain `target` names, when neither `target` nor any later hop is a Live Session. */
function endedLastHop(
  target: string,
  sessions: readonly LiveSession[],
  chains: readonly HandoffChain[],
): string | undefined {
  if (sessions.some((s) => s.sessionId === target || (target.length >= 8 && s.sessionId.startsWith(target))))
    return undefined
  const ids = chainIdsMatching(chains, target)
  if (ids.length !== 1) return undefined
  const later = laterHops(chains, ids[0]!)
  if (!later.length || later.some((id) => sessions.some((s) => s.sessionId === id))) return undefined
  return later[0]
}

/** The label of the Account whose Host last wrote (else last started) session `id`; undefined when none did. */
async function recordAccount(rt: Runtime, id: string): Promise<string | undefined> {
  const accounts = await rt.accounts()
  let best: { ref: string; at: number } | undefined
  for (const a of accounts) {
    const family = rt.families.get(a.family)
    const at =
      (await family?.sessionWrittenAt?.(a, id).catch(() => undefined)) ??
      (await family?.sessionStartedAt?.(a, id).catch(() => undefined))
    if (at !== undefined && (!best || at > best.at)) best = { ref: a.ref, at }
  }
  return best && (accountLabels(rt, accounts).get(best.ref) ?? best.ref)
}
