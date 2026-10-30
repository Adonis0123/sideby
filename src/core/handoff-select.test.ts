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
      selectNext({
        ...base,
        origin: acct('claude:001', { quota: quota(96, 30), resumesAtReset: true }),
        settings: s,
      }),
      {
        kind: 'wait',
        until: inMinutes(30),
      },
    )
    assert.deepEqual(
      selectNext({
        ...base,
        origin: acct('claude:001', { quota: quota(96, 31), resumesAtReset: true }),
        settings: s,
      }),
      pick('claude:002'),
    )
  })

  it('never waits when the session cannot go on by itself, nor when the user asked to move on', () => {
    const base = { candidates: [acct('claude:002')], aliases: {}, used: [], now: NOW }
    const s = settings({ auto: true, sameFamily: true })
    const full = (resumesAtReset?: boolean) =>
      acct('claude:001', {
        quota: quota(96, 10),
        ...(resumesAtReset === undefined ? {} : { resumesAtReset }),
      })
    assert.deepEqual(selectNext({ ...base, origin: full(false), settings: s }), pick('claude:002'))
    assert.deepEqual(selectNext({ ...base, origin: full(), settings: s }), pick('claude:002'))
    assert.deepEqual(
      selectNext({ ...base, origin: full(true), settings: s, manual: true }),
      pick('claude:002'),
    )
    assert.equal(selectNext({ ...base, origin: full(true), settings: s }).kind, 'wait')
  })

  it('ahead, counts the fullest window past prepareAt as full: the plan read at the threshold already says wait', () => {
    const base = { candidates: [acct('claude:002')], aliases: {}, used: [], now: NOW }
    const s = settings({ auto: true, sameFamily: true })
    const at = (used: number) => acct('claude:001', { quota: quota(used, 20), resumesAtReset: true })
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
    const origin = (weekly: number) => acct('claude:001', { quota: two(weekly), resumesAtReset: true })
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

  it('suggests a setting only when it would bring in an account that can take over', () => {
    const candidates = [
      acct('claude:002', { installed: false }),
      acct('claude:003', { receive: false }),
      acct('codex:work', { kind: 'api', installed: false }),
    ]
    assert.deepEqual(
      selectNext({ origin, candidates, settings: settings({ auto: true }), aliases: {}, used: [], now: NOW }),
      { kind: 'none', reason: 'no account may take over' },
    )
  })

  it('leaves out the same Family unless sameFamily is on, and API accounts unless api is on (ADR-0046)', () => {
    const candidates = [acct('claude:002'), acct('codex:work', { kind: 'api' })]
    const base = { origin, candidates, aliases: {}, used: [], now: NOW }
    assert.deepEqual(selectNext({ ...base, settings: settings({ auto: true }) }), {
      kind: 'none',
      reason:
        'no account may take over; not allowed now: accounts of the same AI (`handoff.sameFamily`), API accounts (`handoff.api`)',
    })
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, api: true }) }),
      pick('codex:work'),
    )
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, sameFamily: true }) }),
      pick('claude:002'),
    )
  })

  it('lets a same-Family API account take over without sameFamily once api is on', () => {
    const r = selectNext({
      origin,
      candidates: [acct('claude:002'), acct('claude:deepseek', { kind: 'api' })],
      settings: settings({ auto: true, api: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('claude:deepseek'))
  })

  it('takes an API account only after every subscription, the own Family’s API account first', () => {
    const r = selectNext({
      origin,
      candidates: [
        acct('codex:api', { kind: 'api' }),
        acct('claude:deepseek', { kind: 'api' }),
        acct('claude:002', { quota: quota(90) }),
        acct('codex:main', { quota: quota(30) }),
      ],
      settings: settings({ auto: true, sameFamily: true, otherFamilies: true, api: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(r, pick('codex:main'))
    const none = selectNext({
      origin,
      candidates: [
        acct('codex:api', { kind: 'api' }),
        acct('claude:deepseek', { kind: 'api' }),
        acct('codex:main', { quota: quota(90) }),
      ],
      settings: settings({ auto: true, otherFamilies: true, api: true }),
      aliases: {},
      used: [],
      now: NOW,
    })
    assert.deepEqual(none, pick('claude:deepseek'))
  })

  it('hands over to other Families only with otherFamilies, in familyOrder', () => {
    const candidates = [acct('codex:main', { quota: quota(20) }), acct('grok:main', { quota: quota(5) })]
    const base = { origin, candidates, aliases: {}, used: [], now: NOW }
    assert.equal(selectNext({ ...base, settings: settings({ auto: true }) }).kind, 'none')
    // Without an order, Families come as the candidates do; each Family's own ranking still applies.
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, otherFamilies: true }) }),
      pick('codex:main'),
    )
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, otherFamilies: true, familyOrder: ['grok'] }) }),
      pick('grok:main'),
    )
    // The own Family comes first when sameFamily is on.
    assert.deepEqual(
      selectNext({
        ...base,
        candidates: [...candidates, acct('claude:002', { quota: quota(50) })],
        settings: settings({ auto: true, sameFamily: true, otherFamilies: true, familyOrder: ['grok'] }),
      }),
      pick('claude:002'),
    )
  })

  it('skips an Account at or above the Takeover Limit, which follows the threshold', () => {
    const candidates = [acct('claude:002', { quota: quota(86) }), acct('claude:003', { quota: quota(60) })]
    const base = { origin, candidates, aliases: {}, used: [], now: NOW }
    // Threshold 95: the limit is 85, so 86% is full.
    assert.deepEqual(
      selectNext({ ...base, settings: settings({ auto: true, sameFamily: true }) }),
      pick('claude:003'),
    )
    // Threshold 70: the limit is 60, so 60% is full too and nothing can take over.
    const r = selectNext({
      ...base,
      settings: settings({ auto: true, sameFamily: true, prepareAt: 50, threshold: 70 }),
    })
    assert.equal(r.kind, 'none')
  })

  it('keeps API accounts out of a written Handoff Order unless api is on', () => {
    const s = {
      auto: true,
      families: { claude: { policy: 'order' as const, order: ['codex:api', 'codex:main'] } },
    }
    const base = {
      origin,
      candidates: [acct('codex:api', { kind: 'api' }), acct('codex:main', { quota: quota(30) })],
      aliases: {},
      used: [],
      now: NOW,
    }
    const full = {
      ...base,
      candidates: [acct('codex:api', { kind: 'api' }), acct('codex:main', { quota: quota(90) })],
    }
    assert.equal(selectNext({ ...full, settings: settings(s) }).kind, 'none')
    assert.deepEqual(selectNext({ ...full, settings: settings({ ...s, api: true }) }), pick('codex:api'))
    // Still the last resort: a subscription with room comes first even when the list names the API account first.
    assert.deepEqual(selectNext({ ...base, settings: settings({ ...s, api: true }) }), pick('codex:main'))
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
  describe('an Account the chain already used (ADR-0060)', () => {
    const s = settings({ auto: true, sameFamily: true })
    const left = (ref: string, resetsInMinutes?: number) => ({
      ref,
      ...(resetsInMinutes === undefined
        ? {}
        : { window: { label: '5h', usedPercent: 96, resetsAt: inMinutes(resetsInMinutes) } }),
    })
    const base = { origin, aliases: {}, now: NOW, settings: s }
    const back = acct('claude:008', { quota: quota(20) })

    it('is picked again once the window it handed over for has reset', () => {
      const used = [left('claude:008', -1), left('claude:001')]
      assert.deepEqual(selectNext({ ...base, candidates: [back], used }), pick('claude:008'))
      // Exactly at the reset time counts as reset.
      const atReset = [left('claude:008', 0), left('claude:001')]
      assert.deepEqual(selectNext({ ...base, candidates: [back], used: atReset }), pick('claude:008'))
    })

    it('stays out while that window has not reset', () => {
      const used = [left('claude:008', 30), left('claude:001')]
      assert.equal(selectNext({ ...base, candidates: [back], used }).kind, 'none')
    })

    it('with no recorded window, is picked again when its own Quota shows it ready', () => {
      // claude:008 → 003 (handed over by hand, no window) → 008: 003's window has reset since.
      const used = [left('claude:008', -300), left('claude:003'), left('claude:001')]
      const back3 = acct('claude:003', { quota: quota(20) })
      assert.deepEqual(selectNext({ ...base, candidates: [back3], used }), pick('claude:003'))
      // Its latest hop decides: it came back with a reset window and then left again by hand.
      const again = [left('claude:003', -60), left('claude:002', -1), left('claude:003'), left('claude:001')]
      assert.deepEqual(selectNext({ ...base, candidates: [back3], used: again }), pick('claude:003'))
    })

    it('with no recorded window, stays out while its Quota is not known, and says why', () => {
      const unknown = acct('claude:008', { quota: { status: 'unavailable', reason: 'no-source' } })
      const used = [left('claude:008'), left('claude:001')]
      const r = selectNext({ ...base, candidates: [unknown], used })
      assert.equal(r.kind, 'none')
      assert.equal(r.kind === 'none' && r.reason, 'no account may take over')
      assert.deepEqual(r.kind === 'none' && r.skipped?.map((x) => x.ref), ['claude:008'])
      // A fresh Account with unknown Quota is still picked; the used one is only named as skipped.
      const fresh = acct('claude:002', { quota: { status: 'unavailable', reason: 'no-source' } })
      const r2 = selectNext({ ...base, candidates: [unknown, fresh], used })
      assert.equal(r2.kind === 'pick' && r2.ref, 'claude:002')
      // An API account is not Quota data either.
      const api = acct('claude:008', { kind: 'api', login: 'not-needed' })
      const withApi = { ...base, settings: settings({ auto: true, sameFamily: true, api: true }) }
      assert.equal(selectNext({ ...withApi, candidates: [api], used }).kind, 'none')
    })

    it('with no recorded window, stays out while full and names its reset', () => {
      const full = acct('claude:008', { quota: quota(90, 200) })
      const r = selectNext({ ...base, candidates: [full], used: [left('claude:008'), left('claude:001')] })
      assert.equal(r.kind, 'none')
      assert.deepEqual(r.kind === 'none' && r.earliestReset, { ref: 'claude:008', at: inMinutes(200) })
    })

    it('stays out when only its ref is known', () => {
      assert.equal(
        selectNext({ ...base, candidates: [back], used: ['claude:008', 'claude:001'] }).kind,
        'none',
      )
    })

    it('stays out when its window reset but it is full again', () => {
      const full = acct('claude:008', { quota: quota(90, 200) })
      const used = [left('claude:008', -1), left('claude:001')]
      const r = selectNext({ ...base, candidates: [full], used })
      assert.equal(r.kind, 'none')
      assert.deepEqual(r.kind === 'none' && r.earliestReset, { ref: 'claude:008', at: inMinutes(200) })
    })

    it('never makes the origin a pick, even when its own recorded window has reset', () => {
      const self = acct('claude:001', { quota: quota(10) })
      const used = [left('claude:001', -60), left('claude:002', -1), left('claude:001')]
      assert.equal(selectNext({ ...base, origin: self, candidates: [self], used }).kind, 'none')
    })
  })

  it('with to, picks only that Account, also one the chain already used, and says why it cannot', () => {
    const s = settings({ auto: true, sameFamily: true })
    const base = {
      origin,
      aliases: { cc008: 'claude:008' },
      used: ['claude:008', 'claude:001'],
      now: NOW,
      settings: s,
    }
    const back = acct('claude:008', { quota: quota(20) })
    const candidates = [acct('claude:002'), back]
    assert.deepEqual(
      selectNext({ ...base, candidates }),
      pick('claude:002'),
      'without to, a used Account is left out',
    )
    assert.deepEqual(selectNext({ ...base, candidates, to: 'cc008' }), pick('claude:008'))
    // The origin about to reset would mean wait; the user named an Account, so that applies only without to.
    const resetting = acct('claude:001', { quota: quota(96, 10) })
    assert.deepEqual(
      selectNext({ ...base, origin: resetting, candidates, to: 'claude:008' }),
      pick('claude:008'),
    )

    const full = acct('claude:008', { quota: quota(97, 60) })
    assert.deepEqual(selectNext({ ...base, candidates: [full], to: 'claude:008' }), {
      kind: 'none',
      reason: 'claude:008 cannot take over now: its quota is full',
      earliestReset: { ref: 'claude:008', at: inMinutes(60) },
    })
    const self = selectNext({ ...base, candidates: [origin], to: 'claude:001' })
    assert.equal(self.kind, 'none')
    const off = selectNext({ ...base, settings: settings({ auto: true }), candidates, to: 'claude:008' })
    assert.match(off.kind === 'none' ? off.reason : '', /sameFamily/)
    assert.deepEqual(selectNext({ ...base, candidates, to: 'claude:009' }), {
      kind: 'none',
      reason: 'claude:009 is not an account sideby can find',
    })
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
