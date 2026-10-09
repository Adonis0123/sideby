// Codex `rate_limits` in rollout `token_count` events: the windows the Quota reader and the handoff hook share.
// The hook runs on every tool call, so this module imports only Node built-ins (spec §3.17).
import { open } from 'node:fs/promises'
import type { QuotaWindow } from '../../types.ts'

type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const MAX_RESETS_AT_SECONDS = 1e11

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

/** The windows of one `token_count` payload, or null when its `rate_limits` is missing or malformed. */
export function rateLimits(payload: Obj): { windows: QuotaWindow[]; plan?: string } | null {
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

/** How much of a rollout's end the hook reads: `token_count` events come at least once per turn. */
const TAIL_BYTES = 256 * 1024

/**
 * The windows of the last well-formed `rate_limits` in the rollout's last 256 KB, or null. A line cut by the read
 * window or still being written is skipped. Codex writes `rate_limits` after caching them, so they may lag.
 */
export async function lastRateLimits(file: string): Promise<QuotaWindow[] | null> {
  let text: string
  try {
    const fh = await open(file, 'r')
    try {
      const { size } = await fh.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      await fh.read(buf, 0, buf.length, start)
      text = buf.toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('rate_limits')) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(o) || !isObj(o.payload) || o.payload.type !== 'token_count') continue
    const rl = rateLimits(o.payload)
    if (rl) return rl.windows
  }
  return null
}
