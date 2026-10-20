// When sideby calls a Family's `fetchQuota`, and what it shows from the answer (spec §3.26, ADR-0025): the last answer
// is kept per Account, asked again only when it is older than the Family's `everyMinutes` or the user refreshes, one
// fetch per Account at a time, 20 seconds at most; the newer of the kept answer and the local reading is shown.
import type { Account, Env, QuotaFetch, QuotaResult, ReadContext } from '../types.ts'
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

export const FETCH_TIMEOUT_MS = 20_000
/** How long a `background` read waits when nothing is kept yet, so a first Panel load still shows Quota. */
const FIRST_WAIT_MS = 4_000

/** One fetch per Account file at a time, shared by every reader in this process. */
const inFlight = new Map<string, Promise<QuotaStoreEntry>>()

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
): Promise<QuotaStoreEntry> {
  const kept = await readQuotaStore(file)
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
  const quota = answer?.status === 'ok' ? keptQuota(answer) : kept?.quota
  const entry: QuotaStoreEntry = {
    version: 1,
    attemptedAt: new Date().toISOString(),
    ...(quota ? { quota } : {}),
    ...(error ? { error } : {}),
  }
  await writeQuotaStore(file, entry).catch(() => {})
  return entry
}

/** The kept answer for `account`, after asking again when `mode` and its age say so. */
export async function fetchedQuota(
  fq: QuotaFetch,
  account: Account,
  ctx: ReadContext,
  hostEnv: Env,
  mode: QuotaFetchMode,
): Promise<QuotaStoreEntry | null> {
  const file = quotaStoreFile(ctx.stateDir, account.family, account.name)
  const kept = await readQuotaStore(file)
  if (mode === 'never') return kept
  const at = kept ? Date.parse(kept.attemptedAt) : Number.NaN
  const age = ctx.now.getTime() - at
  // A time in the future (a changed clock) counts as old, so it cannot stop every later fetch.
  const stale = !kept || !Number.isFinite(at) || age < -60_000 || age >= fq.everyMinutes * 60_000
  if (mode !== 'force' && !stale) return kept
  let run = inFlight.get(file)
  if (!run) {
    run = runFetch(fq, account, ctx, hostEnv, file).finally(() => inFlight.delete(file))
    inFlight.set(file, run)
  }
  if (mode !== 'background') return run
  run.catch(() => {})
  if (kept) return kept
  return Promise.race([run, sleep(FIRST_WAIT_MS)]).then((e) => e ?? kept)
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
  if (fetched && own)
    return !localFallbackOnly && Date.parse(own.observedAt) > Date.parse(fetched.observedAt) ? own : fetched
  if (fetched) return fetched
  if (own) return kept?.error ? { ...own, fetchError: kept.error } : own
  if (off) return { status: 'unavailable', reason: 'not-enabled', detail: off }
  if (kept?.error) return { status: 'unavailable', reason: 'fetch-failed', detail: kept.error }
  return local ?? { status: 'unavailable', reason: 'no-session' }
}
