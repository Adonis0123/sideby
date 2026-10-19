// Hand-over Levels (spec §3.17 "交接档", ADR-0032): each window's level from its recent turns.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { QuotaWindow } from '../types.ts'
import { crossedWindow, firstMark, handOverLevel, recordTurn } from './levels.ts'

const plan = { prepareAt: 80, threshold: 95, adaptive: true }
const w = (label: string, usedPercent: number, resetsAt = '2026-10-09T15:00:00Z'): QuotaWindow => ({
  label,
  windowMinutes: label === '7d' ? 10080 : 300,
  usedPercent,
  resetsAt,
})

describe('hand-over levels', () => {
  it('uses threshold until a turn is measured, and always when adaptive is off', () => {
    assert.equal(handOverLevel('5h', plan, {}), 95)
    assert.equal(handOverLevel('5h', { ...plan, adaptive: false }, { turnUse: { '5h': [1] } }), 95)
    assert.equal(handOverLevel('5h', { prepareAt: 80, threshold: 95 }, { turnUse: { '5h': [1] } }), 95)
  })

  it('leaves room for 1.5 times the largest recent turn, between prepareAt and 99', () => {
    assert.equal(handOverLevel('5h', plan, { turnUse: { '5h': [1, 4, 2] } }), 94)
    assert.equal(handOverLevel('7d', plan, { turnUse: { '7d': [0.3] } }), 99)
    assert.equal(handOverLevel('5h', plan, { turnUse: { '5h': [30] } }), 80)
  })

  it('records a turn’s growth per window, keeps the last 5, and ignores a reset', () => {
    let st = firstMark({}, [w('5h', 10), w('7d', 50, '2026-10-12T20:00:00Z')])!
    assert.equal(firstMark(st, [w('5h', 11)]), undefined)
    for (const used of [12, 14, 17, 21, 26, 32]) st = recordTurn(st, [w('5h', used)])
    assert.deepEqual(st.turnUse?.['5h'], [2, 3, 4, 5, 6])
    // The window reset: the drop is not a turn, and the next turn is measured from the new reading.
    st = recordTurn(st, [w('5h', 3, '2026-10-09T20:00:00Z')])
    assert.deepEqual(st.turnUse?.['5h'], [2, 3, 4, 5, 6])
    st = recordTurn(st, [w('5h', 5, '2026-10-09T20:00:00Z')])
    assert.deepEqual(st.turnUse?.['5h'], [3, 4, 5, 6, 2])
    // A reset time that drifts by seconds (Codex) is still the same window.
    st = recordTurn(st, [w('5h', 9, '2026-10-09T20:00:40Z')])
    assert.deepEqual(st.turnUse?.['5h'], [4, 5, 6, 2, 4])
  })

  it('picks the window furthest past its level', () => {
    const st = { turnUse: { '5h': [2], '7d': [1] } }
    assert.equal(crossedWindow([w('5h', 96), w('7d', 97)], plan, st), undefined)
    assert.equal(crossedWindow([w('5h', 97), w('7d', 99)], plan, st)?.label, '7d')
    assert.equal(crossedWindow([w('5h', 99), w('7d', 98)], plan, st)?.label, '5h')
  })
})
