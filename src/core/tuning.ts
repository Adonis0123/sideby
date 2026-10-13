// Estimates the cheapest Compaction Threshold for one model from its recorded turns (spec §3.18). Pure: no I/O,
// no clock. A different threshold changes the summary and what is left after compaction, which the records cannot
// show, so everything here is an estimate that replays the recorded growth against a candidate threshold.
import type { TuningModel, TuningReason, TuningResult } from '../types.ts'

/** Relative cost of a token, input = 1. These are Anthropic's published multipliers, not prices (spec §3.18). */
export const WEIGHT = { input: 1, cacheRead: 0.1, write5m: 1.25, write1h: 2, output: 5 } as const

/** A model with fewer turns than this in the window gets no suggestion. */
export const MIN_CALLS = 200

/** Candidate thresholds as a share of the model's context window. */
export const CANDIDATE_PERCENTS = [
  4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 95,
] as const

/** A suggestion must save at least this share against the current threshold; otherwise it is already the best. */
const MIN_SAVING_PERCENT = 1

/** One assistant turn: the whole context it ran with, what it wrote, and what it added to the prompt cache. */
export interface Turn {
  ts: number
  /** `input + cache read + cache write` tokens of the turn. */
  ctx: number
  out: number
  write5m: number
  write1h: number
}

/** One compaction the Host recorded. */
export interface Compaction {
  ts: number
  trigger: 'auto' | 'manual' | 'unknown'
  pre: number
  post: number
}

export interface ModelRecords {
  model: string
  /** Turns of this model per session, each in time order. */
  sessions: Turn[][]
  compactions: Compaction[]
  contextWindow: number
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? (v[mid] ?? 0) : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2
}

function writeWeight(t: Turn): number {
  const n = t.write5m + t.write1h
  return n > 0 ? (t.write5m * WEIGHT.write5m + t.write1h * WEIGHT.write1h) / n : WEIGHT.write5m
}

/** Weighted cost of one session's turns if the Host compacted whenever the context reached `threshold`. */
function replaySession(turns: Turn[], threshold: number, post: number): number {
  const first = turns[0]
  if (!first) return 0
  const growth: number[] = []
  for (let i = 1; i < turns.length; i++) {
    const d = (turns[i]?.ctx ?? 0) - (turns[i - 1]?.ctx ?? 0)
    if (d >= 0) growth.push(d)
  }
  // A recorded drop means the Host compacted there; what the turn then added is unknown, so use the usual growth.
  const usual = median(growth) ?? 0
  let ctx = first.ctx
  let cost = ctx * writeWeight(first) + first.out * WEIGHT.output
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i]
    const prev = turns[i - 1]
    if (!t || !prev) continue
    const d = t.ctx - prev.ctx
    const g = d >= 0 ? d : usual
    if (ctx + g >= threshold) {
      // The whole context goes in as input, a summary of about `post` tokens comes out, and the next turn
      // writes that summary to the cache again.
      cost += ctx * WEIGHT.input + post * WEIGHT.output + post * WEIGHT.write5m
      ctx = post + g
    } else {
      cost += ctx * WEIGHT.cacheRead
      ctx += g
    }
    cost += g * writeWeight(t) + t.out * WEIGHT.output
  }
  return cost
}

function replay(sessions: Turn[][], threshold: number, post: number): number {
  let total = 0
  for (const s of sessions) total += replaySession(s, threshold, post)
  return total
}

const roundTokens = (n: number) => Math.round(n / 1000) * 1000

export interface SummarizeOptions {
  /** The Account's configured threshold in tokens; null is the Host default. */
  configured: number | null
  /** The model's cost weights are known (a Claude model), so a suggestion is possible. */
  known: boolean
  /** The Family may suggest at all (Codex only observes). */
  mayRecommend: boolean
}

export function summarizeModel(rec: ModelRecords, o: SummarizeOptions): TuningModel {
  const calls = rec.sessions.reduce((n, s) => n + s.length, 0)
  const auto = rec.compactions.filter((c) => c.trigger === 'auto')
  const pre = rec.compactions.map((c) => c.pre).filter((n) => n > 0)
  const posts = rec.compactions.map((c) => c.post).filter((n) => n > 0)
  const autoPre = auto.map((c) => c.pre).filter((n) => n > 0)
  const effective = o.configured !== null ? Math.min(o.configured, rec.contextWindow) : median(autoPre)
  const base: TuningModel = {
    model: rec.model,
    calls,
    contextWindow: rec.contextWindow,
    configured: o.configured,
    effective: effective === null ? null : Math.round(effective),
    compactions: {
      total: rec.compactions.length,
      auto: auto.length,
      manual: rec.compactions.filter((c) => c.trigger === 'manual').length,
      preTokensP50: pre.length ? Math.round(median(pre) as number) : null,
      preTokensMax: pre.length ? Math.max(...pre) : null,
    },
    suggestion: null,
    reason: 'observe-only',
  }
  const stop = (reason: TuningReason): TuningModel => ({ ...base, reason })
  if (!o.mayRecommend) return stop('observe-only')
  if (!o.known) return stop('unknown-model')
  if (calls < MIN_CALLS) return stop('insufficient-calls')
  // What is left after a compaction can only be read from compactions the Host recorded.
  const post = median(posts)
  if (post === null) return stop('no-compactions')

  let best: { threshold: number; cost: number } | null = null
  for (const pct of CANDIDATE_PERCENTS) {
    const threshold = roundTokens((rec.contextWindow * pct) / 100)
    const cost = replay(rec.sessions, threshold, post)
    // On a tie the larger threshold wins: fewer compactions for the same cost.
    if (!best || cost < best.cost || (cost === best.cost && threshold > best.threshold))
      best = { threshold, cost }
  }
  if (!best) return stop('insufficient-calls')
  // A best value at the lowest candidate means the cheapest point may lie below the range that was replayed, so it
  // is a cut-off of the search, not an optimum, and is not suggested.
  if (best.threshold === roundTokens((rec.contextWindow * (CANDIDATE_PERCENTS[0] as number)) / 100))
    return stop('no-optimum')
  if (effective === null)
    return {
      ...base,
      reason: 'suggested',
      suggestion: { threshold: best.threshold, savedPercent: null, savedWeighted: null },
    }
  const current = replay(rec.sessions, effective, post)
  const saved = current - best.cost
  const percent = current > 0 ? (saved / current) * 100 : 0
  if (percent < MIN_SAVING_PERCENT) return stop('already-best')
  return {
    ...base,
    reason: 'suggested',
    suggestion: {
      threshold: best.threshold,
      savedPercent: Math.round(percent * 10) / 10,
      savedWeighted: Math.round(saved),
    },
  }
}

/** The value stored under `key`, creating and storing `make()` first when there is none. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const have = map.get(key)
  if (have !== undefined) return have
  const made = make()
  map.set(key, made)
  return made
}

export interface TuningOptions {
  /** The Account's configured threshold in tokens; null is the Host default. */
  configured: number | null
  /** Whether a model's cost weights are known (spec §3.18); an unknown model gets no suggestion. */
  known: (model: string) => boolean
  /** The Family may suggest at all (Codex only observes). */
  mayRecommend: boolean
}

/** The whole result for an Account: every model summarized, the busiest first. */
export function tuningResult(days: number, records: ModelRecords[], o: TuningOptions): TuningResult {
  const models = records.map((rec) =>
    summarizeModel(rec, {
      configured: o.configured,
      known: o.known(rec.model),
      mayRecommend: o.mayRecommend,
    }),
  )
  models.sort((a, b) => b.calls - a.calls)
  return { status: 'ok', days, estimate: true, models }
}
