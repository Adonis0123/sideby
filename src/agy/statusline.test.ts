// WHY: ADR-0088 tests for `sideby agy-statusline` and `sideby agy-title` (leaf-only imports, ancestor PID resolution,
// non-credential atomic writes, dead-PID pruning, symlink safety, recursion guard, and stdin-only wrapping).
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withFakeHome } from '../../testing/index.ts'
import type { Env } from '../types.ts'
import {
  AGY_HELPER_ACTIVE_VAR,
  AGY_LAUNCH_PID_VAR,
  AGY_LIVE_DIR,
  AGY_ORIG_FLAG,
  type AgyHelperDeps,
  formatAgyLabel,
  type HelperProc,
  runAgyHelper,
} from './statusline.ts'

const START = Date.UTC(2026, 10, 26, 10, 0, 0)
const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e'

async function invoke(
  mode: 'statusline' | 'title',
  argv: string[],
  env: Env,
  input: string,
  deps: AgyHelperDeps = {},
) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  stdout.on('data', (c: Buffer) => out.push(c))
  const code = await runAgyHelper(mode, argv, env, Readable.from([Buffer.from(input)]), stdout, stderr, deps)
  return { code, stdout: Buffer.concat(out).toString('utf8') }
}

describe('agy statusline & title helper (ADR-0088)', () => {
  it('keeps imports leaf-only, resolves owning agy via ancestor walk, writes only non-credential fields, prunes dead pids and rejects symlinks', async () => {
    const src = await readFile(fileURLToPath(new URL('./statusline.ts', import.meta.url)), 'utf8')
    assert.doesNotMatch(src, /from ['"].*(runtime|families\/|core\/accounts|core\/launch)/)

    await withFakeHome(async (h) => {
      const stateDir = h.path('.local/state/sideby')
      await h.write(`.local/state/sideby/${AGY_LIVE_DIR}/9999.json`, '{"version":1,"pid":9999}\n', 0o600)
      const procs: HelperProc[] = [
        { pid: 1000, ppid: 1, startMs: START - 5000, command: 'node sideby run agy:main' },
        { pid: 2000, ppid: 1000, startMs: START, command: '/usr/local/bin/agy --settings /tmp/s.json' },
        { pid: 3000, ppid: 2000, startMs: START + 1000, command: '/bin/sh -c sideby agy-statusline' },
        { pid: 4000, ppid: 3000, startMs: START + 2000, command: 'node sideby agy-statusline' },
      ]
      const payload = JSON.stringify({
        conversation_id: CONV,
        conversation_title: 'Fix login redirect',
        agent_state: 'reviewing',
        cwd: '/work/app',
        transcript_path: '/work/secret-transcript.jsonl',
        email: 'me@example.com',
        plan_tier: 'pro',
        access_token: 'secret-token-must-never-be-written',
      })
      const r = await invoke(
        'statusline',
        [],
        { ...h.env, SIDEBY_LABEL: 'agy:main', [AGY_LAUNCH_PID_VAR]: '1000' },
        payload,
        {
          selfPid: 4000,
          now: () => new Date('2026-11-26T10:05:00.000Z'),
          listProcs: async () => procs,
        },
      )
      assert.equal(r.code, 0)
      assert.equal(r.stdout, 'agy:main · Fix login redirect · 0f8fad5b\n')

      const file = join(stateDir, AGY_LIVE_DIR, '2000.json')
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(join(stateDir, AGY_LIVE_DIR))).mode & 0o777, 0o700)
      const saved = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(saved, {
        version: 1,
        pid: 2000,
        procStart: START,
        conversationId: CONV,
        title: 'Fix login redirect',
        agentState: 'reviewing',
        cwd: '/work/app',
        updatedAt: '2026-11-26T10:05:00.000Z',
      })
      assert.doesNotMatch(JSON.stringify(saved), /example\.com|plan_tier|secret-token|transcript/)
      await assert.rejects(lstat(join(stateDir, AGY_LIVE_DIR, '9999.json')))

      const target = await h.write('outside.json', 'keep-me')
      await symlink(target, join(stateDir, AGY_LIVE_DIR, '2001.json'))
      const procsSym: HelperProc[] = [
        { pid: 2001, ppid: 1, startMs: START, command: 'agy' },
        { pid: 4001, ppid: 2001, startMs: START + 1000, command: 'node sideby agy-statusline' },
      ]
      await invoke('statusline', [], h.env, payload, {
        selfPid: 4001,
        listProcs: async () => procsSym,
      })
      assert.equal(await readFile(target, 'utf8'), 'keep-me')
    })
  })

  it('wraps user statusLine/title commands via stdin only, enforces recursion guard, and handles failures gracefully', async () => {
    await withFakeHome(async (h) => {
      const seen: { cmd: string; input: string; active: string | undefined }[] = []
      const payload = JSON.stringify({
        conversation_id: CONV,
        conversation_title: '$(touch /tmp/pwned); `echo bad`',
        cwd: '/work/repo',
      })
      const origCmd = 'my-custom-bar --flag'
      const origArg = [AGY_ORIG_FLAG, Buffer.from(origCmd, 'utf8').toString('base64')]

      const r = await invoke('statusline', origArg, { ...h.env, SIDEBY_LABEL: 'agy:main' }, payload, {
        listProcs: async () => [],
        runOrig: async (cmd, input, env) => {
          seen.push({ cmd, input: input.toString('utf8'), active: env[AGY_HELPER_ACTIVE_VAR] })
          return { code: 0, stdout: 'custom-bar\n' }
        },
      })
      assert.equal(r.code, 0)
      assert.equal(seen.length, 1)
      assert.equal(seen[0]!.cmd, origCmd)
      assert.equal(seen[0]!.input, payload)
      assert.equal(r.stdout, 'custom-bar · agy:main · $(touch /tmp/pwned); `echo bad` · 0f8fad5b\n')

      const guarded = await invoke(
        'statusline',
        origArg,
        { ...h.env, SIDEBY_LABEL: 'agy:main', [AGY_HELPER_ACTIVE_VAR]: '1' },
        payload,
        {
          listProcs: async () => [],
          runOrig: async () => {
            throw new Error('must not run under recursion guard')
          },
        },
      )
      assert.equal(guarded.code, 0)
      assert.equal(guarded.stdout, 'agy:main · $(touch /tmp/pwned); `echo bad` · 0f8fad5b\n')

      const titleWrapped = await invoke('title', origArg, { ...h.env, SIDEBY_LABEL: 'agy:main' }, payload, {
        listProcs: async () => [],
        runOrig: async () => ({ code: 0, stdout: 'my title\nsecond' }),
      })
      assert.equal(
        titleWrapped.stdout,
        'my title second · agy:main · $(touch /tmp/pwned); `echo bad` · 0f8fad5b\n',
      )
    })
  })

  it('formats labels with workspace fallback and renders bracketed title when unwrapped', async () => {
    assert.equal(
      formatAgyLabel('agy:main', undefined, '/work/my-repo', CONV),
      'agy:main · my-repo · 0f8fad5b',
    )
    assert.equal(
      formatAgyLabel('agy:main', 'Title\x07\x1b', '/work/my-repo', CONV),
      'agy:main · Title · 0f8fad5b',
    )
    await withFakeHome(async (h) => {
      await mkdir(h.path('.local/state/sideby'), { recursive: true })
      const r = await invoke(
        'title',
        [],
        { ...h.env, SIDEBY_LABEL: 'agy:main' },
        JSON.stringify({ conversation_id: CONV, cwd: '/work/demo' }),
        { listProcs: async () => [] },
      )
      assert.equal(r.code, 0)
      assert.equal(r.stdout, '[agy:main · demo · 0f8fad5b]\n')
    })
  })

  it('kills SIGTERM-ignoring original commands and their shell descendants with SIGKILL before returning (ADR-0088)', async () => {
    if (process.platform === 'win32') return
    await withFakeHome(async (h) => {
      const pidFile = h.path('shell.pid')
      const childPidFile = h.path('child.pid')
      const cmd = `trap '' TERM; echo $$ > '${pidFile}'; sleep 30 & echo $! > '${childPidFile}'; wait`
      const origArg = [AGY_ORIG_FLAG, Buffer.from(cmd, 'utf8').toString('base64')]
      const r = await invoke(
        'statusline',
        origArg,
        { ...h.env, SIDEBY_LABEL: 'agy:main' },
        JSON.stringify({ conversation_id: CONV, conversation_title: 'Timeout check' }),
        { listProcs: async () => [], origTimeoutMs: 80, origKillGraceMs: 80 },
      )
      assert.equal(r.code, 0)
      assert.equal(r.stdout, 'agy:main · Timeout check · 0f8fad5b\n')

      const shellPid = Number((await readFile(pidFile, 'utf8')).trim())
      const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
      assert.ok(Number.isInteger(shellPid) && shellPid > 1)
      assert.ok(Number.isInteger(childPid) && childPid > 1)
      for (const pid of [shellPid, childPid]) {
        assert.throws(
          () => process.kill(pid, 0),
          (err: NodeJS.ErrnoException) => err.code === 'ESRCH',
        )
      }
    })
  })
})
