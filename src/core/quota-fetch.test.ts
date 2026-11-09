import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import type { Account, QuotaFetch, QuotaResult, QuotaWindow } from '../types.ts'
import { fetchedQuota, loginProblemOf, shownQuota } from './quota-fetch.ts'
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

// Expired Login (ADR-0071): the newest sign that the login expired against the newest sign that it works.
test('an expiry with nothing working since is an Expired Login, with sideby’s own sentence', () => {
  const p = loginProblemOf(
    'claude:work',
    { expiredAt: '2026-11-08T10:00:00.000Z', workingAt: '2026-11-08T09:00:00.000Z' },
    null,
  )
  assert.equal(p?.kind, 'expired')
  assert.equal(p?.since, '2026-11-08T10:00:00.000Z')
  assert.match(p?.message ?? '', /sideby login claude:work/)
  assert.equal(p?.signedInAt, undefined)
})

test('a later turn or a later good quota answer clears it; a generic failure does not', () => {
  const expiredAt = '2026-11-08T10:00:00.000Z'
  assert.equal(
    loginProblemOf('claude:work', { expiredAt, workingAt: '2026-11-08T11:00:00.000Z' }, null),
    undefined,
  )
  assert.equal(
    loginProblemOf('claude:work', { expiredAt }, kept('2026-11-08T11:00:00.000Z', [win('5h', 3)])),
    undefined,
  )
  const failedLater: QuotaStoreEntry = {
    ...kept('2026-11-08T09:00:00.000Z', [win('5h', 3)]),
    attemptedAt: '2026-11-08T11:00:00.000Z',
    error: 'Claude Code exited without answering; sideby asks again later',
  }
  assert.equal(loginProblemOf('claude:work', { expiredAt }, failedLater)?.kind, 'expired')
})

test('a quota answer that asked for a new sign-in counts, until something works after it', () => {
  const asked: QuotaStoreEntry = {
    ...kept('2026-11-08T08:00:00.000Z', [win('5h', 3)]),
    attemptedAt: '2026-11-08T10:00:00.000Z',
    loginExpiredAt: '2026-11-08T10:00:00.000Z',
  }
  assert.equal(
    loginProblemOf('claude:work', { workingAt: '2026-11-08T09:00:00.000Z' }, asked)?.kind,
    'expired',
  )
  assert.equal(loginProblemOf('claude:work', { workingAt: '2026-11-08T10:30:00.000Z' }, asked), undefined)
})

test('a sign-in sideby started after the expiry is shown as waiting for confirmation', () => {
  const events = { expiredAt: '2026-11-08T10:00:00.000Z' }
  assert.equal(
    loginProblemOf('claude:work', events, null, '2026-11-08T10:05:00.000Z')?.signedInAt,
    '2026-11-08T10:05:00.000Z',
  )
  assert.equal(loginProblemOf('claude:work', events, null, '2026-11-08T09:00:00.000Z')?.signedInAt, undefined)
})

test('a fetch that asks for a new sign-in keeps the time; a good one clears it; a generic failure keeps it', async () => {
  await withFakeHome(async (h) => {
    const account: Account = {
      family: 'claude',
      name: 'work',
      ref: 'claude:work',
      dir: h.path('.claude-work'),
      isMain: false,
      kind: 'subscription',
    }
    const ctx = {
      home: h.home,
      now: new Date('2026-11-08T10:00:00Z'),
      stateDir: h.path('.local/state/sideby'),
      env: h.env,
    }
    const answers: QuotaResult[] = [
      { status: 'unavailable', reason: 'fetch-failed', detail: 'asks for a new sign-in', loginExpired: true },
      { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' },
      {
        status: 'ok',
        windows: [win('5h', 3)],
        observedAt: '2026-11-08T10:10:00.000Z',
        source: 'claude /usage',
      },
    ]
    const fq: QuotaFetch = { everyMinutes: 15, summary: 'test', fetch: async () => answers.shift()! }
    const first = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.ok(first?.loginExpiredAt)
    const second = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.equal(second?.loginExpiredAt, first?.loginExpiredAt)
    const third = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.equal(third?.loginExpiredAt, undefined)
  })
})
