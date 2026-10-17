// Grok Build's Quota (spec §3.26, ADR-0025): how its billing answer becomes a Quota reading, and the local copy Grok
// writes into `$GROK_HOME/logs/unified.jsonl` at every session start and finished turn. Other lines of that file carry
// the user id and the end of the bearer token, so only lines whose `msg` is exactly the billing one are parsed, and
// only the Quota fields and the plan name are kept. Leaf module: the handoff hook reads the log too.
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FileMemo } from '../../core/file-memo.ts'
import type { QuotaResult, QuotaWindow } from '../../types.ts'

export type GrokQuota = Extract<QuotaResult, { status: 'ok' }>

export const GROK_BILLING_MSG = 'billing: fetched credits config'
const WEEKLY = 'USAGE_PERIOD_TYPE_WEEKLY'
const WEEK_MINUTES = 7 * 24 * 60
const CHUNK = 64 * 1024
/** How far back the CLI and the Panel look (Grok halves the file at 5 MB) and how far the handoff hook does. */
export const LOG_READ_BYTES = 8 * 1024 * 1024
export const HOOK_LOG_READ_BYTES = 512 * 1024

export function grokLogFile(accountDir: string): string {
  return join(accountDir, 'logs', 'unified.jsonl')
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * A Quota reading from Grok's billing answer: `{ config, subscription_tier }` from `_x.ai/billing`, or the log line's
 * `ctx` (`{ config, subscriptionTier }`). Null when it holds no usable window.
 */
export function grokQuota(answer: unknown, observedAt: string, source: string): GrokQuota | null {
  const top = record(answer)
  const config = record(top.config)
  const period = record(config.currentPeriod)
  const weekly = period.type === WEEKLY
  const end = Date.parse(str(period.end) ?? str(config.billingPeriodEnd) ?? '')
  if (!Number.isFinite(end)) return null
  const start = Date.parse(str(period.start) ?? str(config.billingPeriodStart) ?? '')
  let used = num(config.creditUsagePercent) ?? num(top.creditUsagePercent)
  if (used === undefined) {
    const spent = num(record(config.used).val)
    const limit = num(record(config.monthlyLimit).val)
    if (spent !== undefined && limit) used = (spent / limit) * 100
    else if (weekly) used = 0
  }
  if (used === undefined) return null
  let minutes = Number.isFinite(start) && end > start ? Math.round((end - start) / 60_000) : undefined
  if (weekly) minutes = WEEK_MINUTES
  if (minutes === undefined) return null
  const days = Math.max(1, Math.round(minutes / 1440))
  const window: QuotaWindow = {
    label: minutes === WEEK_MINUTES ? '7d' : `${days}d`,
    windowMinutes: minutes,
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAt: new Date(end).toISOString(),
  }
  const plan = str(top.subscription_tier) ?? str(top.subscriptionTier)
  return { status: 'ok', windows: [window], observedAt, source, ...(plan ? { plan } : {}) }
}

/** The Quota of one log line, or null for every line that is not Grok's billing line. */
function billingLine(line: string, source: string): GrokQuota | null {
  // A cheap check first: most lines are never parsed.
  if (!line.includes(GROK_BILLING_MSG)) return null
  let data: Record<string, unknown>
  try {
    data = record(JSON.parse(line))
  } catch {
    return null
  }
  const ts = str(data.ts)
  if (data.msg !== GROK_BILLING_MSG || !ts || !Number.isFinite(Date.parse(ts))) return null
  const ctx = record(data.ctx)
  return grokQuota(
    { config: ctx.config, subscriptionTier: ctx.subscriptionTier },
    new Date(Date.parse(ts)).toISOString(),
    source,
  )
}

/** The newest billing line in the last `maxBytes` of `file`, read backwards a chunk at a time; null when none. */
export async function lastGrokBilling(
  file: string,
  maxBytes: number,
  source = file,
): Promise<GrokQuota | null> {
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const size = (await fh.stat()).size
    let pos = size
    // The start of the earliest line read so far, which may continue in the chunk before it.
    let head: Buffer = Buffer.alloc(0)
    while (pos > 0 && size - pos < maxBytes) {
      const len = Math.min(CHUNK, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      const chunk = Buffer.concat([buf, head])
      const cut = pos > 0 ? chunk.indexOf(0x0a) : -1
      head = cut >= 0 ? chunk.subarray(0, cut) : Buffer.alloc(0)
      const lines = chunk
        .subarray(cut + 1)
        .toString('utf8')
        .split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const q = billingLine(lines[i]!, source)
        if (q) return q
      }
    }
    return null
  } finally {
    await fh.close()
  }
}

/** The log's reading per Account directory; the file is read again only after it changed. */
export const grokQuotaMemo = new FileMemo<GrokQuota | null>()

/** Grok's local Quota for one Account directory: its newest billing line. */
export async function readGrokLogQuota(accountDir: string): Promise<QuotaResult> {
  const file = grokLogFile(accountDir)
  const none: QuotaResult = {
    status: 'unavailable',
    reason: 'no-session',
    detail: 'Grok has not reported the quota of this account yet',
  }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return none
  }
  const memo = grokQuotaMemo.pass(accountDir)
  const q = await memo.get(file, st, () => lastGrokBilling(file, LOG_READ_BYTES, 'logs/unified.jsonl'))
  memo.done()
  return q ?? none
}
