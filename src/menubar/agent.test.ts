// The Menu Bar Item's LaunchAgent (spec §3.31, ADR-0034): the file sideby writes, its states and its undo. Every
// launchctl call goes to an injected exec; the real one never runs.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { snapshot, withFakeHome } from '../../testing/index.ts'
import {
  type AutostartContext,
  applyAutostart,
  autostartStatus,
  PANEL_AGENT,
  parseProgramArguments,
  planAutostart,
  refreshAutostart,
} from '../core/autostart.ts'
import { MENUBAR_AGENT } from './agent.ts'
import { MENUBAR_SCRIPT } from './script.ts'

const LAUNCHER = { node: '/bin/sh', entry: '/usr/bin/env' }
const PLIST = 'Library/LaunchAgents/dev.sideby.menubar.plist'

/** The calls that change launchd; `print` only asks. */
const changes = (calls: string[][]) => calls.filter((c) => c[1] !== 'print')

function ctxFor(home: string, calls: string[][]): AutostartContext {
  const held = new Set<string>()
  return {
    home,
    sleep: async () => {},
    env: { PATH: '/opt/fake/bin:/usr/bin', XDG_STATE_HOME: '/fake/state' },
    platform: 'darwin',
    launcher: LAUNCHER,
    uid: 501,
    loginHome: home,
    // A fake launchctl that remembers what it holds: `print` exits 113 for a job it does not hold.
    exec: async (file, args) => {
      calls.push([file, ...args])
      const label = (args[1] ?? '').split('/').pop()!
      if (args[0] === 'print') return { code: held.has(label) ? 0 : 113, output: '' }
      if (args[0] === 'bootout') held.delete(label)
      if (args[0] === 'bootstrap')
        held.add(
          args[2]!
            .split('/')
            .pop()!
            .replace(/\.plist$/, ''),
        )
      return { code: 0, output: '' }
    },
  }
}

describe('menu bar LaunchAgent', () => {
  it('writes osascript with the whole script and this sideby, restarts only after a crash, and removes it', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const ctx = ctxFor(h.home, calls)
      const plan = await planAutostart(ctx, 'on', MENUBAR_AGENT)
      assert.equal(plan.changed, true)
      const r = await applyAutostart(ctx, plan, MENUBAR_AGENT)
      assert.equal(r.loaded, true)
      const content = await readFile(h.path(PLIST), 'utf8')
      assert.equal((await stat(h.path(PLIST))).mode & 0o777, 0o644)
      assert.match(content, /Written by `sideby menubar`/)
      assert.match(content, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
      assert.doesNotMatch(content, /AbandonProcessGroup/)
      // launchd's own PATH lacks most Hosts: the PATH and the XDG folders of whoever turned it on go along.
      assert.match(
        content,
        /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/fake\/bin:\/usr\/bin<\/string>\s*<key>XDG_STATE_HOME<\/key>\s*<string>\/fake\/state<\/string>\s*<\/dict>/,
      )
      assert.doesNotMatch(content, /XDG_CONFIG_HOME/)
      // The script survives the XML round trip unchanged, so `stale` and `current` compare like for like.
      assert.deepEqual(parseProgramArguments(content), [
        '/usr/bin/osascript',
        '-l',
        'JavaScript',
        '-e',
        MENUBAR_SCRIPT,
        LAUNCHER.node,
        LAUNCHER.entry,
      ])
      assert.deepEqual(changes(calls), [['launchctl', 'bootstrap', 'gui/501', h.path(PLIST)]])
      const status = await autostartStatus(ctx, MENUBAR_AGENT)
      assert.deepEqual([status.state, status.current], ['on', true])
      // The Panel's own login item is a separate file, untouched.
      assert.equal((await autostartStatus(ctx, PANEL_AGENT)).state, 'off')
      assert.equal((await planAutostart(ctx, 'on', MENUBAR_AGENT)).changed, false)

      calls.length = 0
      // The file is gone before bootout, which ends the whole job, the process running `off` included ("Hide").
      let fileAtBootout: boolean | null = null
      const watching = {
        ...ctx,
        exec: async (file: string, args: readonly string[]) => {
          fileAtBootout = await stat(h.path(PLIST)).then(
            () => true,
            () => false,
          )
          return ctx.exec!(file, args)
        },
      }
      await applyAutostart(watching, await planAutostart(watching, 'off', MENUBAR_AGENT), MENUBAR_AGENT)
      assert.equal(fileAtBootout, false)
      assert.deepEqual(changes(calls), [['launchctl', 'bootout', 'gui/501/dev.sideby.menubar']])
      assert.equal((await autostartStatus(ctx, MENUBAR_AGENT)).state, 'off')
    })
  })

  it('loads it again when the file is in place but launchd let it go, and only asks launchd otherwise', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const ctx = ctxFor(h.home, calls)
      await applyAutostart(ctx, await planAutostart(ctx, 'on', MENUBAR_AGENT), MENUBAR_AGENT)
      calls.length = 0
      // `launchctl print` exits 113 for a job launchd does not hold.
      const gone: AutostartContext = {
        ...ctx,
        exec: async (file, args) => {
          calls.push([file, ...args])
          return { code: args[0] === 'print' ? 113 : 0, output: '' }
        },
      }
      // On, but not running: the status says so, and `on` only loads it again.
      const s = await autostartStatus(gone, MENUBAR_AGENT)
      assert.deepEqual([s.state, s.loaded], ['on', false])
      assert.equal((await autostartStatus(ctx, MENUBAR_AGENT)).loaded, true)
      // The Panel's login item exits once the Panel runs, so whether launchd holds it says nothing; it is not asked.
      assert.equal((await autostartStatus(gone, PANEL_AGENT)).loaded, undefined)
      const plan = await planAutostart(gone, 'on', MENUBAR_AGENT)
      assert.equal(plan.changed, true)
      assert.deepEqual(plan.commands, [['launchctl', 'bootstrap', 'gui/501', h.path(PLIST)]])
      const before = await readFile(h.path(PLIST), 'utf8')
      const r = await applyAutostart(gone, plan, MENUBAR_AGENT)
      assert.equal(r.loaded, true)
      assert.equal(await readFile(h.path(PLIST), 'utf8'), before)
      assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', h.path(PLIST)])
      // A HOME that is not the login home never asks launchd, so it never plans a load.
      calls.length = 0
      const demo = { ...gone, loginHome: '/some/other/home' }
      assert.equal((await planAutostart(demo, 'on', MENUBAR_AGENT)).changed, false)
      assert.deepEqual(changes(calls), [])
    })
  })

  it('reports a moved sideby as stale, points it back on refresh, and never creates or replaces a foreign file', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const moved = { ...ctxFor(h.home, calls), launcher: { node: '/bin/sh', entry: '/no/such/sideby' } }
      // A missing entry is not refused at write time only when it is not in a temporary folder.
      await applyAutostart(moved, await planAutostart(moved, 'on', MENUBAR_AGENT), MENUBAR_AGENT)
      const ctx = ctxFor(h.home, calls)
      const stale = await autostartStatus(ctx, MENUBAR_AGENT)
      assert.deepEqual([stale.state, stale.missing], ['stale', ['/no/such/sideby']])
      assert.equal((await refreshAutostart(ctx, MENUBAR_AGENT)).rewritten, true)
      assert.equal((await autostartStatus(ctx, MENUBAR_AGENT)).state, 'on')

      await withFakeHome(async (h2) => {
        const none = await refreshAutostart(ctxFor(h2.home, []), MENUBAR_AGENT)
        assert.deepEqual([none.rewritten, none.state], [false, 'off'])
        await h2.write(PLIST, '<plist/>\n', 0o644)
        const before = await snapshot(h2.home)
        const plan = await planAutostart(ctxFor(h2.home, []), 'on', MENUBAR_AGENT)
        assert.equal(plan.blocked?.code, 'foreign')
        assert.match(plan.blocked!.message, /sideby menubar on/)
        assert.deepEqual(await snapshot(h2.home), before)
      })
    })
  })

  it('refuses on other systems', async () => {
    await withFakeHome(async (h) => {
      const plan = await planAutostart({ ...ctxFor(h.home, []), platform: 'linux' }, 'on', MENUBAR_AGENT)
      assert.equal(plan.blocked?.code, 'unsupported')
    })
  })
})

describe('menu bar script', () => {
  it('runs only sideby commands and reads only its own snapshot file', () => {
    const commands = [...MENUBAR_SCRIPT.matchAll(/act\(\[([^\]]*)\]\)|sideby\(\[([^\]]*)\]/g)].map(
      (m) => (m[1] ?? m[2])!,
    )
    assert.deepEqual(commands.sort(), [
      "'menubar', 'off', '--yes'",
      "'menubar', 'snapshot', '--json', '--lang', lang",
      "'menubar', 'start', ref",
      "'ui', '--background'",
    ])
    assert.equal([...MENUBAR_SCRIPT.matchAll(/stringWithContentsOfFile/g)].length, 1)
    assert.doesNotMatch(MENUBAR_SCRIPT, /\/bin\/sh|doShellScript|\$\{/)
    // JXA hands enum constants such as NSAlertFirstButtonReturn over as strings: never compare them with === or !==.
    assert.doesNotMatch(MENUBAR_SCRIPT, /[!=]==\s*\$\.NS\w+/)
    // The key monitor makes AppKit throw inside a modal loop, so every alert lifts it first and puts it back after.
    const modals = [...MENUBAR_SCRIPT.matchAll(/\.runModal\b/g)].length
    assert.ok(modals > 0)
    assert.equal(
      [...MENUBAR_SCRIPT.matchAll(/pauseKeys\(\);[\s\S]{0,160}?\.runModal;[\s\S]{0,80}?resumeKeys\(\);/g)]
        .length,
      modals,
    )
  })

  it('opens on any press made after the menu closed, and starts itself again only while idle', () => {
    // The press is compared with the close by the event's own time, so a quick second press is never dropped.
    assert.match(MENUBAR_SCRIPT, /Number\(e\.timestamp\) > closedAt/)
    assert.match(MENUBAR_SCRIPT, /closedAt = uptime\(\)/)
    // launchd starts it again only after a failed exit, and never while the menu is open or a command runs.
    const restart = MENUBAR_SCRIPT.match(/if \((.*)\) \$\.exit\((\d+)\);/)
    assert.ok(restart)
    assert.notEqual(restart[2], '0')
    for (const guard of ['!menuOpen', '!task', '!actions.length', 'lastUse > 60'])
      assert.ok(restart[1]!.includes(guard), guard)
  })
})
