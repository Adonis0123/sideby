// What the handoff hook needs from one Host (spec §3.17): its Quota Pressure during a session, and whether a failed
// turn hit the limit. Built-in Families only: the hook loads these leaf modules, never a Family index or a Plugin.
import type { Env } from '../types.ts'

/** The hook's stdin, parsed: field names differ per Host (snake_case for Claude and Codex, camelCase for Grok). */
export type HookInput = Record<string, unknown>

export interface HookReader {
  /** Quota Pressure in percent now, or null when unknown. Families without a Quota source leave it out. */
  pressure?(input: HookInput, env: Env, now: Date): Promise<number | null>
  /** Whether a `StopFailure` means the Quota is used up, not a transient rate limit or an overloaded server. */
  limitHit?(input: HookInput, pressure: number | null, threshold: number): boolean
}

/** The first string field among `names`, so one reader accepts both spellings. */
export function field(input: HookInput, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = input[n]
    if (typeof v === 'string') return v
  }
  return undefined
}
