// Hand-over Levels (spec §3.17 "交接档", ADR-0032): each Quota window hands over when it would not survive another
// turn like the run's recent ones. Pure, and a leaf module: the handoff hook runs on every tool call.
import type { PlanFile, RunState, WindowReading } from '../core/handoff-chain.ts'
import type { QuotaWindow } from '../types.ts'

/** Finished turns kept per window. */
export const TURNS_KEPT = 5
/** How many of the largest recent turn the window must still have room for. */
export const HEADROOM = 1.5
/** Never later than this: at 100 the limit is already hit. */
export const LEVEL_MAX = 99

type Levels = Pick<PlanFile, 'prepareAt' | 'threshold' | 'adaptive'>

/** The used percent at which `label` hands over in this run. */
export function handOverLevel(label: string, plan: Levels, state: RunState): number {
  const used = state.turnUse?.[label]
  if (plan.adaptive !== true || !used?.length) return plan.threshold
  const level = Math.floor(100 - HEADROOM * Math.max(...used))
  return Math.max(plan.prepareAt, Math.min(LEVEL_MAX, level))
}

export const reading = (w: QuotaWindow): WindowReading => ({
  label: w.label,
  usedPercent: w.usedPercent,
  resetsAt: w.resetsAt,
})

/** The window that reached its level, the one furthest past it when several have; undefined when none has. */
export function crossedWindow(
  windows: readonly QuotaWindow[],
  plan: Levels,
  state: RunState,
): WindowReading | undefined {
  let best: { w: QuotaWindow; past: number } | undefined
  for (const w of windows) {
    const past = w.usedPercent - handOverLevel(w.label, plan, state)
    if (past >= 0 && (!best || past > best.past)) best = { w, past }
  }
  return best && reading(best.w)
}

/** The fullest window, to name in a message when none is past its level (the preparing step, a limit hit). */
export function fullestWindow(windows: readonly QuotaWindow[]): WindowReading | undefined {
  let top: QuotaWindow | undefined
  for (const w of windows) if (!top || w.usedPercent > top.usedPercent) top = w
  return top && reading(top)
}

/**
 * Two readings belong to one window when their reset times are within 10 minutes: Codex derives the time from a
 * relative `resets_in_seconds`, so it moves a little between readings.
 */
function sameWindow(a: string, b: string): boolean {
  const d = Math.abs(Date.parse(a) - Date.parse(b))
  return Number.isFinite(d) && d < 10 * 60_000
}

/** The readings a run starts measuring from, when no `Stop` has set them yet. */
export function firstMark(state: RunState, windows: readonly QuotaWindow[]): RunState | undefined {
  if (state.turnMark || windows.length === 0) return undefined
  return {
    ...state,
    turnMark: Object.fromEntries(
      windows.map((w) => [w.label, { usedPercent: w.usedPercent, resetsAt: w.resetsAt }]),
    ),
  }
}

/**
 * At a `Stop`: each window's growth since the last one joins its recent turns (growth across a reset, or none at
 * all, is not a turn's use), and today's readings become the next turn's starting point.
 */
export function recordTurn(state: RunState, windows: readonly QuotaWindow[]): RunState {
  const turnUse: Record<string, number[]> = { ...state.turnUse }
  const turnMark: NonNullable<RunState['turnMark']> = {}
  for (const w of windows) {
    const before = state.turnMark?.[w.label]
    const grew = before && sameWindow(before.resetsAt, w.resetsAt) ? w.usedPercent - before.usedPercent : 0
    if (grew > 0) turnUse[w.label] = [...(turnUse[w.label] ?? []), grew].slice(-TURNS_KEPT)
    turnMark[w.label] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt }
  }
  return { ...state, turnMark, turnUse }
}
