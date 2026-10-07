import type { QuotaResult } from '../types.ts'

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
 * or null when the Account has no Quota. The Panel keeps its own copy (`quotaPressure` in page-logic.ts,
 * -1 for null) because page-logic helpers must be self-contained; a test keeps the two equal.
 */
export function quotaPressure(quota: QuotaResult | undefined, now: Date): number | null {
  if (quota?.status !== 'ok' || quota.windows.length === 0) return null
  let max = 0
  for (const w of quota.windows)
    if (!windowReset(w.resetsAt, now)) max = Math.max(max, Math.min(100, Number(w.usedPercent) || 0))
  return max
}
