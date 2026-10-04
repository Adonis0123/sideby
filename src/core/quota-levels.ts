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
