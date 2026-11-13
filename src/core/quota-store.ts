// The kept answers of `FamilyDef.fetchQuota` (spec §3.26): one file per Account in sideby's state directory, with the
// Quota numbers, reset times and plan name only. The handoff hook reads it, so this module imports only Node
// built-ins and leaf modules (never the Runtime, a Family index or core/accounts.ts).
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LimitResets, QuotaResult, QuotaWindow } from '../types.ts'
import { writeFileAtomic } from './fs-safe.ts'

export type FetchedQuota = Extract<QuotaResult, { status: 'ok' }>

export interface QuotaStoreEntry {
  version: 1
  /** When the latest fetch finished, good or not; the next one waits `everyMinutes` from here. */
  attemptedAt: string
  /**
   * When that fetch began asking the Host (the real clock). What it answers is the Quota of some moment after this,
   * so a reader that needs numbers from after a change (a Limit Reset just used, ADR-0072) compares against this,
   * not against when the answer was kept. Left out by an older sideby: such an answer counts as begun before any
   * change.
   */
  startedAt?: string
  /** The latest good answer, kept while later fetches fail. */
  quota?: FetchedQuota
  /** Why the latest fetch failed, when it did. */
  error?: string
  /**
   * When a fetch answered that the login expired (ADR-0071). Kept through later generic failures, dropped by the next
   * good answer.
   */
  loginExpiredAt?: string
  /**
   * The published reset instants (ISO) sideby already asked once more for (ADR-0073), written before that ask so a
   * failed one is not repeated. Only instants of the kept answer's own windows are kept.
   */
  resetAsked?: string[]
}

export function quotaStoreFile(stateDir: string, family: string, name: string): string {
  return join(stateDir, 'quota', family, `${name}.fetched.json`)
}

const isWindow = (w: unknown): w is QuotaWindow => {
  const v = w as Partial<QuotaWindow> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.label === 'string' &&
    (v.name === undefined || typeof v.name === 'string') &&
    typeof v.windowMinutes === 'number' &&
    typeof v.usedPercent === 'number' &&
    typeof v.resetsAt === 'string' &&
    (v.observedAt === undefined || typeof v.observedAt === 'string') &&
    (v.source === undefined || typeof v.source === 'string')
  )
}

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))

/** The Limit Resets of a reading with only the fields sideby keeps, or undefined when it is not a count. */
export function keptLimitResets(v: unknown): LimitResets | undefined {
  const r = v as Partial<LimitResets> | null
  if (typeof r !== 'object' || r === null) return undefined
  if (!Number.isInteger(r.available) || r.available! < 0 || !isTime(r.observedAt)) return undefined
  return {
    available: r.available!,
    observedAt: r.observedAt,
    ...(isTime(r.nextExpiresAt) ? { nextExpiresAt: r.nextExpiresAt } : {}),
  }
}

/** Only the fields a Quota reading may carry, so a plugin's extra fields never reach the file. */
export function keptQuota(q: FetchedQuota): FetchedQuota {
  const limitResets = keptLimitResets(q.limitResets)
  return {
    status: 'ok',
    windows: q.windows.filter(isWindow).map((w) => ({
      label: w.label,
      ...(w.name ? { name: w.name } : {}),
      windowMinutes: w.windowMinutes,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      // A window's own time and source only where they differ from the Quota's (ADR-0073).
      ...(w.observedAt && w.observedAt !== q.observedAt ? { observedAt: w.observedAt } : {}),
      ...(w.source && w.source !== q.source ? { source: w.source } : {}),
    })),
    observedAt: q.observedAt,
    source: q.source,
    ...(typeof q.plan === 'string' && q.plan ? { plan: q.plan } : {}),
    ...(limitResets ? { limitResets } : {}),
  }
}

/** The kept answer, or null when there is none or the file is not one sideby wrote. */
export async function readQuotaStore(file: string): Promise<QuotaStoreEntry | null> {
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  const e = data as Partial<QuotaStoreEntry> | null
  if (typeof e !== 'object' || e === null || e.version !== 1 || typeof e.attemptedAt !== 'string') return null
  const q = e.quota
  const quota =
    q && q.status === 'ok' && Array.isArray(q.windows) && typeof q.observedAt === 'string'
      ? keptQuota({ ...q, source: typeof q.source === 'string' ? q.source : '' })
      : undefined
  return {
    version: 1,
    attemptedAt: e.attemptedAt,
    ...(isTime(e.startedAt) ? { startedAt: e.startedAt } : {}),
    ...(quota ? { quota } : {}),
    ...(typeof e.error === 'string' ? { error: e.error } : {}),
    ...(typeof e.loginExpiredAt === 'string' && Number.isFinite(Date.parse(e.loginExpiredAt))
      ? { loginExpiredAt: e.loginExpiredAt }
      : {}),
    ...(Array.isArray(e.resetAsked) && e.resetAsked.some(isTime)
      ? { resetAsked: [...new Set(e.resetAsked.filter(isTime))] }
      : {}),
  }
}

export async function writeQuotaStore(file: string, entry: QuotaStoreEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify(entry)}\n`, 0o600)
}
