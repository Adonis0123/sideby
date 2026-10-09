// The handoff hook (spec §3.17): when it speaks to the model, when it marks a run ready, and that it never fails.
import assert from 'node:assert/strict'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { ensureChainDir, FILES, type PlanFile, readJsonFile, writeJsonFile } from '../core/handoff-chain.ts'
import { writeQuotaCache } from '../families/claude/quota-cache.ts'
import type { Env } from '../types.ts'
import { decide, runHandoffHook } from './hook.ts'

const NOW = new Date('2026-10-09T12:00:00Z')

async function setup(h: FakeHome, plan: Partial<PlanFile> = {}) {
  const dir = h.path('.local/state/sideby/handoffs/c1')
  await ensureChainDir(dir)
  const brief = join(dir, '1-claude-001.md')
  await writeJsonFile(join(dir, FILES.plan), {
    runId: 'r1',
    brief,
    at: NOW.toISOString(),
    decision: 'pick',
    pick: 'claude:002',
    prepareAt: 80,
    threshold: 95,
    ...plan,
  } satisfies PlanFile)
  const env: Env = {
    HOME: h.home,
    XDG_STATE_HOME: h.path('.local/state'),
    CLAUDE_CONFIG_DIR: h.path('.claude-001'),
    SIDEBY_HANDOFF_RUN: 'r1',
    SIDEBY_HANDOFF_FAMILY: 'claude',
    SIDEBY_HANDOFF_DIR: dir,
  }
  return { dir, brief, env }
}

async function pressure(env: Env, used: number) {
  await writeQuotaCache(join(env.XDG_STATE_HOME!, 'sideby'), '001', {
    version: 1,
    observedAt: NOW.toISOString(),
    windows: [{ label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: '2026-10-09T15:00:00Z' }],
  })
}

const call = (env: Env, event: 'PostToolUse' | 'Stop' | 'StopFailure', input = {}, family = 'claude') =>
  decide({ family, event, input, env, now: NOW })

describe('handoff hook', () => {
  it('stays silent outside a handoff run and for another Family’s hook', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h)
      await pressure(env, 99)
      assert.deepEqual(await call({ ...env, SIDEBY_HANDOFF_RUN: undefined }, 'PostToolUse'), {})
      assert.deepEqual(await call(env, 'PostToolUse', {}, 'grok'), {})
    })
  })

  it('asks once for a Brief at the preparing level, once to finish at the threshold', async () => {
    await withFakeHome(async (h) => {
      const { env, brief } = await setup(h)
      await pressure(env, 82)
      const first = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(first.hookSpecificOutput.additionalContext, /handoff brief/)
      assert.ok(first.hookSpecificOutput.additionalContext.includes(brief))
      assert.deepEqual(await call(env, 'PostToolUse'), {})
      await pressure(env, 96)
      const second = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(second.hookSpecificOutput.additionalContext, /end your turn/)
      assert.deepEqual(await call(env, 'PostToolUse'), {})
    })
  })

  it('does not ask to finish when the plan is to wait', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h, { decision: 'wait' })
      await pressure(env, 96)
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /end your turn/)
    })
  })

  it('ignores a plan left by another run', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h, { runId: 'old' })
      await pressure(env, 99)
      assert.deepEqual(await call(env, 'PostToolUse'), {})
    })
  })

  it('on Stop: blocks once when the Brief was not updated, then ready without it', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await pressure(env, 96)
      await call(env, 'PostToolUse')
      const blocked = (await call(env, 'Stop', { session_id: 's1' })).output as { decision: string }
      assert.equal(blocked.decision, 'block')
      assert.equal(await readJsonFile(join(dir, FILES.ready)), null)
      await call(env, 'Stop', { session_id: 's1', stop_hook_active: true })
      const ready = await readJsonFile<{ trigger: string; brief?: string; sessionId: string }>(
        join(dir, FILES.ready),
      )
      assert.equal(ready?.trigger, 'threshold')
      assert.equal(ready?.brief, undefined)
      assert.equal(ready?.sessionId, 's1')
    })
  })

  it('on Stop: ready with the Brief when the agent wrote it after being asked', async () => {
    await withFakeHome(async (h) => {
      const { env, dir, brief } = await setup(h)
      await pressure(env, 96)
      await call(env, 'PostToolUse')
      await writeFile(brief, '# brief\n')
      const later = new Date(NOW.getTime() + 60_000)
      await utimes(brief, later, later)
      assert.deepEqual(await call(env, 'Stop'), {})
      const ready = await readJsonFile<{ brief?: string; briefSource?: string }>(join(dir, FILES.ready))
      assert.equal(ready?.brief, brief)
      assert.equal(ready?.briefSource, 'agent')
    })
  })

  it('on Stop: blocks with the threshold text when a turn reached it without tool calls', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h)
      await pressure(env, 97)
      const out = (await call(env, 'Stop')).output as { decision: string; reason: string }
      assert.equal(out.decision, 'block')
      assert.match(out.reason, /end your turn/)
    })
  })

  it('without an agent Brief: no preparing step, the threshold only ends the turn, Stop marks ready', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h, { agentBrief: false })
      await pressure(env, 85)
      assert.deepEqual(await call(env, 'PostToolUse'), {})
      await pressure(env, 96)
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(out.hookSpecificOutput.additionalContext, /end your turn/)
      assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /handoff brief/)
      assert.deepEqual(await call(env, 'Stop'), {})
      assert.equal((await readJsonFile<{ brief?: string }>(join(dir, FILES.ready)))?.brief, undefined)
    })
  })

  it('turns a manual request into ready on the next Stop', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await writeJsonFile(join(dir, FILES.request), {
        runId: 'r1',
        at: NOW.toISOString(),
        trigger: 'manual',
        brief: '/b.md',
        briefSource: 'user',
      })
      await call(env, 'Stop')
      const ready = await readJsonFile<{ trigger: string; brief: string }>(join(dir, FILES.ready))
      assert.deepEqual([ready?.trigger, ready?.brief], ['manual', '/b.md'])
      assert.equal(await readJsonFile(join(dir, FILES.request)), null)
    })
  })

  it('marks ready on StopFailure only when the Quota is used up', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await pressure(env, 40)
      await call(env, 'StopFailure', { error: 'rate_limit', error_details: '529 Overloaded' })
      assert.equal(await readJsonFile(join(dir, FILES.ready)), null)
      await call(env, 'StopFailure', { error: 'rate_limit', error_details: 'Claude usage limit reached' })
      assert.equal((await readJsonFile<{ trigger: string }>(join(dir, FILES.ready)))?.trigger, 'limit')
    })
  })

  it('exits 0 with no output on bad input or broken state files', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await writeFile(join(dir, FILES.plan), '{broken')
      await pressure(env, 99)
      const chunks: string[] = []
      const out = new Writable({
        write(c, _e, cb) {
          chunks.push(String(c))
          cb()
        },
      })
      assert.equal(await runHandoffHook(['claude', 'PostToolUse'], env, Readable.from(['not json']), out), 0)
      assert.equal(await runHandoffHook(['claude', 'PostToolUse'], env, Readable.from(['{}']), out), 0)
      assert.equal(await runHandoffHook(['claude', 'Nope'], env, Readable.from(['{}']), out), 0)
      assert.deepEqual(chunks, [])
      assert.equal(await readFile(join(dir, FILES.plan), 'utf8'), '{broken')
    })
  })
})

describe('handoff hook imports', () => {
  it('reaches only leaf modules: never the Runtime, a Family index or core/accounts.ts', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const seen = new Set<string>()
    const walk = async (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/^import (?!type )[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm))
        await walk(resolve(dirname(file), m[1]!))
    }
    await walk(join(root, 'handoff/hook.ts'))
    assert.ok(seen.has(join(root, 'families/claude/quota-cache.ts')), 'the walk follows imports')
    const bad = [...seen]
      .map((f) => relative(root, f))
      .filter((f) => f === 'runtime.ts' || f === 'core/accounts.ts' || /^families\/[^/]+\/index\.ts$/.test(f))
    assert.deepEqual(bad, [])
  })
})
