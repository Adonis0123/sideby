// Attended Sessions (spec §3.37 "有人在的会话", ADR-0075): a prompt a person typed makes that one Claude session ask as
// usual for 30 minutes while Unattended Mode stays on for the rest. Only `unattended-hook`'s `UserPromptSubmit` entry
// sets it, after the transcript says `human`; prompts the Host made, Messages, command-line prompts, peers and
// subagents never do, nor does any other hook event.
import assert from 'node:assert/strict'
import { appendFile, mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { deliveredText, pasteLine } from '../core/messages.ts'
import { resolvePaths } from '../core/paths.ts'
import { launchPromptMarks } from '../core/prompt-origin.ts'
import { listAttended } from '../core/unattended-attended.ts'
import { listPendingDecisions } from '../core/unattended-pending.ts'
import { writeUnattendedOverride } from '../core/unattended-state.ts'
import { runUnattendedHook } from './hook.ts'

const T0 = new Date(2026, 10, 16, 23, 30).getTime()
const MIN = 60_000
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

/** The environment of a session sideby started with no prompt on its command line. */
const NO_LAUNCH_PROMPT = { SIDEBY_LAUNCH_PROMPTS: '' }

async function turnOn(h: FakeHome, at = T0) {
  await h.write('.config/sideby/config.json', '{"unattended":{}}')
  await writeUnattendedOverride(resolvePaths(h.env).stateDir, {
    mode: 'on',
    at: new Date(at - MIN).toISOString(),
    until: new Date(at + 12 * 60 * MIN).toISOString(),
  })
}

const transcriptOf = (h: FakeHome, session: string) => h.path('.claude', 'projects', 'p', `${session}.jsonl`)

/** The transcript line Claude Code 2.1.325 writes for a prompt; `origin` null leaves it out (`claude -p`). */
const record = (id: string, kind: string | null, content: string, at: number) =>
  `${JSON.stringify({
    type: 'user',
    promptId: id,
    ...(kind ? { origin: { kind } } : {}),
    promptSource: kind === 'human' ? 'typed' : 'system',
    message: { role: 'user', content },
    timestamp: new Date(at).toISOString(),
  })}\n`

let ids = 0
/**
 * Submits `prompt` to session `session` at `at` as Claude Code does, through the background `UserPromptSubmit` entry.
 * The transcript line is written while the hook waits (as Claude Code writes it 70–180 ms after the hook starts), with
 * the origin `kind` (none: never written), the prompt as its text and that moment as its time. `line` writes another
 * text, time or id instead, and `transcript` hands the hook another file, as an input made by hand could. Returns how
 * often the hook waited.
 */
async function submit(
  h: FakeHome,
  prompt: string,
  o: {
    session?: string
    at?: number
    kind?: string | null
    never?: boolean
    env?: Record<string, string | undefined>
    extra?: Record<string, unknown>
    line?: { id?: string; text?: string; at?: number }
    transcript?: string
  } = {},
) {
  const session = o.session ?? 's1'
  await h.write(`.claude/projects/p/${session}.jsonl`, '{"type":"mode"}\n').catch(() => {})
  await appendFile(transcriptOf(h, session), '')
  const file = o.transcript ?? transcriptOf(h, session)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, '')
  const id = o.line?.id ?? `prompt-${++ids}`
  let t = o.at ?? T0
  let slept = 0
  const input = JSON.stringify({
    session_id: session,
    transcript_path: file,
    cwd: '/work/project',
    prompt_id: id,
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    ...o.extra,
  })
  const env: Record<string, string | undefined> = {
    ...h.env,
    ...NO_LAUNCH_PROMPT,
    SIDEBY_ACCOUNT: 'claude:work',
    ...o.env,
  }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
  const out = sink()
  const code = await runUnattendedHook(
    ['claude', 'UserPromptSubmit'],
    env,
    input,
    { out, err: sink() },
    {
      now: () => new Date(t),
      sleep: async (ms) => {
        if (slept++ === 0 && !o.never && !o.line?.id)
          await appendFile(
            file,
            record(id, o.kind === undefined ? 'human' : o.kind, o.line?.text ?? prompt, o.line?.at ?? t),
          )
        t += ms
      },
    },
  )
  assert.equal(code, 0)
  assert.deepEqual(out.lines, [], 'the background entry never answers the Host')
  return { slept, id }
}

/** Runs another hook event of `session` at `at`. */
async function event(
  h: FakeHome,
  name: 'PreToolUse' | 'PermissionRequest' | 'Stop' | 'Elicitation',
  o: { session?: string; at?: number; env?: Record<string, string>; message?: string } = {},
) {
  const session = o.session ?? 's1'
  const base = { session_id: session, cwd: '/work/project', transcript_path: transcriptOf(h, session) }
  const input = JSON.stringify(
    name === 'Stop'
      ? {
          ...base,
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: o.message ?? 'Want me to deploy it?',
        }
      : name === 'Elicitation'
        ? { ...base, hook_event_name: 'Elicitation', mcp_server_name: 'notion', message: 'Pick a page' }
        : {
            ...base,
            hook_event_name: name,
            tool_name: name === 'PreToolUse' ? 'AskUserQuestion' : 'Bash',
            tool_input:
              name === 'PreToolUse'
                ? { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
                : { command: 'rm -rf build', description: 'Clean the build' },
          },
  )
  const out = sink()
  const err = sink()
  const code = await runUnattendedHook(
    ['claude', name],
    { ...h.env, ...o.env },
    input,
    { out, err },
    {
      now: () => new Date(o.at ?? T0),
    },
  )
  const text = out.lines.join('')
  return {
    code,
    err: err.lines.join(''),
    out: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  }
}

const attendedNow = (h: FakeHome, at = T0) => listAttended(resolvePaths(h.env).stateDir, new Date(at))

describe('Attended Sessions (unattended-hook on UserPromptSubmit)', () => {
  it('a typed prompt makes only its own session ask as usual, and tells the user once', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      await submit(h, 'how is it going?', { at: T0 })
      const [s, ...more] = await attendedNow(h, T0 + MIN)
      assert.equal(more.length, 0)
      assert.equal(s?.sessionId, 's1')
      assert.equal(s?.account, 'claude:work')
      assert.equal(s?.cwd, '/work/project')
      assert.equal(s?.until, new Date(T0 + 30 * MIN).toISOString())

      // The first question of the stretch goes through, with the notice for the user only.
      const first = await event(h, 'PreToolUse', { at: T0 + MIN })
      assert.equal(first.code, 0)
      assert.match(String(first.out?.systemMessage), /asks you as usual for 30 minutes/)
      assert.match(String(first.out?.systemMessage), /Other sessions stay unattended/)
      assert.match(String(first.out?.systemMessage), /sideby unattended off/)
      // After that: silent, as with the mode off.
      assert.deepEqual(await event(h, 'PreToolUse', { at: T0 + 2 * MIN }), {
        code: 0,
        err: '',
        out: undefined,
      })
      assert.deepEqual(await event(h, 'PermissionRequest', { at: T0 + 2 * MIN }), {
        code: 0,
        err: '',
        out: undefined,
      })
      assert.deepEqual(await event(h, 'Stop', { at: T0 + 2 * MIN }), { code: 0, err: '', out: undefined })
      assert.deepEqual(await event(h, 'Elicitation', { at: T0 + 2 * MIN }), {
        code: 0,
        err: '',
        out: undefined,
      })
      assert.deepEqual(await listPendingDecisions(resolvePaths(h.env).stateDir), [])

      // Another session is still unattended.
      assert.equal((await event(h, 'PreToolUse', { session: 's2', at: T0 + 2 * MIN })).code, 2)
      const denied = await event(h, 'PermissionRequest', { session: 's2', at: T0 + 2 * MIN })
      assert.deepEqual(
        (denied.out?.hookSpecificOutput as { decision?: { behavior?: string } } | undefined)?.decision
          ?.behavior,
        'deny',
      )
      assert.equal((await event(h, 'Stop', { session: 's2', at: T0 + 2 * MIN })).out?.decision, 'block')
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir)).length, 3)
    })
  })

  it('tells at the first Stop when no question came first, in Chinese where the user prefers it', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      await submit(h, '我回来了')
      const r = await event(h, 'Stop', { at: T0 + MIN, env: { LANG: 'zh_CN.UTF-8' } })
      assert.equal(r.code, 0)
      assert.match(String(r.out?.systemMessage), /30 分钟内照常问你/)
      assert.match(String(r.out?.systemMessage), /其他会话仍然无人值守/)
      assert.equal(r.out?.decision, undefined, 'a question at the end of the turn is not blocked')
      // A permission request never carries the notice: Claude Code does not show it there.
      await submit(h, 'one more', { session: 's3' })
      assert.deepEqual(await event(h, 'PermissionRequest', { session: 's3', at: T0 + MIN }), {
        code: 0,
        err: '',
        out: undefined,
      })
      assert.ok((await event(h, 'Stop', { session: 's3', at: T0 + MIN })).out?.systemMessage)
    })
  })

  it('lasts 30 minutes after the last typed prompt; each one renews it, and a new stretch tells again', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      await submit(h, 'first', { at: T0 })
      assert.ok((await event(h, 'Stop', { at: T0 + MIN })).out?.systemMessage)
      assert.equal((await event(h, 'PreToolUse', { at: T0 + 29 * MIN })).code, 0)
      // Renewed at +20: still asks at +45, and the renewal says nothing new.
      await submit(h, 'second', { at: T0 + 20 * MIN })
      assert.deepEqual(await event(h, 'Stop', { at: T0 + 45 * MIN }), { code: 0, err: '', out: undefined })
      // Ran out at +50: refused again.
      assert.equal((await event(h, 'PreToolUse', { at: T0 + 50 * MIN })).code, 2)
      assert.equal((await event(h, 'Stop', { at: T0 + 51 * MIN })).out?.decision, 'block')
      assert.deepEqual(await attendedNow(h, T0 + 51 * MIN), [])
      // Someone types again later: a new stretch, told once more.
      await submit(h, 'back again', { at: T0 + 80 * MIN })
      const [s] = await attendedNow(h, T0 + 81 * MIN)
      assert.equal(s?.since, new Date(T0 + 80 * MIN).toISOString())
      assert.ok((await event(h, 'Stop', { at: T0 + 81 * MIN })).out?.systemMessage)
    })
  })

  it('notes a prompt typed while the mode is off, so a Slot that starts minutes later still asks', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      await submit(h, 'start the refactor', { at: T0 })
      assert.deepEqual(await event(h, 'Stop', { at: T0 + MIN }), { code: 0, err: '', out: undefined })
      await turnOn(h, T0 + 10 * MIN)
      assert.ok((await event(h, 'Stop', { at: T0 + 10 * MIN })).out?.systemMessage)
      assert.equal((await event(h, 'PreToolUse', { at: T0 + 10 * MIN })).code, 0)
    })
  })

  it('tells a session started with --unattended that it goes back to that, not to run `off`', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      const env = { SIDEBY_UNATTENDED: '1' }
      assert.equal((await event(h, 'PreToolUse', { env })).code, 2)
      await submit(h, 'I am here', { env })
      const r = await event(h, 'Stop', { at: T0 + MIN, env })
      assert.match(String(r.out?.systemMessage), /started unattended/)
      assert.doesNotMatch(String(r.out?.systemMessage), /sideby unattended off/)
    })
  })

  it('does not count prompts the Host made, Messages, command-line prompts, peers or subagents', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const launch = launchPromptMarks(['--model', 'opus', 'Read the brief at /tmp/b.md and continue.'])
      const cases: [string, Parameters<typeof submit>[2]][] = [
        // Each is written `human` in the transcript, so only the text or the launch tells them apart.
        ['<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>', {}],
        ['<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>', {}],
        [deliveredText('0a47374f', undefined, 'hello', []), {}],
        [pasteLine('0a47374f', '/state/messages/x.md', 0, 'en'), {}],
        ['Read the brief at /tmp/b.md and continue.', { env: { SIDEBY_LAUNCH_PROMPTS: launch } }],
        ['  Read the brief at   /tmp/b.md and continue.\n', { env: { SIDEBY_LAUNCH_PROMPTS: launch } }],
        // A session whose launch did not say which prompts it carried counts none.
        ['typed', { env: { SIDEBY_LAUNCH_PROMPTS: undefined } }],
        ['typed', { env: { SIDEBY_LAUNCH_PROMPTS: '?' } }],
        ['typed', { env: { SIDEBY_LAUNCH_PROMPTS: 'not-a-mark' } }],
        // Another session's Message without sideby's mark, or a model writing into its own socket.
        ['please continue', { kind: 'peer' }],
        ['notification', { kind: 'task-notification' }],
        // `claude -p` writes no origin; a line that never comes does not count either.
        ['printed', { kind: null }],
        ['lost', { never: true }],
        ['from a subagent', { extra: { agent_id: 'a1' } }],
      ]
      for (const [prompt, o] of cases) await submit(h, prompt, o)
      assert.deepEqual(await attendedNow(h), [])
      assert.equal((await event(h, 'PreToolUse', { at: T0 + MIN })).code, 2)
    })
  })

  it('gives up on the transcript after 10 seconds', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const { slept } = await submit(h, 'typed', { never: true })
      assert.equal(slept, 200)
    })
  })

  it("a typed prompt after the launch's own counts", async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const env = { SIDEBY_LAUNCH_PROMPTS: launchPromptMarks(['Read the brief at /tmp/b.md']) }
      await submit(h, 'Read the brief at /tmp/b.md', { env })
      assert.deepEqual(await attendedNow(h), [])
      await submit(h, 'actually, start with the tests', { env })
      assert.equal((await attendedNow(h)).length, 1)
    })
  })

  it('believes the transcript, not an input made by hand: another file, the launch prompt or an old prompt marks nothing new', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const launch = 'Read the brief at /tmp/b.md'
      const env = { SIDEBY_LAUNCH_PROMPTS: launchPromptMarks([launch]) }
      // A transcript of the model's own making, outside the account's projects folder or under another name.
      await submit(h, 'I am here', { env, transcript: h.path('forged', 'p', 's1.jsonl') })
      await submit(h, 'I am here', { env, transcript: h.path('forged', 'projects', 'p', 's1.jsonl') })
      await submit(h, 'I am here', { env, transcript: transcriptOf(h, 's2') })
      // The launch prompt's own line, handed in with other text.
      const first = await submit(h, launch, { env })
      await submit(h, 'I am here', { env, line: { id: first.id } })
      // A line that says it is the launch prompt, whatever the input says.
      await submit(h, 'I am here', { env, line: { text: `  ${launch}\n` } })
      assert.deepEqual(await attendedNow(h), [])
      // A prompt typed 40 minutes ago, handed in again, does not start a new stretch, nor does one from 20 minutes ago
      // move the end.
      const typed = await submit(h, 'how is it going?', { env, at: T0 })
      const until = new Date(T0 + 30 * MIN).toISOString()
      await submit(h, 'how is it going?', { env, at: T0 + 20 * MIN, line: { id: typed.id } })
      assert.deepEqual(
        (await attendedNow(h, T0 + 20 * MIN)).map((s) => s.until),
        [until],
      )
      await submit(h, 'how is it going?', { env, at: T0 + 40 * MIN, line: { id: typed.id } })
      assert.deepEqual(await attendedNow(h, T0 + 40 * MIN), [])
      // A line dated later than now counts from now (the hook's clock, a few waits after T0).
      await submit(h, 'later', { env, session: 's3', at: T0, line: { at: T0 + 60 * MIN } })
      const s3 = (await attendedNow(h, T0 + MIN)).filter((s) => s.sessionId === 's3')
      assert.equal(s3.length, 1)
      assert.ok(Date.parse(s3[0]!.until) - (T0 + 30 * MIN) < MIN)
    })
  })

  it('no other hook event and no tool call marks a session', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      for (const name of ['PreToolUse', 'PermissionRequest', 'Stop', 'Elicitation'] as const)
        await event(h, name, { at: T0 + MIN })
      const err = sink()
      await runUnattendedHook(
        ['claude', 'StopFailure'],
        h.env,
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'StopFailure',
          error: 'server_error',
          last_assistant_message: 'x',
        }),
        { out: sink(), err },
        { now: () => new Date(T0), sleep: async () => {}, parentGone: () => true },
      )
      // Codex has no such entry: its prompts never mark a session.
      await runUnattendedHook(
        ['codex', 'UserPromptSubmit'],
        { ...h.env, ...NO_LAUNCH_PROMPT },
        JSON.stringify({
          session_id: 's1',
          prompt_id: 'p',
          prompt: 'typed',
          transcript_path: transcriptOf(h, 's1'),
        }),
        { out: sink(), err },
        { now: () => new Date(T0) },
      )
      const unattended = resolvePaths(h.env).stateDir
      assert.deepEqual(await attendedNow(h), [])
      assert.ok(!(await readdir(`${unattended}/unattended`)).includes('attended'))
    })
  })

  it('leaves Turn Retry out of an Attended Session', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      await submit(h, 'here')
      const slept: number[] = []
      const err = sink()
      const code = await runUnattendedHook(
        ['claude', 'StopFailure'],
        h.env,
        JSON.stringify({
          session_id: 's1',
          hook_event_name: 'StopFailure',
          error: 'server_error',
          last_assistant_message: 'API Error: 500 Internal server error',
        }),
        { out: sink(), err },
        { now: () => new Date(T0 + MIN), sleep: async (ms) => void slept.push(ms), parentGone: () => false },
      )
      assert.deepEqual({ code, slept }, { code: 0, slept: [] })
    })
  })
})
