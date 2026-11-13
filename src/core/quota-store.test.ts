import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  type FetchedQuota,
  keptLimitResets,
  keptQuota,
  quotaStoreFile,
  readQuotaStore,
  writeQuotaStore,
} from './quota-store.ts'

const answer = (): FetchedQuota => ({
  status: 'ok',
  windows: [
    { label: '5h', windowMinutes: 300, usedPercent: 12, resetsAt: '2026-11-12T15:00:00.000Z' },
    {
      label: '7d',
      name: 'Fable',
      windowMinutes: 10080,
      usedPercent: 40,
      resetsAt: '2026-11-18T00:00:00.000Z',
      observedAt: '2026-11-12T09:00:00.000Z',
      source: 'claude /usage',
    },
  ],
  observedAt: '2026-11-12T10:00:00.000Z',
  source: 'claude statusline',
  plan: 'max',
  limitResets: {
    available: 2,
    observedAt: '2026-11-12T10:00:00.000Z',
    nextExpiresAt: '2026-11-20T00:00:00.000Z',
  },
})

test('the kept store round-trips the Limit Resets, each window’s own time and source, and the reset marks', async () => {
  await withFakeHome(async (h) => {
    const file = quotaStoreFile(h.path('.local/state/sideby'), 'codex', 'main')
    await writeQuotaStore(file, {
      version: 1,
      attemptedAt: '2026-11-12T10:00:01.000Z',
      quota: keptQuota(answer()),
      resetAsked: ['2026-11-12T09:30:00.000Z'],
    })
    const back = await readQuotaStore(file)
    assert.deepEqual(back?.quota, answer())
    assert.deepEqual(back?.resetAsked, ['2026-11-12T09:30:00.000Z'])
    // Every mark is kept, however many reset times the windows have: a forgotten one would be asked for again.
    const marks = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 10, 12, 9, i)).toISOString())
    const many = quotaStoreFile(h.path('.local/state/sideby'), 'codex', 'many')
    await writeQuotaStore(many, {
      version: 1,
      attemptedAt: '2026-11-12T10:00:01.000Z',
      resetAsked: [...marks, marks[0]!],
    })
    assert.deepEqual((await readQuotaStore(many))?.resetAsked, marks)
    // What was read back writes the same bytes again.
    const first = await readFile(file, 'utf8')
    await writeQuotaStore(file, back!)
    assert.equal(await readFile(file, 'utf8'), first)
  })
})

test('a window as old as its Quota carries no time or source of its own', () => {
  const q = answer()
  q.windows[1] = { ...q.windows[1]!, observedAt: q.observedAt, source: q.source }
  const kept = keptQuota(q)
  assert.equal('observedAt' in kept.windows[1]!, false)
  assert.equal('source' in kept.windows[1]!, false)
})

test('only a whole count with a readable time is kept as Limit Resets, and nothing else of it', () => {
  assert.deepEqual(keptLimitResets({ available: 0, observedAt: '2026-11-12T10:00:00.000Z' }), {
    available: 0,
    observedAt: '2026-11-12T10:00:00.000Z',
  })
  // A plugin's extra fields (a credit id, a title) never reach the file; an unreadable expiry is left out.
  assert.deepEqual(
    keptLimitResets({
      available: 1,
      observedAt: '2026-11-12T10:00:00.000Z',
      nextExpiresAt: 'someday',
      credits: [{ id: 'credit-fake-0001' }],
    }),
    { available: 1, observedAt: '2026-11-12T10:00:00.000Z' },
  )
  for (const bad of [
    null,
    undefined,
    'two',
    { available: 1.5, observedAt: '2026-11-12T10:00:00.000Z' },
    { available: -1, observedAt: '2026-11-12T10:00:00.000Z' },
    { available: '1', observedAt: '2026-11-12T10:00:00.000Z' },
    { available: 1 },
    { available: 1, observedAt: 'when' },
  ])
    assert.equal(keptLimitResets(bad), undefined)
  // A reading without the field stays without it: absent never turns into zero.
  const { limitResets: _none, ...plain } = answer()
  assert.equal('limitResets' in keptQuota(plain), false)
})

test('a store file with a broken window, marks that are not times or another version is read safely', async () => {
  await withFakeHome(async (h) => {
    const file = quotaStoreFile(h.path('.local/state/sideby'), 'codex', 'main')
    await h.write(
      '.local/state/sideby/quota/codex/main.fetched.json',
      JSON.stringify({
        version: 1,
        attemptedAt: '2026-11-12T10:00:01.000Z',
        quota: {
          status: 'ok',
          windows: [
            { label: '5h', windowMinutes: 300, usedPercent: 12, resetsAt: '2026-11-12T15:00:00.000Z' },
            { label: '7d', windowMinutes: 10080, usedPercent: 1, resetsAt: 'x', observedAt: 5 },
          ],
          observedAt: '2026-11-12T10:00:00.000Z',
          source: 'test',
          limitResets: { available: 'many' },
        },
        resetAsked: ['nope', 7],
      }),
    )
    const back = await readQuotaStore(file)
    assert.equal(back?.quota?.windows.length, 1)
    assert.equal(back?.quota?.limitResets, undefined)
    assert.equal(back?.resetAsked, undefined)
  })
})
