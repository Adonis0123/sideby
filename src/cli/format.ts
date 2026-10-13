import { quotaLevel } from '../core/quota-levels.ts'
import { MIN_CALLS } from '../core/tuning.ts'
import type { QuotaResult, QuotaWindow, TuningReason, TuningResult, UsageResult } from '../types.ts'

const useColor = (): boolean => !process.env.NO_COLOR && Boolean(process.stdout.isTTY)
const paint = (code: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s)
export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export function table(rows: string[][], header: string[]): string {
  const strip = (s: string) => s.replace(ANSI, '')
  const all = [header, ...rows]
  const widths = header.map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? '').length)))
  return all
    .map((r, ri) =>
      r
        .map((cell, i) => {
          const pad = ' '.repeat(widths[i]! - strip(cell).length)
          return (ri === 0 ? c.dim(cell) : cell) + (i < r.length - 1 ? pad : '')
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

export function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function clock(iso: string, now: Date): string {
  const d = new Date(iso)
  const sameDay = d.toDateString() === now.toDateString()
  const hm = d.toTimeString().slice(0, 5)
  return sameDay ? hm : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`
}

function windowText(w: QuotaWindow, now: Date): string {
  if (Date.parse(w.resetsAt) <= now.getTime()) return `${w.label} reset`
  const pct = Math.round(w.usedPercent)
  const level = quotaLevel(pct)
  const color = level === 'fail' ? c.red : level === 'warn' ? c.yellow : c.green
  return `${w.label} ${color(`${pct}%`)} ${c.dim(`→ ${clock(w.resetsAt, now)}`)}`
}

export const QUOTA_REASON: Record<string, string> = {
  'not-enabled': 'off',
  'no-session': 'no data yet — start a session',
  unrecognized: 'unrecognized format',
  'no-source': 'no public source',
  'api-account': 'API account',
}

export function quotaText(q: QuotaResult, now: Date): string {
  if (q.status === 'unavailable') return c.dim(QUOTA_REASON[q.reason] ?? q.reason)
  return `${q.windows.map((w) => windowText(w, now)).join('  ')}  ${c.dim(ago(q.observedAt, now))}`
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

export function usageText(u: UsageResult): string {
  if (u.status === 'unavailable')
    return c.dim(u.reason === 'no-source' ? '—' : u.reason === 'no-session' ? 'none' : u.reason)
  if (u.totalTokens === 0) return c.dim('none')
  return `${compactNumber(u.totalTokens)} tok / ${u.days}d`
}

const TUNING_REASON: Record<Exclude<TuningReason, 'suggested'>, string> = {
  'already-best': 'already the cheapest setting we can estimate',
  'insufficient-calls': `too few calls to estimate (needs ${MIN_CALLS})`,
  'no-compactions': 'no compaction recorded to estimate from',
  'no-optimum': 'the cheapest point is at the bottom of the range tried, so there is no clear best value',
  'unknown-model': 'not a Claude model, so the cost weights do not apply',
  'observe-only': 'observation only (no public default for this host)',
}

/** One line per model of a tuning result, or the reason there is none. */
export function tuningLines(t: TuningResult): string[] {
  if (t.status === 'unavailable')
    return [t.reason === 'no-source' ? 'no public source for this host' : (t.detail ?? t.reason)]
  return t.models.map((m) => {
    const now = m.configured === null ? 'Host default' : `${compactNumber(m.configured)}`
    const head = `${m.model}  ${m.calls} calls  now ${now}  ${m.compactions.total} compactions`
    if (m.suggestion) {
      const saved =
        m.suggestion.savedPercent === null
          ? ''
          : ` (about ${m.suggestion.savedPercent}% fewer weighted tokens)`
      return `${head}  suggest ${compactNumber(m.suggestion.threshold)}${saved}`
    }
    return `${head}  ${m.reason === 'suggested' ? '' : TUNING_REASON[m.reason]}`
  })
}
