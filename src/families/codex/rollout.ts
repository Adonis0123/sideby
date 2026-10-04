// Reads Codex Quota and Usage from the Account's local rollout files (spec §3.7, ADR-0003).
// No network, no credentials: only `token_count` events the Host writes into `sessions/**/rollout-*.jsonl`.
import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { USAGE_DAYS } from '../../core/quota-levels.ts'
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

/**
 * Tokens one rollout file adds. `total_token_usage` is cumulative but not monotonic: it can drop back
 * mid-file (a new segment starts), and a subagent's file starts from its parent's running total. So:
 * sum the final value of every segment, then subtract the starting baseline (first total minus that
 * first turn's own usage), which is zero for an ordinary session.
 */
export function fileTokens(events: { total: Totals; turn: Totals | null }[]): Totals | null {
  if (events.length === 0) return null
  const first = events[0]!
  const baseline = first.turn ? minus(first.total, first.turn) : ZERO
  let done = ZERO
  let prev = first.total
  for (const e of events.slice(1)) {
    if (size(e.total) < size(prev)) done = plus(done, prev)
    prev = e.total
  }
  return minus(plus(done, prev), baseline)
}

/**
 * Token totals for rollout files modified in the last `days` days; see fileTokens for how one file counts.
 */
export async function readCodexUsage(dir: string, now: Date, days = USAGE_DAYS): Promise<UsageResult> {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000
  const files = (await listRollouts(dir)).filter((f) => f.mtimeMs >= since)
  if (files.length === 0)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Codex session in the last ${days} days`,
    }
  let sessions = 0
  let sawTokenCount = false
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const f of files) {
    const events: { total: Totals; turn: Totals | null }[] = []
    for await (const { payload } of tokenCounts(f.path)) {
      sawTokenCount = true
      const t = totals(payload)
      if (t) events.push(t)
    }
    const used = fileTokens(events)
    if (!used) continue
    sessions++
    const cached = Math.min(used.cached, used.input)
    sum.inputTokens += used.input - cached
    sum.cacheReadTokens += cached
    sum.outputTokens += used.output
    sum.cacheWriteTokens += used.cacheWrite
  }
  if (sessions === 0)
    return sawTokenCount
      ? { status: 'unavailable', reason: 'unrecognized', detail: 'token_count events have no usable totals' }
      : { status: 'unavailable', reason: 'no-session', detail: `no Codex turn in the last ${days} days` }
  return {
    status: 'ok',
    days,
    sessions,
    ...sum,
    totalTokens: sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens,
  }
}
