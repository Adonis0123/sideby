// Per-day Usage buckets shared by the built-in readers: local calendar dates, oldest first, zero-filled.
import { USAGE_DAYS } from './quota-levels.ts'

export interface DailyTokens {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
  totalTokens: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar date of a time, `YYYY-MM-DD`. */
export function localDate(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * `days` buckets ending with the local day of `now`. `add` drops times outside those days, so the buckets can
 * sum to less than a reader's rolling-window total (the oldest partial day falls outside them).
 */
export function dailyBuckets(now: Date, days = USAGE_DAYS) {
  const daily: DailyTokens[] = []
  const index = new Map<string, DailyTokens>()
  for (let i = days - 1; i >= 0; i--) {
    // Built from calendar parts, so a daylight-saving day of 23 or 25 hours still yields one entry per date.
    const date = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))
    const bucket = { date, totalTokens: 0 }
    daily.push(bucket)
    index.set(date, bucket)
  }
  return {
    daily,
    add(at: number, tokens: number): void {
      if (!Number.isFinite(at) || tokens <= 0) return
      const bucket = index.get(localDate(at))
      if (bucket) bucket.totalTokens += tokens
    },
  }
}
