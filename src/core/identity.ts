// Who an Account is signed in as: the email (and for Claude the organization) from the Host's own login file
// (ADR-0003). Only these identity fields are read out of the file; tokens and every other field are dropped as soon
// as the file is parsed, and are never stored, logged or returned. Each file's pick is remembered until the file
// changes (core/file-memo.ts).
import { readFile, stat } from 'node:fs/promises'
import type { AccountIdentity } from '../types.ts'
import { FileMemo } from './file-memo.ts'

const MAX_EMAIL = 254
const MAX_ORG = 120
// One address, no spaces or control characters; the shape only, not a deliverability check.
const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u

/** The email when `v` looks like one address, else undefined. */
export function cleanEmail(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= MAX_EMAIL && EMAIL.test(v) ? v : undefined
}

/** A short single-line organization name, else undefined. */
export function cleanOrg(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s && s.length <= MAX_ORG && !/\p{Cc}/u.test(s) ? s : undefined
}

/** `{ email?, org? }` without empty fields, or undefined when both are missing. */
export function identityOf(email: unknown, org?: unknown): AccountIdentity | undefined {
  const e = cleanEmail(email)
  const o = cleanOrg(org)
  if (!e && !o) return undefined
  return { ...(e ? { email: e } : {}), ...(o ? { org: o } : {}) }
}

/**
 * The email claim of a JWT such as Codex's `id_token`: the payload segment is base64url-decoded and parsed, and only
 * `email` is kept. The signature is not checked (the token is the Host's own file, read for display only); the
 * token itself and every other claim are dropped.
 */
export function jwtEmail(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof claims === 'object' && claims !== null
      ? cleanEmail((claims as { email?: unknown }).email)
      : undefined
  } catch {
    return undefined
  }
}

const memo = new FileMemo<AccountIdentity | null>()

/** Counters of the identity cache, for tests. */
export const identityMemoStats = memo.stats

/**
 * Reads one JSON login file and keeps only what `pick` returns from it. Undefined when the file is missing, is not
 * JSON or holds no identity. `pick` must return identity fields only (identityOf builds one).
 */
export async function identityFromJsonFile(
  path: string,
  pick: (data: unknown) => AccountIdentity | undefined,
): Promise<AccountIdentity | undefined> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(path)
  } catch {
    return undefined
  }
  if (!st.isFile()) return undefined
  const pass = memo.pass(path)
  const value = await pass.get(path, st, async () => {
    try {
      return pick(JSON.parse(await readFile(path, 'utf8'))) ?? null
    } catch {
      return null
    }
  })
  pass.done()
  return value ?? undefined
}
