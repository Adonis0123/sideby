// The Claude Quota cache: one module owns where it lives, how the Account is named, and how it is written,
// read and validated. The status line tap writes it on every refresh, so this module imports only leaf
// modules and Node built-ins (never the Family index, the Runtime or core/accounts.ts).
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ACCOUNT_NAME } from '../../core/account-name.ts'
import { writeFileAtomic } from '../../core/fs-safe.ts'
import { resolvePaths } from '../../core/paths.ts'
import type { Env, QuotaWindow } from '../../types.ts'
import { CLAUDE_ACCOUNT_PREFIX, CLAUDE_MAIN_DIR } from './layout.ts'

export interface ClaudeQuotaCache {
  version: 1
  /** When the status line last reported these windows. */
  observedAt: string
  windows: QuotaWindow[]
  /**
   * Per status line session id: a hash of the windows it last reported and when that changed. Only these two values
   * are kept for a session (at most {@link MAX_SESSIONS}, none older than {@link SESSION_DAYS} days). Files written
   * before sessions were tracked have none.
   */
  sessions?: Record<string, SessionSeen>
}

export interface SessionSeen {
  hash: string
  seenAt: string
}

/** A status line reading: the cache fields and, when Claude Code sent one, the session that reported it. */
export interface QuotaReading extends ClaudeQuotaCache {
  sessionId?: string
}

const MAX_SESSIONS = 32
const SESSION_DAYS = 8
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

const WINDOWS = [
  { key: 'five_hour', label: '5h', minutes: 300 },
  { key: 'seven_day', label: '7d', minutes: 10_080 },
] as const

export function claudeQuotaCacheFile(stateDir: string, name: string): string {
  return join(stateDir, 'quota', 'claude', `${name}.json`)
}

/** sideby's state directory for this environment (same rule as the Runtime). */
export function cacheStateDir(env: Env): string {
  return resolvePaths(env).stateDir
}

/** Account name from CLAUDE_CONFIG_DIR: unset or `~/.claude` is `main`, `.claude-<name>` is `<name>`, else null. */
export function accountNameFromEnv(env: Env): string | null {
  const dir = env.CLAUDE_CONFIG_DIR
  if (!dir) return 'main'
  if (resolve(dir) === join(env.HOME || homedir(), CLAUDE_MAIN_DIR)) return 'main'
  const base = basename(dir)
  if (!base.startsWith(CLAUDE_ACCOUNT_PREFIX)) return null
  const name = base.slice(CLAUDE_ACCOUNT_PREFIX.length)
  return name !== 'main' && ACCOUNT_NAME.test(name) ? name : null
}

/** Extracts the 5h and 7d windows and the session id from status line JSON; null when there is nothing usable. */
export function parseRateLimits(input: string, observedAt: Date): QuotaReading | null {
  let data: unknown
  try {
    data = JSON.parse(input)
  } catch {
    return null
  }
  const rl = (data as { rate_limits?: unknown } | null)?.rate_limits
  if (typeof rl !== 'object' || rl === null) return null
  const windows: QuotaWindow[] = []
  for (const w of WINDOWS) {
    const v = (rl as Record<string, unknown>)[w.key] as { used_percentage?: unknown; resets_at?: unknown }
    if (typeof v !== 'object' || v === null) continue
    const used = v.used_percentage
    const resets = v.resets_at
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) continue
    windows.push({
      label: w.label,
      windowMinutes: w.minutes,
      usedPercent: used,
      resetsAt: new Date(resets * 1000).toISOString(),
    })
  }
  if (!windows.length) return null
  const id = (data as { session_id?: unknown }).session_id
  return {
    version: 1,
    observedAt: observedAt.toISOString(),
    windows,
    ...(typeof id === 'string' && SESSION_ID.test(id) ? { sessionId: id } : {}),
  }
}

/** Two readings belong to one window when their resets are less than a quarter of the window apart. */
function sameWindow(a: QuotaWindow, b: QuotaWindow): boolean {
  return Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) < (a.windowMinutes * 60_000) / 4
}

const sameReading = (a: QuotaWindow, b: QuotaWindow) =>
  a.label === b.label &&
  a.windowMinutes === b.windowMinutes &&
  a.usedPercent === b.usedPercent &&
  a.resetsAt === b.resetsAt

const order = (label: string) => {
  const i = WINDOWS.findIndex((w) => w.label === label)
  return i < 0 ? WINDOWS.length : i
}

/** What a session reported, as a short hash: equal hashes mean the session has made no request since. */
function windowsHash(windows: readonly QuotaWindow[]): string {
  const key = windows.map((w) => [w.label, w.usedPercent, w.resetsAt])
  return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16)
}

/** The newest {@link MAX_SESSIONS} sessions seen in the last {@link SESSION_DAYS} days before `now`. */
function pruneSessions(sessions: Record<string, SessionSeen>, now: string): Record<string, SessionSeen> {
  const oldest = Date.parse(now) - SESSION_DAYS * 86_400_000
  const kept = Object.entries(sessions)
    .filter(([, s]) => Date.parse(s.seenAt) >= oldest)
    .sort((a, b) => Date.parse(b[1].seenAt) - Date.parse(a[1].seenAt))
    .slice(0, MAX_SESSIONS)
  return Object.fromEntries(kept)
}

/**
 * Merges a status line reading into the cache (spec §3.7). Each session reports the Quota of its own last request, so
 * an idle session of the same Account keeps repeating older numbers. A reading whose session reported exactly these
 * windows before carries nothing new: null, so nothing is written. A reading that changed, or the first of a session,
 * is a fresh request result and wins for every window it has, the vendor's resets included; a window it lacks is
 * kept. A reading without a session id falls back to: within one window the higher use wins, otherwise the reading
 * wins; null when that only repeats the cache.
 */
export function mergeQuotaCache(
  cached: Pick<ClaudeQuotaCache, 'windows' | 'sessions'> | null,
  next: QuotaReading,
): ClaudeQuotaCache | null {
  const { sessionId, ...reading } = next
  const before = cached?.windows ?? []
  const keepLacking = (windows: QuotaWindow[]) => {
    for (const c of before) if (!windows.some((w) => w.label === c.label)) windows.push(c)
    return windows.sort((a, b) => order(a.label) - order(b.label))
  }
  if (sessionId) {
    const hash = windowsHash(reading.windows)
    if (cached?.sessions?.[sessionId]?.hash === hash) return null
    const sessions = pruneSessions(
      { ...cached?.sessions, [sessionId]: { hash, seenAt: reading.observedAt } },
      reading.observedAt,
    )
    return { ...reading, windows: keepLacking([...reading.windows]), sessions }
  }
  let older = false
  const windows = keepLacking(
    reading.windows.map((w) => {
      const c = before.find((x) => x.label === w.label)
      const keep = !!c && sameWindow(c, w) && c.usedPercent > w.usedPercent
      if (keep) older = true
      return keep ? c : w
    }),
  )
  const unchanged =
    windows.length === before.length && windows.every((w) => before.some((c) => sameReading(c, w)))
  if (older && unchanged) return null
  return { ...reading, windows, ...(cached?.sessions ? { sessions: cached.sessions } : {}) }
}

/** Writes the cache atomically; creates the private parent directory first (writeFileAtomic does not). */
export async function writeQuotaCache(
  stateDir: string,
  name: string,
  cache: ClaudeQuotaCache,
): Promise<void> {
  const file = claudeQuotaCacheFile(stateDir, name)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify(cache)}\n`, 0o600)
}

function validWindow(w: unknown): w is QuotaWindow {
  if (typeof w !== 'object' || w === null) return false
  const v = w as Record<string, unknown>
  return (
    typeof v.label === 'string' &&
    typeof v.windowMinutes === 'number' &&
    typeof v.usedPercent === 'number' &&
    typeof v.resetsAt === 'string' &&
    Number.isFinite(Date.parse(v.resetsAt))
  )
}

export type CacheRead =
  | { status: 'ok'; observedAt: string; windows: QuotaWindow[]; sessions?: Record<string, SessionSeen> }
  | { status: 'missing' }
  | { status: 'unrecognized'; detail: string }

/**
 * Reads the cache. Accepts any file with a parseable `observedAt` and at least one valid window; `version`
 * is not enforced so caches written by earlier releases keep working.
 */
export async function readQuotaCache(stateDir: string, name: string): Promise<CacheRead> {
  const file = claudeQuotaCacheFile(stateDir, name)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw err
  }
  let cache: { observedAt?: unknown; windows?: unknown; sessions?: unknown }
  try {
    cache = JSON.parse(raw) as typeof cache
  } catch {
    return { status: 'unrecognized', detail: `${file} is not valid JSON` }
  }
  const windows = Array.isArray(cache?.windows) ? cache.windows.filter(validWindow) : []
  if (
    typeof cache?.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(cache.observedAt)) ||
    !windows.length
  )
    return { status: 'unrecognized', detail: `${file} has no usable quota windows` }
  const sessions = validSessions(cache.sessions)
  return { status: 'ok', observedAt: cache.observedAt, windows, ...(sessions ? { sessions } : {}) }
}

/** The well-formed session entries of a cache file; undefined when it has none (older files). */
function validSessions(raw: unknown): Record<string, SessionSeen> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, SessionSeen> = {}
  for (const [id, v] of Object.entries(raw)) {
    const s = v as Partial<SessionSeen> | null
    if (
      SESSION_ID.test(id) &&
      typeof s?.hash === 'string' &&
      typeof s.seenAt === 'string' &&
      Number.isFinite(Date.parse(s.seenAt))
    )
      out[id] = { hash: s.hash, seenAt: s.seenAt }
  }
  return Object.keys(out).length ? out : undefined
}
