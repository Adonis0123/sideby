import type { QuotaResult, QuotaWindow } from '../types.ts'

/**
 * How full a Quota window must be before the CLI and the Panel warn about it, and the Usage window both
 * report. One rule for both surfaces: the Panel interpolates these numbers into its inline script.
 */
export const QUOTA_FAIL_PERCENT = 85
export const QUOTA_WARN_PERCENT = 60
/**
 * Takeover Limit (spec §3.17 "接力规则"): an Account more used than this does not take over a Handoff, so the next
 * Account starts with room to work. It sits this many points below the Handoff Threshold and moves with it.
 */
export const TAKEOVER_GAP = 10

export function takeoverLimit(threshold: number): number {
  return Math.max(1, threshold - TAKEOVER_GAP)
}

/** Days of Usage every Family reports. */
export const USAGE_DAYS = 7

export type QuotaLevel = 'ok' | 'warn' | 'fail'

/**
 * Shared by the Panel and menu bar. Self-contained so the Panel can inline it without other module state.
 * A reading over an hour old is still current when `lastUseAt`, the newest use of its login on this computer, came at
 * most 10 minutes after it (a session's last records land after its last status line): nothing here has used the
 * Quota since (spec §3.31). Use on the web or another computer cannot be seen; the hover text says so.
 */
export function quotaIsStale(
  quota: { observedAt: string; fetchError?: string },
  now: number,
  lastUseAt?: string | null,
): boolean {
  const at = Date.parse(quota.observedAt)
  if (quota.fetchError || !Number.isFinite(at) || at - now > 60_000) return true
  if (now - at <= 3600_000) return false
  const used = lastUseAt ? Date.parse(lastUseAt) : Number.NaN
  return !(Number.isFinite(used) && used - at <= 600_000)
}

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
