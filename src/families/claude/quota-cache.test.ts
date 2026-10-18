// Round trip: what the status line tap writes is exactly what the Claude Family reads back.
import assert from 'node:assert/strict'
import { readFile, symlink } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import { runStatuslineTap } from '../../quota/statusline-tap.ts'
import { createRuntime } from '../../runtime.ts'
import { claudePlugin } from './index.ts'
import { cacheStateDir, claudeQuotaCacheFile, mergeQuotaCache } from './quota-cache.ts'

const resets = Math.floor(Date.now() / 1000) + 3600
const input = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: resets },
    seven_day: { used_percentage: 9, resets_at: resets },
  },
})

function sink(): Writable & { text: () => string } {
  const chunks: Buffer[] = []
  const w = new Writable({
    write(c, _e, cb) {
      chunks.push(Buffer.from(c))
      cb()
    },
  })
  return Object.assign(w, { text: () => Buffer.concat(chunks).toString() })
}

describe('Claude quota cache round trip', () => {
  it('the tap writes a cache the Family reads back, for main and named accounts', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-work/settings.json', '{}')
      for (const [dir, ref] of [
        [undefined, 'claude:main'],
        [h.path('.claude-work'), 'claude:work'],
      ] as const) {
        const env = { ...h.env, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) }
        const out = sink()
        assert.equal(await runStatuslineTap([], env, Readable.from([input]), out, sink()), 0)
        assert.equal(out.text(), '5h 42% · 7d 9%\n')
        const rt = await createRuntime({
          env: h.env,
          builtins: [{ plugin: claudePlugin, version: '0', description: '', defaultEnabled: true }],
        })
        const q = await rt.quota(await rt.resolve(ref))
        assert.equal(q.status, 'ok', JSON.stringify(q))
        assert.deepEqual(q.status === 'ok' && q.windows.map((w) => [w.label, w.usedPercent]), [
          ['5h', 42],
          ['7d', 9],
        ])
      }
      const file = claudeQuotaCacheFile(cacheStateDir(h.env), 'main')
      assert.equal(file, h.path('.local/state/sideby/quota/claude/main.json'))
    })
  })

  it('never writes through a symlinked cache file, and still passes the original command through', async () => {
    await withFakeHome(async (h) => {
      const file = claudeQuotaCacheFile(cacheStateDir(h.env), 'main')
      await h.write('elsewhere.json', 'untouched')
      await h.mkdir('.local/state/sideby/quota/claude')
      await symlink(h.path('elsewhere.json'), file)
      const out = sink()
      const orig = Buffer.from('printf hi').toString('base64')
      assert.equal(
        await runStatuslineTap(['--orig-b64', orig], h.env, Readable.from([input]), out, sink()),
        0,
      )
      assert.equal(out.text(), 'hi')
      assert.equal(await readFile(h.path('elsewhere.json'), 'utf8'), 'untouched')
    })
  })
})

describe('mergeQuotaCache', () => {
  const at = (iso: string, used: number) => ({
    label: '5h',
    windowMinutes: 300,
    usedPercent: used,
    resetsAt: iso,
  })
  const reading = (
    used: number,
    iso: string,
    sessionId?: string,
    observedAt = '2030-01-01T05:00:00.000Z',
  ) => ({
    version: 1 as const,
    observedAt,
    windows: [at(iso, used)],
    ...(sessionId ? { sessionId } : {}),
  })
  /** Folds readings into a cache the way the status line tap does; null readings leave it unchanged. */
  const fold = (...readings: ReturnType<typeof reading>[]) => {
    let cache: ReturnType<typeof mergeQuotaCache> = null
    let ignored = 0
    for (const r of readings) {
      const merged = mergeQuotaCache(cache, r)
      if (merged) cache = merged
      else ignored++
    }
    return { cache: cache!, ignored }
  }
  const noon = '2030-01-01T12:00:00.000Z'
  const five = '2030-01-01T17:00:00.000Z'

  it('ignores an idle session repeating its old numbers after another session reported newer ones', () => {
    const { cache, ignored } = fold(reading(20, noon, 'a'), reading(50, noon, 'b'), reading(20, noon, 'a'))
    assert.equal(ignored, 1)
    assert.equal(cache.windows[0]!.usedPercent, 50)
  })

  it('takes a changed reading even when the vendor moved the reset earlier', () => {
    const { cache } = fold(reading(50, five, 'a'), reading(10, noon, 'a'))
    assert.deepEqual(cache.windows, [at(noon, 10)])
  })

  it('ignores an idle session repeating the old window after the vendor moved the reset later', () => {
    const { cache, ignored } = fold(reading(90, noon, 'a'), reading(20, five, 'b'), reading(90, noon, 'a'))
    assert.equal(ignored, 1)
    assert.deepEqual(cache.windows, [at(five, 20)])
  })

  it('takes the first reading of a new session, even when it is emptier', () => {
    const { cache, ignored } = fold(reading(90, noon, 'a'), reading(5, noon, 'b'))
    assert.equal(ignored, 0)
    assert.equal(cache.windows[0]!.usedPercent, 5)
  })

  it('keeps only a hash and a time per session, at most 32, none older than 8 days', () => {
    const day = (n: number) => new Date(Date.parse('2030-01-01T00:00:00.000Z') + n * 86_400_000).toISOString()
    const old = fold(reading(1, noon, 'old', day(0)), reading(2, noon, 'fresh', day(5)))
    assert.deepEqual(Object.keys(old.cache.sessions!).sort(), ['fresh', 'old'])
    const later = mergeQuotaCache(old.cache, reading(3, noon, 'new', day(9)))!
    assert.deepEqual(Object.keys(later.sessions!).sort(), ['fresh', 'new'])
    assert.deepEqual(Object.keys(later.sessions!.new!).sort(), ['hash', 'seenAt'])
    const many = Array.from({ length: 40 }, (_, i) =>
      reading(i, noon, `s${i}`, new Date(Date.parse(day(9)) + i * 1000).toISOString()),
    )
    const sessions = fold(...many).cache.sessions!
    assert.equal(Object.keys(sessions).length, 32)
    assert.ok(sessions.s39 && !sessions.s7)
    assert.ok(!JSON.stringify(fold(...many).cache).includes('sessionId'))
  })

  it('without a session id, keeps the higher use within one window and otherwise takes the reading', () => {
    const cached = { windows: [at('2030-01-01T06:00:00.000Z', 96)] }
    assert.equal(mergeQuotaCache(cached, reading(90, '2030-01-01T06:10:00.000Z')), null)
    assert.equal(mergeQuotaCache(cached, reading(5, '2030-01-01T07:30:00.000Z'))?.windows[0]?.usedPercent, 5)
    assert.equal(
      mergeQuotaCache(cached, reading(80, '2030-01-01T04:00:00.000Z'))?.windows[0]?.usedPercent,
      80,
    )
    // A repeat of the same numbers is written, so observedAt moves on.
    assert.deepEqual(
      mergeQuotaCache(cached, reading(96, '2030-01-01T06:00:00.000Z'))?.windows,
      cached.windows,
    )
  })
})
