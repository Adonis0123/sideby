// Grouping of Session History (spec §3.33): day groups by local midnight, group order and folded groups.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DAY_GROUPS, dayGroup, type GroupItem, orderGroups } from './history-group.ts'

const item = (id: number, project: string, score: number): GroupItem =>
  ({ id, project, account: 'claude:main', family: 'claude', updatedAt: score, score }) as GroupItem

describe('dayGroup', () => {
  it('puts a time in today, yesterday, the last 7 or 30 days, or older, by local midnight', () => {
    const now = new Date(2026, 9, 20, 9, 0)
    const at = (d: number, h = 12) => new Date(2026, 9, 20 - d, h).getTime()
    assert.equal(dayGroup(new Date(2026, 9, 20, 0, 1).getTime(), now), 'today')
    assert.equal(dayGroup(at(1, 23), now), 'yesterday')
    assert.equal(dayGroup(at(1, 0), now), 'yesterday')
    assert.equal(dayGroup(at(2), now), 'week')
    assert.equal(dayGroup(at(7, 0), now), 'week')
    assert.equal(dayGroup(at(8), now), 'month')
    assert.equal(dayGroup(at(31), now), 'older')
  })
})

describe('orderGroups', () => {
  const items = [item(1, '/a', 10), item(2, '/b', 30), item(3, '/a', 20), item(4, '', 40)]
  const keyOf = (o: { project: string }) => o.project

  it('orders groups by their best item, the group without a key last, and items by score inside', () => {
    const r = orderGroups(items, keyOf)
    assert.deepEqual(
      r.groups.map((g) => [g.key, g.sessions]),
      [
        ['/b', 1],
        ['/a', 2],
        ['', 1],
      ],
    )
    assert.deepEqual(
      r.items.map((x) => x.id),
      [2, 3, 1, 4],
    )
  })

  it('counts a folded group but leaves its items out', () => {
    const r = orderGroups(items, keyOf, new Set(['/a']))
    assert.equal(r.groups.find((g) => g.key === '/a')?.sessions, 2)
    assert.deepEqual(
      r.items.map((x) => x.id),
      [2, 4],
    )
  })

  it('keeps a fixed order, as days have, whatever the scores', () => {
    const days = [item(1, 'older', 99), item(2, 'today', 1), item(3, 'week', 50)]
    const r = orderGroups(days, keyOf, new Set(), DAY_GROUPS)
    assert.deepEqual(
      r.groups.map((g) => g.key),
      ['today', 'week', 'older'],
    )
  })
})
