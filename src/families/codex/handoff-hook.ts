// Codex for the handoff hook (spec §3.17): Quota Pressure from the current session's rollout. Codex has no hook
// for a failed turn, so it starts a Handoff only before its limit. Leaf module: the hook runs on every tool call.
import { quotaPressure } from '../../core/quota-levels.ts'
import { field, type HookReader } from '../../handoff/reader.ts'
import { lastRateLimits } from './rate-limits.ts'

export const codexHookReader: HookReader = {
  async pressure(input, _env, now) {
    const file = field(input, 'transcript_path')
    if (!file) return null
    const windows = await lastRateLimits(file)
    return windows
      ? quotaPressure({ status: 'ok', windows, observedAt: now.toISOString(), source: file }, now)
      : null
  },
}
