// When sideby calls a Family's `fetchQuota`, and what it shows from the answer (spec §3.26, ADR-0025): the last answer
// is kept per Account, asked again only when it is older than the Family's `everyMinutes`, when one of its windows
// passed its published reset time (once per reset instant, ADR-0073) or the user refreshes, and not while a local
// reading newer than that covers all of it (`localCovers`); one fetch per Account at
// a time, in this process and across processes, at most four fetches on the machine at once, 20 seconds each; the
// newer of the kept answer and the local reading is shown.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  Account,
  Env,
  LoginEvents,
  LoginProblem,
  QuotaFetch,
  QuotaResult,
  QuotaWindow,
  ReadContext,
} from '../types.ts'
import { takeFileLock } from './lock.ts'
import { windowLevel } from './quota-levels.ts'
import {
  keptQuota,
  type QuotaStoreEntry,
  quotaStoreFile,
  readQuotaStore,
  writeQuotaStore,
} from './quota-store.ts'
import { inCi } from './update.ts'

/**
 * `wait`: ask when the kept answer is old, and wait for it (the CLI). `background`: ask when old, but show the kept
 * answer now (the Panel; with nothing kept it waits a few seconds). `force`: ask now, and wait (a refresh). `never`:
 * the kept answer only.
 */
export type QuotaFetchMode = 'wait' | 'background' | 'force' | 'never'

/**
 * What decides which Account is asked first when several are due at once (spec §3.26): Pinned Accounts, then shown
 * Accounts with a window at its warning level, then the most recently used, Hidden ones last.
 */
export interface QuotaAskHint {
  pinned?: boolean
  hidden?: boolean
  /** When the login was last used on this computer, in ms; the newer, the earlier it is asked. */
  usedAt?: number
  /**
   * The Family's local reading of this Account, when it has one (Claude Code's status line). While it is newer than
   * `everyMinutes` and covers everything the kept answer holds, the Host is not asked (`localCovers`).
   */
  local?: QuotaResult | null
  /**
   * Only an answer whose ask began at or after this real time (ms) will do, also when another reader is asking right
   * now or kept its answer meanwhile: a read that must come after a change, such as a Limit Reset just spent
   * (ADR-0072). When an answer was kept does not count: an ask that began before the change can be kept after it.
   */
  notBefore?: number
  /**
   * What is kept for the other Accounts of this Account's Same Login, read when called. A reset instant one of them
   * already asked for, or whose answer was taken after it, had its one extra ask (ADR-0073), whichever Account asks
   * for the login now.
   */
  peers?: () => Promise<readonly (QuotaStoreEntry | null)[]>
  /**
   * The real time (ms) a Limit Reset was last used for this login (ADR-0072), read when called. An answer whose ask
   * began before it may hold the numbers from before, however late it arrives: it is not kept, and the Account stays
   * due.
   */
  changedAt?: () => Promise<number | undefined>
}

/** Whether the ask that gave `entry` began at or after `notBefore` (real ms); false when it does not say. */
const beganAfter = (entry: QuotaStoreEntry | null, notBefore: number): boolean =>
  Date.parse(entry?.startedAt ?? '') >= notBefore

/**
 * Whether a local reading stands in for a due ask (spec §3.26): it was taken within `everyMinutes`, after every
 * window of the kept answer was read and after each of their reset times that has passed, and it shows every window
 * the kept answer holds. A kept model-group window the local reading cannot see (Claude Code's status line has only
 * the plan-wide ones), or a kept count of Limit Resets, still needs the Host. Never for a Family whose local records
 * can replay old numbers (`localFallbackOnly`, Codex), nor before a first answer is kept.
 */
export function localCovers(
  fq: Pick<QuotaFetch, 'everyMinutes' | 'localFallbackOnly'>,
  local: QuotaResult | null | undefined,
  kept: QuotaStoreEntry | null,
  now: Date,
): boolean {
  if (fq.localFallbackOnly || local?.status !== 'ok' || !kept?.quota) return false
  const every = fq.everyMinutes * 60_000
  // A reading is judged by when it was taken: each window by its own time when it has one, else the reading's.
  const fresh = (at: number) =>
    Number.isFinite(at) && now.getTime() - at >= -60_000 && now.getTime() - at < every
  if (!fresh(Date.parse(local.observedAt))) return false
  if (kept.quota.limitResets && !local.limitResets) return false
  const mine = new Map(local.windows.map((w) => [`${w.name ?? ''}\0${w.label}`, w]))
  const keptAt = kept.quota.observedAt
  return kept.quota.windows.every((w) => {
    const own = mine.get(`${w.name ?? ''}\0${w.label}`)
    if (!own) return false
    const at = Date.parse(own.observedAt ?? local.observedAt)
    if (!fresh(at)) return false
    // Read before the kept window was: it tells nothing newer.
    const before = Date.parse(w.observedAt ?? keptAt)
    if (Number.isFinite(before) && at < before) return false
    const reset = Date.parse(w.resetsAt)
    // A window that reset after the local reading was taken shows its new numbers only in a newer reading.
    return !(Number.isFinite(reset) && reset <= now.getTime() && reset > at)
  })
}

export const FETCH_TIMEOUT_MS = 20_000
/** How long a `background` read waits when nothing is kept yet, so a first Panel load still shows Quota. */
const FIRST_WAIT_MS = 4_000
/** Fetches that run at once: in this process, and across every sideby process on the machine. */
export const MAX_ASKS = 4
/** How long asks that arrive together are gathered before the first is started, so they start in order. */
const GATHER_MS = 25
/** A fetch waits this long for one of the machine's `MAX_ASKS` places, then leaves the kept answer as it is. */
const SLOT_WAIT_MS = 60_000
const LOCK = { staleMs: 30_000, beatMs: 5_000, maxMs: 120_000 }

/** One fetch per Account file at a time, shared by every reader in this process. */
const inFlight = new Map<string, Promise<QuotaStoreEntry | null>>()

/**
 * Why the extra ask after a passed reset time (ADR-0073) was not sent for an Account file: its mark could not be
 * saved. Shown with the kept answer until a write to that file works again.
 */
const unmarked = new Map<string, string>()

/** `kept` with the reason its extra ask is waiting, when there is one and no fetch error of its own. */
const noted = (file: string, kept: QuotaStoreEntry | null): QuotaStoreEntry | null => {
  const why = unmarked.get(file)
  return kept && why && !kept.error ? { ...kept, error: why } : kept
}

/** Whether this process is asking the Account's Host right now (the Panel marks such a row as being read). */
export function quotaAsking(stateDir: string, family: string, name: string): boolean {
  return inFlight.has(quotaStoreFile(stateDir, family, name))
}

interface Job {
  rank: number
  usedAt: number
  seq: number
  start: () => void
}
const waiting: Job[] = []
let running = 0
let seq = 0
let gathering = false

function pump(): void {
  waiting.sort((a, b) => a.rank - b.rank || b.usedAt - a.usedAt || a.seq - b.seq)
  while (running < MAX_ASKS && waiting.length) {
    running++
    waiting.shift()!.start()
  }
}

/**
 * Runs `fn` when one of this process's `MAX_ASKS` places is free, the lowest `rank` first. Asks that arrive together
 * are gathered for a moment before the first starts, so they start in that order.
 */
function queued<T>(rank: number, usedAt: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push({
      rank,
      usedAt,
      seq: seq++,
      start: () =>
        void fn()
          .then(resolve, reject)
          .finally(() => {
            running--
            pump()
          }),
    })
    if (gathering) return
    gathering = true
    setTimeout(() => {
      gathering = false
      pump()
    }, GATHER_MS)
  })
}

/** One of the machine's `MAX_ASKS` places (lock files in sideby's state directory), or null when none came free. */
async function takeSlot(stateDir: string, waitMs: number): Promise<(() => Promise<void>) | null> {
  const dir = join(stateDir, 'quota', 'asking')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  for (;;) {
    for (let i = 0; i < MAX_ASKS; i++) {
      const release = await takeFileLock(join(dir, `${i}.lock`), LOCK).catch(() => null)
      if (release) return release
    }
    if (Date.now() >= deadline) return null
    // Not unref'd: a CLI that waits for a place must stay alive meanwhile.
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Why fetching is off for `family`, or null when it is on (spec §3.26). */
export function quotaCheckOff(
  family: string,
  config: { quota?: { check?: Record<string, boolean> } },
  env: Env,
): string | null {
  if (config.quota?.check?.[family] === false)
    return `Quota checks are turned off for this tool (config quota.check.${family}); turn them on in the Panel's settings`
  if (inCi(env)) return 'Quota checks are off in CI'
  return null
}

const sleep = (ms: number) =>
  new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), ms).unref()
  })

async function runFetch(
  fq: QuotaFetch,
  account: Account,
  ctx: ReadContext,
  hostEnv: Env,
  file: string,
  hint: QuotaAskHint = {},
): Promise<QuotaStoreEntry | null> {
  const kept = await readQuotaStore(file)
  // The real clock, as `attemptedAt`: the Host is asked from here on.
  const startedAt = new Date().toISOString()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  aborted.catch(() => {})
  let answer: QuotaResult | undefined
  let error: string | undefined
  try {
    answer = await Promise.race([fq.fetch(account, { ...ctx, signal: ac.signal, hostEnv }), aborted])
  } catch (err) {
    error = ac.signal.aborted
      ? `no answer within ${FETCH_TIMEOUT_MS / 1000} seconds; sideby asks again in ${fq.everyMinutes} minutes`
      : ((err as Error)?.message ?? String(err))
  } finally {
    clearTimeout(timer)
    if (!ac.signal.aborted) ac.abort()
  }
  if (answer?.status === 'unavailable') error = answer.detail ?? answer.reason
  // Asked before a Limit Reset was used for this login, answered after: these may be the numbers from before, and
  // kept now they would show as the newest. What is kept stays (nothing, for a first ask), and stays due, so the next
  // read asks again.
  if (answer?.status === 'ok' && hint.changedAt) {
    const changed = await hint.changedAt().catch(() => undefined)
    if (changed !== undefined && Date.parse(startedAt) < changed) return kept
  }
  const quota = answer?.status === 'ok' ? keptQuota(answer) : kept?.quota
  const attemptedAt = new Date().toISOString()
  // An answer that asks for a new sign-in marks the login expired; a good answer clears it; any other failure keeps
  // what was known (ADR-0071).
  const loginExpiredAt =
    answer?.status === 'unavailable' && answer.loginExpired === true
      ? attemptedAt
      : answer?.status === 'ok'
        ? undefined
        : kept?.loginExpiredAt
  // Marks of reset instants already asked for (ADR-0073) stay only while the kept answer still has that instant.
  const instants = new Set((quota?.windows ?? []).map((w) => Date.parse(w.resetsAt)))
  const resetAsked = (kept?.resetAsked ?? []).filter((t) => instants.has(Date.parse(t)))
  const entry: QuotaStoreEntry = {
    version: 1,
    attemptedAt,
    startedAt,
    ...(quota ? { quota } : {}),
    ...(error ? { error } : {}),
    ...(loginExpiredAt ? { loginExpiredAt } : {}),
    ...(resetAsked.length ? { resetAsked } : {}),
  }
  await writeQuotaStore(file, entry).then(
    () => unmarked.delete(file),
    () => {},
  )
  return entry
}

/** What is kept for the other Accounts of the Same Login, read now; none when it cannot be read. */
const peersOf = (hint: QuotaAskHint): Promise<readonly (QuotaStoreEntry | null)[]> =>
  hint.peers ? hint.peers().catch(() => []) : Promise.resolve([])

/**
 * The published reset instants of the kept answer that passed after it was taken and were not asked for yet
 * (ADR-0073): windows that reset at the same instant count once, and so does an instant handled for another Account of
 * the Same Login (`peers`). Empty without a kept answer.
 */
export function passedResets(
  kept: QuotaStoreEntry | null,
  now: Date,
  peers: readonly (QuotaStoreEntry | null)[] = [],
): string[] {
  const q = kept?.quota
  if (!q) return []
  const asked = new Set((kept.resetAsked ?? []).map((t) => Date.parse(t)))
  const out = new Map<number, string>()
  for (const w of q.windows) {
    const at = Date.parse(w.resetsAt)
    const taken = Date.parse(w.observedAt ?? q.observedAt)
    if (!Number.isFinite(at) || !Number.isFinite(taken)) continue
    if (at > taken && at <= now.getTime() && !asked.has(at)) out.set(at, new Date(at).toISOString())
  }
  // A Same Login is one vendor Quota: an instant another of its Accounts asked for, or answered after, is done.
  for (const p of peers) {
    for (const t of p?.resetAsked ?? []) out.delete(Date.parse(t))
    // When its kept answer was taken: by the start of the ask that brought it, or, after a later ask failed (the
    // start kept is then that ask's), by the answer's own time. A failed ask is never taken for an answer.
    const answered = !p?.quota
      ? Number.NaN
      : Date.parse(p.error ? p.quota.observedAt : (p.startedAt ?? p.quota.observedAt))
    if (Number.isFinite(answered)) for (const at of [...out.keys()]) if (answered >= at) out.delete(at)
  }
  return [...out.values()]
}

/**
 * One ask for `file`, across processes: waits for another process that is asking the same Account and takes its
 * answer, marks the reset instants this ask is for before asking, and holds one of the machine's `MAX_ASKS` places
 * while the Host runs. Null (or the kept answer) when no place or lock came free. `extra` is an ask that is due only
 * because a reset time passed inside `everyMinutes` (ADR-0073): it is sent only once its mark is on disk, and not at
 * all when another process marked that instant meanwhile.
 */
async function askOnce(
  fq: QuotaFetch,
  account: Account,
  ctx: ReadContext,
  hostEnv: Env,
  file: string,
  judged: QuotaStoreEntry | null,
  extra: boolean,
  notBefore?: number,
  hint: QuotaAskHint = {},
): Promise<QuotaStoreEntry | null> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = await takeFileLock(`${file}.lock`, {
    ...LOCK,
    wait: { timeoutMs: FETCH_TIMEOUT_MS + 10_000, pollMs: 100 },
  }).catch(() => null)
  // Another process is still asking this Account: what is kept shows meanwhile.
  if (!lock) return readQuotaStore(file)
  try {
    const kept = await readQuotaStore(file)
    // Another process asked while this one waited for the lock: its answer is the one this ask wanted.
    // Unless this ask must come after a change, and that answer's ask began before it: kept late, it still holds
    // the numbers from before.
    const early = notBefore !== undefined && !beganAfter(kept, notBefore)
    if (kept && kept.attemptedAt !== judged?.attemptedAt && !early) return kept
    const due = passedResets(kept, ctx.now, await peersOf(hint))
    // Judged again under the lock: another process that was due for the same reset instant marked it and asked while
    // this one waited. `attemptedAt` does not tell, because what its ask brought may not have been kept. The instant
    // had its one ask, so the kept answer shows on until the regular ask of `everyMinutes` is due.
    if (extra && kept && !due.length && !olderThanInterval(fq, kept, ctx.now)) return kept
    if (kept && due.length) {
      const marked = await writeQuotaStore(file, {
        ...kept,
        resetAsked: [...(kept.resetAsked ?? []), ...due],
      }).then(
        () => true,
        () => false,
      )
      if (marked) unmarked.delete(file)
      else if (extra) {
        // Without the mark a failed ask would be sent again on every read: "once per reset instant" needs it on disk
        // first. The kept answer goes on showing, with why it was not asked again.
        const why = `a window's reset time has passed, but sideby could not write ${file} to note that it asks again, so it did not ask; it will once that file can be written, or at the next regular check`
        unmarked.set(file, why)
        return noted(file, kept)
      }
    }
    const slot = await takeSlot(ctx.stateDir, SLOT_WAIT_MS)
    if (!slot) return readQuotaStore(file)
    try {
      return await runFetch(fq, account, ctx, hostEnv, file, hint)
    } finally {
      await slot()
    }
  } finally {
    await lock()
  }
}

/**
 * Whether the regular ask is due: nothing is kept, or it was last asked `everyMinutes` ago or longer. A time in the
 * future (a changed clock) counts as old, so it cannot stop every later fetch.
 */
function olderThanInterval(
  fq: Pick<QuotaFetch, 'everyMinutes'>,
  kept: QuotaStoreEntry | null,
  now: Date,
): boolean {
  const at = kept ? Date.parse(kept.attemptedAt) : Number.NaN
  const age = now.getTime() - at
  return !kept || !Number.isFinite(at) || age < -60_000 || age >= fq.everyMinutes * 60_000
}

/** Whether a kept answer has a window that counts toward Quota Pressure at or over its warning level. */
const tight = (kept: QuotaStoreEntry | null): boolean =>
  (kept?.quota?.windows ?? []).some((w: QuotaWindow) => !w.name && windowLevel(w) !== 'ok')

/**
 * The kept answer for `account`, after asking again when `mode` says so and it is due: older than `everyMinutes`, or
 * one of its windows passed its published reset time since it was taken and that instant was not asked for yet
 * (ADR-0073).
 */
export async function fetchedQuota(
  fq: QuotaFetch,
  account: Account,
  ctx: ReadContext,
  hostEnv: Env,
  mode: QuotaFetchMode,
  hint: QuotaAskHint = {},
): Promise<QuotaStoreEntry | null> {
  const file = quotaStoreFile(ctx.stateDir, account.family, account.name)
  const kept = await readQuotaStore(file)
  if (mode === 'never') return kept
  // A local reading that is newer than the Family asks, and shows all the kept answer holds, spares the Host.
  if (mode !== 'force' && localCovers(fq, hint.local, kept, ctx.now)) return kept
  const stale = olderThanInterval(fq, kept, ctx.now)
  if (mode !== 'force' && !stale && passedResets(kept, ctx.now, await peersOf(hint)).length === 0) {
    // Nothing is due, so no extra ask is waiting for its mark any more.
    unmarked.delete(file)
    return kept
  }
  const notBefore = mode === 'force' ? hint.notBefore : undefined
  let run = inFlight.get(file)
  // An ask already running may have begun before the change this one must see, or may bring an answer another
  // process kept: let it end, and ask anew unless what it brought began after the change.
  while (run && notBefore !== undefined) {
    const joined = await run.catch(() => null)
    if (beganAfter(joined, notBefore)) return joined
    run = inFlight.get(file)
  }
  if (!run) {
    const rank = hint.hidden ? 3 : hint.pinned ? 0 : tight(kept) ? 1 : 2
    // Due only because a reset time passed inside `everyMinutes`: the one extra ask of ADR-0073.
    const extra = mode !== 'force' && !stale
    run = queued(rank, hint.usedAt ?? 0, () =>
      askOnce(fq, account, ctx, hostEnv, file, kept, extra, notBefore, hint),
    ).finally(() => inFlight.delete(file))
    inFlight.set(file, run)
  }
  if (mode !== 'background') return run
  run.catch(() => {})
  if (kept) return noted(file, kept)
  return Promise.race([run, sleep(FIRST_WAIT_MS)]).then((e) => e ?? kept)
}

/**
 * The Expired Login of a signed-in Subscription Account (ADR-0071), from what its Host wrote (`events`) and the kept
 * Quota answer: expired when the newest sign that the login expired is newer than every sign that it works (a
 * successful turn, a good Quota answer). `signedInAt` is when a sign-in sideby started last finished.
 */
export function loginProblemOf(
  ref: string,
  events: LoginEvents | undefined,
  kept: QuotaStoreEntry | null,
  signedInAt?: string,
): LoginProblem | undefined {
  const t = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN)
  const newest = (...xs: (string | undefined)[]) => {
    let best: string | undefined
    for (const x of xs) if (Number.isFinite(t(x)) && (!best || t(x) > t(best))) best = x
    return best
  }
  const expired = newest(events?.expiredAt, kept?.loginExpiredAt)
  if (!expired) return undefined
  const working = newest(events?.workingAt, kept?.quota?.observedAt)
  if (working && t(working) >= t(expired)) return undefined
  const since = new Date(t(expired)).toISOString()
  return {
    kind: 'expired',
    since,
    message: `sign-in expired; run \`sideby login ${ref}\` to sign in again`,
    ...(signedInAt && t(signedInAt) > t(expired) ? { signedInAt } : {}),
  }
}

/**
 * What sideby shows from a Family that fetches Quota: the newer reading, or the kept answer when local events can
 * replay old snapshots (`localFallbackOnly`); else why there is none (`off` is why fetching is off, or null).
 */
export function shownQuota(
  local: QuotaResult | null,
  kept: QuotaStoreEntry | null,
  off: string | null,
  localFallbackOnly = false,
): QuotaResult {
  const fetched: QuotaResult | null = kept?.quota
    ? { ...kept.quota, fetched: true, ...(kept.error ? { fetchError: kept.error } : {}) }
    : null
  const own = local?.status === 'ok' ? local : null
  if (fetched && own) {
    if (localFallbackOnly || Date.parse(own.observedAt) <= Date.parse(fetched.observedAt)) return fetched
    // A local reading (Claude's status line) sees only the plan-wide windows. Keep the fetched model-group windows it
    // cannot see, so a group's line (such as Fable) does not come and go with whichever reading is newer.
    const seen = new Set(own.windows.map((w) => `${w.name ?? ''}\0${w.label}`))
    // Those windows keep the time and source they were read at: the newer reading did not cover them (ADR-0073).
    const groups = fetched.windows
      .filter((w) => w.name && !seen.has(`${w.name}\0${w.label}`))
      .map((w): QuotaWindow => {
        const observedAt = w.observedAt ?? fetched.observedAt
        const source = w.source ?? fetched.source
        return {
          ...w,
          ...(observedAt !== own.observedAt ? { observedAt } : {}),
          ...(source !== own.source ? { source } : {}),
        }
      })
    // A local reading knows nothing of Limit Resets; the Host's own count stays, with its own read time.
    const limitResets = own.limitResets ?? fetched.limitResets
    if (!groups.length && !limitResets) return own
    return { ...own, windows: [...own.windows, ...groups], ...(limitResets ? { limitResets } : {}) }
  }
  if (fetched) return fetched
  if (own) return kept?.error ? { ...own, fetchError: kept.error } : own
  if (off) return { status: 'unavailable', reason: 'not-enabled', detail: off }
  if (kept?.error) return { status: 'unavailable', reason: 'fetch-failed', detail: kept.error }
  return local ?? { status: 'unavailable', reason: 'no-session' }
}
