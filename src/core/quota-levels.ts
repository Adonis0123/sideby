import type { QuotaResult, QuotaWindow } from '../types.ts'

/**
 * How full a Quota window must be before the CLI and the Panel warn about it, and the Usage window both
 * report. One rule for both surfaces: the Panel interpolates these numbers into its inline script.
 */
export const QUOTA_FAIL_PERCENT = 85
export const QUOTA_WARN_PERCENT = 60
/** Days of Usage every Family reports. */
export const USAGE_DAYS = 7

export type QuotaLevel = 'ok' | 'warn' | 'fail'

export function quotaLevel(usedPercent: number): QuotaLevel {
  if (usedPercent >= QUOTA_FAIL_PERCENT) return 'fail'
  if (usedPercent >= QUOTA_WARN_PERCENT) return 'warn'
  return 'ok'
}

/** True once a window's reset time has passed; an unreadable time never counts as reset. */
export function windowReset(resetsAt: string, now: Date): boolean {
  const t = Date.parse(resetsAt)
  return Number.isFinite(t) && t <= now.getTime()
}

/**
 * Quota Pressure: the used percent of the fullest window that has not reset yet (0 when all have reset),
 * or null when the Account has no Quota. A window with a `name` covers only some models and never counts (spec
 * §3.26). The Panel keeps its own copy (`quotaPressure` in page-logic.ts, -1 for null) because page-logic helpers
 * must be self-contained; a test keeps the two equal.
 */
export function quotaPressure(quota: QuotaResult | undefined, now: Date): number | null {
  const windows = openWindows(quota, now)
  if (windows === null) return null
  let max = 0
  for (const w of windows) max = Math.max(max, w.usedPercent)
  return max
}

/**
 * The windows that count toward Quota Pressure and have not reset, with `usedPercent` clamped to 0–100; null when
 * the Account has no Quota or no window that counts (spec §3.26).
 */
export function openWindows(quota: QuotaResult | undefined, now: Date): QuotaWindow[] | null {
  if (quota?.status !== 'ok') return null
  const windows = quota.windows.filter((w) => !w.name)
  if (windows.length === 0) return null
  return windows
    .filter((w) => !windowReset(w.resetsAt, now))
    .map((w) => ({ ...w, usedPercent: Math.min(100, Number(w.usedPercent) || 0) }))
}
