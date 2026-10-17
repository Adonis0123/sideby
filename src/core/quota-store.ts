// The kept answers of `FamilyDef.fetchQuota` (spec §3.26): one file per Account in sideby's state directory, with the
// Quota numbers, reset times and plan name only. The handoff hook reads it, so this module imports only Node
// built-ins and leaf modules (never the Runtime, a Family index or core/accounts.ts).
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { QuotaResult, QuotaWindow } from '../types.ts'
import { writeFileAtomic } from './fs-safe.ts'

export type FetchedQuota = Extract<QuotaResult, { status: 'ok' }>

export interface QuotaStoreEntry {
  version: 1
  /** When the latest fetch finished, good or not; the next one waits `everyMinutes` from here. */
  attemptedAt: string
  /** The latest good answer, kept while later fetches fail. */
  quota?: FetchedQuota
  /** Why the latest fetch failed, when it did. */
  error?: string
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
    typeof v.resetsAt === 'string'
  )
}

/** Only the fields a Quota reading may carry, so a plugin's extra fields never reach the file. */
export function keptQuota(q: FetchedQuota): FetchedQuota {
  return {
    status: 'ok',
    windows: q.windows.filter(isWindow).map((w) => ({
      label: w.label,
      ...(w.name ? { name: w.name } : {}),
      windowMinutes: w.windowMinutes,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
    })),
    observedAt: q.observedAt,
    source: q.source,
    ...(typeof q.plan === 'string' && q.plan ? { plan: q.plan } : {}),
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
    ...(quota ? { quota } : {}),
    ...(typeof e.error === 'string' ? { error: e.error } : {}),
  }
}

export async function writeQuotaStore(file: string, entry: QuotaStoreEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify(entry)}\n`, 0o600)
}
