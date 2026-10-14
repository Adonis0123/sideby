// Turning Auto Handoff on in one step and the overview the Auto Handoff page shows (spec §3.17 "页面与一键开启").
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { createRuntime } from '../runtime.ts'
import { applyHandoffEnable, planHandoffEnable } from './handoff-enable.ts'
import { readRecentHandoffs } from './handoff-overview.ts'

const builtins = [claudePlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

async function setup(h: FakeHome, opts: { sideby?: boolean } = {}) {
  await h.write('.claude/settings.json', '{\n  "model": "opus"\n}\n')
  await h.write('.claude-001/projects/.keep', '')
  if (opts.sideby !== false) {
    // The hook command needs a sideby with the hook entry on PATH; this one only answers the check.
    await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
    await chmod(join(h.bin, 'sideby'), 0o755)
  }
  return createRuntime({ env: h.env, builtins })
}

describe('planHandoffEnable / applyHandoffEnable', () => {
  it('lists every change without writing, then writes them all and leaves other keys alone', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h)
      const before = await snapshot(h.home)
      const plan = await planHandoffEnable(rt)
      assert.equal(plan.alreadyOn, false)
      assert.deepEqual(
        plan.steps.map((s) => s.id),
        ['config', 'quota'],
      )
      assert.match(plan.steps[0]!.diff!, /"auto": true/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])

      const r = await applyHandoffEnable(rt)
      assert.ok(r.results.every((x) => x.ok))
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(config.handoff, { auto: true })
      const settings = JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8'))
      assert.equal(settings.model, 'opus')
      assert.match(JSON.stringify(settings.statusLine), /statusline-tap/)

      const again = await planHandoffEnable(await createRuntime({ env: h.env, builtins }))
      assert.equal(again.alreadyOn, true)
      assert.deepEqual(again.steps, [])
    })
  })

  it('turns on same-family hand-over only when asked', async () => {
    await withFakeHome(async (h) => {
      await applyHandoffEnable(await setup(h))
      const rt = await createRuntime({ env: h.env, builtins })
      assert.equal(rt.handoffSettings().sameFamily, false)
      const plan = await planHandoffEnable(rt, { sameFamily: true })
      assert.deepEqual(
        plan.steps.map((s) => s.id),
        ['config'],
      )
      await applyHandoffEnable(rt, { sameFamily: true })
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(config.handoff, { auto: true, sameFamily: true })
    })
  })

  it('writes nothing when the sideby on PATH cannot answer hooks', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { sideby: false })
      const before = await snapshot(h.home)
      const r = await applyHandoffEnable(rt)
      assert.match(r.plan.blocked!, /sideby/)
      assert.deepEqual(r.plan.steps, [])
      assert.deepEqual(r.results, [])
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })
})

describe('readRecentHandoffs', () => {
  it('returns accounts, times and triggers, newest first, and never a Brief or its path', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const chain = async (name: string, hops: object[]) => {
        await mkdir(join(state, 'handoffs', name), { recursive: true })
        await writeFile(join(state, 'handoffs', name, 'chain.json'), JSON.stringify({ hops }))
      }
      await chain('a', [
        {
          ref: 'claude:001',
          startedAt: '2026-10-13T03:00:00Z',
          trigger: 'threshold',
          briefSource: 'agent',
          brief: '/secret/1.md',
        },
        { ref: 'claude:003', startedAt: '2026-10-14T03:50:00Z' },
      ])
      await chain('b', [
        {
          ref: 'claude:002',
          startedAt: '2026-10-12T01:00:00Z',
          trigger: 'limit',
          briefSource: 'sideby',
          brief: '/secret/2.md',
        },
        { ref: 'claude:001', startedAt: '2026-10-12T02:00:00Z' },
      ])
      await chain('c', [{ ref: 'claude:003', startedAt: '2026-10-14T05:00:00Z' }])
      const recent = await readRecentHandoffs(state)
      assert.deepEqual(recent, [
        {
          from: 'claude:001',
          to: 'claude:003',
          at: '2026-10-14T03:50:00Z',
          trigger: 'threshold',
          briefSource: 'agent',
        },
        {
          from: 'claude:002',
          to: 'claude:001',
          at: '2026-10-12T02:00:00Z',
          trigger: 'limit',
          briefSource: 'sideby',
        },
      ])
      assert.ok(!JSON.stringify(recent).includes('secret'))
    })
  })

  it('is empty when there is no state yet', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(await readRecentHandoffs(h.path('.local/state/sideby')), [])
    })
  })
})
