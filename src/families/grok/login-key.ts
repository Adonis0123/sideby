// Grok's Login Key (ADR-0037): which x.ai user and team an Account is signed in as, kept only as a hash.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../../types.ts'

// The shapes Grok Build writes; anything else gives no key rather than a key built from an unexpected value.
const ID = /^[A-Za-z0-9-]{8,64}$/

/**
 * A hash of `user_id` and `team_id` of the single sign-in entry in `auth.json`, cut to 16 hex characters, only for
 * comparing two Accounts while the Runtime groups a Same Login. A missing or null `team_id` counts as no team. Tokens
 * and every other field are dropped at once. Undefined on any problem: the Account then simply does not group.
 */
export async function grokLoginKey(account: Account): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(join(account.dir, 'auth.json'), 'utf8')) as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
    const entries = Object.values(data)
    if (entries.length !== 1) return undefined
    const entry = entries[0] as { user_id?: unknown; team_id?: unknown } | null
    const user = entry?.user_id
    const team = entry?.team_id ?? ''
    if (typeof user !== 'string' || !ID.test(user) || typeof team !== 'string' || (team && !ID.test(team)))
      return undefined
    return createHash('sha256').update(`grok\0${team}\0${user}`).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}
