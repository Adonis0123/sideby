// Claude Code for the handoff hook (spec §3.17): Quota Pressure from the status line tap's cache, and a used-up
// Quota told apart from a transient rate limit. Leaf module: the hook runs on every tool call.
import { quotaPressure } from '../../core/quota-levels.ts'
import { field, type HookReader } from '../../handoff/reader.ts'
import { accountNameFromEnv, cacheStateDir, readQuotaCache } from './quota-cache.ts'

/** Claude Code's wording when a subscription window is used up (as opposed to an overloaded server). */
const USED_UP = /usage limit|limit reached|out of (extra )?usage/i

export const claudeHookReader: HookReader = {
  async pressure(_input, env, now) {
    const name = accountNameFromEnv(env)
    if (!name) return null
    try {
      const cache = await readQuotaCache(cacheStateDir(env), name)
      if (cache.status !== 'ok') return null
      return quotaPressure({ ...cache, source: 'statusline' }, now)
    } catch {
      return null
    }
  },
  limitHit(input, pressure, threshold) {
    if (field(input, 'error') !== 'rate_limit') return false
    if (pressure !== null && pressure >= threshold) return true
    const text = `${field(input, 'error_details', 'errorDetails') ?? ''} ${field(input, 'last_assistant_message', 'lastAssistantMessage') ?? ''}`
    return USED_UP.test(text)
  },
}
