import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { QuotaWindow } from '../types.ts'
import { shownQuota } from './quota-fetch.ts'
import type { QuotaStoreEntry } from './quota-store.ts'

const win = (label: string, usedPercent: number, name?: string): QuotaWindow => ({
  label,
  ...(name ? { name } : {}),
  windowMinutes: label === '5h' ? 300 : 10080,
  usedPercent,
  resetsAt: '2026-11-05T09:00:00.000Z',
})
const kept = (observedAt: string, windows: QuotaWindow[]): QuotaStoreEntry => ({
  version: 1,
  attemptedAt: observedAt,
  quota: { status: 'ok', windows, observedAt, source: 'claude /usage' },
})
const local = (observedAt: string, windows: QuotaWindow[]) =>
  ({ status: 'ok', windows, observedAt, source: 'claude statusline' }) as const

test('a newer local reading keeps the fetched model-group windows it cannot see', () => {
  const q = shownQuota(
    local('2026-10-31T13:20:00Z', [win('5h', 5), win('7d', 23)]),
    kept('2026-10-31T13:00:00Z', [win('5h', 1), win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(q.status, 'ok')
  if (q.status !== 'ok') return
  assert.equal(q.source, 'claude statusline')
  assert.deepEqual(
    q.windows.map((w) => [w.name ?? '', w.label, w.usedPercent]),
    [
      ['', '5h', 5],
      ['', '7d', 23],
      ['Fable', '7d', 0],
    ],
  )
})

test('a local reading that reports a group itself keeps its own numbers for it', () => {
  const q = shownQuota(
    local('2026-10-31T13:20:00Z', [win('7d', 30), win('7d', 4, 'Fable')]),
    kept('2026-10-31T13:00:00Z', [win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(
    q.status === 'ok' &&
      q.windows
        .filter((w) => w.name === 'Fable')
        .map((w) => w.usedPercent)
        .join(),
    '4',
  )
})

test('an older local reading still loses to the fetched answer whole', () => {
  const q = shownQuota(
    local('2026-10-31T12:00:00Z', [win('5h', 5), win('7d', 23)]),
    kept('2026-10-31T13:00:00Z', [win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(q.status === 'ok' && q.source, 'claude /usage')
  assert.equal(q.status === 'ok' && q.windows.length, 2)
})
