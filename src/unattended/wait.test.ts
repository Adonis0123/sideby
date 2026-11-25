// Answer Wait (spec §3.37 item 7, ADR-0077): a question or a permission prompt Claude Code shows in a session sideby
// started waits for a person; once it has waited `unattended.answerWait` minutes (10 by default) and Unattended Mode is
// on, `unattended-hook` refuses it as the mode would and keeps a Pending Decision with how long it waited. It never
// answers "yes". What is on screen comes from Claude Code's session record, `sessions/<pid>.json`, faked here.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from '../core/paths.ts'
import { markAttended } from '../core/unattended-attended.ts'
import { listPendingDecisions, markPendingDone } from '../core/unattended-pending.ts'
import { writeUnattendedOverride } from '../core/unattended-state.ts'
import { runUnattendedHook } from './hook.ts'

const T0 = new Date(2026, 10, 16, 21, 0).getTime()
const MIN = 60_000
const PID = 4242
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

/** The config's `unattended` section; `wait` sets `answerWait` (false: never). */
async function configure(h: FakeHome, wait?: number | false) {
  await h.write(
    '.config/sideby/config.json',
    JSON.stringify({ unattended: wait === undefined ? {} : { answerWait: wait } }),
  )
}

/** Unattended Mode turned on by hand from `from` for 12 hours. */
async function turnOn(h: FakeHome, from = T0 - MIN) {
  await writeUnattendedOverride(resolvePaths(h.env).stateDir, {
    mode: 'on',
    at: new Date(from).toISOString(),
    until: new Date(from + 12 * 60 * MIN).toISOString(),
  })
}

/** Unattended Mode paused by hand at `at` for 12 hours: off. */
async function turnOff(h: FakeHome, at: number) {
  await writeUnattendedOverride(resolvePaths(h.env).stateDir, {
    mode: 'pause',
    at: new Date(at).toISOString(),
    until: new Date(at + 12 * 60 * MIN).toISOString(),
  })
}

/** Someone typed into session `s1` just before `T0`: an Attended Session, so its questions are shown. */
const attend = (h: FakeHome) =>
  markAttended(resolvePaths(h.env).stateDir, { sessionId: 's1', family: 'claude' }, new Date(T0 - MIN))

/** Claude Code's record of the session process, as 2.1.325 writes it while a dialog is on screen (`waiting`). */
const screen = (h: FakeHome, status: string, at: number, session = 's1') =>
  h.write(
    `.claude/sessions/${PID}.json`,
    JSON.stringify({
      pid: PID,
      sessionId: session,
      status,
      updatedAt: at,
      statusUpdatedAt: at,
      ...(status === 'waiting' ? { waitingFor: 'input needed' } : {}),
    }),
  )

const QUESTION = {
  questions: [
    {
      question: 'Which framework should I use?',
      header: 'Framework',
      multiSelect: false,
      options: [{ label: 'Vue' }, { label: 'React (Recommended)' }],
    },
  ],
}

/** A permission request as Claude Code 2.1.325 sends it for the ask tool or a Bash command. */
const request = (tool: 'AskUserQuestion' | 'Bash', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 's1',
    cwd: '/work/project',
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_name: tool,
    tool_input:
      tool === 'Bash' ? { command: 'rm -rf build', description: 'Remove the build folder' } : QUESTION,
    ...extra,
  })

/** A turn's end as Claude Code sends it to the background `Stop` entry. */
const stop = (message: string, active = false) =>
  JSON.stringify({
    session_id: 's1',
    cwd: '/work/project',
    hook_event_name: 'Stop',
    stop_hook_active: active,
    last_assistant_message: message,
    background_tasks: [],
  })

/**
 * Runs the hook with a fake clock that each wait moves on; `at(t)` runs at every wait, so a test can change the record
 * or the config at a moment. Past `cap` minutes the wait throws, as Claude Code's `timeout` would end the hook.
 */
async function run(
  h: FakeHome,
  argv: string[],
  input: string,
  o: {
    at?: (t: number) => Promise<void>
    cap?: number
    env?: Record<string, string>
    parentGone?: () => boolean
    beforeAct?: () => Promise<unknown>
    afterKeep?: () => Promise<unknown>
  } = {},
) {
  let t = T0
  let waits = 0
  const out = sink()
  const err = sink()
  const code = await runUnattendedHook(
    argv,
    { ...h.env, SIDEBY_ACCOUNT: 'claude:work', ...o.env },
    input,
    { out, err },
    {
      now: () => new Date(t),
      hostPid: PID,
      parentGone: o.parentGone ?? (() => false),
      ...(o.beforeAct ? { beforeAct: o.beforeAct } : {}),
      ...(o.afterKeep ? { afterKeep: o.afterKeep } : {}),
      sleep: async (ms) => {
        waits++
        t += ms
        if (t - T0 > (o.cap ?? 13 * 60) * MIN) throw new Error('timed out')
        await o.at?.(t)
      },
    },
  )
  return { code, out: out.lines.join(''), err: err.lines.join(''), minutes: (t - T0) / MIN, waits }
}

const pending = (h: FakeHome, all = false) => listPendingDecisions(resolvePaths(h.env).stateDir, { all })

describe('Answer Wait: a question shown in a session', () => {
  it('waits 10 minutes, then the session goes on with the recommended option', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'))
      assert.equal(r.code, 0)
      assert.ok(r.minutes >= 10 && r.minutes < 10.1, `went on after ${r.minutes} minutes`)
      const answer = JSON.parse(r.out)
      assert.equal(answer.hookSpecificOutput.hookEventName, 'PermissionRequest')
      assert.equal(answer.hookSpecificOutput.decision.behavior, 'deny')
      assert.match(answer.hookSpecificOutput.decision.message, /^No answer after 10 minutes/)
      assert.match(answer.hookSpecificOutput.decision.message, /go on with the recommended option/)
      assert.match(answer.hookSpecificOutput.decision.message, /Do not ask again/)
      const [d] = await pending(h)
      assert.equal(d?.kind, 'question')
      assert.equal(d?.waited, 10)
      assert.equal(d?.sessionId, 's1')
      assert.equal(d?.account, 'claude:work')
      assert.match(d!.text, /Which framework should I use\?/)
      assert.match(d!.text, /- React \(Recommended\)/)
    })
  })

  it('is answered in time: nothing happens and nothing is kept', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        at: async (t) => {
          if (t >= T0 + 4 * MIN) await screen(h, 'busy', T0 + 4 * MIN)
        },
      })
      assert.deepEqual([r.code, r.out, r.err], [0, '', ''])
      assert.ok(r.minutes < 4.1, 'it stops as soon as the person answered')
      assert.deepEqual(await pending(h), [])
    })
  })

  it('stops when another dialog takes its place, or the Host is gone', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const next = await run(h, ['claude', 'PermissionRequest'], request('Bash'), {
        // Answered, and the next prompt is on screen at once: still `waiting`, with a new time.
        at: async (t) => {
          if (t >= T0 + 2 * MIN) await screen(h, 'waiting', T0 + 2 * MIN)
        },
      })
      assert.deepEqual([next.out, next.err], ['', ''])
      await screen(h, 'waiting', T0)
      const gone = await run(h, ['claude', 'PermissionRequest'], request('Bash'), { parentGone: () => true })
      assert.deepEqual([gone.out, gone.minutes < 1], ['', true])
      assert.deepEqual(await pending(h), [])
    })
  })

  it('lets it be when the person answers right after the last look, or while the decision is kept', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      // Answered between the last look and the answer: the record no longer shows the dialog.
      await screen(h, 'waiting', T0)
      const late = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        beforeAct: () => screen(h, 'busy', T0 + 10 * MIN),
      })
      assert.deepEqual([late.code, late.out, late.err], [0, '', ''])
      assert.deepEqual(await pending(h), [])
      // Answered while the Pending Decision was being kept: it is taken back and nothing is answered.
      await screen(h, 'waiting', T0)
      const saving = await run(h, ['claude', 'PermissionRequest'], request('Bash'), {
        afterKeep: () => screen(h, 'busy', T0 + 10 * MIN),
      })
      assert.deepEqual([saving.code, saving.out, saving.err], [0, '', ''])
      assert.deepEqual(await pending(h, true), [])
    })
  })

  it('goes on watching when the wait is made longer at the last look or while the decision is kept', async () => {
    await withFakeHome(async (h) => {
      await configure(h, 1)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      let longer = false
      const last = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        cap: 40,
        // Made 30 minutes just after the watch saw 1 minute pass.
        beforeAct: async () => {
          if (!longer) await configure(h, 30)
          longer = true
        },
      })
      assert.ok(last.minutes >= 30 && last.minutes < 30.1, `went on after ${last.minutes} minutes`)
      assert.match(JSON.parse(last.out).hookSpecificOutput.decision.message, /^No answer after 30 minutes/)
      assert.deepEqual(
        (await pending(h, true)).map((d) => d.waited),
        [30],
      )
      await markPendingDone(resolvePaths(h.env).stateDir, 'all')
      await configure(h, 1)
      let saving = false
      const kept = await run(h, ['claude', 'PermissionRequest'], request('Bash'), {
        cap: 40,
        // Made 30 minutes while the decision of the first minute was being kept: taken back, and the watch goes on.
        afterKeep: async () => {
          if (!saving) await configure(h, 30)
          saving = true
        },
      })
      assert.ok(kept.minutes >= 30 && kept.minutes < 30.1, `went on after ${kept.minutes} minutes`)
      assert.match(
        JSON.parse(kept.out).hookSpecificOutput.decision.message,
        /nobody confirmed this action in 30 minutes/,
      )
      assert.deepEqual(
        (await pending(h)).map((d) => [d.kind, d.waited]),
        [['permission', 30]],
      )
    })
  })

  it('never takes a dialog put up after the hook began for its own: that one was answered meanwhile', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      // The person answered this request while the hook started, and the next dialog is already on screen.
      await screen(h, 'waiting', T0 + 1000)
      const r = await run(h, ['claude', 'PermissionRequest'], request('Bash'))
      assert.deepEqual([r.code, r.out, r.err], [0, '', ''])
      assert.ok(r.minutes < 0.1, `let it be after ${r.minutes} minutes`)
      assert.deepEqual(await pending(h, true), [])
    })
  })

  it('refuses a permission prompt and never answers "yes"', async () => {
    await withFakeHome(async (h) => {
      await configure(h, 5)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('Bash'))
      assert.ok(r.minutes >= 5 && r.minutes < 5.1)
      const answer = JSON.parse(r.out)
      assert.deepEqual(Object.keys(answer.hookSpecificOutput.decision).sort(), ['behavior', 'message'])
      assert.equal(answer.hookSpecificOutput.decision.behavior, 'deny')
      assert.doesNotMatch(r.out, /"allow"|updatedInput|updatedPermissions/)
      assert.match(
        answer.hookSpecificOutput.decision.message,
        /^Not allowed: nobody confirmed this action in 5 minutes/,
      )
      const [d] = await pending(h)
      assert.deepEqual(
        [d?.kind, d?.waited, d?.text],
        ['permission', 5, 'Bash: rm\n(Remove the build folder)'],
      )
    })
  })

  it('does nothing with answerWait false: the question waits for the person', async () => {
    await withFakeHome(async (h) => {
      await configure(h, false)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'))
      assert.deepEqual([r.code, r.out, r.err, r.waits], [0, '', '', 0])
      assert.deepEqual(await pending(h), [])
    })
  })

  it('stops waiting when the wait is set to never meanwhile', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        at: async (t) => {
          if (t >= T0 + 3 * MIN) await configure(h, false)
        },
      })
      assert.deepEqual([r.out, r.minutes < 3.1], ['', true])
    })
  })

  it('with Unattended Mode off it keeps waiting, and goes on once the mode comes on', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        at: async (t) => {
          if (t >= T0 + 45 * MIN && t < T0 + 45 * MIN + 3000) await turnOn(h, T0 + 45 * MIN)
        },
      })
      assert.ok(r.minutes >= 45 && r.minutes < 45.2, `went on after ${r.minutes} minutes`)
      assert.match(JSON.parse(r.out).hookSpecificOutput.decision.message, /^No answer after 45 minutes/)
      assert.equal((await pending(h))[0]?.waited, 45)
    })
  })

  it('with Unattended Mode off all along it never answers', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('Bash'), { cap: 30 })
      assert.deepEqual([r.code, r.out, r.err], [0, '', ''])
      assert.deepEqual(await pending(h), [])
    })
  })

  it('leaves alone what is not on screen: a subagent’s request, a session that shows none, no record', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      // A background subagent's request: Claude Code shows it only after the hooks, so holding it would hide it.
      await screen(h, 'waiting', T0)
      const sub = await run(
        h,
        ['claude', 'PermissionRequest'],
        request('Bash', { agent_id: 'a1', agent_type: 'general-purpose' }),
      )
      assert.deepEqual([sub.out, sub.waits], ['', 0])
      // `claude -p` and a subagent's request: the record says `busy`, never `waiting`.
      await screen(h, 'busy', T0)
      const busy = await run(h, ['claude', 'PermissionRequest'], request('Bash'))
      assert.equal(busy.out, '')
      assert.ok(busy.minutes * MIN <= 2100, 'it looks for 2 seconds at most')
      // Another session's record, or none.
      await screen(h, 'waiting', T0, 'other')
      assert.equal((await run(h, ['claude', 'PermissionRequest'], request('Bash'))).waits, 0)
      await h.write(`.claude/sessions/${PID}.json`, 'not json')
      assert.equal((await run(h, ['claude', 'PermissionRequest'], request('Bash'))).out, '')
      assert.deepEqual(await pending(h), [])
    })
  })

  it('reads the record of the Account the session runs as (CLAUDE_CONFIG_DIR)', async () => {
    await withFakeHome(async (h) => {
      await configure(h, 1)
      await turnOn(h)
      await attend(h)
      await h.write(
        `.claude-work/sessions/${PID}.json`,
        JSON.stringify({ sessionId: 's1', status: 'waiting', statusUpdatedAt: T0 }),
      )
      const r = await run(h, ['claude', 'PermissionRequest'], request('Bash'), {
        env: { CLAUDE_CONFIG_DIR: h.path('.claude-work') },
      })
      assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny')
    })
  })

  it('an unattended session is refused at once, as before', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('Bash'))
      assert.equal(r.waits, 0)
      assert.match(
        JSON.parse(r.out).hookSpecificOutput.decision.message,
        /^Not allowed: Claude Code wanted a person/,
      )
      assert.equal((await pending(h))[0]?.waited, undefined)
    })
  })

  it('says it in Chinese', async () => {
    await withFakeHome(async (h) => {
      await configure(h, 15)
      await turnOn(h)
      await attend(h)
      await screen(h, 'waiting', T0)
      const r = await run(h, ['claude', 'PermissionRequest'], request('AskUserQuestion'), {
        env: { LANG: 'zh_CN.UTF-8' },
      })
      assert.match(JSON.parse(r.out).hookSpecificOutput.decision.message, /^15 分钟没人回答/)
    })
  })
})

describe('Answer Wait: a turn that ended on a question written as text', () => {
  const ASKED = 'I can use React or Vue. Should I use React?'

  it('wakes the session after 10 minutes with no reply and keeps the question', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'idle', T0)
      const r = await run(h, ['claude', 'StopWait'], stop(ASKED))
      assert.equal(r.code, 2)
      assert.ok(r.minutes >= 10 && r.minutes < 10.1)
      assert.match(r.err, /^Nobody replied to your question for 10 minutes/)
      assert.match(r.err, /This note is not the user's reply/)
      assert.match(r.err, /go on with the recommended option/)
      assert.equal(r.out, '')
      const [d] = await pending(h)
      assert.deepEqual([d?.kind, d?.waited, d?.text], ['question', 10, ASKED])
    })
  })

  it('a reply in time: nothing happens', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'idle', T0)
      const r = await run(h, ['claude', 'StopWait'], stop(ASKED), {
        at: async (t) => {
          if (t >= T0 + 6 * MIN) await screen(h, 'busy', T0 + 6 * MIN)
        },
      })
      assert.deepEqual([r.code, r.err], [0, ''])
      assert.deepEqual(await pending(h), [])
    })
  })

  it('wakes nothing when the reply comes right after the last look, or the mode goes off while the question is kept', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      await screen(h, 'idle', T0)
      const late = await run(h, ['claude', 'StopWait'], stop(ASKED), {
        beforeAct: () => screen(h, 'busy', T0 + 10 * MIN),
      })
      assert.deepEqual([late.code, late.err], [0, ''])
      await screen(h, 'idle', T0)
      // WHY: with the mode off the hook keeps watching until Claude Code's timeout ends it; `cap` stands in for that.
      const off = await run(h, ['claude', 'StopWait'], stop(ASKED), {
        afterKeep: () => turnOff(h, T0 + 10 * MIN),
        cap: 15,
      })
      assert.deepEqual([off.code, off.err], [0, ''])
      assert.deepEqual(await pending(h, true), [])
    })
  })

  it('wakes nothing when someone replied before the hook first read the record, and that turn has ended', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await attend(h)
      // The record the hook first reads is already the end of the turn the reply started; the prompt a person typed
      // after this Stop is noted (in the background) a moment later.
      await screen(h, 'idle', T0 + 1800)
      const r = await run(h, ['claude', 'StopWait'], stop(ASKED), {
        at: async (t) => {
          if (t >= T0 + 3000 && t < T0 + 6000)
            await markAttended(
              resolvePaths(h.env).stateDir,
              { sessionId: 's1', family: 'claude' },
              new Date(T0 + 1000),
            )
        },
      })
      assert.deepEqual([r.code, r.err], [0, ''])
      assert.ok(r.minutes < 0.2, `stopped after ${r.minutes} minutes`)
      assert.deepEqual(await pending(h, true), [])
    })
  })

  it('leaves an unattended session to the first Stop entry, and ends that are not open questions', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await turnOn(h)
      await screen(h, 'idle', T0)
      // Not attended: the first `Stop` entry already keeps the turn going.
      assert.deepEqual((await run(h, ['claude', 'StopWait'], stop(ASKED))).waits, 0)
      await attend(h)
      for (const input of [stop('Done: all tests pass.'), stop(ASKED, true)]) {
        const r = await run(h, ['claude', 'StopWait'], input)
        assert.deepEqual([r.code, r.err, r.waits], [0, '', 0])
      }
      await configure(h, false)
      assert.equal((await run(h, ['claude', 'StopWait'], stop(ASKED))).waits, 0)
      assert.deepEqual(await pending(h), [])
    })
  })

  it('with the mode off it waits on, and wakes the session once a Slot begins', async () => {
    await withFakeHome(async (h) => {
      await configure(h)
      await screen(h, 'idle', T0)
      const r = await run(h, ['claude', 'StopWait'], stop('要不要把旧接口删掉？'), {
        env: { LANG: 'zh_CN.UTF-8' },
        at: async (t) => {
          if (t >= T0 + 2 * 60 * MIN && t < T0 + 2 * 60 * MIN + 3000) await turnOn(h, T0 + 2 * 60 * MIN)
        },
      })
      assert.equal(r.code, 2)
      assert.match(r.err, /^120 分钟没人回复你的问题/)
      assert.match(r.err, /这条不是用户的回复/)
    })
  })
})
