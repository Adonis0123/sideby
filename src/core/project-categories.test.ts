// Project Categories (spec §3.33, ADR-0044): answers kept for a minute, only for the Projects asked about, and a
// Plugin that fails, answers wrong or is slow costs only the categories.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { categoryReader } from './project-categories.ts'

describe('categoryReader', () => {
  it('keeps an answer for a minute, and asks again for a Project it was not asked about', async () => {
    let asked = 0
    let clock = 0
    const read = categoryReader(
      {
        label: 'Workspace',
        categoriesOf: (ps) => {
          asked++
          return Object.fromEntries(ps.map((p) => [p, ` ${p.slice(1).toUpperCase()} `]))
        },
      },
      'ws',
      () => clock,
    )
    const a = await read(['/a', '/b'])
    assert.equal(a.label, 'Workspace')
    assert.equal(a.of.get('/a'), 'A')
    await read(['/b'])
    assert.equal(asked, 1)
    await read(['/c'])
    assert.equal(asked, 2)
    clock += 61_000
    await read(['/c'])
    assert.equal(asked, 3)
  })

  it('keeps only the Projects asked about, with a name, cut to 80 characters', async () => {
    const read = categoryReader(
      {
        categoriesOf: () => ({
          '/a': 'x'.repeat(100),
          '/b': '',
          '/other': 'Z',
          '/c': 7 as unknown as string,
        }),
      },
      'ws',
    )
    const r = await read(['/a', '/b', '/c'])
    assert.equal(r.label, 'Category')
    assert.deepEqual([...r.of.keys()], ['/a'])
    assert.equal(r.of.get('/a')?.length, 80)
  })

  it('turns a throw or a wrong answer into a problem that says what to do', async () => {
    const thrown = await categoryReader(
      { categoriesOf: () => Promise.reject(new Error('boom')) },
      'ws',
    )(['/a'])
    assert.equal(thrown.of.size, 0)
    assert.equal(thrown.problem, 'ws: project categories failed (boom); fix the plugin or remove it')
    const wrong = await categoryReader(
      { categoriesOf: () => [] as unknown as Record<string, string> },
      'ws',
    )(['/a'])
    assert.match(wrong.problem ?? '', /categoriesOf must return an object/)
  })

  it('gives up on a Plugin that takes longer than 3 s', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const pending = categoryReader({ categoriesOf: () => new Promise(() => {}) }, 'ws')(['/a'])
    await Promise.resolve()
    t.mock.timers.tick(3_001)
    const r = await pending
    assert.match(r.problem ?? '', /no answer within 3 s/)
  })
})
