// Reads Codex Quota and Usage from the Account's local rollout files (spec §3.7, ADR-0003).
// No network, no credentials: only `token_count` events the Host writes into `sessions/**/rollout-*.jsonl`.
import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { USAGE_DAYS } from '../../core/quota-levels.ts'
import { dailyBuckets } from '../../core/usage-days.ts'
import type { QuotaResult, QuotaWindow, UsageResult } from '../../types.ts'

export const MAX_QUOTA_FILES = 20
const ROLLOUT = /^rollout-.*\.jsonl$/
const MAX_RESETS_AT_SECONDS = 1e11

export interface RolloutFile {
  path: string
  mtimeMs: number
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Every rollout file under `<dir>/sessions`, newest mtime first. */
export async function listRollouts(dir: string): Promise<RolloutFile[]> {
  const root = join(dir, 'sessions')
  let entries: Dirent[]
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const out: RolloutFile[] = []
  for (const e of entries) {
    if (!e.isFile() || !ROLLOUT.test(e.name)) continue
    const path = join(e.parentPath, e.name)
    try {
      out.push({ path, mtimeMs: (await stat(path)).mtimeMs })
    } catch {
      // removed while scanning
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Yields parsed `token_count` payloads with their event time; bad and truncated lines are skipped. */
async function* tokenCounts(file: string): AsyncGenerator<{ at: number; payload: Obj }> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      if (!line.includes('token_count')) continue
      let o: unknown
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObj(o) || !isObj(o.payload) || o.payload.type !== 'token_count') continue
      const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN
      if (!Number.isFinite(at)) continue
      yield { at, payload: o.payload }
    }
  } catch {
    // unreadable file: keep what was read
  } finally {
    lines.close()
  }
}

export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h'
  if (minutes === 10080) return '7d'
  return `${minutes}m`
}

function quotaWindow(raw: unknown): QuotaWindow | null {
  if (!isObj(raw)) return null
  const { used_percent: used, window_minutes: minutes, resets_at: resets } = raw
  if (!isNum(used) || !isNum(minutes) || minutes <= 0) return null
  // Seconds since the epoch; a millisecond value would land tens of thousands of years ahead.
  if (!isNum(resets) || resets <= 0 || resets >= MAX_RESETS_AT_SECONDS) return null
  return {
    label: windowLabel(minutes),
    windowMinutes: minutes,
    usedPercent: used,
    resetsAt: new Date(resets * 1000).toISOString(),
  }
}

function rateLimits(payload: Obj): { windows: QuotaWindow[]; plan?: string } | null {
  const rl = payload.rate_limits
  if (!isObj(rl)) return null
  const primary = quotaWindow(rl.primary)
  if (!primary) return null
  const windows = [primary]
  if (rl.secondary !== null && rl.secondary !== undefined) {
    const secondary = quotaWindow(rl.secondary)
    if (!secondary) return null
    windows.push(secondary)
  }
  return { windows, ...(typeof rl.plan_type === 'string' ? { plan: rl.plan_type } : {}) }
}

/** Newest well-formed `rate_limits` across the newest rollout files, by event timestamp. */
export async function readCodexQuota(dir: string): Promise<QuotaResult> {
  const files = (await listRollouts(dir)).slice(0, MAX_QUOTA_FILES)
  if (files.length === 0)
    return { status: 'unavailable', reason: 'no-session', detail: 'no Codex session in this account yet' }
  let best: { at: number; file: string; windows: QuotaWindow[]; plan?: string } | null = null
  for (const f of files) {
    for await (const { at, payload } of tokenCounts(f.path)) {
      if (best && at < best.at) continue
      const rl = rateLimits(payload)
      if (rl) best = { at, file: f.path, ...rl }
    }
  }
  if (!best)
    return {
      status: 'unavailable',
      reason: 'unrecognized',
      detail: `no rate_limits event in the newest ${files.length} rollout file(s)`,
    }
  return {
    status: 'ok',
    windows: best.windows,
    observedAt: new Date(best.at).toISOString(),
    source: relative(dir, best.file),
    ...(best.plan ? { plan: best.plan } : {}),
  }
}

interface Totals {
  input: number
  cached: number
  output: number
  cacheWrite: number
}

function parseTotals(t: unknown): Totals | null {
  if (!isObj(t) || !isNum(t.input_tokens) || !isNum(t.output_tokens)) return null
  return {
    input: t.input_tokens,
    cached: isNum(t.cached_input_tokens) ? t.cached_input_tokens : 0,
    output: t.output_tokens,
    cacheWrite: isNum(t.cache_write_input_tokens) ? t.cache_write_input_tokens : 0,
  }
}

/** Cumulative totals so far in the session, plus this turn's own usage when the event carries it. */
function totals(payload: Obj): { total: Totals; turn: Totals | null } | null {
  const info = payload.info
  if (!isObj(info)) return null
  const total = parseTotals(info.total_token_usage)
  return total ? { total, turn: parseTotals(info.last_token_usage) } : null
}

const ZERO: Totals = { input: 0, cached: 0, output: 0, cacheWrite: 0 }
const FIELDS = ['input', 'cached', 'output', 'cacheWrite'] as const
const size = (t: Totals) => t.input + t.output + t.cacheWrite
const plus = (a: Totals, b: Totals): Totals => ({
  input: a.input + b.input,
  cached: a.cached + b.cached,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
const minus = (a: Totals, b: Totals): Totals => ({
  input: Math.max(0, a.input - b.input),
  cached: Math.max(0, a.cached - b.cached),
  output: Math.max(0, a.output - b.output),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
})
/** True when any counter went down: each one only grows within a segment. */
const dropped = (now: Totals, prev: Totals) => FIELDS.some((k) => now[k] < prev[k])

/**
 * What each event adds, by index. `total_token_usage` is cumulative per segment: every field, cached input
 * included, only grows until the Host starts a new segment, where they all start again from zero. A subagent's
 * file starts from its parent's running total. So the first event adds its total minus the starting baseline
 * (that total minus the first turn's own usage, zero for an ordinary session), an event where any field went
 * down starts a new segment and adds its whole total, and any other event adds its growth. Every field of every
 * increment is therefore zero or more, and any run of events sums to exactly what it added.
 */
export function fileDeltas(events: { total: Totals; turn: Totals | null }[]): Totals[] {
  if (events.length === 0) return []
  const first = events[0]!
  const baseline = first.turn ? minus(first.total, first.turn) : ZERO
  const out = [minus(first.total, baseline)]
  let prev = first.total
  for (const e of events.slice(1)) {
    out.push(dropped(e.total, prev) ? minus(e.total, ZERO) : minus(e.total, prev))
    prev = e.total
  }
  return out
}

/** Tokens one whole rollout file adds: the sum of its fileDeltas. */
export function fileTokens(events: { total: Totals; turn: Totals | null }[]): Totals | null {
  if (events.length === 0) return null
  return fileDeltas(events).reduce(plus, ZERO)
}

/**
 * Token totals for events in the last `days` x 24 h, from rollout files modified in that window (mtime only
 * picks which files to read). Each event counts its fileDeltas increment, so a long session resumed today
 * adds only its recent turns. `daily` spreads the same increments over local days.
 */
export async function readCodexUsage(dir: string, now: Date, days = USAGE_DAYS): Promise<UsageResult> {
  const end = now.getTime()
  const since = end - days * 24 * 60 * 60 * 1000
  const files = (await listRollouts(dir)).filter((f) => f.mtimeMs >= since)
  if (files.length === 0)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Codex session in the last ${days} days`,
    }
  let sessions = 0
  let sawTokenCount = false
  let sawTotals = false
  let last = Number.NEGATIVE_INFINITY
  const daily = dailyBuckets(now, days)
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const f of files) {
    const events: { at: number; total: Totals; turn: Totals | null }[] = []
    for await (const { at, payload } of tokenCounts(f.path)) {
      sawTokenCount = true
      if (at <= end && at > last) last = at
      const t = totals(payload)
      if (t) events.push({ at, ...t })
    }
    if (events.length) sawTotals = true
    const deltas = fileDeltas(events)
    let used = ZERO
    let inWindow = false
    for (const [i, e] of events.entries()) {
      if (e.at < since || e.at > end) continue
      inWindow = true
      used = plus(used, deltas[i]!)
      daily.add(e.at, size(deltas[i]!))
    }
    if (!inWindow) continue
    sessions++
    const cached = Math.min(used.cached, used.input)
    sum.inputTokens += used.input - cached
    sum.cacheReadTokens += cached
    sum.outputTokens += used.output
    sum.cacheWriteTokens += used.cacheWrite
  }
  if (sessions === 0)
    return sawTokenCount && !sawTotals
      ? { status: 'unavailable', reason: 'unrecognized', detail: 'token_count events have no usable totals' }
      : { status: 'unavailable', reason: 'no-session', detail: `no Codex turn in the last ${days} days` }
  return {
    status: 'ok',
    days,
    sessions,
    ...sum,
    totalTokens: sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens,
    daily: daily.daily,
    ...(Number.isFinite(last) ? { lastActivityAt: new Date(last).toISOString() } : {}),
  }
}
