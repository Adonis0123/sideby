import assert from 'node:assert/strict'
import { copyFile, mkdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import {
  fileDeltas,
  fileTokens,
  MAX_QUOTA_FILES,
  readCodexQuota,
  readCodexUsage,
  windowLabel,
} from './rollout.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const RESETS = 1791583213

interface Win {
  used_percent: unknown
  window_minutes: unknown
  resets_at: unknown
}

const win = (used: number, minutes: number, resets = RESETS): Win => ({
  used_percent: used,
  window_minutes: minutes,
  resets_at: resets,
})

function event(
  timestamp: string,
  opts: { primary?: Win | null; secondary?: Win | null; usage?: Record<string, number>; plan?: string },
) {
  const payload: Record<string, unknown> = { type: 'token_count', info: null }
  if (opts.usage) payload.info = { total_token_usage: opts.usage, model_context_window: 1000 }
  if (opts.primary !== undefined)
    payload.rate_limits = {
      limit_id: 'codex',
      primary: opts.primary,
      secondary: opts.secondary ?? null,
      plan_type: opts.plan ?? 'pro',
    }
  return JSON.stringify({ timestamp, ordinal: 1, type: 'event_msg', payload })
}

/** Writes a rollout file in `<dir>/sessions` with the given mtime offset (ms before NOW). */
async function rollout(h: FakeHome, account: string, name: string, lines: string[], ageMs = 0) {
  const p = await h.write(
    join(account, 'sessions', '2026', '10', '05', `rollout-${name}.jsonl`),
    lines.join('\n'),
  )
  const t = new Date(NOW.getTime() - ageMs)
  await utimes(p, t, t)
  return p
}

describe('windowLabel', () => {
  it('names the known windows and keeps others in minutes', () => {
    assert.equal(windowLabel(300), '5h')
    assert.equal(windowLabel(10080), '7d')
    assert.equal(windowLabel(60), '60m')
  })
})

describe('readCodexQuota', () => {
  it('reports no-session without rollout files', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.codex-work')
      const r = await readCodexQuota(h.path('.codex-work'))
      assert.equal(r.status, 'unavailable')
      assert.equal(r.status === 'unavailable' && r.reason, 'no-session')
    })
  })

  it('picks the newest event by timestamp across files, skipping bad and truncated lines', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.codex-work')
      // Newest mtime holds the older event; the newest event sits in an older file between bad lines.
      await rollout(h, '.codex-work', 'a', [event('2026-10-05T09:00:00Z', { primary: win(10, 300) })], 0)
      await rollout(
        h,
        '.codex-work',
        'b',
        [
          '{oops token_count',
          event('2026-10-05T11:00:00Z', {
            primary: win(42, 300, RESETS),
            secondary: win(7, 10080, RESETS + 3600),
            plan: 'plus',
          }),
          event('2026-10-05T08:00:00Z', { primary: win(1, 300) }),
          '{"timestamp":"2026-10-05T11:59:00Z","type":"event_msg","payload":{"type":"token_count","rate_li',
        ],
        DAY,
      )
      const r = await readCodexQuota(dir)
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.observedAt, '2026-10-05T11:00:00.000Z')
      assert.equal(r.source, join('sessions', '2026', '10', '05', 'rollout-b.jsonl'))
      assert.equal(r.plan, 'plus')
      assert.deepEqual(r.windows, [
        { label: '5h', windowMinutes: 300, usedPercent: 42, resetsAt: new Date(RESETS * 1000).toISOString() },
        {
          label: '7d',
          windowMinutes: 10080,
          usedPercent: 7,
          resetsAt: new Date((RESETS + 3600) * 1000).toISOString(),
        },
      ])
    })
  })

  it('accepts a null secondary and unknown window lengths', async () => {
    await withFakeHome(async (h) => {
      await rollout(h, '.codex-work', 'a', [event('2026-10-05T09:00:00Z', { primary: win(5, 60) })])
      const r = await readCodexQuota(h.path('.codex-work'))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.deepEqual(
        r.windows.map((w) => [w.label, w.usedPercent]),
        [['60m', 5]],
      )
    })
  })

  it('reads the real-shaped fixture', async () => {
    await withFakeHome(async (h) => {
      const dst = h.path('.codex-work', 'sessions', '2026', '10', '01', 'rollout-fixture.jsonl')
      await mkdir(dirname(dst), { recursive: true })
      await copyFile(join(import.meta.dirname, 'fixtures', 'rollout-sample.jsonl'), dst)
      const r = await readCodexQuota(h.path('.codex-work'))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.observedAt, '2026-10-01T08:01:00.000Z')
      assert.equal(r.plan, 'pro')
      assert.deepEqual(
        r.windows.map((w) => [w.label, w.usedPercent]),
        [['7d', 5]],
      )
    })
  })

  it('rejects malformed rate_limits and reports unrecognized', async () => {
    await withFakeHome(async (h) => {
      await rollout(h, '.codex-work', 'a', [
        event('2026-10-05T09:00:00Z', { primary: { ...win(5, 300), used_percent: '5' } }),
        event('2026-10-05T09:01:00Z', { primary: win(5, 0) }),
        event('2026-10-05T09:02:00Z', { primary: win(5, 300, RESETS * 1000) }),
        event('2026-10-05T09:03:00Z', {
          primary: win(5, 300),
          secondary: { ...win(1, 10080), resets_at: null },
        }),
        event('2026-10-05T09:04:00Z', { usage: { input_tokens: 1, output_tokens: 1 } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {} } }),
      ])
      const r = await readCodexQuota(h.path('.codex-work'))
      assert.equal(r.status === 'unavailable' && r.reason, 'unrecognized')
    })
  })

  it(`reads at most ${MAX_QUOTA_FILES} files, newest mtime first`, async () => {
    await withFakeHome(async (h) => {
      for (let i = 0; i < MAX_QUOTA_FILES; i++)
        await rollout(
          h,
          '.codex-work',
          `n${String(i).padStart(2, '0')}`,
          [event('2026-10-05T09:00:00Z', { primary: win(i, 300) })],
          i * 1000,
        )
      // The 21st file by mtime has the newest event but must not be read.
      await rollout(
        h,
        '.codex-work',
        'old',
        [event('2026-10-05T11:30:00Z', { primary: win(99, 300) })],
        MAX_QUOTA_FILES * 1000,
      )
      const r = await readCodexQuota(h.path('.codex-work'))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.notEqual(r.windows[0]!.usedPercent, 99)
      assert.equal(r.observedAt, '2026-10-05T09:00:00.000Z')
    })
  })
})

describe('readCodexUsage', () => {
  const usage = (input: number, cached: number, output: number, cacheWrite = 0) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 1,
    total_tokens: input + output,
  })

  it('reports no-session without recent files', async () => {
    await withFakeHome(async (h) => {
      await rollout(
        h,
        '.codex-work',
        'old',
        [event('2026-09-01T00:00:00Z', { usage: usage(10, 0, 10) })],
        8 * DAY,
      )
      const r = await readCodexUsage(h.path('.codex-work'), NOW)
      assert.equal(r.status === 'unavailable' && r.reason, 'no-session')
    })
  })

  it('sums the last cumulative total of each file inside the window', async () => {
    await withFakeHome(async (h) => {
      await rollout(
        h,
        '.codex-work',
        'a',
        [
          event('2026-10-05T09:00:00Z', { usage: usage(100, 40, 10) }),
          event('2026-10-05T09:05:00Z', { usage: usage(300, 100, 30, 5) }),
          event('2026-10-05T09:06:00Z', { primary: win(1, 300) }),
          '{"timestamp":"2026-10-05T09:07:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total',
        ],
        DAY,
      )
      await rollout(
        h,
        '.codex-work',
        'b',
        [event('2026-10-04T09:00:00Z', { usage: usage(50, 0, 20) })],
        6 * DAY,
      )
      await rollout(
        h,
        '.codex-work',
        'c',
        [event('2026-09-20T09:00:00Z', { usage: usage(9999, 0, 9999) })],
        8 * DAY,
      )
      await rollout(h, '.codex-work', 'd', ['{"type":"session_meta","payload":{}}'], 0)
      const r = await readCodexUsage(h.path('.codex-work'), NOW)
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      const { daily, lastActivityAt, ...totals } = r
      assert.deepEqual(totals, {
        status: 'ok',
        days: 7,
        sessions: 2,
        inputTokens: 200 + 50,
        cacheReadTokens: 100,
        outputTokens: 30 + 20,
        cacheWriteTokens: 5,
        totalTokens: 250 + 100 + 50 + 5,
      })
      // The rate-limits-only event is the newest one seen; the truncated line is not.
      assert.equal(lastActivityAt, '2026-10-05T09:06:00.000Z')
      assert.equal(
        daily?.reduce((a, d) => a + d.totalTokens, 0),
        r.totalTokens,
      )
    })
  })

  it('counts only the turns inside the window of a long session resumed today', async () => {
    await withFakeHome(async (h) => {
      await rollout(
        h,
        '.codex-work',
        'long',
        [
          // Ten days before NOW: outside the window, although the file was modified today.
          event('2026-09-25T09:00:00Z', { usage: usage(1000, 400, 100) }),
          event('2026-10-05T09:00:00Z', { usage: usage(1300, 500, 150) }),
          // The cumulative value drops back: a new segment adds its whole total.
          event('2026-10-05T10:00:00Z', { usage: usage(20, 0, 5) }),
        ],
        0,
      )
      // Modified today, but every turn is older than the window: not a session.
      await rollout(
        h,
        '.codex-work',
        'stale',
        [event('2026-09-20T09:00:00Z', { usage: usage(50, 0, 50) })],
        0,
      )
      const r = await readCodexUsage(h.path('.codex-work'), NOW)
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      const { daily, lastActivityAt, ...totals } = r
      assert.deepEqual(totals, {
        status: 'ok',
        days: 7,
        sessions: 1,
        inputTokens: 320 - 100,
        cacheReadTokens: 100,
        outputTokens: 55,
        cacheWriteTokens: 0,
        totalTokens: 375,
      })
      assert.equal(
        daily?.reduce((a, d) => a + d.totalTokens, 0),
        375,
      )
      assert.equal(lastActivityAt, '2026-10-05T10:00:00.000Z')

      await rollout(h, '.codex-old', 'stale', [event('2026-09-20T09:00:00Z', { usage: usage(50, 0, 50) })], 0)
      const none = await readCodexUsage(h.path('.codex-old'), NOW)
      assert.equal(none.status === 'unavailable' && none.reason, 'no-session')
    })
  })

  it('spreads each file over the local days of its events, keeping segments and the baseline', async () => {
    await withFakeHome(async (h) => {
      // Local times, so the test holds in any time zone.
      const now = new Date(2026, 9, 5, 15, 0, 0)
      const at = (month: number, d: number, hh: number, mm = 0, ss = 0, ms = 0) =>
        new Date(2026, month - 1, d, hh, mm, ss, ms).toISOString()
      const tokens = (input: number) => ({ input_tokens: input, output_tokens: 0 })
      const line = (time: string, total: number, turn?: number) =>
        JSON.stringify({
          timestamp: time,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: tokens(total),
              ...(turn === undefined ? {} : { last_token_usage: tokens(turn) }),
            },
          },
        })
      const write = async (name: string, lines: string[]) => {
        const p = await h.write(join('.codex-work', 'sessions', `rollout-${name}.jsonl`), lines.join('\n'))
        await utimes(p, now, now)
      }
      await write('a', [
        line(at(10, 4, 23, 59, 59, 999), 100, 100),
        // Exactly midnight: the new day.
        line(at(10, 5, 0, 0, 0, 0), 150, 50),
        // The cumulative value drops back: a new segment adds its whole total.
        line(at(10, 5, 1, 0), 30, 30),
        event(at(10, 5, 16, 0), { primary: win(1, 300) }),
      ])
      // A subagent file that starts from its parent's running total of 980.
      await write('b', [line(at(10, 2, 12, 0), 1000, 20), line(at(10, 2, 12, 5), 1050, 50)])
      const r = await readCodexUsage(h.path('.codex-work'), now)
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.totalTokens, 180 + 70)
      assert.deepEqual(r.daily, [
        { date: '2026-09-29', totalTokens: 0 },
        { date: '2026-09-30', totalTokens: 0 },
        { date: '2026-10-01', totalTokens: 0 },
        { date: '2026-10-02', totalTokens: 70 },
        { date: '2026-10-03', totalTokens: 0 },
        { date: '2026-10-04', totalTokens: 100 },
        { date: '2026-10-05', totalTokens: 80 },
      ])
      // The event after `now` is ignored.
      assert.equal(r.lastActivityAt, at(10, 5, 1, 0))
    })
  })
})

describe('fileDeltas', () => {
  const t = (input: number, output: number) => ({ input, cached: 0, output, cacheWrite: 0 })
  it('gives each event its increment and sums to fileTokens for segments and an inherited baseline', () => {
    const events = [
      { total: t(1000, 100), turn: t(20, 2) },
      { total: t(1050, 105), turn: t(50, 5) },
      { total: t(5, 1), turn: t(5, 1) },
    ]
    assert.deepEqual(fileDeltas(events), [t(20, 2), t(50, 5), t(5, 1)])
    assert.deepEqual(fileTokens(events), t(75, 8))
    assert.deepEqual(fileDeltas([]), [])
  })
})

describe('fileTokens', () => {
  const t = (input: number, output: number) => ({ input, cached: 0, output, cacheWrite: 0 })
  it('counts an ordinary session by its last cumulative value', () => {
    assert.deepEqual(
      fileTokens([
        { total: t(10, 1), turn: t(10, 1) },
        { total: t(30, 3), turn: t(20, 2) },
      ]),
      t(30, 3),
    )
  })
  it('adds every segment when the cumulative value drops back mid-file', () => {
    const events = [
      { total: t(10, 1), turn: t(10, 1) },
      { total: t(100, 10), turn: t(90, 9) },
      { total: t(5, 1), turn: t(5, 1) },
      { total: t(20, 2), turn: t(15, 1) },
    ]
    assert.deepEqual(fileTokens(events), t(120, 12))
  })
  it("subtracts a subagent's inherited parent total", () => {
    const events = [
      { total: t(1000, 100), turn: t(20, 2) },
      { total: t(1050, 105), turn: t(50, 5) },
    ]
    assert.deepEqual(fileTokens(events), t(70, 7))
  })
  it('returns null for a file without token counts', () => {
    assert.equal(fileTokens([]), null)
  })
  it('starts a new segment when any one field drops, even while the total size grows', () => {
    // input falls 100 -> 50 while output rises 100 -> 150: the size stays 200, but a cumulative counter
    // only falls when a new segment starts, so the second event counts its whole total.
    const events = [
      { total: t(100, 100), turn: t(100, 100) },
      { total: t(50, 150), turn: t(50, 150) },
    ]
    assert.deepEqual(fileDeltas(events), [t(100, 100), t(50, 150)])
    assert.deepEqual(fileTokens(events), t(150, 250))
  })
  it('starts a new segment when only the cached count drops, keeping the cache hit rate honest', () => {
    const c = (input: number, cached: number) => ({ input, cached, output: 10, cacheWrite: 0 })
    const events = [
      { total: c(100, 80), turn: c(100, 80) },
      { total: c(120, 20), turn: c(120, 20) },
    ]
    const deltas = fileDeltas(events)
    assert.deepEqual(deltas, [c(100, 80), { input: 120, cached: 20, output: 10, cacheWrite: 0 }])
    assert.deepEqual(fileTokens(events), { input: 220, cached: 100, output: 20, cacheWrite: 0 })
  })
  it('keeps every increment non-negative, so fileTokens is exactly the sum of fileDeltas', () => {
    const c = (input: number, cached: number, output: number, cacheWrite: number) => ({
      input,
      cached,
      output,
      cacheWrite,
    })
    const events = [
      { total: c(500, 100, 50, 5), turn: c(20, 10, 2, 1) },
      { total: c(600, 90, 60, 6), turn: null },
      { total: c(700, 150, 55, 9), turn: null },
      { total: c(10, 5, 1, 0), turn: c(10, 5, 1, 0) },
      { total: c(30, 5, 3, 2), turn: null },
    ]
    const deltas = fileDeltas(events)
    for (const d of deltas) for (const v of Object.values(d)) assert.ok(v >= 0, JSON.stringify(deltas))
    const sum = deltas.reduce(
      (a, d) => c(a.input + d.input, a.cached + d.cached, a.output + d.output, a.cacheWrite + d.cacheWrite),
      c(0, 0, 0, 0),
    )
    assert.deepEqual(fileTokens(events), sum)
  })
})
