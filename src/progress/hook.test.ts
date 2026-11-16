// `sideby progress-hook` (spec §3.42, ADR-0076): a reminder every `progress.every` minutes while a Claude session
// waits on background work, and nothing when the work is done, a later Stop or a new turn took over, the Host is gone,
// the setting is off, Auto Handoff is handing over, or the session is unattended. Its wake-up is host-made. Nothing
// really waits: the clock moves only when the fake sleep says so.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { ensureChainDir, FILES, writeJsonFile } from '../core/handoff-chain.ts'
import { resolvePaths } from '../core/paths.ts'
import { readPromptRecord, readWatch } from '../core/progress-state.ts'
import { hostMade, PROGRESS_MARK, progressWakeUp } from '../core/prompt-origin.ts'
import { markAttended, readAttended } from '../core/unattended-attended.ts'
import { writeUnattendedOverride } from '../core/unattended-state.ts'
import { runUnattendedHook } from '../unattended/hook.ts'
import { type ProgressHookDeps, runProgressHook, watchWhileWaiting } from './hook.ts'

const MIN = 60_000
const SID = '2a1a3b9f-aad8-46f7-ba5a-cb58f25aa568'
const TASKS = [
  {
    id: 'bfcm7pcid',
    type: 'shell',
    status: 'running',
    description: 'long background wait',
    command: 'sleep 45; echo SECRET-ARG',
  },
  {
    id: 'a9e77b682c7292bd2',
    type: 'subagent',
    status: 'running',
    description: 'probe subagent',
    agent_type: 'general-purpose',
  },
]
const stopInput = (o: { promptId?: string; tasks?: unknown[]; active?: boolean } = {}) => ({
  session_id: SID,
  transcript_path: '/nowhere/t.jsonl',
  cwd: '/work',
  prompt_id: o.promptId ?? 'p-typed',
  hook_event_name: 'Stop',
  stop_hook_active: o.active ?? false,
  last_assistant_message: 'ok, the build runs in the background',
  background_tasks: o.tasks ?? TASKS,
  session_crons: [],
})
/** How Claude Code 2.1.325 hands a background `Stop` hook's exit 2 to the session (seen on 2026-11-16). */
const wrap = (stderr: string) =>
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${stderr}\n\n</system-reminder>`

async function on(h: FakeHome, every = 10, extra: object = {}) {
  await h.write('.config/sideby/config.json', JSON.stringify({ progress: { every }, ...extra }))
}

/** A clock that moves only when the hook sleeps; `onSleep` runs after each move, with the minutes passed so far. */
function fake(
  opts: { onSleep?: (minutes: number) => Promise<void>; parentGone?: () => boolean; id?: string } = {},
) {
  const start = Date.now()
  let t = start
  let n = 0
  const deps: ProgressHookDeps & { readonly sleeps: number; readonly minutes: number } = {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms
      n++
      await opts.onSleep?.((t - start) / MIN)
    },
    parentGone: opts.parentGone ?? (() => false),
    id: opts.id ?? 'w1',
    get sleeps() {
      return n
    },
    get minutes() {
      return (t - start) / MIN
    },
  }
  return deps
}

const notePrompt = (h: FakeHome, prompt: string, promptId: string, extra: object = {}) =>
  runProgressHook(
    ['claude', 'UserPromptSubmit'],
    h.env,
    JSON.stringify({ session_id: SID, prompt_id: promptId, prompt, ...extra }),
    { err: { write: () => true } },
  )

describe('progress hook: Stop', () => {
  it('does nothing while nothing runs in the background, after replacing an earlier watch', async () => {
    await withFakeHome(async (h) => {
      await on(h)
      const { stateDir } = resolvePaths(h.env)
      const f = fake()
      assert.deepEqual(await watchWhileWaiting(stopInput({ tasks: [] }), h.env, f), { exit: 0 })
      assert.deepEqual(await watchWhileWaiting({ session_id: SID }, h.env, f), { exit: 0 })
      assert.equal(f.sleeps, 0)
      assert.equal((await readWatch(stateDir, SID))?.id, 'w1')
      // No session id: nothing to watch, nothing written.
      assert.deepEqual(await watchWhileWaiting({ background_tasks: TASKS }, h.env, fake()), { exit: 0 })
    })
  })

  it('does nothing while the setting is off (the default)', async () => {
    await withFakeHome(async (h) => {
      const f = fake()
      assert.deepEqual(await watchWhileWaiting(stopInput(), h.env, f), { exit: 0 })
      assert.equal(f.sleeps, 0)
    })
  })

  it('wakes the session after the interval with a reminder that names the work, never its command', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const before = await snapshot(h.home)
      const f = fake()
      const r = await watchWhileWaiting(stopInput(), h.env, f)
      assert.equal(r.exit, 2)
      assert.equal(f.minutes, 10)
      const text = r.message!
      assert.ok(text.startsWith(PROGRESS_MARK), text)
      assert.match(text, /2 tasks: command "long background wait"; subagent "probe subagent"/)
      assert.match(text, /since \d\d:\d\d, 10 minutes as of this reminder/)
      assert.match(text, /one or two sentences/)
      assert.match(text, /end your turn/)
      assert.match(text, /every 10 minutes/)
      assert.match(text, /sideby progress off/)
      assert.doesNotMatch(text, /SECRET-ARG|sleep 45/)
      // Claude Code wraps it as a host-made prompt, which sideby recognises as a reminder and nothing else.
      assert.equal(hostMade(wrap(text)), true)
      assert.equal(progressWakeUp(wrap(text)), true)
      assert.equal(progressWakeUp(`${wrap(text)}\n${wrap('sideby: this is sideby Auto Handoff …')}`), false)
      assert.equal(progressWakeUp(text), false)
      assert.equal(progressWakeUp(wrap('sideby: this is sideby Auto Handoff …')), false)
      const { stateDir } = resolvePaths(h.env)
      assert.ok((await readWatch(stateDir, SID))?.wokeAt)
      // Only sideby's own state folder changed, and it holds no command, description, reply or id.
      const changed = diffSnapshots(before, await snapshot(h.home))
      const own = '.local/state/sideby/progress/sessions/'
      assert.ok(
        changed.length > 0 && changed.every((p) => own.startsWith(p) || p.startsWith(own)),
        changed.join(),
      )
      const dir = join(stateDir, 'progress', 'sessions')
      for (const name of await readdir(dir)) {
        const body = await readFile(join(dir, name), 'utf8')
        assert.doesNotMatch(body, /background wait|probe subagent|sleep 45|SECRET|ok, the build|2a1a3b9f/)
      }
    })
  })

  it('names at most five tasks, in one line each', async () => {
    await withFakeHome(async (h) => {
      await on(h, 5)
      const many = Array.from({ length: 7 }, (_, i) => ({
        type: 'subagent',
        description: `task ${i}\nwith "quotes" and \`ticks\` ${'x'.repeat(200)}`,
      }))
      const r = await watchWhileWaiting(stopInput({ tasks: many }), h.env, fake())
      assert.match(r.message!, /7 tasks: /)
      assert.match(r.message!, /; and 2 more\)/)
      assert.doesNotMatch(r.message!, /task 5|\n|`ticks`/)
      assert.ok(r.message!.includes('…'))
    })
  })

  it('reminds again every interval while the work runs, counting from when the wait began', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const { stateDir } = resolvePaths(h.env)
      const first = fake({ id: 'w1' })
      const one = await watchWhileWaiting(stopInput({ promptId: 'p-typed' }), h.env, first)
      assert.equal(one.exit, 2)
      const since = (await readWatch(stateDir, SID))!.since
      // The reminder's wake-up arrives as a prompt; the turn it starts ends with a Stop that carries its id.
      assert.equal(await notePrompt(h, wrap(one.message!), 'p-wake-1'), 0)
      assert.deepEqual(await readPromptRecord(stateDir, SID).then((p) => p?.reminder), true)
      const second = fake({ id: 'w2' })
      const t0 = Date.parse(since)
      const later = { ...second, now: () => new Date(second.now!().getTime() + 10 * MIN) }
      const two = await watchWhileWaiting(stopInput({ promptId: 'p-wake-1', active: true }), h.env, later)
      assert.equal(two.exit, 2)
      assert.equal((await readWatch(stateDir, SID))!.since, since)
      assert.match(two.message!, /, 20 minutes as of this reminder/)
      assert.ok(t0 > 0)
      // A reminder Network Guard held and handed over later is still a reminder: the wait keeps its start.
      const held = wrap(
        `sideby's Network Guard held back a message Claude Code made itself. The message as it was:\n<sideby-held-message>\n${wrap(two.message!)}\n</sideby-held-message>`,
      )
      await notePrompt(h, held, 'p-held')
      assert.deepEqual(await readPromptRecord(stateDir, SID).then((p) => p?.reminder), true)
      await watchWhileWaiting(
        stopInput({ promptId: 'p-held', active: true, tasks: [] }),
        h.env,
        fake({ id: 'w4' }),
      )
      assert.equal((await readWatch(stateDir, SID))!.since, since)
      // An ordinary turn (typed, or a task's notification) starts a new wait.
      await notePrompt(h, 'how is it going?', 'p-typed-2')
      await watchWhileWaiting(stopInput({ promptId: 'p-typed-2', tasks: [] }), h.env, fake({ id: 'w3' }))
      assert.notEqual((await readWatch(stateDir, SID))!.since, since)
    })
  })

  it('ends without a word when a later Stop takes over, or the work is all done', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      // The next turn ends with work still running: its watch replaces this one, which ends without a word.
      let next: Promise<unknown> | undefined
      const { stateDir } = resolvePaths(h.env)
      const f = fake({
        onSleep: async (m) => {
          if (m !== 1) return
          next = watchWhileWaiting(stopInput({ promptId: 'p-2' }), h.env, fake({ id: 'w2' }))
          while ((await readWatch(stateDir, SID))?.id !== 'w2') await new Promise((r) => setTimeout(r, 1))
        },
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), h.env, f), { exit: 0 })
      assert.equal(f.minutes, 1)
      assert.equal(((await next) as { exit: number }).exit, 2)
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      // The work finished: Claude Code's notification starts a turn whose Stop lists nothing.
      const g = fake({
        onSleep: async (m) => {
          if (m === 2)
            await watchWhileWaiting(stopInput({ promptId: 'p-note', tasks: [] }), h.env, fake({ id: 'w2' }))
        },
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), h.env, g), { exit: 0 })
      assert.equal(g.minutes, 2)
    })
  })

  it('ends without a word when a new turn began after its Stop, so a reminder never follows an answer', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const f = fake({
        onSleep: async (m) => {
          if (m === 3) await notePrompt(h, 'what is the status?', 'p-new')
        },
      })
      assert.deepEqual(await watchWhileWaiting(stopInput({ promptId: 'p-typed' }), h.env, f), { exit: 0 })
      assert.equal(f.minutes, 3)
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      // The prompt of the turn that just ended, noted late (an instant turn), is not a new turn.
      const f = fake({
        onSleep: async (m) => {
          if (m === 1) await notePrompt(h, 'start the build', 'p-typed')
        },
      })
      assert.equal((await watchWhileWaiting(stopInput({ promptId: 'p-typed' }), h.env, f)).exit, 2)
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      // The next prompt (queued while this turn ran) was noted before this Stop's watch even started.
      await notePrompt(h, 'start the build', 'p-typed')
      await notePrompt(h, 'and now the docs', 'p-queued')
      const f = fake()
      const late = { ...f, now: () => new Date(f.now!().getTime() + 5000) }
      assert.deepEqual(await watchWhileWaiting(stopInput({ promptId: 'p-typed' }), h.env, late), { exit: 0 })
      assert.equal(f.minutes, 1)
    })
  })

  it('a Stop that comes while a watch wakes the session keeps its own watch going', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const { stateDir } = resolvePaths(h.env)
      let next: Promise<{ exit: number }> | undefined
      const f = {
        ...fake({ id: 'w1' }),
        // Between this watch's last check and its wake-up mark, the next turn's Stop replaces the record.
        beforeWake: async () => {
          next = watchWhileWaiting(stopInput({ promptId: 'p-2' }), h.env, fake({ id: 'w2' }))
          await new Promise((r) => setTimeout(r, 100))
        },
      }
      assert.equal((await watchWhileWaiting(stopInput(), h.env, f)).exit, 2)
      assert.equal((await next!).exit, 2)
      // The later Stop's record was never put back to the earlier watch's.
      assert.equal((await readWatch(stateDir, SID))?.id, 'w2')
      assert.deepEqual(
        (await readdir(join(stateDir, 'progress', 'sessions'))).filter((n) => n.endsWith('.lock')),
        [],
      )
    })
  })

  it('ends when the Host is gone or the setting was turned off', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      let gone = false
      const f = fake({
        parentGone: () => gone,
        onSleep: async (m) => {
          if (m >= 4) gone = true
        },
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), h.env, f), { exit: 0 })
      assert.equal(f.minutes, 4)
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      const f = fake({
        onSleep: async (m) =>
          m === 5 ? h.write('.config/sideby/config.json', '{}').then(() => {}) : undefined,
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), h.env, f), { exit: 0 })
      assert.equal(f.minutes, 5)
    })
  })

  it('follows a new interval in a running session', async () => {
    await withFakeHome(async (h) => {
      await on(h, 30)
      const f = fake({ onSleep: async (m) => (m === 2 ? on(h, 5) : undefined) })
      const r = await watchWhileWaiting(stopInput(), h.env, f)
      assert.equal(r.exit, 2)
      assert.equal(f.minutes, 5)
      assert.match(r.message!, /every 5 minutes/)
    })
  })

  it('stays quiet while the session is unattended, and reminds once someone is there again', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const { stateDir } = resolvePaths(h.env)
      const f = fake({
        onSleep: async (m) => {
          // Unattended Mode is turned off 15 minutes in.
          if (m === 15)
            await writeUnattendedOverride(stateDir, { mode: 'pause', at: new Date().toISOString() })
        },
      })
      await writeUnattendedOverride(stateDir, {
        mode: 'on',
        until: new Date(Date.now() + 15 * MIN).toISOString(),
        at: new Date().toISOString(),
      })
      const r = await watchWhileWaiting(stopInput(), h.env, f)
      // Skipped at 10 (unattended), the wait started again: the next reminder is at 20.
      assert.equal(r.exit, 2)
      assert.equal(f.minutes, 20)
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      // A session started with --unattended stays quiet the whole time.
      let n = 0
      const f = fake({ onSleep: async () => void n++ })
      const env = { ...h.env, SIDEBY_UNATTENDED: '1' }
      const r = await watchWhileWaiting(stopInput(), env, {
        ...f,
        parentGone: () => n > 40,
      })
      assert.deepEqual(r, { exit: 0 })
    })
    await withFakeHome(async (h) => {
      await on(h, 10)
      // An Attended Session (someone typed in it within 30 minutes) is not unattended: it is reminded.
      const { stateDir } = resolvePaths(h.env)
      await markAttended(stateDir, { sessionId: SID, family: 'claude' }, new Date())
      const env = { ...h.env, SIDEBY_UNATTENDED: '1' }
      assert.equal((await watchWhileWaiting(stopInput(), env, fake())).exit, 2)
    })
  })

  it('stays quiet once Auto Handoff is handing over', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const dir = h.path('.local/state/sideby/handoffs/c1')
      await ensureChainDir(dir)
      const env = {
        ...h.env,
        SIDEBY_HANDOFF_RUN: 'r1',
        SIDEBY_HANDOFF_FAMILY: 'claude',
        SIDEBY_HANDOFF_DIR: dir,
      }
      const f = fake({
        onSleep: async (m) => {
          // IdleWatch marked the threshold and woke the session.
          if (m === 6)
            await writeJsonFile(join(dir, FILES.run('r1')), { thresholdSentAt: new Date().toISOString() })
        },
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), env, f), { exit: 0 })
      assert.equal(f.minutes, 6)
      await writeJsonFile(join(dir, FILES.run('r1')), {})
      await writeJsonFile(join(dir, FILES.ready), {
        runId: 'r1',
        at: new Date().toISOString(),
        trigger: 'threshold',
      })
      assert.deepEqual(await watchWhileWaiting(stopInput(), env, fake()), { exit: 0 })
    })
  })

  it('gives up by itself before Claude Code’s five-hour timeout', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const env = { ...h.env, SIDEBY_UNATTENDED: '1' }
      const f = fake()
      assert.deepEqual(await watchWhileWaiting(stopInput(), env, f), { exit: 0 })
      assert.ok(f.minutes >= 4 * 60 + 55 && f.minutes < 5 * 60, String(f.minutes))
    })
  })
})

describe('progress hook: the entry', () => {
  const sink = () => {
    const lines: string[] = []
    return {
      lines,
      w: new Writable({
        write(c, _e, cb) {
          lines.push(String(c))
          cb()
        },
      }),
    }
  }

  it('writes the reminder to stderr with exit 2, and never fails the Host', async () => {
    await withFakeHome(async (h) => {
      await on(h, 10)
      const err = sink()
      const code = await runProgressHook(
        ['claude', 'Stop'],
        h.env,
        JSON.stringify(stopInput()),
        { err: err.w },
        fake(),
      )
      assert.equal(code, 2)
      assert.ok(err.lines.join('').startsWith(PROGRESS_MARK))
      const quiet = sink()
      assert.equal(
        await runProgressHook(
          ['codex', 'Stop'],
          h.env,
          JSON.stringify(stopInput()),
          { err: quiet.w },
          fake(),
        ),
        0,
      )
      assert.equal(
        await runProgressHook(['claude', 'Stop'], h.env, '{ not json', { err: quiet.w }, fake()),
        0,
      )
      assert.equal(await runProgressHook(['claude', 'PreToolUse'], h.env, '{}', { err: quiet.w }, fake()), 0)
      assert.deepEqual(quiet.lines, [])
    })
  })

  it('notes a prompt only while the setting is on, never for a subagent, and keeps no text or id', async () => {
    await withFakeHome(async (h) => {
      const { stateDir } = resolvePaths(h.env)
      assert.equal(await notePrompt(h, 'hello', 'p-1'), 0)
      assert.equal(await readPromptRecord(stateDir, SID), undefined)
      await on(h, 10)
      await notePrompt(h, 'hello there', 'p-2', { agent_id: 'a1' })
      assert.equal(await readPromptRecord(stateDir, SID), undefined)
      await notePrompt(h, 'hello there', 'p-2')
      const r = await readPromptRecord(stateDir, SID)
      assert.equal(r?.reminder, false)
      const body = await readFile(
        join(stateDir, 'progress', 'sessions', (await readdir(join(stateDir, 'progress', 'sessions')))[0]!),
        'utf8',
      )
      assert.doesNotMatch(body, /hello|p-2/)
      await notePrompt(h, wrap(`${PROGRESS_MARK} you are waiting on background work`), 'p-3')
      assert.equal((await readPromptRecord(stateDir, SID))?.reminder, true)
    })
  })

  it('a reminder’s wake-up never makes the session an Attended Session', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: {}, progress: { every: 10 } }))
      const { stateDir } = resolvePaths(h.env)
      const code = await runUnattendedHook(
        ['claude', 'UserPromptSubmit'],
        { ...h.env, SIDEBY_LAUNCH_PROMPTS: '' },
        JSON.stringify({
          session_id: SID,
          prompt_id: 'p-wake',
          prompt: wrap(`${PROGRESS_MARK} you are waiting on background work`),
          transcript_path: h.path('.claude/projects/-work/x.jsonl'),
          cwd: '/work',
        }),
        { out: { write: () => true }, err: { write: () => true } },
      )
      assert.equal(code, 0)
      assert.equal(await readAttended(stateDir, SID, new Date()), undefined)
    })
  })
})

describe('progress hook imports', () => {
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
    await walk(join(root, 'progress/hook.ts'))
    assert.ok(seen.has(join(root, 'core/progress-state.ts')), 'the walk follows imports')
    const allowed = new Set([
      'progress/hook.ts',
      'core/progress-state.ts',
      'core/prompt-origin.ts',
      'core/handoff-chain.ts',
      'core/unattended-attended.ts',
      'core/unattended-state.ts',
      'core/fs-safe.ts',
      'core/lock.ts',
      'core/paths.ts',
    ])
    assert.deepEqual(
      [...seen].map((f) => relative(root, f)).filter((f) => !allowed.has(f)),
      [],
    )
  })
})
