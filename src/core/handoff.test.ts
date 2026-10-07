import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quotaPressure as panelPressure } from '../panel/page-logic.ts'
import type { QuotaResult } from '../types.ts'
import { type HandoffCandidate, planHandoff } from './handoff.ts'
import { quotaPressure } from './quota-levels.ts'

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

  it('matches the Panel copy for every case', () => {
    const cases = [
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
})
