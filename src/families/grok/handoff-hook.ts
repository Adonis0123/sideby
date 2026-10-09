// Grok Build for the handoff hook (spec §3.17): no public Quota, so only a turn that failed at the limit starts a
// Handoff. Leaf module. The wording comes from the grok 1.0.50 binary; check it again when Grok changes.
import { field, type HookReader } from '../../handoff/reader.ts'

/** Substrings that mean the usage pool or credits are used up. `StopFailure.error` has no class of its own for it. */
export const GROK_USED_UP = [
  'You hit your weekly limit',
  'You hit your free usage limit',
  'reached your free Grok Build usage limit',
  'usage limit reached',
  'out of credits',
  'usage balance exhausted',
  'spending cap',
  'credit limit for your plan',
  'free-usage-exhausted',
  'status 402',
]

export const grokHookReader: HookReader = {
  limitHit(input) {
    if (field(input, 'subagentType')) return false
    // `status 403` is not listed: alone it may be a refused request, and next to a used-up message that message
    // matches by itself. A plain "rate limit … try again later" is transient and matches nothing here.
    const text = `${field(input, 'errorDetails') ?? ''}\n${field(input, 'lastAssistantMessage') ?? ''}`
    return GROK_USED_UP.some((s) => text.includes(s))
  },
}
