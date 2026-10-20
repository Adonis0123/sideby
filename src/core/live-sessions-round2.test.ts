// Review round 2 of Live Sessions (spec §3.32): arguments that look like environment variables, a quoted prompt that
// starts with a subcommand's name, programs that ignore SIGTERM, an overall deadline, parallel `lsof`, and read
// errors below the session folder.
import assert from 'node:assert/strict'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { codexSubcommand } from '../families/codex/live-sessions.ts'
import { createRuntime } from '../runtime.ts'
import { listLiveSessions } from './live-sessions.ts'
import { envFromPs, type LiveSessionDeps, type ProcessInfo, runProgram } from './live-sessions-procs.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const ID1 = '61230c3d-1111-4111-8111-111111111111'
const ID2 = '0799701d-2222-4222-8222-222222222222'
const ID3 = '01a157ef-4444-4444-8444-444444444444'
const proc = (pid: number, command: string): ProcessInfo => ({ pid, ppid: 1, startMs: START, command })
const rollout = (id: string, cwd: string) =>
  `${JSON.stringify({ type: 'session_meta', payload: { id, timestamp: '2026-10-20T06:11:32.141Z', cwd } })}\n`
const asRoot = process.getuid?.() === 0

async function codexHome(h: FakeHome) {
  await h.write('.codex/config.toml', 'model = "m"\n')
}

describe('environment, not arguments (macOS ps)', () => {
  const argv = 'codex exec ORCA_TERMINAL_HANDLE=term_other CODEX_HOME=/fake PATH=/bin HOME=/demo'

  it('reads only what follows the exact argv in the ps eww output', () => {
    const eww = `${argv} PATH=/usr/bin:/bin HOME=/Users/me TERM=xterm-256color\n`
    assert.equal(envFromPs(`${argv}\n`, eww, 'ORCA_TERMINAL_HANDLE'), undefined)
    assert.equal(envFromPs(`${argv}\n`, eww, 'CODEX_HOME'), undefined)
    assert.equal(envFromPs(`${argv}\n`, eww, 'HOME'), '/Users/me')
    const spaced = `${argv} PATH=/bin CODEX_HOME=/tmp/My Accounts/.codex-team ORCA_TERMINAL_HANDLE=term_real\n`
    assert.equal(envFromPs(argv, spaced, 'CODEX_HOME'), '/tmp/My Accounts/.codex-team')
    assert.equal(envFromPs(argv, spaced, 'ORCA_TERMINAL_HANDLE'), 'term_real')
  })

  it('treats the environment as unreadable when the eww output does not start with the argv', () => {
    // The process changed between the two calls, or one output was cut off.
    assert.throws(
      () => envFromPs('codex resume', 'codex exec PATH=/bin CODEX_HOME=/x', 'CODEX_HOME'),
      /cannot be read/,
    )
    // No environment shown at all (another user's process).
    assert.throws(() => envFromPs(argv, `${argv}\n`, 'CODEX_HOME'), /cannot be read/)
  })
})

describe('Codex subcommand', () => {
  it('does not take a flattened prompt for a subcommand, and reads exact argv when it has it', () => {
    // `codex "mcp integration needs fixing"` as ps shows it: one flat line.
    assert.equal(codexSubcommand(['mcp', 'integration', 'needs', 'fixing'], false), undefined)
    assert.equal(
      codexSubcommand(['-c', 'features.x=true', 'app-server', '--listen', 'unix://'], false),
      'app-server',
    )
    assert.equal(codexSubcommand(['mcp-server'], false), 'mcp-server')
    assert.equal(codexSubcommand(['exec', 'fix', 'mcp', 'tests'], false), 'exec')
    // From /proc/<pid>/cmdline the words are exact: one prompt argument is not a subcommand.
    assert.equal(codexSubcommand(['mcp integration needs fixing'], true), 'mcp integration needs fixing')
    assert.equal(codexSubcommand(['mcp', 'list'], true), 'mcp')
  })

  it('keeps a session whose prompt starts with a server word', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      const open = await h.write(
        `.codex/sessions/2026/10/20/rollout-2026-10-20T14-11-32-${ID3}.jsonl`,
        rollout(ID3, '/w'),
      )
      const rt = await createRuntime({ env: h.env })
      const deps: LiveSessionDeps = {
        processes: async () => [proc(700, 'codex mcp integration needs fixing')],
        envVar: async () => undefined,
        openFiles: async () => [open],
      }
      assert.equal((await listLiveSessions(rt, { only: 'codex' }, deps)).sessions.length, 1)
    })
  })
})

describe('time limits', () => {
  it('ends a program that ignores SIGTERM and always settles', { timeout: 10_000 }, async () => {
    await withFakeHome(async (h) => {
      const pidFile = join(h.bin, 'pid')
      const bin = join(h.bin, 'stubborn')
      await writeFile(
        bin,
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {})\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
        { mode: 0o755 },
      )
      const t = Date.now()
      await assert.rejects(
        runProgram(bin, [], h.env, undefined, { timeoutMs: 300, graceMs: 200 }),
        /did not answer/,
      )
      assert.ok(Date.now() - t < 1500, 'the promise did not settle at the timeout')
      const pid = Number(await readFile(pidFile, 'utf8'))
      await new Promise((r) => setTimeout(r, 600))
      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the program is still running after SIGKILL')
    })
  })

  it('returns what it has once the overall deadline passes, and says what is missing', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write('.claude/settings.json', '{}')
      await h.write(
        '.claude/sessions/111.json',
        JSON.stringify({ pid: 111, sessionId: ID1, procStart: PROC_START, cwd: '/w' }),
      )
      await h.write(`.codex/sessions/2026/10/20/rollout-2026-10-20T14-11-32-${ID3}.jsonl`, rollout(ID3, '/w'))
      const rt = await createRuntime({ env: h.env })
      const deps: LiveSessionDeps = {
        processes: async () => [proc(111, 'claude'), proc(700, 'codex')],
        envVar: async () => undefined,
        openFiles: () => new Promise(() => {}),
      }
      const t = Date.now()
      const r = await listLiveSessions(rt, { deadlineMs: 150 }, deps)
      assert.ok(Date.now() - t < 1000)
      assert.deepEqual(
        r.sessions.map((s) => s.sessionId),
        [ID1],
      )
      assert.ok(
        r.problems.some((p) => /stopped looking after 0\.15 s.*codex:main/.test(p)),
        r.problems.join('\n'),
      )
    })
  })

  it('asks lsof for several Codex processes at once', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write(`.codex/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`, rollout(ID2, '/w'))
      const rt = await createRuntime({ env: h.env })
      let running = 0
      let most = 0
      const deps: LiveSessionDeps = {
        processes: async () => [proc(700, 'codex'), proc(701, 'codex'), proc(702, 'codex')],
        envVar: async () => undefined,
        openFiles: async () => {
          most = Math.max(most, ++running)
          await new Promise((r) => setTimeout(r, 30))
          running--
          return []
        },
      }
      await listLiveSessions(rt, { only: 'codex' }, deps)
      assert.ok(most > 1, `lsof ran one at a time (${most})`)
    })
  })
})

describe('read errors below the session folder', { skip: asRoot }, () => {
  const deps = (command: string): LiveSessionDeps => ({
    processes: async () => [proc(700, command)],
    envVar: async () => undefined,
    openFiles: async () => [],
  })

  it('reports an unreadable Codex subfolder instead of showing no session', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write(`.codex/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`, rollout(ID2, '/w'))
      await chmod(h.path('.codex/sessions/2026'), 0o000)
      try {
        const rt = await createRuntime({ env: h.env })
        const r = await listLiveSessions(rt, { only: 'codex' }, deps('codex'))
        assert.deepEqual(r.sessions, [])
        assert.ok(
          r.problems.some((p) => /^codex:main: could not read its sessions \(EACCES\)/.test(p)),
          r.problems.join('\n'),
        )
      } finally {
        await chmod(h.path('.codex/sessions/2026'), 0o755)
      }
    })
  })

  it('reports a session file it cannot look at (Codex and pi)', async () => {
    await withFakeHome(async (h) => {
      await codexHome(h)
      await h.write(`.codex/sessions/2026/rollout-2026-10-19T10-00-00-${ID2}.jsonl`, rollout(ID2, '/w'))
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.write(
        `.pi/agent/sessions/--w--/2026-10-09_${ID1}.jsonl`,
        `${JSON.stringify({ type: 'session', id: ID1, cwd: '/w' })}\n`,
      )
      // Readable but not searchable: the names are listed, stat() fails with EACCES.
      await chmod(h.path('.codex/sessions/2026'), 0o444)
      await chmod(h.path('.pi/agent/sessions/--w--'), 0o444)
      try {
        const rt = await createRuntime({ env: h.env })
        const codex = await listLiveSessions(rt, { only: 'codex' }, deps('codex'))
        assert.ok(
          codex.problems.some((p) => /^codex:main: could not read .*rollout-.*EACCES/.test(p)),
          codex.problems.join('\n'),
        )
        const pi = await listLiveSessions(rt, { only: 'pi' }, deps('pi'))
        assert.ok(
          pi.problems.some((p) => /^pi:main: could not read .*\.jsonl.*EACCES/.test(p)),
          pi.problems.join('\n'),
        )
      } finally {
        await chmod(h.path('.codex/sessions/2026'), 0o755)
        await chmod(h.path('.pi/agent/sessions/--w--'), 0o755)
      }
    })
  })
})
