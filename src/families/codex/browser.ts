// The ChatGPT user id that chatgpt.com's Local Storage key names also carry (spec §3.24, ADR-0023).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../../types.ts'

const USER_ID = /^user-[A-Za-z0-9]{8,64}$/
const AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * `chatgpt_user_id` (else `user_id`, as Codex itself falls back: codex-rs/login/src/token_data.rs) under the auth
 * claim of `tokens.id_token`, only for matching. The payload is decoded as for the email (core/identity.ts); the
 * token and every other claim are dropped at once. `tokens.account_id` is the workspace and is not used.
 */
export async function codexSignInId(account: Account): Promise<string | undefined> {
  try {
    const token = (
      JSON.parse(await readFile(join(account.dir, 'auth.json'), 'utf8')) as {
        tokens?: { id_token?: unknown }
      } | null
    )?.tokens?.id_token
    if (typeof token !== 'string') return undefined
    const payload = token.split('.')[1]
    if (!payload) return undefined
    const auth = (
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> | null
    )?.[AUTH_CLAIM] as { chatgpt_user_id?: unknown; user_id?: unknown } | undefined
    const id = auth?.chatgpt_user_id ?? auth?.user_id
    return typeof id === 'string' && USER_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}
