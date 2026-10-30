import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  longWindow as panelLongWindow,
  quotaPressure as panelPressure,
  windowState as panelWindowState,
} from '../panel/page-logic.ts'
import type { QuotaResult } from '../types.ts'
import { type HandoffCandidate, planHandoff } from './handoff.ts'
import {
  isLongWindow,
  limitUse,
  QUOTA_FAIL_PERCENT,
  QUOTA_LONG_FAIL_PERCENT,
  QUOTA_LONG_WARN_PERCENT,
  QUOTA_WARN_PERCENT,
  quotaPressure,
  takeoverLimits,
  windowLevel,
} from './quota-levels.ts'

const NOW = new Date('2026-10-05T12:00:00Z')
const at = (hours: number) => new Date(NOW.getTime() + hours * 3600_000).toISOString()
const quota = (...windows: [number, number][]): QuotaResult => ({
  status: 'ok',
  observedAt: at(-1),
  source: 'test',
  windows: windows.map(([usedPercent, resetIn], i) => ({
    label: i ? '7d' : '5h',
    windowMinutes: i ? 10080 : 300,
    usedPercent,
    resetsAt: at(resetIn),
  })),
})
const none: QuotaResult = { status: 'unavailable', reason: 'no-session' }
const cand = (name: string, q: QuotaResult, o: Partial<HandoffCandidate> = {}): HandoffCandidate => ({
  ref: `claude:${name}`,
  name,
  isMain: name === 'main',
  kind: 'subscription',
  login: 'logged-in',
  quota: q,
  ...o,
})
const refs = (p: ReturnType<typeof planHandoff>) => p.accounts.map((e) => `${e.ref.slice(7)}:${e.state}`)

describe('quotaPressure', () => {
  it('takes the fullest live window, counts passed windows as 0 and has no value without Quota', () => {
    assert.equal(quotaPressure(quota([20, 2], [70, 50]), NOW), 70)
    assert.equal(quotaPressure(quota([95, -1], [30, 50]), NOW), 30, 'a reset window no longer counts')
    assert.equal(quotaPressure(quota([95, -1]), NOW), 0)
    assert.equal(quotaPressure(quota([140, 2]), NOW), 100)
    assert.equal(quotaPressure(none, NOW), null)
    assert.equal(quotaPressure({ status: 'ok', observedAt: at(-1), source: 'test', windows: [] }, NOW), null)
  })

  it('leaves out a window that covers only some models (spec §3.26)', () => {
    const named = quota([20, 2], [90, 50])
    if (named.status === 'ok') named.windows[1]!.name = 'Other models'
    assert.equal(quotaPressure(named, NOW), 20)
    if (named.status === 'ok') named.windows[0]!.name = 'Cursor models'
    assert.equal(quotaPressure(named, NOW), null, 'only named windows: no pressure to tell')
  })

  it('matches the Panel copy for every case', () => {
    const named = quota([20, 2], [90, 50])
    if (named.status === 'ok') named.windows[1]!.name = 'Other models'
    const cases = [
      named,
      quota([20, 2], [70, 50]),
      quota([95, -1], [30, 50]),
      quota([95, -1]),
      quota([140, 2]),
      none,
    ]
    for (const q of cases)
      assert.equal(
        panelPressure({ family: 'claude', name: 'x', ref: 'claude:x', quota: q }, NOW.getTime()),
        quotaPressure(q, NOW) ?? -1,
      )
  })
})

describe('planHandoff', () => {
  it('picks the lowest Quota Pressure, unknown Quota next, and keeps full and signed-out Accounts last', () => {
    const p = planHandoff(
      'claude',
      [
        cand('main', quota([90, 2], [40, 50])),
        cand('work', quota([30, 3])),
        cand('new', none),
        cand('lab', quota([10, 1], [20, 30])),
        cand('gone', quota([5, 1]), { login: 'logged-out' }),
        cand('key', { status: 'unavailable', reason: 'api-account' }, { kind: 'api', login: 'not-needed' }),
      ],
      NOW,
    )
    assert.equal(p.pick, 'claude:lab')
    assert.deepEqual(refs(p), [
      'lab:ready',
      'work:ready',
      'new:unknown',
      'key:api',
      'main:full',
      'gone:logged-out',
    ])
    assert.equal(p.accounts.find((e) => e.state === 'full')?.resetsAt, at(2))
    assert.equal(p.earliestReset, undefined)
  })

  it('treats a passed window as empty, so an Account full this morning is ready again', () => {
    const p = planHandoff(
      'claude',
      [cand('main', quota([20, 1])), cand('work', quota([100, -2], [10, 40]))],
      NOW,
    )
    assert.equal(p.pick, 'claude:work')
  })

  it('breaks ties with the Main Account first, then by name', () => {
    const p = planHandoff(
      'claude',
      [cand('w10', quota([10, 1])), cand('w9', quota([10, 1])), cand('main', quota([10, 1]))],
      NOW,
    )
    assert.deepEqual(refs(p), ['main:ready', 'w9:ready', 'w10:ready'])
  })

  it('picks an API Account only when asked', () => {
    const api = cand(
      'key',
      { status: 'unavailable', reason: 'api-account' },
      { kind: 'api', login: 'not-needed' },
    )
    const full = cand('main', quota([99, 3]))
    assert.equal(planHandoff('claude', [full, api], NOW).pick, null)
    assert.equal(planHandoff('claude', [full, api], NOW, { includeApi: true }).pick, 'claude:key')
  })

  it('names the first Account to come back when all are full, waiting for the last full window', () => {
    const p = planHandoff(
      'claude',
      [
        cand('main', quota([90, 1], [95, 48])),
        cand('work', quota([99, 5])),
        cand('gone', none, { login: 'logged-out' }),
      ],
      NOW,
    )
    assert.equal(p.pick, null)
    assert.deepEqual(refs(p), ['work:full', 'main:full', 'gone:logged-out'])
    assert.deepEqual(p.earliestReset, { ref: 'claude:work', at: at(5) })
  })

  it('orders full Accounts by reset time, an unreadable one last, whatever the input order', () => {
    const broken: QuotaResult = {
      status: 'ok',
      observedAt: at(-1),
      source: 'test',
      windows: [{ label: '5h', windowMinutes: 300, usedPercent: 99, resetsAt: 'soon' }],
    }
    const list = [cand('a', quota([99, 5])), cand('b', broken), cand('c', quota([99, 1]))]
    for (const order of [list, [list[1]!, list[0]!, list[2]!], [...list].reverse()]) {
      const p = planHandoff('claude', order, NOW)
      assert.deepEqual(refs(p), ['c:full', 'a:full', 'b:full'])
      assert.equal(p.earliestReset?.ref, 'claude:c')
    }
  })

  it('says whether any Account has Quota, and when each was recorded', () => {
    const guess = planHandoff('claude', [cand('main', none), cand('work', none)], NOW)
    assert.equal(guess.pick, 'claude:main')
    assert.equal(guess.hasQuota, false, 'a pick without any data is only a guess')
    const known = planHandoff('claude', [cand('main', quota([99, 2])), cand('new', none)], NOW)
    assert.equal(known.pick, 'claude:new', 'a fresh Account is the right move when the others are full')
    assert.equal(known.hasQuota, true)
    assert.equal(known.accounts.find((e) => e.ref === 'claude:main')?.observedAt, at(-1))
    assert.equal(known.accounts.find((e) => e.ref === 'claude:new')?.observedAt, undefined)
  })

  it('keeps an Account whose login state is unknown in the running', () => {
    assert.equal(
      planHandoff('claude', [cand('main', quota([10, 1]), { login: 'unknown' })], NOW).pick,
      'claude:main',
    )
  })

  it("never picks an Account of the current Account's Same Login, and marks it (spec §3.21)", () => {
    const shared = quota([30, 2])
    const main = cand('main', shared, { sameLogin: ['claude:001'] })
    const one = cand('001', shared, { sameLogin: ['claude:main'] })
    const work = cand('work', quota([50, 2]))
    const plan = planHandoff('claude', [main, one, work], NOW, { from: 'claude:001' })
    assert.equal(plan.from, 'claude:001')
    assert.equal(plan.accounts.find((e) => e.ref === 'claude:main')?.sameLoginAs, 'claude:001')
    assert.equal(plan.accounts.at(-1)?.ref, 'claude:main', 'it cannot be picked, so it comes last')
    assert.equal(plan.pick, 'claude:001', 'main would win the tie, but it shares the quota of 001')
    // Without a current Account nothing is skipped.
    assert.equal(planHandoff('claude', [main, one, work], NOW).pick, 'claude:main')
    // Only the same login left: the current one itself is full, so nothing can be picked.
    const full = quota([95, 2])
    const p2 = planHandoff(
      'claude',
      [cand('main', full, { sameLogin: ['claude:001'] }), cand('001', full, { sameLogin: ['claude:main'] })],
      NOW,
      { from: 'claude:001' },
    )
    assert.equal(p2.pick, null)
  })

  it('reports where a shared Quota was read from', () => {
    const borrowed = { ...quota([30, 2]), from: 'claude:001' } as QuotaResult
    const plan = planHandoff('claude', [cand('main', borrowed)], NOW)
    assert.equal(plan.accounts[0]?.quotaFrom, 'claude:001')
  })

  it('a Last Resort picks the least used full Account under 100%, ahead of API, and marks the plan tight', () => {
    const all = [
      cand('main', quota([50, 2], [97, 50])),
      cand('008', quota([86, 1], [40, 50])),
      cand('003', quota([99, 3])),
      cand('key', none, { kind: 'api', login: 'not-needed' }),
    ]
    const plan = planHandoff('claude', all, NOW, { lastResort: true, includeApi: true })
    // 008's 5-hour 86% is 101.2% of its limit of 85; main's weekly 97% is 102.1% of 95.
    assert.equal(plan.pick, 'claude:008')
    assert.deepEqual(plan.tight, { limit: 85, longLimit: 95 })
    assert.equal(plan.earliestReset, undefined)
    assert.deepEqual(refs(plan), ['008:full', 'main:full', '003:full', 'key:api'])
    // Auto Handoff's plan (no lastResort) keeps the Takeover Limit: nothing full is picked.
    const auto = planHandoff('claude', all.slice(0, 3), NOW)
    assert.equal(auto.pick, null)
    assert.equal(auto.tight, undefined)
    // An Account below the limit wins, unmarked; so does one without Quota data.
    const ready = planHandoff('claude', [...all, cand('lab', quota([84, 2]))], NOW, { lastResort: true })
    assert.deepEqual([ready.pick, ready.tight], ['claude:lab', undefined])
    const fresh = planHandoff('claude', [...all, cand('new', none)], NOW, { lastResort: true })
    assert.deepEqual([fresh.pick, fresh.tight], ['claude:new', undefined])
  })

  it('a Last Resort never starts an Account with a window used up, signed out or of the same login', () => {
    const plan = planHandoff(
      'claude',
      [
        cand('main', quota([100, 3], [90, 50])),
        cand('001', quota([100, 1], [95, 50])),
        cand('002', quota([20, 2]), { login: 'logged-out' }),
      ],
      NOW,
      { lastResort: true },
    )
    assert.equal(plan.pick, null)
    assert.equal(plan.tight, undefined)
    // Back once the used-up 5-hour window resets, not the weekly window that is only past the limit.
    assert.deepEqual(plan.earliestReset, { ref: 'claude:001', at: at(1) })
    const same = planHandoff(
      'claude',
      [cand('main', quota([90, 2]), { sameLogin: ['claude:001'] }), cand('001', quota([88, 2]))],
      NOW,
      { lastResort: true, from: 'claude:main' },
    )
    assert.equal(same.pick, 'claude:main')
  })
})

describe('Takeover Limits per window kind (spec §3.13, ADR-0062)', () => {
  const entryOf = (p: ReturnType<typeof planHandoff>, name: string) =>
    p.accounts.find((e) => e.ref === `claude:${name}`)!

  it('a weekly window at 87% with the 5-hour window at 43% is ready', () => {
    const p = planHandoff('claude', [cand('008', quota([43, 1], [87, 120]))], NOW)
    assert.equal(p.pick, 'claude:008')
    const e = entryOf(p, '008')
    assert.equal(e.state, 'ready')
    assert.equal(e.pressure, 87, 'Quota Pressure itself stays the fullest window')
    assert.equal(e.limitUse, 91.6)
    assert.deepEqual(e.window, { label: '7d', usedPercent: 87, limit: 95 })
  })

  it('a weekly window at 96% makes the Account full until that window resets', () => {
    const p = planHandoff('claude', [cand('main', quota([10, 2], [96, 72]))], NOW)
    assert.equal(p.pick, null)
    assert.equal(entryOf(p, 'main').state, 'full')
    assert.equal(entryOf(p, 'main').resetsAt, at(72))
    assert.deepEqual(p.earliestReset, { ref: 'claude:main', at: at(72) })
  })

  it('a 5-hour window at 86% makes the Account full until that window resets', () => {
    const p = planHandoff('claude', [cand('main', quota([86, 2], [50, 72]))], NOW)
    assert.equal(entryOf(p, 'main').state, 'full')
    assert.equal(
      entryOf(p, 'main').resetsAt,
      at(2),
      'the weekly window is under its limit, so it does not wait for it',
    )
  })

  it('ranks ready Accounts by the window closest to its own limit', () => {
    const p = planHandoff(
      'claude',
      [
        cand('a', quota([43, 1], [87, 120])),
        cand('b', quota([80, 1], [10, 120])),
        cand('c', quota([20, 1], [60, 120])),
      ],
      NOW,
    )
    // c: 7d 60/95 = 63.2; a: 7d 87/95 = 91.6; b: 5h 80/85 = 94.1, though b's fullest window (80) is below a's (87).
    assert.deepEqual(refs(p), ['c:ready', 'a:ready', 'b:ready'])
    assert.deepEqual(
      p.accounts.map((e) => e.limitUse),
      [63.2, 91.6, 94.1],
    )
  })

  it('both limits follow the Handoff Threshold', () => {
    assert.deepEqual(takeoverLimits(95), { short: 85, long: 95 })
    assert.deepEqual(takeoverLimits(90), { short: 80, long: 90 })
    const q = quota([30, 1], [91, 120])
    assert.equal(planHandoff('claude', [cand('main', q)], NOW).accounts[0]!.state, 'ready')
    assert.equal(
      planHandoff('claude', [cand('main', q)], NOW, { limits: takeoverLimits(90) }).accounts[0]!.state,
      'full',
    )
  })

  it('tells a Long Window by its length: a week or a billing period, from the minutes or the label', () => {
    assert.equal(isLongWindow({ label: '5h', windowMinutes: 300 }), false)
    assert.equal(
      isLongWindow({ label: '24h', windowMinutes: 1440 }),
      false,
      'one day is not longer than a day',
    )
    assert.equal(isLongWindow({ label: '7d', windowMinutes: 10080 }), true)
    assert.equal(isLongWindow({ label: '30d', windowMinutes: 43200 }), true)
    assert.equal(
      isLongWindow({ label: '7d', windowMinutes: 0 }),
      true,
      'the label when the minutes are missing',
    )
    assert.equal(isLongWindow({ label: '300m' }), false)
    assert.equal(isLongWindow({ label: 'odd' }), false)
    const billing: QuotaResult = {
      status: 'ok',
      observedAt: at(-1),
      source: 'test',
      windows: [{ label: '30d', windowMinutes: 43200, usedPercent: 90, resetsAt: at(200) }],
    }
    assert.equal(limitUse(billing, NOW, takeoverLimits(95))?.window?.label, '30d')
    assert.equal(planHandoff('grok', [cand('main', billing)], NOW).accounts[0]!.state, 'ready')
  })

  it('colors each window by its own levels, the same in the CLI, the menu bar and the Panel', () => {
    assert.equal(windowLevel({ label: '5h', windowMinutes: 300, usedPercent: 87 }), 'fail')
    assert.equal(windowLevel({ label: '7d', windowMinutes: 10080, usedPercent: 87 }), 'warn')
    assert.equal(windowLevel({ label: '7d', windowMinutes: 10080, usedPercent: 84 }), 'ok')
    assert.equal(windowLevel({ label: '7d', windowMinutes: 10080, usedPercent: 95 }), 'fail')
    const long = { warn: QUOTA_LONG_WARN_PERCENT, fail: QUOTA_LONG_FAIL_PERCENT }
    const shapes = [
      { label: '5h', windowMinutes: 300 },
      { label: '7d', windowMinutes: 10080 },
      { label: '30d', windowMinutes: 43200 },
      { label: '24h', windowMinutes: 1440 },
      { label: '7d', windowMinutes: 0 },
      { label: '2w' },
      { label: '90m' },
      { label: 'odd' },
    ]
    for (const shape of shapes) {
      assert.equal(panelLongWindow(shape), isLongWindow(shape), JSON.stringify(shape))
      for (const usedPercent of [0, 59, 60, 84, 85, 86, 94, 95, 100]) {
        const w = { ...shape, usedPercent, resetsAt: at(3) }
        assert.equal(
          panelWindowState(w, NOW.getTime(), QUOTA_WARN_PERCENT, QUOTA_FAIL_PERCENT, long).level,
          windowLevel(w),
          `${JSON.stringify(shape)} at ${usedPercent}%`,
        )
      }
    }
  })
})
