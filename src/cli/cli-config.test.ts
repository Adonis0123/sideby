import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fakeHost, withFakeHome } from '../../testing/index.ts'
import { checkSchema, sideby, sidebySpawn } from './cli-test-helpers.ts'

describe('config get|set|unset (spec §3.29)', () => {
  it('previews a change with exit 10, writes it with --yes, and lists every key', async () => {
    await withFakeHome(async (h) => {
      const file = h.path('.config/sideby/config.json')
      const preview = await sideby(h, ['config', 'set', 'panel.theme', 'dark'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /panel\.theme: \(not set\) → "dark"/)
      await assert.rejects(readFile(file, 'utf8'))
      const done = checkSchema(
        'config-set',
        (await sideby(h, ['config', 'set', 'panel.theme', 'dark', '--yes', '--json'])).out,
      )
      assert.deepEqual([done.applied, done.after], [true, 'dark'])
      assert.equal(JSON.parse(await readFile(file, 'utf8')).panel.theme, 'dark')
      const one = checkSchema('config-get', (await sideby(h, ['config', 'get', 'panel.theme', '--json'])).out)
      assert.deepEqual([one.set, one.value], [true, 'dark'])
      const all = checkSchema('config-get', (await sideby(h, ['config', '--json'])).out)
      assert.ok((all.keys as { key: string }[]).some((k) => k.key === 'handoff.threshold'))
      const same = await sideby(h, ['config', 'set', 'panel.theme', 'dark'])
      assert.equal(same.code, 0)
      const unset = await sideby(h, ['config', 'unset', 'panel.theme', '--yes'])
      assert.equal(unset.code, 0)
      assert.equal(JSON.parse(await readFile(file, 'utf8')).panel, undefined)
    })
  })

  it('refuses bad values, plugin settings and non-model account arguments with exit 1, and bad shapes with 2', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      await h.mkdir('.claude/skills')
      const bad = await sideby(h, ['config', 'set', 'handoff.threshold', '200', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(checkSchema('error', bad.out).code, 'bad-value')
      const plugin = await sideby(h, ['config', 'get', 'plugins.x.token', '--json'])
      assert.equal(plugin.code, 1)
      assert.equal(JSON.parse(plugin.out).code, 'plugin-config')
      const args = await sideby(h, [
        'config',
        'set',
        'accounts.claude:main.args',
        '["--dangerously-skip-permissions"]',
      ])
      assert.equal(args.code, 1)
      assert.match(args.err, /model and effort/)
      const ok = await sideby(h, ['config', 'set', 'accounts.claude:main.args', '["--model","opus"]'])
      assert.equal(ok.code, 10)
      assert.equal((await sideby(h, ['config', 'set', 'panel.theme'])).code, 2)
      assert.equal((await sideby(h, ['config', 'frob'])).code, 2)
    })
  })

  it('checks handoff names as `sideby handoff` does', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      await h.mkdir('.claude/skills')
      const order = await sidebySpawn(h, [
        'config',
        'set',
        'handoff.families.claude',
        '{"policy":"order","order":["claude:nope"]}',
        '--json',
      ])
      assert.equal(order.code, 1)
      assert.equal(checkSchema('error', order.out).code, 'unknown-account')
      const family = await sidebySpawn(h, ['config', 'set', 'handoff.familyOrder', '["nope"]'])
      assert.equal(family.code, 1)
      assert.match(family.err, /unknown family "nope"/)
      const cross = await sidebySpawn(h, ['config', 'set', 'handoff.crossOrganization', '["ghost"]'])
      assert.equal(cross.code, 1)
      assert.match(cross.err, /ghost is not an account/)
      const ok = await sidebySpawn(h, ['config', 'set', 'handoff.crossOrganization', '["claude:main"]'])
      assert.equal(ok.code, 10)
    })
  })
})

describe('autostart (spec §3.29)', () => {
  it('reports the state in the schema and refuses or skips without touching launchd', async () => {
    await withFakeHome(async (h) => {
      const status = checkSchema('autostart', (await sidebySpawn(h, ['autostart', '--json'])).out)
      assert.equal(status.state, 'off')
      const supported = process.platform === 'darwin' || process.platform === 'linux'
      assert.equal(status.supported, supported)
      const off = await sideby(h, ['autostart', 'off', '--json'])
      assert.equal(off.code, supported ? 0 : 1)
      await h.write('Library/LaunchAgents/dev.sideby.panel.plist', '<plist/>\n', 0o644)
      if (process.platform === 'darwin') {
        assert.equal(
          checkSchema('autostart', (await sideby(h, ['autostart', '--json'])).out).state,
          'foreign',
        )
        const refused = await sideby(h, ['autostart', 'off', '--yes', '--json'])
        assert.equal(refused.code, 1)
        assert.equal(JSON.parse(refused.out).code, 'foreign')
      }
      assert.equal(
        await readFile(h.path('Library/LaunchAgents/dev.sideby.panel.plist'), 'utf8'),
        '<plist/>\n',
      )
      assert.equal((await sideby(h, ['autostart', 'maybe'])).code, 2)
      assert.equal((await sideby(h, ['autostart', '--yes'])).code, 2)
    })
  })
})

describe('menubar (spec §3.31)', () => {
  it('reports its state, shows the change before --yes, and prints what the menu shows', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const status = checkSchema('menubar', (await sideby(h, ['menubar', '--json'])).out)
      assert.deepEqual([status.state, status.supported], ['off', process.platform === 'darwin'])
      const shown = await sideby(h, ['menubar', 'on', '--json'])
      // A checkout in a temporary folder cannot start at login, so `on` refuses it there (`temp-dir`).
      const inTemp = shown.code === 1 && JSON.parse(shown.out).code === 'temp-dir'
      if (process.platform === 'darwin' && !inTemp) {
        assert.equal(shown.code, 10)
        const plan = checkSchema('menubar', shown.out)
        assert.equal((plan.programArguments as string[])[0], '/usr/bin/osascript')
        assert.match((await sideby(h, ['menubar', 'on'])).out, /dev\.sideby\.menubar\.plist.*--yes/s)
      } else assert.equal(shown.code, 1)
      // Nothing is written before --yes.
      await assert.rejects(readFile(h.path('Library/LaunchAgents/dev.sideby.menubar.plist')))
      const snap = checkSchema(
        'menubar-snapshot',
        (await sideby(h, ['menubar', 'snapshot', '--json', '--lang', 'zh'])).out,
      ) as { lang: string; sections: { rows: { ref: string }[] }[] }
      assert.equal(snap.lang, 'zh')
      assert.deepEqual(
        snap.sections.map((x) => x.rows.map((r) => r.ref)),
        [['claude:main']],
      )
      assert.equal((await sideby(h, ['menubar', 'maybe'])).code, 2)
      assert.equal((await sideby(h, ['menubar', '--yes'])).code, 2)
      assert.equal((await sideby(h, ['menubar', 'start'])).code, 2)
    })
  })

  it('changes the shortcut, refuses one macOS uses, and says when the menu bar item could not register it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const first = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual(
        [first.keys, first.label, first.isDefault, first.registered],
        ['opt+x', '⌥X', true, null],
      )
      const refused = await sideby(h, ['menubar', 'hotkey', 'cmd+q', '--json'])
      assert.equal(refused.code, 1)
      assert.equal(JSON.parse(refused.out).code, 'hotkey.reserved')
      assert.equal(
        JSON.parse((await sideby(h, ['menubar', 'hotkey', 'shift+k', '--json'])).out).code,
        'hotkey.needs-modifier',
      )
      // Any order and spelling; written the way config keeps it.
      const set = checkSchema(
        'menubar-hotkey',
        (await sideby(h, ['menubar', 'hotkey', 'Cmd+Ctrl+K', '--json'])).out,
      )
      assert.deepEqual([set.changed, (set.hotkey as { keys: string }).keys], [true, 'ctrl+cmd+k'])
      assert.match(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /"hotkey": "ctrl\+cmd\+k"/)
      // The menu bar script reports that another app holds the key; status and `hotkey` say so.
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'taken'])
      const taken = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual([taken.label, taken.registered], ['⌃⌘K', false])
      assert.match((await sideby(h, ['menubar', 'hotkey'])).out, /macOS did not accept it/)
      // A report about a shortcut config no longer holds says nothing about the current one.
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'ok', '--hotkey-label', '⌥⌘S'])
      const older = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual([older.label, older.registered], ['⌃⌘K', null])
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'taken', '--hotkey-label', '⌃⌘K'])
      // Back to the default removes the key from config.
      await sideby(h, ['menubar', 'hotkey', 'default'])
      assert.doesNotMatch(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /hotkey/)
      assert.equal((await sideby(h, ['menubar', 'snapshot', '--hotkey', 'maybe'])).code, 2)
    })
  })

  it('changes the account order with no --yes, refuses an unknown one, and default removes the key', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const first = checkSchema('menubar-sort', (await sideby(h, ['menubar', 'sort', '--json'])).out)
      assert.deepEqual([first.sort, first.isDefault], ['order', true])
      const set = checkSchema('menubar-sort', (await sideby(h, ['menubar', 'sort', 'room', '--json'])).out)
      assert.deepEqual([set.changed, set.sort, set.isDefault], [true, 'room', false])
      assert.match(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /"sort": "room"/)
      const bad = await sideby(h, ['menubar', 'sort', 'busiest', '--json'])
      assert.deepEqual([bad.code, JSON.parse(bad.out).code], [1, 'sort.invalid'])
      await sideby(h, ['menubar', 'sort', 'order'])
      assert.doesNotMatch(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /"sort"/)
    })
  })
})

describe('_notice on --json outputs (spec §3.23)', () => {
  it('carries a newer version from the cache and an outdated skill, on results and errors, and not when turned off', async () => {
    await withFakeHome(async (h) => {
      // Checked just now, so no Update Check starts: tests never make the request.
      const now = new Date().toISOString()
      await h.write(
        '.local/state/sideby/update.json',
        JSON.stringify({ checkedAt: now, triedAt: now, latest: '99.0.0' }),
      )
      await h.write('.agents/skills/sideby/SKILL.md', '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n')
      const on = { SIDEBY_NO_UPDATE_NOTIFIER: '' }
      const list = checkSchema('list', (await sideby(h, ['list', '--json'], on)).out)
      const n = list._notice as { update: { latest: string; command: string }; skill: { installed: string } }
      assert.deepEqual(
        [n.update.latest, n.update.command, n.skill.installed],
        ['99.0.0', 'sideby update', '0.0.1'],
      )
      const err = await sideby(h, ['quota', 'nope:x', '--json'], on)
      assert.equal(err.code, 1)
      assert.ok((checkSchema('error', err.out)._notice as object | undefined) !== undefined)
      assert.equal(checkSchema('list', (await sideby(h, ['list', '--json'])).out)._notice, undefined)
      const update = JSON.parse(
        (await sideby(h, ['update', '--json'], { ...on, SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' })).out,
      )
      assert.equal(update._notice, undefined)
    })
  })
})

describe('sideby desktop (spec §3.20)', () => {
  it('refuses before starting anything: no account, an API account, a family without a desktop app', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-deepseek/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.write('.grok/skills/x.md', 'x\n')
      assert.equal((await sideby(h, ['desktop'])).code, 2)
      const api = await sidebySpawn(h, ['desktop', 'claude:deepseek', '--json'])
      assert.equal(api.code, 1)
      assert.equal(checkSchema('error', api.out).code, 'api-account')
      const pi = await sideby(h, ['desktop', 'pi:main'])
      assert.equal(pi.code, 1)
      assert.match(pi.err, /no desktop app sideby can open \(only claude and codex accounts do\)/)
      const grok = await sideby(h, ['desktop', 'grok:main'])
      assert.match(grok.err, /use `sideby desktop grok-bot:<name>`/)
      // Grok Bot windows: none of these reach a real app.
      assert.equal((await sideby(h, ['desktop', 'claude:main', '--remove'])).code, 2)
      const bad = await sideby(h, ['desktop', 'grok-bot:Bad', '--remove', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(checkSchema('error', bad.out).code, 'invalid-name')
      const main = await sideby(h, ['desktop', 'grok-bot', '--remove', '--json'])
      assert.equal(checkSchema('error', main.out).code, 'main-profile')
      const help = await sideby(h, ['desktop', '--help'])
      assert.match(help.out, /sideby desktop <account>/)
      assert.match(help.out, /sideby desktop grok-bot:<name> \[--remove \[--yes\]\]/)
    })
  })
})

describe('sideby edit (spec §3.30)', () => {
  it('prints where the settings file is with --path and says what to do when it is missing, opening nothing', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-empty/CLAUDE.md', '# rules\n')
      assert.equal((await sideby(h, ['edit'])).code, 2)
      const path = await sidebySpawn(h, ['edit', 'claude:main', '--path', '--json'])
      assert.equal(path.code, 0)
      const r = checkSchema('edit', path.out)
      assert.equal(r.opened, false)
      assert.equal(r.path, h.path('.claude/settings.json'))
      assert.equal(
        (await sideby(h, ['edit', 'claude:main', '--path'])).out.trim(),
        h.path('.claude/settings.json'),
      )
      const missing = await sideby(h, ['edit', 'claude:empty', '--json'])
      assert.equal(missing.code, 1)
      assert.equal(checkSchema('error', missing.out).code, 'settings-missing')
      assert.match(
        (await sideby(h, ['edit', '--help'])).out,
        /sideby edit <account> \[--path\] \[--with <editor>\]/,
      )
      // An unknown editor is a usage error before anything opens; a known one passes with --path, which opens nothing.
      const bad = await sideby(h, ['edit', 'claude:main', '--with', 'notepad'])
      assert.equal(bad.code, 2)
      assert.match(bad.err, /--with takes one of system, cursor, vscode, windsurf, zed/)
      assert.equal((await sideby(h, ['edit', 'claude:main', '--with', 'zed', '--path'])).code, 0)
    })
  })
})
