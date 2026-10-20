// Live Sessions where something does not add up (spec §3.32): an environment that cannot be read, a start time that
// cannot be checked, a prompt that looks like a subcommand, a neighbouring directory, an unreadable session folder,
// a clipboard program that misbehaves, and a title check that is still running when the Host ends.
import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { listLiveSessions } from './live-sessions.ts'
import { copyToClipboard } from './live-sessions-copy.ts'
import type { LiveSessionDeps, ProcessInfo } from './live-sessions-procs.ts'
import { watchSessionTitle } from './live-sessions-title.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const ID1 = '61230c3d-1111-4111-8111-111111111111'
const ID2 = '0799701d-2222-4222-8222-222222222222'
const ID3 = '01a157ef-4444-4444-8444-444444444444'

const proc = (pid: number, command: string, ppid = 1): ProcessInfo => ({ pid, ppid, startMs: START, command })

function deps(
  procs: ProcessInfo[],
  env: Record<number, Record<string, string> | 'unreadable'> = {},
  open: Record<number, string[]> = {},
): LiveSessionDeps {
  return {
    processes: async () => procs,
    envVar: async (pid, name) => {
      const e = env[pid]
      if (e === 'unreadable') throw new Error('the environment of this process cannot be read')
      return e?.[name]
    },
    openFiles: async (pid) => open[pid] ?? [],
  }
}

const rollout = (id: string, cwd: string) =>
  `${JSON.stringify({ type: 'session_meta', payload: { id, timestamp: '2026-10-20T06:11:32.141Z', cwd } })}\n`

async function codexHome(h: FakeHome) {
  await h.write('.codex/config.toml', 'model = "m"\n')
  await h.write('.codex-team/config.toml', 'model = "m"\n')
}

describe('Live Sessions: edge cases from review', () => {
  it('leaves out a process whose environment cannot be read instead of giving it to the Main Account', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      const open = await h.write(
        `.codex/sessions/2026/10/20/rollout-2026-10-20T14-11-32-${ID3}.jsonl`,
        rollout(ID3, '/w/c'),
      )
      await h.write(
        `.codex/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`,
        rollout(ID2, '/w/old'),
      )
      const rt = await createRuntime({ env: h.env })
      const r = await listLiveSessions(
        rt,
        { only: 'codex' },
        deps([proc(700, 'codex'), proc(701, 'codex')], { 700: {}, 701: 'unreadable' }, { 700: [open] }),
      )
      // codex:main keeps its own session; process 701 is reported once, not shown as a guess of either Account.
      assert.deepEqual(
        r.sessions.map((s) => [s.account, s.sessionId, s.guessed]),
        [['codex:main', ID3, false]],
      )
      assert.equal(r.problems.length, 1)
      assert.match(r.problems[0]!, /could not tell which account codex process 701 runs as/)
    })
  })

  it('leaves out a Claude or Grok record whose start time cannot be checked, and says so', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write(
        '.claude/sessions/111.json',
        JSON.stringify({ pid: 111, sessionId: ID1, procStart: 'invalid', cwd: '/w' }),
      )
      await h.write('.claude/sessions/112.json', JSON.stringify({ pid: 112, sessionId: ID2, cwd: '/w' }))
      await h.write(
        '.claude/sessions/113.json',
        JSON.stringify({ pid: 113, sessionId: ID3, procStart: PROC_START, cwd: '/w' }),
      )
      await h.mkdir('.grok/skills')
      await h.write(
        '.grok/active_sessions.json',
        JSON.stringify([{ session_id: ID1, pid: 555, cwd: '/w/g' }]),
      )
      const rt = await createRuntime({ env: h.env })
      const r = await listLiveSessions(
        rt,
        {},
        deps([proc(111, 'unrelated'), proc(112, 'unrelated'), proc(113, 'claude'), proc(555, 'unrelated')]),
      )
      assert.deepEqual(
        r.sessions.map((s) => s.sessionId),
        [ID3],
      )
      assert.equal(r.problems.length, 3)
      assert.ok(r.problems.some((p) => /111\.json has no start time .*leaves it out/.test(p)))
      assert.ok(r.problems.some((p) => /112\.json has no start time/.test(p)))
      assert.ok(
        r.problems.some((p) => /grok:main: an entry of .*active_sessions\.json has no start time/.test(p)),
      )
    })
  })

  it('reads only the Codex subcommand, not words of the prompt', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      const open = await h.write(
        `.codex/sessions/2026/10/20/rollout-2026-10-20T14-11-32-${ID3}.jsonl`,
        rollout(ID3, '/w/c'),
      )
      const rt = await createRuntime({ env: h.env })
      const run = (command: string) =>
        listLiveSessions(rt, { only: 'codex:main' }, deps([proc(700, command)], { 700: {} }, { 700: [open] }))
      assert.equal((await run('codex exec fix mcp tests')).sessions.length, 1)
      assert.equal((await run('codex -m mcp "fix the login page"')).sessions.length, 1)
      assert.equal((await run('codex -c model=x app-server --listen unix://')).sessions.length, 0)
      assert.equal((await run('node /opt/codex.js mcp-server')).sessions.length, 0)
    })
  })

  it("does not take a rollout in a neighbouring directory for the Account's session", async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write(
        `.codex/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`,
        rollout(ID2, '/w/old'),
      )
      const next = await h.write(
        `.codex/sessions-backup/rollout-2026-10-20T14-11-32-${ID3}.jsonl`,
        rollout(ID3, '/w/c'),
      )
      const rt = await createRuntime({ env: h.env })
      const r = await listLiveSessions(
        rt,
        { only: 'codex:main' },
        deps([proc(700, 'codex')], { 700: {} }, { 700: [next] }),
      )
      // The open file is outside sessions/, so the Account's newest rollout is shown, as a guess.
      assert.deepEqual(
        r.sessions.map((s) => [s.sessionId, s.guessed]),
        [[ID2, true]],
      )
    })
  })

  it('reports a session folder it cannot read instead of showing no session', async () => {
    if (process.getuid?.() === 0) return // root reads every folder
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write(
        `.codex/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`,
        rollout(ID2, '/w/old'),
      )
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.write(
        `.pi/agent/sessions/--w--/2026-10-09_${ID1}.jsonl`,
        `${JSON.stringify({ type: 'session', id: ID1, cwd: '/w' })}\n`,
      )
      await chmod(h.path('.codex/sessions'), 0o000)
      await chmod(h.path('.pi/agent/sessions'), 0o000)
      try {
        const rt = await createRuntime({ env: h.env })
        const r = await listLiveSessions(
          rt,
          {},
          deps([proc(700, 'codex'), proc(800, 'pi')], { 700: {}, 800: {} }),
        )
        assert.deepEqual(r.sessions, [])
        assert.ok(
          r.problems.some((p) => /^codex:main: could not read its sessions \(EACCES\)/.test(p)),
          r.problems.join('\n'),
        )
        assert.ok(
          r.problems.some((p) => /^pi:main: could not read its sessions \(EACCES\)/.test(p)),
          r.problems.join('\n'),
        )
      } finally {
        await chmod(h.path('.codex/sessions'), 0o755)
        await chmod(h.path('.pi/agent/sessions'), 0o755)
      }
    })
  })
})

describe('clipboard programs that misbehave', () => {
  const script = (body: string) => `#!${process.execPath}\n${body}\n`

  it('survives a program that closes its input early, and tries the next one', async () => {
    await withFakeHome(async (h) => {
      await writeFile(join(h.bin, 'xclip'), script('process.exit(0)'), { mode: 0o755 })
      await writeFile(
        join(h.bin, 'wl-copy'),
        script(
          `let n=0;process.stdin.on('data',(c)=>n+=c.length).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(join(h.bin, 'n'))},String(n)))`,
        ),
        { mode: 0o755 },
      )
      const text = 'x'.repeat(8 * 1024 * 1024)
      // xclip closes its input without reading: EPIPE must not end sideby; wl-copy then gets the text.
      assert.equal(await copyToClipboard(text, { PATH: h.bin }, 'linux'), 'wl-copy')
    })
  })

  it('gives up on a program that hangs, within the timeout', { timeout: 10_000 }, async () => {
    await withFakeHome(async (h) => {
      await writeFile(join(h.bin, 'pbcopy'), script('setInterval(() => {}, 1000)'), { mode: 0o755 })
      const t = Date.now()
      assert.equal(await copyToClipboard('hello', { PATH: h.bin }, 'darwin', 300), null)
      assert.ok(Date.now() - t < 3000)
    })
  })
})

describe('title checks end with the Host', () => {
  const account = (h: FakeHome): Account => ({
    family: 'claude',
    name: '002',
    ref: 'claude:002',
    dir: h.path('.claude-002'),
    isMain: false,
    kind: 'subscription',
  })

  it('stopping ends a check still running', async () => {
    await withFakeHome(async (h) => {
      let seen: AbortSignal | undefined
      const hanging: LiveSessionDeps = {
        processes: (signal) =>
          new Promise((_, reject) => {
            seen = signal
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
        envVar: async () => undefined,
        openFiles: async () => [],
      }
      const stop = watchSessionTitle({
        account: account(h),
        accountLabel: 'cc002',
        pid: 901,
        deps: hanging,
        write: () => {},
        firstMs: 1,
        everyMs: 1000,
      })
      await new Promise((r) => setTimeout(r, 30))
      stop()
      assert.ok(seen, 'the check did not get a signal to stop it')
      assert.equal(seen.aborted, true)
    })
  })

  it('a check that never answers does not block the next one', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.claude-002/sessions/901.json',
        JSON.stringify({ pid: 901, sessionId: ID1, name: 'knip cleanup', procStart: PROC_START }),
      )
      let calls = 0
      const firstHangs: LiveSessionDeps = {
        // The first `ps` never returns and ignores the signal; later ones answer.
        processes: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve([proc(901, 'claude')])),
        envVar: async () => undefined,
        openFiles: async () => [],
      }
      const written: string[] = []
      const stop = watchSessionTitle({
        account: account(h),
        accountLabel: 'cc002',
        pid: 901,
        deps: firstHangs,
        write: (t) => written.push(t),
        firstMs: 1,
        everyMs: 20,
        deadlineMs: 30,
      })
      try {
        await new Promise((r) => setTimeout(r, 200))
      } finally {
        stop()
      }
      assert.deepEqual(written, ['[cc002 · knip cleanup · 61230c3d]'])
    })
  })
})
