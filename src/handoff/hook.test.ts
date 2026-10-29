// The handoff hook (spec §3.17): when it speaks to the model, when it marks a run ready, and that it never fails.
import assert from 'node:assert/strict'
import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import {
  BRIEF_DONE,
  ensureChainDir,
  FILES,
  type PlanFile,
  type ReadyFile,
  type RunState,
  readJsonFile,
  writeJsonFile,
} from '../core/handoff-chain.ts'
import { writeQuotaCache } from '../families/claude/quota-cache.ts'
import type { Env, HandoffHookEvent } from '../types.ts'
import { decide, idleWatch, runHandoffHook } from './hook.ts'
import type { HookInput } from './reader.ts'

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

async function pressure(env: Env, used: number, weekly?: number) {
  await writeQuotaCache(join(env.XDG_STATE_HOME!, 'sideby'), '001', {
    version: 1,
    observedAt: NOW.toISOString(),
    windows: [
      { label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: '2026-10-09T15:00:00Z' },
      ...(weekly === undefined
        ? []
        : [{ label: '7d', windowMinutes: 10080, usedPercent: weekly, resetsAt: '2026-10-12T20:00:00Z' }]),
    ],
  })
}

const call = (env: Env, event: HandoffHookEvent, input = {}, family = 'claude') =>
  decide({ family, event, input, env, now: NOW })

describe('handoff hook', () => {
  it('tells a session at start how to move the task to another account when the user asks', async () => {
    await withFakeHome(async (h) => {
      const { env, brief } = await setup(h)
      const out = (await call({ ...env, SIDEBY_ACCOUNT: 'claude:001' }, 'SessionStart')).output as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string }
      }
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
      const text = out.hookSpecificOutput.additionalContext
      assert.match(text, /runs in claude:001/)
      assert.match(text, /sideby handoff ready --to <account>/)
      assert.ok(text.includes(brief))
      // Nothing to say outside a run, or when the account is unknown.
      assert.deepEqual(
        await call({ ...env, SIDEBY_HANDOFF_RUN: undefined, SIDEBY_ACCOUNT: 'claude:001' }, 'SessionStart'),
        {},
      )
      assert.deepEqual(await call(env, 'SessionStart'), {})
    })
  })

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

  it('tells the user once, not the model, that the session will wait for the reset and how to move on now', async () => {
    await withFakeHome(async (h) => {
      const until = '2026-10-09T12:26:00Z'
      const { env } = await setup(h, { decision: 'wait', until })
      const e = { ...env, SIDEBY_ACCOUNT: 'claude:008' }
      await pressure(env, 90)
      assert.equal(
        ((await call(e, 'PostToolUse')).output as { systemMessage?: string }).systemMessage,
        undefined,
      )
      await pressure(env, 96)
      const out = (await call(e, 'PostToolUse')).output as {
        systemMessage: string
        hookSpecificOutput?: unknown
      }
      assert.match(
        out.systemMessage,
        /claude:008 is at 96%.*waits and goes on by itself.*! sideby handoff ready/,
      )
      assert.ok(
        out.systemMessage.includes(
          new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
        ),
      )
      assert.equal(out.hookSpecificOutput, undefined)
      for (const event of ['PostToolUse', 'Stop'] as const) {
        const again = (await call(e, event)).output as { systemMessage?: string } | undefined
        assert.equal(again?.systemMessage, undefined)
      }
    })
  })

  it('at the limit while the plan is to wait, marks the run and sends a desktop notification', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h, { decision: 'wait', until: '2026-10-09T12:26:00Z' })
      await pressure(env, 100)
      const r = await call({ ...env, SIDEBY_ACCOUNT: 'claude:008' }, 'StopFailure', { error: 'rate_limit' })
      const seq = (r.output as { terminalSequence: string }).terminalSequence
      assert.ok(seq.startsWith('\u001b]9;sideby: claude:008 hit its limit'))
      assert.ok(seq.includes('\u001b]777;notify;sideby;'))
      assert.ok(seq.endsWith('! sideby handoff ready\u0007'))
      assert.equal((await readJsonFile<{ trigger: string }>(join(dir, FILES.ready)))?.trigger, 'limit')
      // A plan that moves on needs no notice: sideby hands over itself.
      const other = await setup(h, { decision: 'pick', runId: 'r1' })
      await writeFile(join(other.dir, FILES.ready), '')
      assert.deepEqual(await call(other.env, 'StopFailure', { error: 'rate_limit' }), {})
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
      await writeFile(brief, `# brief\n${BRIEF_DONE}\n`)
      const later = new Date(NOW.getTime() + 60_000)
      await utimes(brief, later, later)
      assert.deepEqual(await call(env, 'Stop'), {})
      const ready = await readJsonFile<ReadyFile>(join(dir, FILES.ready))
      assert.equal(ready?.brief, brief)
      assert.equal(ready?.briefSource, 'agent')
      assert.deepEqual(ready?.window, { label: '5h', usedPercent: 96, resetsAt: '2026-10-09T15:00:00Z' })
    })
  })

  it('on Stop: a Brief without the finished line counts as not written: block once, then ready without it', async () => {
    await withFakeHome(async (h) => {
      const { env, dir, brief } = await setup(h)
      await pressure(env, 96)
      await call(env, 'PostToolUse')
      await writeFile(brief, '# brief, half done\n')
      const later = new Date(NOW.getTime() + 60_000)
      await utimes(brief, later, later)
      const blocked = (await call(env, 'Stop')).output as { decision: string; reason: string }
      assert.equal(blocked.decision, 'block')
      assert.ok(blocked.reason.includes(BRIEF_DONE))
      await call(env, 'Stop', { stop_hook_active: true })
      const ready = await readJsonFile<ReadyFile>(join(dir, FILES.ready))
      assert.equal(ready?.trigger, 'threshold')
      assert.equal(ready?.brief, undefined)
    })
  })

  it('names the window that reached its level: the weekly one while the 5-hour one is nearly empty', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h)
      await pressure(env, 1, 95)
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(out.hookSpecificOutput.additionalContext, /weekly \(7d\) quota is at 95%/)
    })
  })

  it('adaptive: a window of light turns hands over later than threshold, a heavy turn earlier', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h, { adaptive: true })
      // Turns of 1–2 points: the level is 100 − 1.5 × 2 = 97.
      await pressure(env, 90)
      await call(env, 'PostToolUse')
      await pressure(env, 92)
      await call(env, 'Stop')
      await pressure(env, 93)
      await call(env, 'Stop')
      await pressure(env, 96)
      assert.deepEqual(await call(env, 'PostToolUse'), {})
      await pressure(env, 97)
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(out.hookSpecificOutput.additionalContext, /end your turn/)
    })
    await withFakeHome(async (h) => {
      const { env } = await setup(h, { adaptive: true })
      // One turn of 8 points: the level is 100 − 12 = 88, so a turn that ends at 88 is told to finish.
      await pressure(env, 80)
      await call(env, 'PostToolUse')
      await pressure(env, 88)
      const out = (await call(env, 'Stop')).output as { decision: string; reason: string }
      assert.equal(out.decision, 'block')
      assert.match(out.reason, /5-hour \(5h\) quota is at 88%/)
    })
  })

  it('adaptive: without a measured turn a window uses threshold', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h, { adaptive: true })
      await pressure(env, 94)
      await call(env, 'PostToolUse')
      await pressure(env, 95)
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(out.hookSpecificOutput.additionalContext, /end your turn/)
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

  it('says nothing to a subagent and marks nothing sent (PostToolUse with agent_id)', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await pressure(env, 99)
      assert.deepEqual(await call(env, 'PostToolUse', { agent_id: 'a1', session_id: 's1' }), {})
      assert.equal(await readJsonFile(join(dir, FILES.run('r1'))), null)
      // The main conversation still gets it at its next tool call.
      const out = (await call(env, 'PostToolUse')).output as {
        hookSpecificOutput: { additionalContext: string }
      }
      assert.match(out.hookSpecificOutput.additionalContext, /end your turn/)
    })
  })
})

describe('handoff hook IdleWatch', () => {
  const BUSY = {
    background_tasks: [{ id: 't1', type: 'local_agent', status: 'running', description: 'tests' }],
  }
  // No real waiting: each sleep moves the clock 15 s on.
  const fake = (opts: { parentGone?: () => boolean; onSleep?: (n: number) => Promise<void> } = {}) => {
    let t = NOW.getTime()
    let n = 0
    return {
      clock: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms
        n++
        await opts.onSleep?.(n)
      },
      parentGone: opts.parentGone ?? (() => false),
      id: 'w1',
      get sleeps() {
        return n
      },
    }
  }
  const watch = (env: Env, input: object, f = fake(), family = 'claude') =>
    idleWatch({ family, input: input as HookInput, env, ...f })

  it('exits 0 at once without background work, after replacing an earlier watch', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await pressure(env, 99)
      await writeJsonFile(join(dir, FILES.watch('r1')), { id: 'old' })
      const f = fake()
      assert.deepEqual(await watch(env, { background_tasks: [] }, f), { exit: 0 })
      assert.deepEqual(await watch(env, {}, f), { exit: 0 })
      assert.equal(f.sleeps, 0)
      assert.deepEqual(await readJsonFile(join(dir, FILES.watch('r1'))), { id: 'w1' })
      assert.equal(await readJsonFile(join(dir, FILES.run('r1'))), null)
    })
  })

  it('wakes the session when a window reaches its level under a pick plan: marks it sent, exit 2 with the message', async () => {
    await withFakeHome(async (h) => {
      const { env, dir, brief } = await setup(h)
      await pressure(env, 90)
      await writeJsonFile(join(dir, FILES.run('r1')), { prepareSentAt: NOW.toISOString(), sessionId: 's1' })
      const f = fake({ onSleep: async (n) => (n === 3 ? pressure(env, 96) : undefined) })
      const r = await watch(env, BUSY, f)
      assert.equal(r.exit, 2)
      assert.equal(f.sleeps, 3)
      assert.match(r.message!, /sideby Auto Handoff, set up when this session started/)
      assert.match(r.message!, /background task/)
      assert.match(r.message!, /end your turn/)
      assert.ok(r.message!.includes(brief))
      assert.ok(r.message!.includes(BRIEF_DONE))
      const state = await readJsonFile<RunState>(join(dir, FILES.run('r1')))
      assert.equal(state?.thresholdWindow?.label, '5h')
      assert.ok(state?.thresholdSentAt)
      // Kept what was there.
      assert.equal(state?.sessionId, 's1')
      assert.ok(state?.prepareSentAt)
    })
  })

  it('through the entry: the message goes to stderr and the exit code is 2', async () => {
    await withFakeHome(async (h) => {
      const { env } = await setup(h)
      await pressure(env, 99)
      const out: string[] = []
      const err: string[] = []
      const sink = (to: string[]) =>
        new Writable({
          write(c, _e, cb) {
            to.push(String(c))
            cb()
          },
        })
      const code = await runHandoffHook(
        ['claude', 'IdleWatch'],
        env,
        Readable.from([JSON.stringify(BUSY)]),
        sink(out),
        sink(err),
        fake(),
      )
      assert.equal(code, 2)
      assert.deepEqual(out, [])
      assert.match(err.join(''), /end your turn/)
    })
  })

  it('never wakes the session for a wait or none plan', async () => {
    await withFakeHome(async (h) => {
      for (const decision of ['wait', 'none'] as const) {
        const { env, dir } = await setup(h, { decision })
        await pressure(env, 99)
        const r = await watch(env, BUSY, fake({ parentGone: () => false }), 'claude')
        // It watches until time runs out (the clock moves 15 s per reading), never waking.
        assert.deepEqual(r, { exit: 0 })
        assert.equal((await readJsonFile<RunState>(join(dir, FILES.run('r1'))))?.thresholdSentAt, undefined)
      }
    })
  })

  it('ends without waking: a later watch took over, the session already handled it, a hand-over is under way, the parent is gone', async () => {
    await withFakeHome(async (h) => {
      const { env, dir } = await setup(h)
      await pressure(env, 99)
      const watchFile = join(dir, FILES.watch('r1'))
      const superseded = fake({ onSleep: async () => writeJsonFile(watchFile, { id: 'newer' }) })
      assert.deepEqual(await watch(env, BUSY, superseded), { exit: 0 })
      assert.equal(await readJsonFile(join(dir, FILES.run('r1'))), null)

      await writeJsonFile(join(dir, FILES.run('r1')), { thresholdSentAt: NOW.toISOString() })
      assert.deepEqual(await watch(env, BUSY), { exit: 0 })
      await rm(join(dir, FILES.run('r1')))

      await writeJsonFile(join(dir, FILES.ready), { runId: 'r1', at: NOW.toISOString(), trigger: 'manual' })
      assert.deepEqual(await watch(env, BUSY), { exit: 0 })
      await rm(join(dir, FILES.ready))

      assert.deepEqual(await watch(env, BUSY, fake({ parentGone: () => true })), { exit: 0 })
      assert.equal(await readJsonFile(join(dir, FILES.run('r1'))), null)
      // Another Family, or outside a run: nothing at all.
      assert.deepEqual(await watch(env, BUSY, fake(), 'codex'), { exit: 0 })
      assert.deepEqual(await watch({ ...env, SIDEBY_HANDOFF_RUN: undefined }, BUSY), { exit: 0 })
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
