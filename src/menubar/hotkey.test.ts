// The Menu Bar Item's shortcut (spec §3.31): which combinations a user may pick, what the Panel and CLI show about the
// last registration, and how a change reaches a running menu bar item. launchctl goes to an injected exec.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  checkHotkey,
  hotkeyView,
  iconView,
  readHotkeyState,
  readMenubarState,
  setMenubarHotkey,
  writeHotkeyState,
  writeMenubarState,
} from './hotkey.ts'

describe('checkHotkey', () => {
  it('takes modifiers and one letter or digit in any order and spelling, written as config keeps them', () => {
    const ok = (v: string) => {
      const r = checkHotkey(v)
      assert.ok(r.ok, v)
      return [r.keys, r.hotkey?.label ?? '']
    }
    assert.deepEqual(ok('Cmd+Option+K'), ['opt+cmd+k', '⌥⌘K'])
    assert.deepEqual(ok('ctrl + shift + 0'), ['ctrl+shift+0', '⌃⇧0'])
    assert.deepEqual(ok('default'), ['opt+x', '⌥X'])
    assert.deepEqual(ok('off'), ['off', ''])
    // ⌘S saves, but ⌥⌘S is free; ⌥ alone (two keys, one hand) is allowed.
    assert.deepEqual(ok('opt+cmd+s'), ['opt+cmd+s', '⌥⌘S'])
    assert.deepEqual(ok('Option+Z'), ['opt+z', '⌥Z'])
  })
  it('refuses what is not a shortcut, what would fire while typing, and what macOS uses, with what to do', () => {
    const code = (v: string) => {
      const r = checkHotkey(v)
      assert.ok(!r.ok, v)
      assert.match(r.message, /such as|write/)
      return r.code
    }
    assert.equal(code('cmd+space'), 'hotkey.invalid')
    assert.equal(code('k'), 'hotkey.invalid')
    assert.equal(code('cmd+cmd+k'), 'hotkey.invalid')
    assert.equal(code('shift+k'), 'hotkey.needs-modifier')
    assert.equal(code('cmd+q'), 'hotkey.reserved')
    assert.equal(code('cmd+shift+4'), 'hotkey.reserved')
    assert.equal(code('Option+Command+D'), 'hotkey.reserved')
    assert.equal(code('ctrl+cmd+q'), 'hotkey.reserved')
    assert.ok(checkHotkey('ctrl+opt+cmd+q').ok)
  })
})

describe('hotkeyView', () => {
  it('says whether the menu bar item registered this shortcut, and nothing about an older one', () => {
    const at = '2026-10-20T00:00:00.000Z'
    assert.equal(hotkeyView(undefined, { label: '⌥X', registered: false, at }).registered, false)
    assert.equal(hotkeyView('ctrl+cmd+k', { label: '⌥X', registered: false, at }).registered, null)
    const off = hotkeyView('off', null)
    assert.deepEqual([off.enabled, off.label, off.registered], [false, '', null])
    // An older, looser choice still works and says why a new one would be refused.
    assert.equal(hotkeyView('shift+k', null).problem?.code, 'hotkey.needs-modifier')
  })
})

describe('menu bar state', () => {
  it('keeps the shortcut and the icon reports side by side, and trusts an icon report for 15 minutes', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.local/state/sideby')
      await writeHotkeyState(dir, { label: '⌥⌘S', registered: true, at: '2026-10-20T00:00:00.000Z' })
      await writeMenubarState(dir, { icon: { visible: false, at: '2026-10-20T00:00:00.000Z' } })
      const kept = await readMenubarState(dir)
      assert.deepEqual([kept.hotkey?.label, kept.icon?.visible], ['⌥⌘S', false])
      assert.deepEqual(iconView(kept.icon, new Date('2026-10-20T00:10:00.000Z')), { visible: false })
      assert.deepEqual(iconView(kept.icon, new Date('2026-10-20T00:20:00.000Z')), { visible: null })
      assert.deepEqual(iconView(undefined, new Date()), { visible: null })
    })
  })
})

describe('setMenubarHotkey', () => {
  it('writes config, restarts a running menu bar item, and keeps the registration state', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const ctx = {
        home: h.home,
        loginHome: h.home,
        platform: 'darwin' as const,
        uid: 501,
        exec: async (file: string, args: readonly string[]) => {
          calls.push([file, ...args])
          return { code: 0, output: '' }
        },
      }
      const configFile = h.path('.config/sideby/config.json')
      const stateDir = h.path('.local/state/sideby')
      await writeHotkeyState(stateDir, { label: '⌃⌘K', registered: true, at: '2026-10-20T00:00:00.000Z' })
      const r = await setMenubarHotkey({ configFile, stateDir, value: 'ctrl+cmd+k', ctx })
      assert.deepEqual([r.changed, r.nudged, r.hotkey.registered], [true, true, true])
      // The running item is told through a distributed notification, not restarted.
      const [file, ...args] = calls.at(-1)!
      assert.deepEqual([file, args[0], args[1]], ['/usr/bin/osascript', '-l', 'JavaScript'])
      assert.match(args[3]!, /postNotificationName[\s\S]*dev\.sideby\.menubar\.reload/)
      assert.ok(!calls.some((c) => c.includes('kickstart')))
      assert.equal(JSON.parse(await readFile(configFile, 'utf8')).menubar.hotkey, 'ctrl+cmd+k')
      calls.length = 0
      assert.equal(
        (await setMenubarHotkey({ configFile, stateDir, value: 'ctrl+cmd+k', ctx })).changed,
        false,
      )
      assert.deepEqual(calls, [])
      await assert.rejects(setMenubarHotkey({ configFile, stateDir, value: 'cmd+w', ctx }), {
        code: 'hotkey.reserved',
      })
      assert.equal((await readHotkeyState(stateDir))?.label, '⌃⌘K')
    })
  })
})
