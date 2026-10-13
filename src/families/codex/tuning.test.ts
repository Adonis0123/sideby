import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import type { Account, ReadContext } from '../../types.ts'
import { codexTuningMemo, readCodexTuning, readCompactLimit } from './tuning.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const MARKER = 'not-a-secret-marker-only-for-this-test'

const account = (dir: string): Account => ({
  family: 'codex',
  name: 'main',
  ref: 'codex:main',
  dir,
  isMain: true,
  kind: 'subscription',
})

const ctx = (h: FakeHome): ReadContext => ({
  home: h.home,
  now: NOW,
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})

const at = (i: number) => new Date(NOW.getTime() - 3_600_000 * 5 + i * 1000).toISOString()

const tokenCount = (i: number, input: number) => ({
  timestamp: at(i),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: input }, model_context_window: 258_400 },
  },
})

/** Context grows to 230K, Codex compacts, and it grows again. */
function rollout(): string {
  const rows: object[] = [{ timestamp: at(0), type: 'turn_context', payload: { model: 'gpt-fake-1' } }]
  rows.push(tokenCount(1, 100_000), tokenCount(2, 230_000))
  rows.push({ timestamp: at(3), type: 'compacted', payload: { message: 'summary text', window_number: 2 } })
  rows.push(tokenCount(4, 30_000), tokenCount(5, 60_000))
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
}

async function put(h: FakeHome, config?: string): Promise<Account> {
  const dir = h.path('.codex')
  await mkdir(join(dir, 'sessions', '2026', '10', '05'), { recursive: true })
  await writeFile(join(dir, 'sessions', '2026', '10', '05', 'rollout-a.jsonl'), rollout())
  if (config !== undefined) await writeFile(join(dir, 'config.toml'), config)
  return account(dir)
}

describe('codex tuning', () => {
  it('observes compactions and the context size around them, and never recommends', async () => {
    await withFakeHome(async (h) => {
      const r = await readCodexTuning(await put(h), ctx(h))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      const [m] = r.models
      assert.equal(m?.model, 'gpt-fake-1')
      assert.equal(m?.calls, 4)
      assert.equal(m?.contextWindow, 258_400)
      assert.equal(m?.reason, 'observe-only')
      assert.equal(m?.suggestion, null)
      assert.equal(m?.configured, null)
      assert.deepEqual(m?.compactions, {
        total: 1,
        auto: 0,
        manual: 0,
        idle: 0,
        preTokensP50: 230_000,
        preTokensMax: 230_000,
      })
    })
  })

  it('counts only what is inside the window when a cached parse is reused after time moved on', async () => {
    await withFakeHome(async (h) => {
      const a = await put(h)
      const first = await readCodexTuning(a, ctx(h))
      assert.equal(first.status === 'ok' && first.models[0]?.compactions.total, 1)
      // Eight days later the same unchanged file has nothing left in the window (its events are 5 hours old).
      const later = await readCodexTuning(a, { ...ctx(h), now: new Date(NOW.getTime() + 8 * 86_400_000) })
      assert.equal(later.status, 'unavailable')
    })
  })

  it('reports no-session without rollouts', async () => {
    await withFakeHome(async (h) => {
      const r = await readCodexTuning(account(h.path('.codex')), ctx(h))
      assert.equal(r.status === 'unavailable' && r.reason, 'no-session')
    })
  })

  it('reads model_auto_compact_token_limit only, from the top level of config.toml', async () => {
    await withFakeHome(async (h) => {
      const config = `model = "${MARKER}"\nmodel_auto_compact_token_limit = 200_000 # tuned\n[profiles.x]\nmodel_auto_compact_token_limit = 1\n`
      const a = await put(h, config)
      const r = await readCodexTuning(a, ctx(h))
      assert.equal(r.status === 'ok' && r.models[0]?.configured, 200_000)
      assert.ok(!JSON.stringify(r).includes(MARKER))
      assert.ok(!JSON.stringify(codexTuningMemo.dump()).includes(MARKER))
    })
  })

  it('treats a missing key, a key inside a table, or a broken value as the Host default', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.codex')
      await mkdir(dir, { recursive: true })
      assert.equal(await readCompactLimit(dir), null)
      for (const bad of [
        'model = "x"\n',
        '[profiles.x]\nmodel_auto_compact_token_limit = 100\n',
        'model_auto_compact_token_limit = "lots"\n',
        'model_auto_compact_token_limit = 0\n',
      ]) {
        await writeFile(join(dir, 'config.toml'), bad)
        assert.equal(await readCompactLimit(dir), null, bad)
      }
    })
  })

  it('writes nothing into the Account directory', async () => {
    await withFakeHome(async (h) => {
      const a = await put(h, 'model_auto_compact_token_limit = 200000\n')
      const before = await snapshot(a.dir)
      await readCodexTuning(a, ctx(h))
      assert.deepEqual(diffSnapshots(before, await snapshot(a.dir)), [])
    })
  })
})
