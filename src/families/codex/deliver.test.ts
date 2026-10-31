// Delivering a Message to a Codex session through `codex queue` (spec §3.32 step 4). `runCodex` is replaced, so no
// test starts Codex or looks at the machine's real processes or sessions.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, withFakeHome } from '../../../testing/index.ts'
import type { LiveSessionDeps, ProcessInfo } from '../../core/live-sessions-procs.ts'
import { type MessageDeps, sendMessage } from '../../core/messages.ts'
import { createRuntime } from '../../runtime.ts'
import { CodexQueueTimeout, runCodex } from './deliver.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const ID_T = '01a15823-5555-4555-8555-555555555555'
const SECRET = 'fake-SECRET-value-must-not-appear'
const TEXT = 'Please review the plan in docs/plan.md'

const proc = (pid: number, command: string): ProcessInfo => ({ pid, ppid: 1, startMs: START, command })
const rollout = (id: string, cwd: string) =>
  `${JSON.stringify({ timestamp: '2026-10-20T06:11:32.141Z', type: 'session_meta', payload: { id, timestamp: '2026-10-20T06:11:32.141Z', cwd } })}\n`

/** codex:team runs session T and holds its rollout open; `open: false` leaves only a guess. */
async function machine(h: FakeHome, open = true): Promise<LiveSessionDeps> {
  await h.write('.codex/config.toml', 'model = "m"\n')
  await h.write('.codex/auth.json', `{"token":"${SECRET}"}`)
  await h.write('.codex-team/config.toml', 'model = "m"\n')
  await h.write('.codex-team/auth.json', `{"token":"${SECRET}"}`)
  const file = await h.write(
    `.codex-team/sessions/2026/10/20/rollout-2026-10-20T10-00-00-${ID_T}.jsonl`,
    rollout(ID_T, '/work/t'),
  )
  return {
    processes: async () => [proc(702, 'codex')],
    envVar: async (pid, name) => (pid === 702 && name === 'CODEX_HOME' ? h.path('.codex-team') : undefined),
    openFiles: async (pid) => (open && pid === 702 ? [file] : []),
  }
}

function recorder(code: number | Error) {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  const deps: Partial<MessageDeps> = {
    selfPid: 999_999,
    runCodex: async (args, env) => {
      calls.push({ args, env })
      if (code instanceof Error) throw code
      return code
    },
  }
  return { calls, deps }
}

describe('sideby send to a Codex session', () => {
  it('queues the line that points at the kept Message, never its text, with the Account’s own Codex home', async () => {
    await withFakeHome(async (h) => {
      const procs = await machine(h)
      const rt = await createRuntime({ env: { ...h.env, OPENAI_API_KEY: 'x' } })
      const { calls, deps } = recorder(0)
      const r = await sendMessage(rt, ID_T, { text: TEXT }, { procs, ...deps })
      assert.equal(r.status, 'delivered')
      assert.match(r.note!, /^sent to .*; Codex reads it when its current turn ends$/)
      assert.equal(calls.length, 1)
      const { args, env } = calls[0]!
      assert.deepEqual(args, [
        '-c',
        'cli_auth_credentials_store="file"',
        'queue',
        '--thread',
        ID_T,
        '--message',
        r.pasteText,
      ])
      assert.match(r.pasteText, new RegExp(`sideby message ${r.id}`))
      assert.ok(!args.join(' ').includes(TEXT))
      assert.equal(env.CODEX_HOME, h.path('.codex-team'))
      // A Hijack Variable does not reach the queue process.
      assert.equal(env.OPENAI_API_KEY, undefined)
      assert.match(await fsp.readFile(r.file, 'utf8'), new RegExp(TEXT))
    })
  })

  it('hands the user a paste when Codex refuses, cannot start, or the session is only a guess', async () => {
    await withFakeHome(async (h) => {
      const procs = await machine(h)
      const rt = await createRuntime({ env: h.env })
      const refused = await sendMessage(rt, ID_T, { text: TEXT }, { procs, ...recorder(1).deps })
      assert.equal(refused.status, 'paste-needed')
      assert.match(refused.note!, /`codex queue` exited with 1; requires Codex 0\.163\+/)
      const missing = await sendMessage(
        rt,
        ID_T,
        { text: TEXT },
        { procs, ...recorder(new Error('Codex is not on PATH')).deps },
      )
      assert.equal(missing.status, 'paste-needed')
      assert.match(missing.note!, /could not send it to .* \(Codex is not on PATH\); paste the line/)
    })
    await withFakeHome(async (h) => {
      const procs = await machine(h, false)
      const rt = await createRuntime({ env: h.env })
      const { calls, deps } = recorder(0)
      const guessed = await sendMessage(rt, 'codex:team', { text: TEXT }, { procs, ...deps })
      assert.equal(guessed.status, 'paste-needed')
      assert.match(
        guessed.note!,
        /could not tell which codex:team session is running \(picked the newest one\)/,
      )
      assert.equal(calls.length, 0)
    })
    await withFakeHome(async (h) => {
      const procs = await machine(h)
      const real = await createRuntime({ env: h.env })
      // The Account is there while the session is picked, and gone by the time it is delivered.
      let asked = 0
      const rt = { ...real, accounts: async () => (asked++ ? [] : real.accounts()) }
      const { calls, deps } = recorder(0)
      const gone = await sendMessage(rt, ID_T, { text: TEXT }, { procs, ...deps })
      assert.equal(gone.status, 'paste-needed')
      assert.match(gone.note!, /account codex:team was not found/)
      assert.equal(calls.length, 0)
    })
    await withFakeHome(async (h) => {
      const procs = await machine(h)
      const rt = await createRuntime({ env: h.env })
      // The session is found, then its process ends before the line is queued.
      let looked = 0
      const ending = { ...procs, processes: async () => (looked++ ? [] : procs.processes()) }
      const { calls, deps } = recorder(0)
      const ended = await sendMessage(rt, ID_T, { text: TEXT }, { procs: ending, ...deps })
      assert.equal(ended.status, 'paste-needed')
      assert.match(ended.note!, /stopped running; start it again/)
      assert.equal(calls.length, 0)
    })
  })

  it('says it cannot confirm, without asking for a paste, when `codex queue` started and timed out', async () => {
    await withFakeHome(async (h) => {
      const procs = await machine(h)
      const rt = await createRuntime({ env: h.env })
      const slow = recorder(new CodexQueueTimeout('Codex did not answer in time'))
      const r = await sendMessage(rt, ID_T, { text: TEXT }, { procs, ...slow.deps })
      assert.equal(r.status, 'unknown')
      assert.match(r.note!, /could not confirm that .* got it: `codex queue` did not finish within 20 s\./)
      assert.match(r.note!, /check the session before you send it again$/)
      assert.doesNotMatch(r.note!, /paste|has ended/i)
      // The line is kept for later, and the receipt is saved as unknown.
      assert.match(r.pasteText, new RegExp(`sideby message ${r.id}`))
      const kept = JSON.parse(await fsp.readFile(r.file.replace(/\.md$/, '.json'), 'utf8'))
      assert.equal(kept.status, 'unknown')
      // The session ended while Codex was asked: still unknown, and the note says so.
      let gone = false
      const ending = { ...procs, processes: async () => (gone ? [] : procs.processes()) }
      const ended = await sendMessage(
        rt,
        ID_T,
        { text: TEXT },
        {
          procs: ending,
          selfPid: 999_999,
          runCodex: async () => {
            gone = true
            throw new CodexQueueTimeout('Codex did not answer in time')
          },
        },
      )
      assert.equal(ended.status, 'unknown')
      assert.match(ended.note!, /The session has ended since\./)
    })
  })

  it('tells a queue that started and hung from one that could not start', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'codex', { sleep: 5 })
      await assert.rejects(runCodex(['queue'], h.env, 300), (e) => e instanceof CodexQueueTimeout)
      const empty = await h.mkdir('empty-bin')
      await assert.rejects(
        runCodex(['queue'], { ...h.env, PATH: empty }, 300),
        (e) => !(e instanceof CodexQueueTimeout) && /Codex is not on PATH/.test((e as Error).message),
      )
      await fakeHost(h, 'codex', { exitCode: 3 })
      assert.equal(await runCodex(['queue'], h.env, 5000), 3)
    })
  })
})
