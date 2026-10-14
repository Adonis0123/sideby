// Picking the next Account of an Auto Handoff (spec §3.17 "选号").
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QuotaResult } from '../types.ts'
import { handoffSettings } from './config.ts'
import { type SelectCandidate, sameOrganization, selectNext } from './handoff-select.ts'

const NOW = new Date('2026-10-09T12:00:00Z')
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString()
const quota = (used: number, resetsInMinutes = 120): QuotaResult => ({
  status: 'ok',
  windows: [{ label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: inMinutes(resetsInMinutes) }],
  observedAt: NOW.toISOString(),
  source: 'test',
})

function acct(ref: string, over: Partial<SelectCandidate> = {}): SelectCandidate {
  const [family, name] = ref.split(':') as [string, string]
  return {
    ref,
    family,
    name,
    isMain: name === 'main',
    kind: 'subscription',
    login: 'logged-in',
    quota: quota(10),
    installed: true,
    receive: true,
    ...over,
  }
}

const origin = acct('claude:001', { quota: quota(96, 120) })
const settings = (h: Parameters<typeof handoffSettings>[0]['handoff']) => handoffSettings({ handoff: h })
const pick = (ref: string) => ({ kind: 'pick', ref })

describe('selectNext', () => {
  it('waits when the full window resets within the configured minutes, not one minute later', () => {
    const base = { candidates: [acct('claude:002')], aliases: {}, used: [], now: NOW }
    const s = settings({ auto: true, sameFamily: true })
    assert.deepEqual(
      selectNext({ ...base, origin: acct('claude:001', { quota: quota(96, 30) }), settings: s }),
      {
        kind: 'wait',
        until: inMinutes(30),
      },
    )
    assert.deepEqual(
      selectNext({ ...base, origin: acct('claude:001', { quota: quota(96, 31) }), settings: s }),
      pick('claude:002'),
    )
  })

  it('ahead, counts the fullest window past prepareAt as full: the plan read at the threshold already says wait', () => {
    const base = { candidates: [acct('claude:002')], aliases: {}, used: [], now: NOW }
    const s = settings({ auto: true, sameFamily: true })
    const at = (used: number) => acct('claude:001', { quota: quota(used, 20) })
    assert.deepEqual(selectNext({ ...base, origin: at(90), settings: s }), pick('claude:002'))
    assert.deepEqual(selectNext({ ...base, origin: at(90), settings: s, ahead: true }), {
      kind: 'wait',
      until: inMinutes(20),
    })
    // Below prepareAt it is too early to say the window will be full before it resets.
    assert.deepEqual(selectNext({ ...base, origin: at(70), settings: s, ahead: true }), pick('claude:002'))
  })

  it('ahead, looks only at the fullest window: a weekly window that resets in days means no wait', () => {
    const base = { candidates: [acct('claude:002')], aliases: {}, used: [], now: NOW }
    const s = settings({ auto: true, sameFamily: true })
    const two = (weekly: number): QuotaResult => ({
      status: 'ok',
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: 90, resetsAt: inMinutes(20) },
        { label: '7d', windowMinutes: 10_080, usedPercent: weekly, resetsAt: inMinutes(3 * 1440) },
      ],
      observedAt: NOW.toISOString(),
      source: 'test',
    })
    const origin = (weekly: number) => acct('claude:001', { quota: two(weekly) })
    assert.deepEqual(
      selectNext({ ...base, origin: origin(94), settings: s, ahead: true }),
      pick('claude:002'),
    )
    assert.deepEqual(selectNext({ ...base, origin: origin(50), settings: s, ahead: true }), {
      kind: 'wait',
      until: inMinutes(20),
    })
  })

  it('follows an order list and resolves short commands', () => {
    const r = selectNext({
      origin,
      candidates: [acct('claude:002', { quota: quota(5) }), acct('codex:main', { quota: quota(50) })],
      settings: settings({
        auto: true,
        sameFamily: true,
        families: { claude: { policy: 'order', order: ['codex001', 'cc002'] } },
      }),
      aliases: { codex001: 'codex:main', cc002: 'claude:002' },
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('codex:main'))
  })

  it('skips used, full, signed-out, missing-host and non-receiving Accounts', () => {
    const r = selectNext({
      origin,
      candidates: [
        acct('claude:002'),
        acct('claude:003', { quota: quota(90) }),
        acct('claude:004', { login: 'logged-out' }),
        acct('claude:005', { installed: false }),
        acct('claude:006', { receive: false }),
        acct('claude:007', { quota: quota(40) }),
      ],
      settings: settings({ auto: true, sameFamily: true }),
      aliases: {},
      used: ['claude:002'],
      now: NOW,
    })
    assert.deepEqual(r, pick('claude:007'))
  })

  it('leaves out the same Family unless sameFamily is on, then adds other Families’ API accounts', () => {
    const candidates = [acct('claude:002'), acct('codex:work', { kind: 'api' })]
    const base = { origin, candidates, aliases: {}, used: [], now: NOW }
    assert.deepEqual(selectNext({ ...base, settings: settings({ auto: true }) }), pick('codex:work'))
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, sameFamily: true }) }),
      pick('claude:002'),
    )
  })

  it('lets a same-Family API account take over without sameFamily', () => {
    const r = selectNext({
      origin,
      candidates: [acct('claude:002'), acct('claude:deepseek', { kind: 'api' })],
      settings: settings({ auto: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('claude:deepseek'))
  })

  it('treats an Account already at the user’s threshold as full, with its reset time', () => {
    const r = selectNext({
      origin,
      candidates: [acct('claude:002', { quota: quota(70, 45) })],
      settings: settings({ auto: true, sameFamily: true, prepareAt: 50, threshold: 60 }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, {
      kind: 'none',
      reason: 'every account that may take over is full or signed out',
      earliestReset: { ref: 'claude:002', at: inMinutes(45) },
    })
  })

  it('prefers a ready or unknown Account over an API account in an order list', () => {
    const r = selectNext({
      origin,
      candidates: [
        acct('claude:api', { kind: 'api' }),
        acct('codex:main', { quota: { status: 'unavailable', reason: 'no-session' } }),
      ],
      settings: settings({
        auto: true,
        families: { claude: { policy: 'order', order: ['claude:api', 'codex:main'] } },
      }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('codex:main'))
  })

  it('skips another organization unless the Account is allowed in crossOrganization', () => {
    const work = acct('claude:001', { quota: quota(96), identity: { email: 'me@work.dev', org: 'Work' } })
    const candidates = [acct('codex:main', { identity: { email: 'me@gmail.com' } })]
    const base = { origin: work, candidates, aliases: { codex001: 'codex:main' }, used: [], now: NOW }
    const order = { claude: { policy: 'order' as const, order: ['codex001'] } }
    assert.equal(selectNext({ ...base, settings: settings({ auto: true, families: order }) }).kind, 'none')
    assert.deepEqual(
      selectNext({
        ...base,
        settings: settings({ auto: true, families: order, crossOrganization: ['codex001'] }),
      }),
      pick('codex:main'),
    )
  })

  it('reports the earliest reset when nothing can be picked', () => {
    const r = selectNext({
      origin,
      candidates: [
        acct('claude:002', { quota: quota(99, 200) }),
        acct('claude:003', { quota: quota(99, 90) }),
      ],
      settings: settings({ auto: true, sameFamily: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.equal(r.kind, 'none')
    assert.deepEqual(r.kind === 'none' && r.earliestReset, { ref: 'claude:003', at: inMinutes(90) })
  })

  it('ranks the Family by pressure when no order is written', () => {
    const r = selectNext({
      origin,
      candidates: [acct('claude:002', { quota: quota(50) }), acct('claude:003', { quota: quota(20) })],
      settings: settings({ auto: true, sameFamily: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('claude:003'))
  })
})

describe('sameOrganization', () => {
  it('compares organizations, then email domains, and treats missing data as the same', () => {
    assert.equal(sameOrganization({ org: 'Work' }, { org: 'work' }), true)
    assert.equal(sameOrganization({ org: 'Work' }, { org: 'Home' }), false)
    assert.equal(sameOrganization({ email: 'a@work.dev', org: 'Work' }, { email: 'b@work.dev' }), true)
    assert.equal(sameOrganization({ email: 'a@work.dev' }, { email: 'b@gmail.com' }), false)
    assert.equal(sameOrganization({ email: 'a@work.dev' }, undefined), true)
    assert.equal(sameOrganization(undefined, undefined), true)
  })

  it('never hands over to the same login, and says so when the Handoff Order names it (spec §3.21)', () => {
    const from = acct('claude:001', { quota: quota(96, 300), sameLogin: ['claude:main'] })
    const main = acct('claude:main', { quota: quota(96, 300), sameLogin: ['claude:001'] })
    const s = settings({
      auto: true,
      sameFamily: true,
      families: { claude: { policy: 'order', order: ['claude:main', 'claude:002'] } },
    })
    const d = selectNext({
      origin: from,
      candidates: [from, main, acct('claude:002')],
      settings: s,
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.equal(d.kind, 'pick')
    assert.equal(d.kind === 'pick' && d.ref, 'claude:002')
    assert.deepEqual(d.kind === 'pick' && d.skipped, [
      { ref: 'claude:main', reason: 'same login as claude:001, so it shares the same quota' },
    ])
    // Only the same login in the order: no account may take over, and the reason names it.
    const only = selectNext({
      origin: from,
      candidates: [from, { ...main, quota: quota(10) }],
      settings: settings({
        auto: true,
        sameFamily: true,
        families: { claude: { policy: 'order', order: ['claude:main'] } },
      }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.equal(only.kind, 'none')
    assert.equal(only.kind === 'none' && only.skipped?.[0]?.ref, 'claude:main')
    // By pressure as well: main has room on paper, but it is the same quota.
    const byPressure = selectNext({
      origin: from,
      candidates: [from, { ...main, quota: quota(10) }, acct('claude:002', { quota: quota(40) })],
      settings: settings({ auto: true, sameFamily: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.equal(byPressure.kind === 'pick' && byPressure.ref, 'claude:002')
  })
})
