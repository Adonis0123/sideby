import assert from 'node:assert/strict'
import { copyFile, mkdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import { fileTokens, MAX_QUOTA_FILES, readCodexQuota, readCodexUsage, windowLabel } from './rollout.ts'

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
      assert.deepEqual(r, {
        status: 'ok',
        days: 7,
        sessions: 2,
        inputTokens: 200 + 50,
        cacheReadTokens: 100,
        outputTokens: 30 + 20,
        cacheWriteTokens: 5,
        totalTokens: 250 + 100 + 50 + 5,
      })
    })
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
})
