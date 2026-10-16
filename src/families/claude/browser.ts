// The Claude account id that claude.ai's Local Storage key names also carry (spec §3.24, ADR-0023).
import { readFile } from 'node:fs/promises'
import type { Account } from '../../types.ts'
import { claudeJsonOf } from './index.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `oauthAccount.accountUuid` of `.claude.json`, only for matching; every other field is dropped at once. */
export async function claudeSignInId(account: Account): Promise<string | undefined> {
  try {
    const id = (
      JSON.parse(await readFile(claudeJsonOf(account), 'utf8')) as {
        oauthAccount?: { accountUuid?: unknown }
      } | null
    )?.oauthAccount?.accountUuid
    return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined
  } catch {
    return undefined
  }
}
