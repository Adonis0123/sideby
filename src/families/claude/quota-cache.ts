// The Claude Quota cache: one module owns where it lives, how the Account is named, and how it is written,
// read and validated. The status line tap writes it on every refresh, so this module imports only leaf
// modules and Node built-ins (never the Family index, the Runtime or core/accounts.ts).
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
}

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

/** Extracts the 5h and 7d windows from status line JSON; null when there is nothing usable. */
export function parseRateLimits(input: string, observedAt: Date): ClaudeQuotaCache | null {
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
  return windows.length ? { version: 1, observedAt: observedAt.toISOString(), windows } : null
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
  | { status: 'ok'; observedAt: string; windows: QuotaWindow[] }
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
  let cache: { observedAt?: unknown; windows?: unknown }
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
  return { status: 'ok', observedAt: cache.observedAt, windows }
}
