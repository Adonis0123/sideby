// The x.ai user id that grok.com's Local Storage key names also carry (spec §3.24, ADR-0043).
import type { Account } from '../../types.ts'
import { grokSignInIds } from './login-key.ts'

/** `user_id` of the sign-in entry in `auth.json`, only for matching; it never leaves the Runtime. */
export async function grokSignInId(account: Account): Promise<string | undefined> {
  return (await grokSignInIds(account))?.user
}
