// Grok Build for the handoff hook (spec §3.17, §3.26): the Quota windows from the kept answer of its CLI and the billing
// lines it writes to its log, and a turn that failed at the limit. Leaf module: the hook runs on every tool call. The
// wording comes from the grok 1.0.50 binary; check it again when Grok changes.
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ACCOUNT_NAME } from '../../core/account-name.ts'
import { resolvePaths } from '../../core/paths.ts'
import { openWindows } from '../../core/quota-levels.ts'
import { quotaStoreFile, readQuotaStore } from '../../core/quota-store.ts'
import { field, type HookReader } from '../../handoff/reader.ts'
import type { Env } from '../../types.ts'
import { grokLogFile, HOOK_LOG_READ_BYTES, lastGrokBilling } from './quota-log.ts'

const MAIN_DIR = '.grok'
const ACCOUNT_PREFIX = '.grok-'

/** The Account the hook runs for, from `GROK_HOME`: unset or `~/.grok` is `main`, `.grok-<name>` is `<name>`. */
export function grokAccountFromEnv(env: Env): { name: string; dir: string } | null {
  const home = env.HOME || homedir()
  const dir = env.GROK_HOME
  if (!dir || resolve(dir) === join(home, MAIN_DIR)) return { name: 'main', dir: join(home, MAIN_DIR) }
  const base = basename(dir)
  if (!base.startsWith(ACCOUNT_PREFIX)) return null
  const name = base.slice(ACCOUNT_PREFIX.length)
  return name !== 'main' && ACCOUNT_NAME.test(name) ? { name, dir } : null
}

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
  async windows(_input, env, now) {
    const account = grokAccountFromEnv(env)
    if (!account) return null
    try {
      const [log, kept] = await Promise.all([
        lastGrokBilling(grokLogFile(account.dir), HOOK_LOG_READ_BYTES),
        readQuotaStore(quotaStoreFile(resolvePaths(env).stateDir, 'grok', account.name)),
      ])
      const fetched = kept?.quota ?? null
      const newer =
        log && fetched
          ? Date.parse(log.observedAt) > Date.parse(fetched.observedAt)
            ? log
            : fetched
          : (log ?? fetched)
      return newer ? openWindows(newer, now) : null
    } catch {
      return null
    }
  },
  limitHit(input) {
    if (field(input, 'subagentType')) return false
    // `status 403` is not listed: alone it may be a refused request, and next to a used-up message that message
    // matches by itself. A plain "rate limit … try again later" is transient and matches nothing here.
    const text = `${field(input, 'errorDetails') ?? ''}\n${field(input, 'lastAssistantMessage') ?? ''}`
    return GROK_USED_UP.some((s) => text.includes(s))
  },
}
