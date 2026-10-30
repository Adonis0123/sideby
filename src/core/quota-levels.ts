import type { QuotaResult, QuotaWindow } from '../types.ts'

/**
 * How full a Quota window must be before the CLI, the Panel and the menu bar warn about it (yellow) and show it as
 * nearly used up (red). A Short Window (5 hours) uses the first pair, a Long Window (weekly, a billing period) the
 * second: one full 5-hour window costs only about a fifth of a weekly one, so 87% of a week still leaves several
 * 5-hour windows of work (spec §3.26, ADR-0062). The Panel interpolates these numbers into its inline script.
 */
export const QUOTA_FAIL_PERCENT = 85
export const QUOTA_WARN_PERCENT = 60
export const QUOTA_LONG_FAIL_PERCENT = 95
export const QUOTA_LONG_WARN_PERCENT = 85
/** A window longer than this many minutes (one day) is a Long Window. No Host has a daily Quota. */
export const LONG_WINDOW_MINUTES = 1440
/**
 * Takeover Limit (spec §3.17 "接力规则"): an Account more used than this does not take over a Handoff, so the next
 * Account starts with room to work. For a Short Window it sits this many points below the Handoff Threshold and moves
 * with it; a Long Window's limit is the Handoff Threshold itself (`takeoverLimits`).
 */
export const TAKEOVER_GAP = 10

export function takeoverLimit(threshold: number): number {
  return Math.max(1, threshold - TAKEOVER_GAP)
}

/** The Takeover Limit of each kind of window: at or above it, that window makes an Account full. */
export interface TakeoverLimits {
  /** Short Windows (5 hours): the Handoff Threshold − 10, 85 by default. */
  short: number
  /** Long Windows (weekly, a billing period): the Handoff Threshold, 95 by default. */
  long: number
}

export function takeoverLimits(threshold: number): TakeoverLimits {
  return { short: takeoverLimit(threshold), long: Math.max(1, Math.min(100, threshold)) }
}

/** The limits at the default Handoff Threshold (95): 85 for Short Windows, 95 for Long ones. */
export const DEFAULT_TAKEOVER_LIMITS: TakeoverLimits = takeoverLimits(95)

const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 }

/**
 * A window's length in minutes: `windowMinutes`, or read from a label such as `5h`, `7d` or `90m` when that is
 * missing; 0 when neither tells. The Panel keeps its own copy in `longWindow` (page-logic.ts); a test keeps them equal.
 */
export function windowLength(w: { label?: string; windowMinutes?: number }): number {
  const minutes = Number(w.windowMinutes)
  if (Number.isFinite(minutes) && minutes > 0) return minutes
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(String(w.label ?? '').trim())
  return m ? Number(m[1]) * UNIT_MINUTES[m[2]!.toLowerCase()]! : 0
}

/** A Long Window: longer than one day (weekly, a billing period). Every other window is a Short Window. */
export function isLongWindow(w: { label?: string; windowMinutes?: number }): boolean {
  return windowLength(w) > LONG_WINDOW_MINUTES
}

/** The window's own Takeover Limit. */
export function limitOf(w: { label?: string; windowMinutes?: number }, limits: TakeoverLimits): number {
  return isLongWindow(w) ? limits.long : limits.short
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

/** The warning level of a used percent; `long` for a Long Window, which warns later (spec §3.26). */
export function quotaLevel(usedPercent: number, long = false): QuotaLevel {
  if (usedPercent >= (long ? QUOTA_LONG_FAIL_PERCENT : QUOTA_FAIL_PERCENT)) return 'fail'
  if (usedPercent >= (long ? QUOTA_LONG_WARN_PERCENT : QUOTA_WARN_PERCENT)) return 'warn'
  return 'ok'
}

/** One window's warning level by its own kind: a Short Window warns at 60/85, a Long Window at 85/95. */
export function windowLevel(w: { label?: string; windowMinutes?: number; usedPercent: number }): QuotaLevel {
  return quotaLevel(w.usedPercent, isLongWindow(w))
}

const LEVEL_RANK: Record<QuotaLevel, number> = { ok: 0, warn: 1, fail: 2 }

/** The more serious of two levels. */
export function worseLevel(a: QuotaLevel, b: QuotaLevel): QuotaLevel {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a
}

/**
 * The window that runs out first relative to its own kind: the highest used percent over that window's red level
 * (85 for a Short Window, 95 for a Long one), the first on a tie. What the menu bar's reset column and title speak
 * about. Undefined without windows.
 */
export function bindingWindow<W extends { label?: string; windowMinutes?: number; usedPercent: number }>(
  windows: readonly W[],
): W | undefined {
  let best: W | undefined
  let bestShare = -1
  for (const w of windows) {
    const share = w.usedPercent / (isLongWindow(w) ? QUOTA_LONG_FAIL_PERCENT : QUOTA_FAIL_PERCENT)
    if (share > bestShare) {
      best = w
      bestShare = share
    }
  }
  return best
}

/**
 * Limit Use: how close an Account is to being full, as the percent of its own Takeover Limit that its closest window
 * has used (a weekly window at 87% under a limit of 95 is 91.6; a 5-hour window at 43% under 85 is 50.6), with that
 * window. Null when the Account has no Quota. A Handoff ranks ready Accounts by it, lowest first (spec §3.13).
 */
export function limitUse(
  quota: QuotaResult | undefined,
  now: Date,
  limits: TakeoverLimits,
): { percent: number; window: QuotaWindow | null } | null {
  const windows = openWindows(quota, now)
  if (windows === null) return null
  let best: { percent: number; window: QuotaWindow | null } = { percent: 0, window: null }
  for (const w of windows) {
    const percent = Math.round((w.usedPercent / limitOf(w, limits)) * 1000) / 10
    if (best.window === null || percent > best.percent) best = { percent, window: w }
  }
  return best
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
