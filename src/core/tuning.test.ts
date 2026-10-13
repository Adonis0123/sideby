import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Compaction, ModelRecords, Turn } from './tuning.ts'
import { MIN_CALLS, summarizeModel, tuningResult } from './tuning.ts'

const WINDOW = 200_000

/** One session whose context grows by 900 a turn from 10K: cache reads dominate, so a lower threshold is cheaper. */
function steady(turns: number): Turn[] {
  return Array.from({ length: turns }, (_, i) => ({
    ts: 1_000 + i,
    ctx: 10_000 + i * 900,
    out: 200,
    write5m: 1_000,
    write1h: 0,
  }))
}

const auto = (pre: number, post = 20_000): Compaction => ({ ts: 5, trigger: 'auto', pre, post })

function records(over: Partial<ModelRecords> = {}): ModelRecords {
  return {
    model: 'claude-opus-5-5',
    sessions: [steady(300).map((t) => ({ ...t, ctx: 10_000 + (t.ctx % 170_000) }))],
    compactions: [auto(190_000)],
    contextWindow: WINDOW,
    ...over,
  }
}

const opts = { configured: null, known: true, mayRecommend: true }

describe('summarizeModel', () => {
  it('suggests an interior threshold when steady growth makes long contexts the expensive part', () => {
    const m = summarizeModel(records({ sessions: [steady(210)] }), { ...opts, configured: 190_000 })
    assert.equal(m.reason, 'suggested')
    assert.equal(m.suggestion?.threshold, 80_000)
    assert.ok((m.suggestion?.savedPercent ?? 0) > 1)
    assert.equal(m.effective, 190_000)
  })

  it('suggests no value when the cheapest point is the lowest candidate, which only cuts the search off', () => {
    const tiny = records({ sessions: [steady(210)], compactions: [auto(190_000, 100)] })
    const m = summarizeModel(tiny, { ...opts, configured: 190_000 })
    assert.equal(m.reason, 'no-optimum')
    assert.equal(m.suggestion, null)
  })

  it('suggests a higher threshold when a lot is kept after each compaction, so compacting is costly', () => {
    const keep = [auto(190_000, 100_000)]
    const m = summarizeModel(records({ sessions: [steady(210)], compactions: keep }), {
      ...opts,
      configured: 190_000,
    })
    assert.equal(m.reason, 'suggested')
    assert.equal(m.suggestion?.threshold, 160_000)
  })

  it('says already-best, with no suggestion, when the current threshold is the cheapest', () => {
    const keep = [auto(190_000, 100_000)]
    const m = summarizeModel(records({ sessions: [steady(210)], compactions: keep }), {
      ...opts,
      configured: 150_000,
    })
    assert.equal(m.reason, 'already-best')
    assert.equal(m.suggestion, null)
  })

  it('caps a configured threshold at the model window', () => {
    const m = summarizeModel(records({ sessions: [steady(210)] }), { ...opts, configured: 500_000 })
    assert.equal(m.effective, WINDOW)
  })

  it('suggests without a saving when nothing is configured and no auto compaction was seen', () => {
    const manual: Compaction = { ts: 5, trigger: 'manual', pre: 150_000, post: 100_000 }
    const m = summarizeModel(records({ sessions: [steady(210)], compactions: [manual] }), opts)
    assert.equal(m.reason, 'suggested')
    assert.equal(m.suggestion?.savedPercent, null)
    assert.equal(m.suggestion?.savedWeighted, null)
    assert.equal(m.effective, null)
  })

  it('uses the median auto compaction size as the baseline when nothing is configured', () => {
    const m = summarizeModel(
      records({ sessions: [steady(210)], compactions: [auto(180_000), auto(190_000), auto(170_000)] }),
      opts,
    )
    assert.equal(m.effective, 180_000)
    assert.equal(m.compactions.auto, 3)
    assert.equal(m.compactions.preTokensMax, 190_000)
  })

  it('gives a reason instead of a suggestion for too few calls, an unknown model and a missing compaction record', () => {
    const few = summarizeModel(records({ sessions: [steady(MIN_CALLS - 1)] }), opts)
    assert.deepEqual([few.reason, few.suggestion], ['insufficient-calls', null])
    const unknown = summarizeModel(records({ sessions: [steady(250)] }), { ...opts, known: false })
    assert.equal(unknown.reason, 'unknown-model')
    const none = summarizeModel(records({ sessions: [steady(250)], compactions: [] }), opts)
    assert.equal(none.reason, 'no-compactions')
  })

  it('only observes when the Family may not recommend', () => {
    const m = summarizeModel(records({ sessions: [steady(250)] }), { ...opts, mayRecommend: false })
    assert.equal(m.reason, 'observe-only')
    assert.equal(m.suggestion, null)
    assert.equal(m.compactions.auto, 1)
  })

  it('tolerates empty sessions', () => {
    const m = summarizeModel(records({ sessions: [[]] }), opts)
    assert.equal(m.calls, 0)
    assert.equal(m.reason, 'insufficient-calls')
  })
})

describe('tuningResult', () => {
  it('summarizes every model, busiest first, and marks the result as an estimate', () => {
    const quiet = records({ model: 'claude-haiku', sessions: [steady(5)] })
    const busy = records({
      model: 'claude-opus-5-5',
      sessions: [steady(210)],
      compactions: [auto(190_000, 100_000)],
    })
    const r = tuningResult(7, [quiet, busy], {
      configured: 190_000,
      known: (m) => m.startsWith('claude-'),
      mayRecommend: true,
    })
    assert.equal(r.status, 'ok')
    if (r.status !== 'ok') return
    assert.equal(r.estimate, true)
    assert.equal(r.days, 7)
    assert.deepEqual(
      r.models.map((m) => m.model),
      ['claude-opus-5-5', 'claude-haiku'],
    )
    assert.equal(r.models[0]?.reason, 'suggested')
  })

  it('gives a model that is not known no suggestion', () => {
    const r = tuningResult(7, [records({ model: 'other-model', sessions: [steady(210)] })], {
      configured: null,
      known: (m) => m.startsWith('claude-'),
      mayRecommend: true,
    })
    assert.equal(r.status === 'ok' && r.models[0]?.reason, 'unknown-model')
  })
})
