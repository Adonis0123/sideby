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

/** Whether a code point takes two terminal columns (East Asian Wide and Fullwidth, and emoji). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** How many terminal columns `s` takes, colours left out. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s.replace(ANSI, '')) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

/** `s` cut to at most `max` columns, ending in `…` when cut. */
export function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

export function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows]
  const widths = header.map((_, i) => Math.max(...all.map((r) => displayWidth(r[i] ?? ''))))
  return all
    .map((r, ri) =>
      r
        .map((cell, i) => {
          const pad = ' '.repeat(widths[i]! - displayWidth(cell))
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
  // A window that covers only some models goes by their name (spec §3.26).
  const label = w.name ?? w.label
  if (Date.parse(w.resetsAt) <= now.getTime()) return `${label} reset`
  const pct = Math.round(w.usedPercent)
  const level = quotaLevel(pct)
  const color = level === 'fail' ? c.red : level === 'warn' ? c.yellow : c.green
  return `${label} ${color(`${pct}%`)} ${c.dim(`→ ${clock(w.resetsAt, now)}`)}`
}

export const QUOTA_REASON: Record<string, string> = {
  'not-enabled': 'off',
  'no-session': 'no data yet — start a session',
  unrecognized: 'unrecognized format',
  'no-source': 'no public source',
  'api-account': 'API account',
  'fetch-failed': 'could not get it',
}

export function quotaText(q: QuotaResult, now: Date): string {
  if (q.status === 'unavailable') return c.dim(QUOTA_REASON[q.reason] ?? q.reason)
  const failed = q.fetchError ? c.yellow(' (latest check failed)') : ''
  return `${q.windows.map((w) => windowText(w, now)).join('  ')}  ${c.dim(ago(q.observedAt, now))}${failed}`
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
  'no-optimum':
    'the model window is below the lowest size Claude Code accepts (100K), so there is nothing to set',
  'unknown-model': 'not a Claude model, so the cost weights do not apply',
  'observe-only': 'observation only (no public default for this host)',
}

/** One line per model of a tuning result, or the reason there is none. */
export function tuningLines(t: TuningResult): string[] {
  if (t.status === 'unavailable')
    return [t.reason === 'no-source' ? 'no public source for this host' : (t.detail ?? t.reason)]
  return t.models.map((m) => {
    const now = m.configured === null ? 'Host default' : `${compactNumber(m.configured)}`
    const head = `${m.model}  ${m.calls} calls  now ${now}  ${m.compactions.total} compactions${m.compactions.idle ? ` (${m.compactions.idle} after idle)` : ''}`
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
