// Codex's Login Key (ADR-0028): which ChatGPT workspace and user an Account is signed in as, kept only as a hash.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../../types.ts'

const AUTH_CLAIM = 'https://api.openai.com/auth'
// The shapes Codex writes; anything else gives no key rather than a key built from an unexpected value.
const ACCOUNT_ID = /^[A-Za-z0-9-]{8,64}$/
const USER_ID = /^user-[A-Za-z0-9]{8,64}$/

/**
 * A hash of `chatgpt_account_id` (the workspace) and `chatgpt_user_id` under the auth claim of `tokens.id_token`,
 * cut to 16 hex characters, only for comparing two Accounts while the Runtime groups a Same Login. The payload is
 * decoded as for the email (core/identity.ts); the token, both ids and every other claim are dropped at once.
 * Undefined on any problem: the Account then simply does not group.
 */
export async function codexLoginKey(account: Account): Promise<string | undefined> {
  try {
    const token = (
      JSON.parse(await readFile(join(account.dir, 'auth.json'), 'utf8')) as {
        tokens?: { id_token?: unknown }
      } | null
    )?.tokens?.id_token
    if (typeof token !== 'string') return undefined
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) return undefined
    const auth = (
      JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown> | null
    )?.[AUTH_CLAIM] as { chatgpt_account_id?: unknown; chatgpt_user_id?: unknown } | undefined
    const ws = auth?.chatgpt_account_id
    const user = auth?.chatgpt_user_id
    if (typeof ws !== 'string' || !ACCOUNT_ID.test(ws) || typeof user !== 'string' || !USER_ID.test(user))
      return undefined
    return createHash('sha256').update(`codex\0${ws}\0${user}`).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}
