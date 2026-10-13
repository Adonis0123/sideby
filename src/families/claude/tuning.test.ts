import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import type { Account, ReadContext } from '../../types.ts'
import { claudeTuningMemo, readAutoCompactWindow, readClaudeTuning } from './tuning.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const MARKER = 'not-a-secret-marker-only-for-this-test'

const account = (dir: string): Account => ({
  family: 'claude',
  name: 'work',
  ref: 'claude:work',
  dir,
  isMain: false,
  kind: 'subscription',
})

const ctx = (h: FakeHome): ReadContext => ({
  home: h.home,
  now: NOW,
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})

/** A session log: `turns` assistant rows growing 900 tokens each, one auto compaction in the middle. */
function session(model: string, turns: number, extra: object[] = []): string {
  const rows: object[] = []
  for (let i = 0; i < turns; i++) {
    const at = new Date(NOW.getTime() - 3_600_000 * 24 + i * 1000).toISOString()
    rows.push({
      type: 'assistant',
      timestamp: at,
      sessionId: 'sess-a',
      message: {
        id: `msg_${model}_${i}`,
        model,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 10_000 + i * 900,
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
          output_tokens: 200,
        },
      },
    })
  }
  rows.push(...extra)
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
}

const boundary = (trigger: string, pre = 190_000, post = 20_000) => ({
  type: 'system',
  subtype: 'compact_boundary',
  timestamp: new Date(NOW.getTime() - 3_600_000 * 23).toISOString(),
  sessionId: 'sess-a',
  compactMetadata: { trigger, preTokens: pre, postTokens: post },
})

async function put(h: FakeHome, body: string, settings?: string): Promise<Account> {
  const dir = h.path('.claude-work')
  await mkdir(join(dir, 'projects', 'p'), { recursive: true })
  await writeFile(join(dir, 'projects', 'p', 'sess-a.jsonl'), body)
  if (settings !== undefined) await writeFile(join(dir, 'settings.json'), settings)
  return account(dir)
}

describe('claude tuning', () => {
  it('suggests a threshold for a known model and reports the configured one', async () => {
    await withFakeHome(async (h) => {
      const a = await put(
        h,
        session('claude-opus-5-5', 210, [boundary('auto'), boundary('manual', 120_000)]),
        '{"autoCompactWindow":190000}',
      )
      const r = await readClaudeTuning(a, ctx(h))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.estimate, true)
      assert.equal(r.days, 7)
      const [m] = r.models
      assert.equal(m?.model, 'claude-opus-5-5')
      assert.equal(m?.calls, 210)
      assert.equal(m?.configured, 190_000)
      assert.equal(m?.compactions.total, 2)
      assert.equal(m?.compactions.auto, 1)
      assert.equal(m?.compactions.manual, 1)
      assert.equal(m?.reason, 'suggested')
      assert.ok((m?.suggestion?.threshold ?? 0) > 0)
    })
  })

  it('gives no suggestion for a model that is not a Claude model or with too few calls', async () => {
    await withFakeHome(async (h) => {
      const other = await readClaudeTuning(
        await put(h, session('deepseek-chat', 250, [boundary('auto')])),
        ctx(h),
      )
      assert.equal(other.status === 'ok' && other.models[0]?.reason, 'unknown-model')
      const few = await readClaudeTuning(
        await put(h, session('claude-opus-5-5', 20, [boundary('auto')])),
        ctx(h),
      )
      assert.equal(few.status === 'ok' && few.models[0]?.reason, 'insufficient-calls')
    })
  })

  it('counts a message once however many lines or files repeat it, and ignores sidechain turns', async () => {
    await withFakeHome(async (h) => {
      const body = session('claude-opus-5-5', 5, [
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: NOW.toISOString(),
          message: { id: 'side', model: 'claude-opus-5-5', usage: { input_tokens: 9 } },
        },
      ])
      const a = await put(h, body + body)
      const r = await readClaudeTuning(a, ctx(h))
      assert.equal(r.status === 'ok' && r.models[0]?.calls, 5)
    })
  })

  it('reports no-session without logs and unrecognized for logs that are not JSON', async () => {
    await withFakeHome(async (h) => {
      const empty = await readClaudeTuning(account(h.path('.claude-work')), ctx(h))
      assert.equal(empty.status === 'unavailable' && empty.reason, 'no-session')
      const bad = await readClaudeTuning(await put(h, 'not json\nnot json either\n'), ctx(h))
      assert.equal(bad.status === 'unavailable' && bad.reason, 'unrecognized')
    })
  })

  it('reads only autoCompactWindow from settings.json and keeps every other value out of results and caches', async () => {
    await withFakeHome(async (h) => {
      const settings = JSON.stringify({
        autoCompactWindow: 160_000,
        env: { SOME_SETTING: MARKER },
        model: MARKER,
      })
      const a = await put(h, session('claude-opus-5-5', 210, [boundary('auto')]), settings)
      const r = await readClaudeTuning(a, ctx(h))
      assert.equal(r.status === 'ok' && r.models[0]?.configured, 160_000)
      assert.ok(!JSON.stringify(r).includes(MARKER))
      assert.ok(!JSON.stringify(claudeTuningMemo.dump()).includes(MARKER))
    })
  })

  it('treats a missing, broken, non-numeric or negative setting as the Host default', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.claude-work')
      assert.equal(await readAutoCompactWindow(dir), null)
      for (const bad of [
        '{',
        '[]',
        '{"autoCompactWindow":"500K"}',
        '{"autoCompactWindow":-5}',
        '{"autoCompactWindow":0}',
      ]) {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'settings.json'), bad)
        assert.equal(await readAutoCompactWindow(dir), null, bad)
      }
    })
  })

  it('drops a compaction that has aged out of the window when a cached parse is reused later', async () => {
    await withFakeHome(async (h) => {
      const old = { ...boundary('auto'), timestamp: new Date(NOW.getTime() - 6 * 86_400_000).toISOString() }
      const a = await put(h, session('claude-opus-5-5', 210, [old, boundary('auto', 150_000)]))
      const first = await readClaudeTuning(a, ctx(h))
      assert.equal(first.status === 'ok' && first.models[0]?.compactions.total, 2)
      const later = await readClaudeTuning(a, { ...ctx(h), now: new Date(NOW.getTime() + 3 * 86_400_000) })
      assert.equal(later.status === 'ok' && later.models[0]?.compactions.total, 1)
    })
  })

  it('gives a compaction logged before the first assistant row of its file the model that follows', async () => {
    await withFakeHome(async (h) => {
      const rows = session('claude-opus-5-5', 210).split('\n').filter(Boolean)
      const body = `${[JSON.stringify(boundary('auto')), ...rows].join('\n')}\n`
      const r = await readClaudeTuning(await put(h, body), ctx(h))
      assert.equal(r.status === 'ok' && r.models[0]?.compactions.total, 1)
      assert.equal(r.status === 'ok' && r.models[0]?.reason, 'suggested')
    })
  })

  it('takes the model of a session from another file when its compaction is the only row in its own', async () => {
    await withFakeHome(async (h) => {
      const a = await put(h, session('claude-opus-5-5', 210))
      await writeFile(join(a.dir, 'projects', 'p', 'sess-b.jsonl'), `${JSON.stringify(boundary('auto'))}\n`)
      const r = await readClaudeTuning(a, ctx(h))
      assert.equal(r.status === 'ok' && r.models[0]?.compactions.total, 1)
      assert.equal(r.status === 'ok' && r.models[0]?.reason, 'suggested')
    })
  })

  it('knows the models with a native 1M window compact at about 967K by default, and the others at their window', async () => {
    await withFakeHome(async (h) => {
      const native = await readClaudeTuning(
        await put(h, session('claude-opus-5-5', 210, [boundary('manual', 150_000)])),
        ctx(h),
      )
      const nm = native.status === 'ok' ? native.models[0] : undefined
      assert.deepEqual([nm?.contextWindow, nm?.effective], [1_000_000, 967_000])
      const other = await readClaudeTuning(
        await put(h, session('claude-opus-4-6', 210, [boundary('manual', 150_000)])),
        ctx(h),
      )
      const om = other.status === 'ok' ? other.models[0] : undefined
      assert.deepEqual([om?.contextWindow, om?.effective], [200_000, 200_000])
    })
  })

  it('tells a compaction after about an hour of silence (Claude Code on its own) from one a size triggered', async () => {
    await withFakeHome(async (h) => {
      const lastTurn = NOW.getTime() - 3_600_000 * 24 + 209 * 1000
      const at = (ms: number) => new Date(lastTurn + ms).toISOString()
      const body = session('claude-opus-5-5', 210, [
        { ...boundary('auto', 300_000), timestamp: at(54 * 60_000) },
        { ...boundary('auto', 960_000), timestamp: at(54 * 60_000 + 5_000) },
      ])
      const r = await readClaudeTuning(await put(h, body), ctx(h))
      const c = r.status === 'ok' ? r.models[0]?.compactions : undefined
      assert.equal(c?.auto, 2)
      // Only the first follows the silence; the second comes right after the first compaction.
      assert.equal(c?.idle, 1)
    })
  })

  it('writes nothing into the Account directory', async () => {
    await withFakeHome(async (h) => {
      const a = await put(
        h,
        session('claude-opus-5-5', 210, [boundary('auto')]),
        '{"autoCompactWindow":190000}',
      )
      const before = await snapshot(a.dir)
      await readClaudeTuning(a, ctx(h))
      assert.deepEqual(diffSnapshots(before, await snapshot(a.dir)), [])
    })
  })
})
