// Sign in again (spec §3.21 "换个账号登录"): what `sideby login` says before and after the Host's sign-in.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type LoginSnapshot, loginAfterLine, loginBeforeLine } from './login-check.ts'

const snap = (
  email: string | undefined,
  sameLogin: string[] = [],
  login: LoginSnapshot['login'] = 'logged-in',
) => ({
  login,
  ...(email ? { email } : {}),
  sameLogin,
})

describe('loginBeforeLine', () => {
  it('names the current login and its Same Login peers', () => {
    const line = loginBeforeLine('codex:team', snap('me@example.com', ['codex:main']))
    assert.match(line!, /signed in as me@example\.com, the same login as codex:main/)
    assert.match(line!, /private window/)
  })

  it('says nothing for a signed-out Account or one without an email', () => {
    assert.equal(loginBeforeLine('codex:team', snap(undefined, [], 'logged-out')), undefined)
    assert.equal(loginBeforeLine('codex:team', snap(undefined)), undefined)
  })
})

describe('loginAfterLine', () => {
  it('reports a login of its own, and the quota it no longer shares', () => {
    const r = loginAfterLine('codex:team', snap('me@example.com', ['codex:main']), snap('team@example.com'))
    assert.deepEqual(r, {
      line: 'codex:team is signed in as team@example.com; it no longer shares a quota with codex:main.',
      ok: true,
    })
  })

  it('warns when the browser signed in as the same login again', () => {
    const before = snap('me@example.com', ['codex:main'])
    const r = loginAfterLine('codex:team', before, before)
    assert.equal(r!.ok, false)
    assert.match(r!.line, /still signed in as me@example\.com, the same login as codex:main/)
    assert.match(r!.line, /sideby login codex:team` again/)
  })

  it('warns when a new sign-in became the same login as another Account', () => {
    const r = loginAfterLine(
      'codex:team',
      snap(undefined, [], 'logged-out'),
      snap('me@example.com', ['codex:main']),
    )
    assert.equal(r!.ok, false)
    assert.match(
      r!.line,
      /now signed in as me@example\.com, the same login as codex:main, so they share one quota/,
    )
  })

  it('keeps a plain re-sign-in of the same login quiet', () => {
    const r = loginAfterLine('claude:work', snap('me@example.com'), snap('me@example.com'))
    assert.deepEqual(r, { line: 'claude:work is signed in as me@example.com.', ok: true })
  })

  it('says when the Account is still signed out, and nothing when the state is unknown', () => {
    assert.equal(loginAfterLine('codex:team', snap(undefined), snap(undefined, [], 'logged-out'))!.ok, false)
    assert.equal(loginAfterLine('pi:main', snap(undefined), snap(undefined, [], 'unknown')), undefined)
  })
})
