// Sign in again (spec §3.21 "换个账号登录"): `sideby login` reads who the Account is signed in as before and after the
// Host's own sign-in, and says whether the login changed. Pure: the caller reads each status, this only words it.
import type { LoginState } from '../types.ts'

/** What `sideby login` reads of an Account around the sign-in: identity fields and Same Login peers only. */
export interface LoginSnapshot {
  login: LoginState | 'not-needed'
  email?: string
  /** The other Accounts of its Same Login (spec §3.21). */
  sameLogin: readonly string[]
}

/** How to get a different login when the browser keeps signing in as the old one. */
const OTHER_LOGIN = 'sign out of it in the browser, or open the sign-in link in a private window'

/** The line before the sign-in: who the Account is now, and how to choose another login. Undefined when signed out. */
export function loginBeforeLine(ref: string, before: LoginSnapshot): string | undefined {
  if (before.login !== 'logged-in' || !before.email) return undefined
  const same = before.sameLogin.length ? `, the same login as ${before.sameLogin.join(', ')}` : ''
  return `${ref} is signed in as ${before.email}${same}. To use another login, first ${OTHER_LOGIN}.`
}

/** The result after the sign-in, with what to do next when it did not give the Account a login of its own. */
export function loginAfterLine(
  ref: string,
  before: LoginSnapshot,
  after: LoginSnapshot,
): { line: string; ok: boolean } | undefined {
  if (after.login === 'logged-out') return { line: `${ref} is not signed in.`, ok: false }
  if (after.login !== 'logged-in' || !after.email) return undefined
  const again = `${OTHER_LOGIN}, then run \`sideby login ${ref}\` again`
  const peers = after.sameLogin.join(', ')
  if (after.sameLogin.length && before.email === after.email && before.sameLogin.length)
    return {
      line: `${ref} is still signed in as ${after.email}, the same login as ${peers}: the browser used the login it was signed in to. To use another one, ${again}.`,
      ok: false,
    }
  if (after.sameLogin.length)
    return {
      line: `${ref} is now signed in as ${after.email}, the same login as ${peers}, so they share one quota. To use another login, ${again}.`,
      ok: false,
    }
  const split = before.sameLogin.length
    ? `; it no longer shares a quota with ${before.sameLogin.join(', ')}`
    : ''
  return { line: `${ref} is signed in as ${after.email}${split}.`, ok: true }
}
