// Asks Antigravity CLI for the Main Account's Quota (spec §3.26, ADR-0048): `agy -p /usage --output-format json` runs
// the `/usage` command with agy's own sign-in and starts no model turn (`num_turns` 0, every token count 0; tried with
// agy 1.4.4 on 2026-10-21). sideby never reads the sign-in and sends no request of its own.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { Account, QuotaFetch, QuotaFetchContext, QuotaResult, QuotaWindow } from '../../types.ts'

export const AGY_QUOTA_ARGS = ['-p', '/usage', '--output-format', 'json'] as const
/** agy answers in about 6 s; anything far larger than its answer is not one. */
const MAX_OUTPUT = 256 * 1024

const failed = (detail: string): QuotaResult => ({ status: 'unavailable', reason: 'fetch-failed', detail })

const WINDOWS: Record<string, { label: string; minutes: number }> = {
  '5h': { label: '5h', minutes: 300 },
  weekly: { label: '7d', minutes: 7 * 24 * 60 },
}

/**
 * The Quota in agy's JSON answer: one window per bucket, named after its model group, since each limit covers only
 * that group's models. Only group names, windows, percentages and reset times are kept.
 */
export function agyQuota(answer: unknown, observedAt: string): QuotaResult | null {
  if (typeof answer !== 'object' || answer === null) return null
  const a = answer as { status?: unknown; error?: unknown; command?: { data?: { groups?: unknown } } }
  if (a.status !== 'SUCCESS') return null
  const groups = a.command?.data?.groups
  if (!Array.isArray(groups)) return null
  const windows: QuotaWindow[] = []
  for (const g of groups) {
    const name = typeof g?.name === 'string' ? g.name.slice(0, 60) : undefined
    if (!name || !Array.isArray(g.buckets)) continue
    for (const b of g.buckets) {
      const w = WINDOWS[b?.window]
      const left = b?.remaining_fraction
      if (!w || typeof left !== 'number' || !Number.isFinite(left)) continue
      const resets = typeof b.reset_time === 'string' ? Date.parse(b.reset_time) : Number.NaN
      if (!Number.isFinite(resets)) continue
      windows.push({
        label: w.label,
        name,
        windowMinutes: w.minutes,
        usedPercent: Math.round(Math.min(1, Math.max(0, 1 - left)) * 100),
        resetsAt: new Date(resets).toISOString(),
      })
    }
  }
  return windows.length ? { status: 'ok', windows, observedAt, source: 'agy /usage' } : null
}

/** Why agy's answer gave no Quota, and what to do. agy's own words are only matched, never repeated. */
function errorDetail(account: Account, answer: unknown): string {
  const { status, error } = (answer ?? {}) as { status?: unknown; error?: unknown }
  if (status === 'SUCCESS')
    return 'Antigravity CLI answered in a form sideby does not recognise; update sideby'
  if (typeof error === 'string' && /auth/i.test(error))
    return `Antigravity CLI is not signed in; run \`sideby login ${account.ref}\` and sign in with Google`
  return 'Antigravity CLI could not report the quota; sideby asks again later, or start agy once'
}

export async function fetchAgyQuota(account: Account, ctx: QuotaFetchContext): Promise<QuotaResult> {
  if (ctx.signal.aborted) return failed('the quota check was stopped')
  const child = spawn('agy', [...AGY_QUOTA_ARGS], {
    cwd: tmpdir(),
    env: ctx.hostEnv,
    // stderr holds a sign-in link when signed out: never read.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  ctx.signal.addEventListener('abort', stop, { once: true })
  try {
    return await new Promise<QuotaResult>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      child.stdout.on('data', (b: Buffer) => {
        size += b.length
        if (size > MAX_OUTPUT) return stop()
        chunks.push(b)
      })
      child.on('error', (err: NodeJS.ErrnoException) =>
        resolve(
          failed(
            err.code === 'ENOENT'
              ? 'Antigravity CLI is not installed or not on PATH; install it, then refresh'
              : `could not start Antigravity CLI (${err.code ?? 'error'})`,
          ),
        ),
      )
      child.on('close', () => {
        if (ctx.signal.aborted) return resolve(failed('the quota check was stopped'))
        let answer: unknown
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return resolve(failed('Antigravity CLI exited without answering; sideby asks again later'))
        }
        resolve(agyQuota(answer, ctx.now.toISOString()) ?? failed(errorDetail(account, answer)))
      })
    })
  } finally {
    ctx.signal.removeEventListener('abort', stop)
    stop()
  }
}

export const agyQuotaFetch: QuotaFetch = {
  everyMinutes: 15,
  summary: 'Antigravity CLI asks Google for its quota, at most every 15 minutes',
  fetch: fetchAgyQuota,
}
