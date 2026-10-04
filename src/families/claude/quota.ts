// Quota for a Claude subscription Account: the windows `sideby statusline-tap` last cached for it.
// Windows past `resetsAt` are returned unchanged; callers compare with the current time and show "reset".
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathOrNull } from '../../core/fs-safe.ts'
import { claudeStatusline, isWrapped, mainSettingsFile } from '../../quota/claude-statusline.ts'
import type { Account, QuotaResult, ReadContext } from '../../types.ts'
import { readQuotaCache } from './quota-cache.ts'

export const QUOTA_SOURCE = 'claude statusline'

/** How the Account reaches the wrapper: the shared main settings.json, its own wrapped file, or neither. */
async function accountWrapped(
  account: Account,
  ctx: ReadContext,
): Promise<'shared' | 'own' | 'own-unwrapped'> {
  if (account.isMain) return 'shared'
  const own = join(account.dir, 'settings.json')
  const [a, b] = await Promise.all([realpathOrNull(own), realpathOrNull(mainSettingsFile(ctx.home))])
  if (a !== null && a === b) return 'shared'
  try {
    const s = JSON.parse(await readFile(own, 'utf8')) as { statusLine?: { command?: unknown } }
    return isWrapped(s?.statusLine?.command) ? 'own' : 'own-unwrapped'
  } catch {
    return 'own-unwrapped'
  }
}

async function withoutCache(account: Account, ctx: ReadContext): Promise<QuotaResult> {
  const wiring = await accountWrapped(account, ctx)
  if (wiring === 'own-unwrapped')
    return {
      status: 'unavailable',
      reason: 'not-enabled',
      detail:
        "this account's settings.json is not shared with the main account, so its quota needs its own status line setup",
    }
  const planStatus = await claudeStatusline.plan(ctx).then(
    (p) => p.status,
    () => 'blocked' as const,
  )
  if (wiring === 'shared' && planStatus !== 'enabled')
    return {
      status: 'unavailable',
      reason: 'not-enabled',
      detail: 'run `sideby quota setup claude` to record Claude quota from the status line',
    }
  return {
    status: 'unavailable',
    reason: 'no-session',
    detail: 'start a Claude Code session with this account; quota is recorded after its first reply',
  }
}

export async function readClaudeQuota(account: Account, ctx: ReadContext): Promise<QuotaResult> {
  const read = await readQuotaCache(ctx.stateDir, account.name)
  if (read.status === 'missing') return withoutCache(account, ctx)
  if (read.status === 'unrecognized')
    return { status: 'unavailable', reason: 'unrecognized', detail: read.detail }
  return { status: 'ok', windows: read.windows, observedAt: read.observedAt, source: QUOTA_SOURCE }
}
