// The Auto Handoff hint after a session (spec §3.17 "交给 AI 开启"): only when it would have helped, once a day.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { writeQuotaCache } from '../families/claude/quota-cache.ts'
import { createRuntime } from '../runtime.ts'
import { handoffHint } from './handoff-status.ts'

const builtins = [claudePlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

async function setup(h: FakeHome, used: number, handoff: object = {}) {
  await h.write('.claude-001/projects/.keep', '')
  await h.write('.config/sideby/config.json', JSON.stringify({ handoff }))
  await writeQuotaCache(join(h.path('.local/state'), 'sideby'), '001', {
    version: 1,
    observedAt: new Date().toISOString(),
    windows: [
      {
        label: '5h',
        windowMinutes: 300,
        usedPercent: used,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  })
  return createRuntime({ env: h.env, builtins })
}

describe('handoffHint', () => {
  it('points at Auto Handoff once a day when the quota passed the threshold', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, 96)
      assert.match((await handoffHint(rt, 'claude:001'))!, /claude:001 is at 96%.*sideby handoff status/)
      assert.equal(await handoffHint(rt, 'claude:001'), null)
    })
  })

  it('says nothing below the threshold or when Auto Handoff is already on', async () => {
    await withFakeHome(async (h) => {
      assert.equal(await handoffHint(await setup(h, 60), 'claude:001'), null)
      assert.equal(await handoffHint(await setup(h, 99, { auto: true }), 'claude:001'), null)
    })
  })
})

describe('lineDiff', () => {
  it('marks only the lines that changed', async () => {
    const { lineDiff } = await import('./handoff-status.ts')
    assert.equal(
      lineDiff('{\n  "auto": false,\n  "threshold": 95\n}', '{\n  "auto": true,\n  "threshold": 95\n}'),
      '  {\n-   "auto": false,\n+   "auto": true,\n    "threshold": 95\n  }',
    )
    assert.equal(lineDiff('{}', '{\n  "auto": true\n}'), '- {}\n+ {\n+   "auto": true\n+ }')
  })
})
