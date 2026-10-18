// Start at login (spec §3.29, ADR-0029): the LaunchAgent sideby writes, its states and its refusals. Every launchctl
// call goes to an injected exec; the real one never runs.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  AUTOSTART_MARKER,
  type AutostartContext,
  applyAutostart,
  autostartPath,
  autostartStatus,
  parseProgramArguments,
  planAutostart,
  plistContent,
  refreshAutostart,
} from './autostart.ts'

// Paths that exist outside any temporary folder; only their existence is checked.
const LAUNCHER = { node: '/bin/sh', entry: '/usr/bin/env' }
const OTHER = { node: '/bin/sh', entry: '/bin/ls' }

function recorder() {
  const calls: string[][] = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args])
    return { code: 0, output: '' }
  }
  return { calls, exec }
}

const ctxFor = (home: string, extra: Partial<AutostartContext> = {}): AutostartContext => ({
  home,
  platform: 'darwin',
  launcher: LAUNCHER,
  uid: 501,
  loginHome: home,
  ...extra,
})

describe('autostart', () => {
  it('is off without a file, and `on` plans the plist and the bootstrap without writing', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      const ctx = ctxFor(h.home, { exec })
      assert.equal((await autostartStatus(ctx)).state, 'off')
      const plan = await planAutostart(ctx, 'on')
      assert.equal(plan.changed, true)
      assert.equal(plan.blocked, undefined)
      assert.deepEqual(plan.programArguments, ['/bin/sh', '/usr/bin/env', 'ui', '--background', '--no-open'])
      assert.deepEqual(plan.commands, [['launchctl', 'bootstrap', 'gui/501', autostartPath(h.home)]])
      assert.match(plan.content!, /<key>RunAtLoad<\/key>\s*<true\/>/)
      assert.match(plan.content!, /<key>KeepAlive<\/key>\s*<false\/>/)
      assert.ok(plan.content!.includes(AUTOSTART_MARKER))
      assert.equal(await stat(autostartPath(h.home)).catch(() => null), null)
      assert.deepEqual(calls, [])
    })
  })

  it('writes the plist with mode 644, loads it, reports on, and off unloads and removes it', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      const ctx = ctxFor(h.home, { exec })
      const r = await applyAutostart(ctx, await planAutostart(ctx, 'on'))
      assert.equal(r.state, 'on')
      assert.equal(r.loaded, true)
      const path = autostartPath(h.home)
      assert.equal((await stat(path)).mode & 0o777, 0o644)
      assert.deepEqual(parseProgramArguments(await readFile(path, 'utf8')), [
        '/bin/sh',
        '/usr/bin/env',
        'ui',
        '--background',
        '--no-open',
      ])
      assert.deepEqual(calls, [['launchctl', 'bootstrap', 'gui/501', path]])
      const s = await autostartStatus(ctx)
      assert.equal(s.state, 'on')
      assert.equal(s.current, true)
      const again = await planAutostart(ctx, 'on')
      assert.equal(again.changed, false)
      calls.length = 0
      const off = await applyAutostart(ctx, await planAutostart(ctx, 'off'))
      assert.equal(off.state, 'off')
      assert.deepEqual(calls, [['launchctl', 'bootout', 'gui/501/dev.sideby.panel']])
      assert.equal(await stat(path).catch(() => null), null)
      assert.equal((await planAutostart(ctx, 'off')).changed, false)
    })
  })

  it('reports a file without the marker as foreign and never touches it', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      const ctx = ctxFor(h.home, { exec })
      const path = await h.write(
        'Library/LaunchAgents/dev.sideby.panel.plist',
        '<plist>mine</plist>\n',
        0o644,
      )
      assert.equal((await autostartStatus(ctx)).state, 'foreign')
      for (const action of ['on', 'off'] as const) {
        const plan = await planAutostart(ctx, action)
        assert.equal(plan.blocked?.code, 'foreign')
        await assert.rejects(applyAutostart(ctx, plan), /not written by sideby/)
      }
      assert.equal(await readFile(path, 'utf8'), '<plist>mine</plist>\n')
      assert.equal((await refreshAutostart(ctx)).rewritten, false)
      assert.equal(await readFile(path, 'utf8'), '<plist>mine</plist>\n')
      assert.deepEqual(calls, [])
    })
  })

  it('reports stale when a recorded path is gone, and `on` rewrites it after unloading the old one', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      const gone = h.path('gone', 'main.js')
      const old = { node: '/bin/sh', entry: gone }
      // Written as an older sideby would have, from a folder that no longer exists.
      await h.write(
        'Library/LaunchAgents/dev.sideby.panel.plist',
        plistContent(['/bin/sh', old.entry, 'ui', '--background', '--no-open']),
        0o644,
      )
      const ctx = ctxFor(h.home, { exec })
      const s = await autostartStatus(ctx)
      assert.equal(s.state, 'stale')
      assert.deepEqual(s.missing, [gone])
      const plan = await planAutostart(ctx, 'on')
      assert.deepEqual(plan.commands[0], ['launchctl', 'bootout', 'gui/501/dev.sideby.panel'])
      await applyAutostart(ctx, plan)
      assert.equal((await autostartStatus(ctx)).state, 'on')
      assert.equal(calls.length, 2)
    })
  })

  it('refresh rewrites an existing agent to point at the sideby in use, and never creates one', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      assert.deepEqual(await refreshAutostart(ctxFor(h.home, { exec })), { rewritten: false, state: 'off' })
      assert.equal(await stat(autostartPath(h.home)).catch(() => null), null)
      const first = ctxFor(h.home, { exec, launcher: OTHER })
      await applyAutostart(first, await planAutostart(first, 'on'))
      const ctx = ctxFor(h.home, { exec })
      assert.equal((await autostartStatus(ctx)).current, false)
      assert.equal((await refreshAutostart(ctx)).rewritten, true)
      assert.equal((await autostartStatus(ctx)).current, true)
      assert.equal(calls.filter((c) => c[1] === 'bootstrap').length, 2)
    })
  })

  it('refuses an entry in the npx cache or a temporary folder, a path with control characters, and other systems', async () => {
    await withFakeHome(async (h) => {
      const cases: [Partial<AutostartContext>, string][] = [
        [
          { launcher: { node: '/bin/sh', entry: '/opt/npm/_npx/abc/node_modules/sideby/main.js' } },
          'npx-cache',
        ],
        [{ launcher: { node: '/bin/sh', entry: '/tmp/sideby/main.js' } }, 'temp-dir'],
        [{ launcher: { node: '/bin/sh', entry: '/opt/side\nby/main.js' } }, 'unsafe-path'],
        [{ platform: 'linux' }, 'unsupported'],
      ]
      for (const [extra, code] of cases) {
        const plan = await planAutostart(ctxFor(h.home, extra), 'on')
        assert.equal(plan.blocked?.code, code, code)
        assert.match(plan.blocked!.message, code === 'unsupported' ? /macOS only/ : /npm i -g sideby/)
      }
      const linux = await autostartStatus(ctxFor(h.home, { platform: 'linux' }))
      assert.equal(linux.supported, false)
      assert.equal(await stat(autostartPath(h.home)).catch(() => null), null)
    })
  })

  it('does not run launchctl for a HOME that is not the login home, and says so', async () => {
    await withFakeHome(async (h) => {
      const { calls, exec } = recorder()
      const ctx = ctxFor(h.home, { exec, loginHome: '/Users/someone-else' })
      const r = await applyAutostart(ctx, await planAutostart(ctx, 'on'))
      assert.equal(r.loaded, false)
      assert.match(r.note!, /not your login home/)
      assert.deepEqual(calls, [])
    })
  })

  it('refuses to apply when the file changed after the plan', async () => {
    await withFakeHome(async (h) => {
      const { exec } = recorder()
      const ctx = ctxFor(h.home, { exec })
      const plan = await planAutostart(ctx, 'on')
      await h.write('Library/LaunchAgents/dev.sideby.panel.plist', 'someone else\n', 0o644)
      await assert.rejects(applyAutostart(ctx, plan), /changed since sideby looked at it/)
      assert.equal(await readFile(autostartPath(h.home), 'utf8'), 'someone else\n')
    })
  })

  it('escapes XML in paths', () => {
    const text = plistContent(['/opt/a&b<c>/node', '/x'])
    assert.ok(text.includes('/opt/a&amp;b&lt;c&gt;/node'))
    assert.deepEqual(parseProgramArguments(text), ['/opt/a&b<c>/node', '/x'])
  })
})
