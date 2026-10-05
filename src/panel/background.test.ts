// `sideby ui --background` / `--stop`: one detached Panel per state directory, Hosts found through the login
// shell's PATH, and a stop that only ever signals a verified sideby Panel. Real child processes, fake HOME.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, fakeHost, withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from '../core/paths.ts'
import { processStartTime } from './background.ts'
import { isSidebyPanel } from './server.ts'

const MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url))

function sideby(env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

const pidFile = (h: FakeHome) => `${resolvePaths(h.env).stateDir}/panel.json`

async function readPid(h: FakeHome): Promise<{ pid: number; port: number; url: string } | undefined> {
  try {
    return JSON.parse(await readFile(pidFile(h), 'utf8'))
  } catch {
    return undefined
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('background panel', () => {
  it('starts detached, finds Hosts through the login shell, is reused, and stops', async () => {
    await withFakeHome(async (h) => {
      // claude lives where only the login shell's PATH reaches, like ~/.local/bin under Finder.
      await fakeHost(h, 'claude')
      const hostDir = await h.mkdir('.local/bin')
      const { rename } = await import('node:fs/promises')
      await rename(`${h.bin}/claude`, `${hostDir}/claude`)
      const shell = await h.write(
        'login-shell',
        `#!/bin/sh\necho "rc noise"\nPATH="${hostDir}:$PATH"; export PATH\n/bin/sh -c "$2"\n`,
        0o755,
      )
      const env = { ...(h.env as Record<string, string>), PATH: '/usr/bin:/bin', SHELL: shell }
      const port = 30000 + Math.floor(Math.random() * 20000)
      let pid: number | undefined
      try {
        const first = await sideby(env, ['ui', '--background', '--no-open', '--port', String(port)])
        assert.equal(first.code, 0, first.err)
        assert.match(first.out, /in the background; stop it with `sideby ui --stop`/)
        const rec = await readPid(h)
        assert.ok(rec, 'pid file written')
        pid = rec.pid
        assert.ok(first.out.includes(rec.url))
        assert.ok(await isSidebyPanel(rec.port))

        const state = (await (await fetch(`${rec.url}api/state`)).json()) as {
          families: { id: string; installed: boolean }[]
        }
        assert.equal(state.families.find((f) => f.id === 'claude')?.installed, true)
        const log = await readFile(`${resolvePaths(h.env).stateDir}/panel.log`, 'utf8')
        assert.match(log, /host PATH: from the login shell/)

        const second = await sideby(env, ['ui', '--background', '--no-open', '--port', String(port)])
        assert.equal(second.code, 0, second.err)
        assert.match(second.out, /already running at/)
        assert.ok(second.out.includes(rec.url))
        assert.equal((await readPid(h))?.pid, pid, 'no second server')

        const stop = await sideby(env, ['ui', '--stop'])
        assert.equal(stop.code, 0, stop.err)
        assert.match(stop.out, /stopped the background panel/)
        assert.equal(alive(pid), false)
        assert.equal(await readPid(h), undefined)
        assert.equal(await isSidebyPanel(rec.port), false)

        const again = await sideby(env, ['ui', '--stop'])
        assert.equal(again.code, 0)
        assert.match(again.out, /No background panel is running/)
      } finally {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      }
    })
  })

  it('starts only one server when two launches race (a double double-click)', async () => {
    await withFakeHome(async (h) => {
      const env = { ...(h.env as Record<string, string>), SHELL: '/bin/sh' }
      const port = 30000 + Math.floor(Math.random() * 20000)
      const args = ['ui', '--background', '--no-open', '--port', String(port)]
      let pid: number | undefined
      try {
        const [a, b] = await Promise.all([sideby(env, args), sideby(env, args)])
        assert.equal(a.code, 0, a.err)
        assert.equal(b.code, 0, b.err)
        const rec = await readPid(h)
        pid = rec?.pid
        assert.ok(rec)
        assert.ok(a.out.includes(rec.url) && b.out.includes(rec.url), `${a.out}\n${b.out}`)
        assert.equal([a.out, b.out].filter((o) => /already running/.test(o)).length, 1)
      } finally {
        await sideby(env, ['ui', '--stop'])
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      }
    })
  })

  it('never signals a reused pid or another detached panel, even when its command line matches', async () => {
    await withFakeHome(async (h) => {
      const env = { ...(h.env as Record<string, string>), SHELL: '/bin/sh' }
      const { mkdir } = await import('node:fs/promises')
      await mkdir(resolvePaths(h.env).stateDir, { recursive: true })
      // A stand-in that looks like a detached Panel to `ps` but serves nothing: what a reused pid can look like.
      const fake = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)', '--', 'ui', '--serve-detached', '--no-open', '--port', '1'],
        { stdio: 'ignore' },
      )
      let otherPid: number | undefined
      try {
        await new Promise((r) => fake.once('spawn', r))
        const start = await processStartTime(fake.pid!)
        assert.ok(start, 'ps reports a start time')
        const port = 30000 + Math.floor(Math.random() * 20000)
        const rec = { pid: fake.pid, port, url: `http://127.0.0.1:${port}/`, startedAt: '', instance: 'abc' }

        // Same pid and command line, different start time: the pid was reused.
        await writeFile(pidFile(h), JSON.stringify({ ...rec, processStart: 'Mon Jan  1 00:00:00 2001' }))
        let r = await sideby(env, ['ui', '--stop'])
        assert.equal(r.code, 0, r.err)
        assert.match(r.out, /removed a stale pid file/)
        assert.equal(alive(fake.pid!), true, 'not signalled')
        assert.equal(await readPid(h), undefined)

        // Right start time, but nothing on the port confirms the instance: still not signalled.
        await writeFile(pidFile(h), JSON.stringify({ ...rec, processStart: start }))
        r = await sideby(env, ['ui', '--stop'])
        assert.equal(alive(fake.pid!), true, 'not signalled')
        assert.equal(r.code, 1)
        assert.match(r.err, /does not answer/)

        // A real detached Panel of another state directory, named by this pid file with another instance id.
        const otherState = h.path('other-state')
        const otherEnv = { ...env, XDG_STATE_HOME: otherState }
        const started = await sideby(otherEnv, ['ui', '--background', '--no-open', '--port', String(port)])
        assert.equal(started.code, 0, started.err)
        const real = JSON.parse(await readFile(`${otherState}/sideby/panel.json`, 'utf8'))
        otherPid = real.pid
        assert.match(real.instance, /^[0-9a-f]{32}$/)
        await writeFile(pidFile(h), JSON.stringify({ ...real, instance: 'not-this-one' }))
        r = await sideby(env, ['ui', '--stop'])
        assert.equal(r.code, 0, r.err)
        assert.match(r.out, /removed a stale pid file/)
        assert.equal(alive(real.pid), true, 'the other panel keeps running')
        assert.ok(await isSidebyPanel(real.port))

        // Its own pid file still stops it.
        r = await sideby(otherEnv, ['ui', '--stop'])
        assert.equal(r.code, 0, r.err)
        assert.equal(alive(real.pid), false)
      } finally {
        fake.kill('SIGKILL')
        if (otherPid && alive(otherPid)) process.kill(otherPid, 'SIGKILL')
      }
    })
  })

  it('never signals a process that is not a sideby panel, and rejects --stop with other options', async () => {
    await withFakeHome(async (h) => {
      const env = h.env as Record<string, string>
      const { mkdir } = await import('node:fs/promises')
      await mkdir(resolvePaths(h.env).stateDir, { recursive: true })
      // This test process is alive but is no Panel: the pid file is stale and must only be removed.
      await writeFile(
        pidFile(h),
        JSON.stringify({ pid: process.pid, port: 1, url: 'http://127.0.0.1:1/', startedAt: '' }),
      )
      const r = await sideby(env, ['ui', '--stop'])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /removed a stale pid file/)
      assert.equal(await readPid(h), undefined)
      const bad = await sideby(env, ['ui', '--stop', '--background'])
      assert.equal(bad.code, 2)
    })
  })
})
