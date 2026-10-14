// Same Login (spec §3.21, ADR-0016): which Accounts share one Quota, and which reading they show.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QuotaResult } from '../types.ts'
import { isSameLogin, type LoginMember, sameLoginGroups, sharedQuota } from './same-login.ts'

const m = (
  ref: string,
  identity?: LoginMember['identity'],
  over: Partial<LoginMember> = {},
): LoginMember => ({
  ref,
  family: ref.slice(0, ref.indexOf(':')),
  kind: 'subscription',
  ...(identity ? { identity } : {}),
  ...over,
})

describe('isSameLogin', () => {
  it('groups the same email and organization, ignoring case', () => {
    assert.ok(
      isSameLogin(
        m('claude:main', { email: 'a@x.dev', org: 'Acme' }),
        m('claude:001', { email: 'A@x.dev', org: 'acme' }),
      ),
    )
  })

  it('groups the same email when neither has an organization', () => {
    assert.ok(isSameLogin(m('claude:main', { email: 'a@x.dev' }), m('claude:001', { email: 'a@x.dev' })))
  })

  it('does not group a different organization, or one side without an organization', () => {
    const a = m('claude:main', { email: 'a@x.dev', org: 'Acme' })
    assert.equal(isSameLogin(a, m('claude:001', { email: 'a@x.dev', org: 'Other' })), false)
    assert.equal(isSameLogin(a, m('claude:001', { email: 'a@x.dev' })), false)
    assert.equal(isSameLogin(m('claude:001', { email: 'a@x.dev' }), a), false)
  })

  it('never groups without an email, API Accounts, different Families, or codex (v1)', () => {
    assert.equal(isSameLogin(m('claude:main', { org: 'Acme' }), m('claude:001', { org: 'Acme' })), false)
    assert.equal(isSameLogin(m('claude:main'), m('claude:001')), false)
    const id = { email: 'a@x.dev' }
    assert.equal(isSameLogin(m('claude:main', id), m('claude:key', id, { kind: 'api' })), false)
    assert.equal(isSameLogin(m('claude:main', id), m('codex:main', id)), false)
    assert.equal(isSameLogin(m('codex:main', id), m('codex:001', id)), false)
    assert.equal(isSameLogin(m('grok:main', id), m('grok:001', id)), false)
    assert.equal(isSameLogin(m('claude:main', id), m('claude:main', id)), false, 'not with itself')
  })
})

describe('sameLoginGroups', () => {
  it('lists the other members for each Account of a group, in the order given', () => {
    const id = { email: 'a@x.dev' }
    const groups = sameLoginGroups([
      m('claude:main', id),
      m('claude:001', id),
      m('claude:002', { email: 'b@x.dev' }),
      m('claude:003', id),
      m('codex:main', id),
    ])
    assert.deepEqual(Object.fromEntries(groups), {
      'claude:main': ['claude:001', 'claude:003'],
      'claude:001': ['claude:main', 'claude:003'],
      'claude:003': ['claude:main', 'claude:001'],
    })
  })
})

describe('sharedQuota', () => {
  const ok = (observedAt: string, used: number): QuotaResult => ({
    status: 'ok',
    observedAt,
    source: 'test',
    windows: [{ label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: '2026-10-14T20:00:00Z' }],
  })
  const fresh = ok('2026-10-14T12:00:00Z', 64)
  const old = ok('2026-10-14T06:00:00Z', 25)
  const readings = (r: Record<string, QuotaResult>) => new Map(Object.entries(r))

  it('takes the freshest reading of the group and names where it came from', () => {
    const r = readings({ 'claude:main': old, 'claude:001': fresh })
    assert.deepEqual(sharedQuota('claude:main', r, ['claude:001']), { ...fresh, from: 'claude:001' })
    assert.deepEqual(sharedQuota('claude:001', r, ['claude:main']), fresh, 'its own reading has no from')
  })

  it('borrows when the Account has no reading of its own, and keeps its own reason when nobody has one', () => {
    const none: QuotaResult = { status: 'unavailable', reason: 'no-session' }
    assert.deepEqual(
      sharedQuota('claude:main', readings({ 'claude:main': none, 'claude:001': old }), ['claude:001']),
      {
        ...old,
        from: 'claude:001',
      },
    )
    const off: QuotaResult = { status: 'unavailable', reason: 'not-enabled' }
    assert.deepEqual(
      sharedQuota('claude:main', readings({ 'claude:main': off, 'claude:001': none }), ['claude:001']),
      off,
    )
  })

  it('keeps its own reading on a tie', () => {
    const same = ok(fresh.status === 'ok' ? fresh.observedAt : '', 10)
    assert.deepEqual(
      sharedQuota('claude:main', readings({ 'claude:main': same, 'claude:001': fresh }), ['claude:001']),
      same,
    )
  })
})
