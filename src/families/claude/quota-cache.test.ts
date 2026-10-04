// Round trip: what the status line tap writes is exactly what the Claude Family reads back.
import assert from 'node:assert/strict'
import { readFile, symlink } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import { runStatuslineTap } from '../../quota/statusline-tap.ts'
import { createRuntime } from '../../runtime.ts'
import { claudePlugin } from './index.ts'
import { cacheStateDir, claudeQuotaCacheFile } from './quota-cache.ts'

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
