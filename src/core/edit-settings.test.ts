// Opening an Account's Host settings file in the user's editor (spec §3.30, ADR-0033). Every program goes through
// a fake `exec`, so no test opens a real editor.
import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { createRuntime } from '../runtime.ts'
import { ConfigError, configGet, editConfigPath, loadConfig, settableKeys } from './config.ts'
import type { ExecResult } from './desktop-app.ts'
import { editSettings, hostSettingsFile } from './edit-settings.ts'
import { UserError } from './errors.ts'

const SECRET = 'fake-key-never-shown'

async function setup(
  h: FakeHome,
  platform: NodeJS.Platform,
  opts: {
    wslMount?: string
    code?: number
    /** config `editor`, written before the Runtime reads the config. */
    editor?: string
    /** Exit codes by program; any other program exits with `code` (0 by default). */
    codes?: Record<string, number>
    appDirs?: string[]
  } = {},
) {
  if (opts.editor) await h.write(CONFIG, JSON.stringify({ editor: opts.editor }))
  await h.write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } }))
  await h.mkdir('.claude-work')
  await symlink(h.path('.claude/settings.json'), h.path('.claude-work/settings.json'))
  await h.write('.claude-solo/settings.json', '{}\n')
  await h.write('.claude-empty/CLAUDE.md', '# rules\n')
  await h.write('.codex/config.toml', 'model = "gpt-fake"\n')
  const calls: { cmd: string; args: string[] }[] = []
  const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
    calls.push({ cmd, args: [...args] })
    if (cmd === 'wslpath')
      return { code: 0, stdout: `\\\\wsl.localhost\\Fake${args[1]?.replaceAll('/', '\\')}\n`, stderr: '' }
    return { code: opts.codes?.[cmd] ?? opts.code ?? 0, stdout: '', stderr: '' }
  }
  // Only the fake HOME's bin on PATH and its own Applications folder, so no editor of the machine running the test
  // is found.
  const rt = await createRuntime({
    env: { ...h.env, PATH: h.bin },
    desktop: {
      platform,
      exec,
      appDirs: opts.appDirs ?? [h.path('Applications')],
      ...(opts.wslMount ? { wslMount: opts.wslMount } : {}),
    },
  })
  return { rt, calls }
}

const CONFIG = '.config/sideby/config.json'
/** An editor's command line inside a fake app bundle, as macOS has it. */
const bundled = (h: FakeHome, app: string, rel: string) =>
  h.write(`Applications/${app}.app/${rel}`, '', 0o755)
/** An editor's command in the fake PATH. */
async function onPath(h: FakeHome, name: string) {
  const p = join(h.bin, name)
  await writeFile(p, '', { mode: 0o755 })
  return p
}

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UserError, String(err))
    assert.equal(err.code, code)
    assert.ok(!err.message.includes(SECRET))
    return true
  })
}

describe('sideby edit', () => {
  it('opens the real file of a linked account in the default text editor and names who shares it, writing nothing', async () => {
    await withFakeHome(async (h) => {
      const { rt, calls } = await setup(h, 'darwin')
      const before = await snapshot(h.home)
      const r = await editSettings(rt, 'claude:work')
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const real = h.path('.claude/settings.json')
      assert.deepEqual(calls, [{ cmd: '/usr/bin/open', args: ['-t', real] }])
      assert.equal(r.path, h.path('.claude-work/settings.json'))
      assert.equal(r.target, real)
      assert.deepEqual(r.sharedWith, ['claude:main'])
      assert.equal(r.opened, true)
      assert.ok(Value.Check(OUTPUT_SCHEMAS.edit!, r))
      assert.ok(!JSON.stringify(r).includes(SECRET))
    })
  })

  it('gives a file of its own no target and no one to share with; --path opens nothing', async () => {
    await withFakeHome(async (h) => {
      const { rt, calls } = await setup(h, 'darwin')
      const r = await editSettings(rt, 'claude:solo', { open: false })
      assert.equal(r.target, undefined)
      assert.deepEqual(r.sharedWith, [])
      assert.equal(r.opened, false)
      assert.deepEqual(calls, [])
      const main = await editSettings(rt, 'claude:main', { open: false })
      assert.deepEqual(main.sharedWith, ['claude:work'])
    })
  })

  it('opens the family’s own file: config.toml for codex', async () => {
    await withFakeHome(async (h) => {
      const { rt, calls } = await setup(h, 'linux')
      const r = await editSettings(rt, 'codex:main')
      assert.equal(r.file, 'config.toml')
      assert.deepEqual(calls, [{ cmd: 'xdg-open', args: [h.path('.codex/config.toml')] }])
    })
  })

  it('on WSL hands the Windows path to cmd.exe start, and says so when it fails', async () => {
    await withFakeHome(async (h) => {
      const failing = await setup(h, 'linux', { wslMount: '/mnt', code: 1 })
      await refused(editSettings(failing.rt, 'claude:solo'), 'open-failed')
    })
    await withFakeHome(async (h) => {
      const { rt, calls } = await setup(h, 'linux', { wslMount: '/mnt' })
      const r = await editSettings(rt, 'claude:solo')
      const file = h.path('.claude-solo/settings.json')
      assert.deepEqual(calls[0], { cmd: 'wslpath', args: ['-w', file] })
      assert.deepEqual(calls[1], {
        cmd: '/mnt/c/Windows/System32/cmd.exe',
        args: ['/c', 'start', '', `\\\\wsl.localhost\\Fake${file.replaceAll('/', '\\')}`],
      })
      assert.equal(r.opened, true)
    })
  })

  it('says what to do when the file is missing, cannot be opened, or the system is not supported', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, 'linux', { code: 3 })
      await refused(editSettings(rt, 'claude:empty'), 'settings-missing')
      await refused(editSettings(rt, 'claude:solo'), 'open-failed')
      const win = await createRuntime({
        env: h.env,
        desktop: { platform: 'win32', exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      })
      await refused(editSettings(win, 'claude:solo'), 'open-failed')
    })
  })

  it('opens the file in the configured editor through the command line in its app bundle on macOS', async () => {
    await withFakeHome(async (h) => {
      await bundled(h, 'Cursor', 'Contents/Resources/app/bin/cursor')
      const { rt, calls } = await setup(h, 'darwin', { editor: 'cursor' })
      const before = await snapshot(h.home)
      const r = await editSettings(rt, 'claude:work')
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const real = h.path('.claude/settings.json')
      const cli = h.path('Applications/Cursor.app/Contents/Resources/app/bin/cursor')
      // Cursor opens a lone file in its Agent Window; --classic with the folder opens an editor window on it.
      const args = ['--classic', h.path('.claude'), real]
      assert.deepEqual(calls, [{ cmd: cli, args }])
      assert.deepEqual(r.command, [cli, ...args])
      assert.equal(r.editor, 'cursor')
      assert.ok(Value.Check(OUTPUT_SCHEMAS.edit!, r))
    })
  })

  it('on macOS takes the command on PATH next, then open -a, and Zed’s cli from its bundle', async () => {
    await withFakeHome(async (h) => {
      const code = await onPath(h, 'code')
      const { rt, calls } = await setup(h, 'darwin', { editor: 'vscode' })
      const r = await editSettings(rt, 'claude:solo')
      const file = h.path('.claude-solo/settings.json')
      assert.deepEqual(calls, [{ cmd: code, args: [file] }])
      assert.deepEqual(r.command, [code, file])
    })
    await withFakeHome(async (h) => {
      // The bundle's command line fails: open -a gets the file instead.
      await bundled(h, 'Windsurf', 'Contents/Resources/app/bin/windsurf')
      const cli = h.path('Applications/Windsurf.app/Contents/Resources/app/bin/windsurf')
      const { rt, calls } = await setup(h, 'darwin', { editor: 'windsurf', codes: { [cli]: 1 } })
      const r = await editSettings(rt, 'claude:solo')
      const file = h.path('.claude-solo/settings.json')
      assert.deepEqual(calls, [
        { cmd: cli, args: [file] },
        { cmd: '/usr/bin/open', args: ['-a', 'Windsurf', file] },
      ])
      assert.deepEqual(r.command, ['/usr/bin/open', '-a', 'Windsurf', file])
    })
    await withFakeHome(async (h) => {
      await bundled(h, 'Zed', 'Contents/MacOS/cli')
      const { rt, calls } = await setup(h, 'darwin', { editor: 'zed' })
      await editSettings(rt, 'claude:solo')
      assert.deepEqual(calls, [
        {
          cmd: h.path('Applications/Zed.app/Contents/MacOS/cli'),
          args: [h.path('.claude-solo/settings.json')],
        },
      ])
    })
    await withFakeHome(async (h) => {
      // Not installed at all: open -a fails too, and the message says what to do.
      const { rt } = await setup(h, 'darwin', { editor: 'cursor', code: 1 })
      await refused(editSettings(rt, 'claude:solo'), 'open-failed')
    })
  })

  it('on Linux runs the editor on PATH, else falls back to the default program', async () => {
    await withFakeHome(async (h) => {
      const code = await onPath(h, 'code')
      const { rt, calls } = await setup(h, 'linux', { editor: 'vscode' })
      const r = await editSettings(rt, 'codex:main')
      assert.deepEqual(calls, [{ cmd: code, args: [h.path('.codex/config.toml')] }])
      assert.equal(r.editor, 'vscode')
    })
    await withFakeHome(async (h) => {
      const { rt, calls } = await setup(h, 'linux', { editor: 'cursor' })
      const r = await editSettings(rt, 'codex:main')
      assert.deepEqual(calls, [{ cmd: 'xdg-open', args: [h.path('.codex/config.toml')] }])
      assert.deepEqual(r.command, ['xdg-open', h.path('.codex/config.toml')])
      // Cursor is not on PATH: the default program opened it, and the result says so.
      assert.equal(r.editor, 'system')
    })
  })

  it('keeps the default program for `system`, and a one-off editor wins over the config', async () => {
    await withFakeHome(async (h) => {
      await bundled(h, 'Cursor', 'Contents/Resources/app/bin/cursor')
      const { rt, calls } = await setup(h, 'darwin', { editor: 'system' })
      const file = h.path('.claude-solo/settings.json')
      const r = await editSettings(rt, 'claude:solo')
      assert.deepEqual(calls, [{ cmd: '/usr/bin/open', args: ['-t', file] }])
      assert.equal(r.editor, 'system')
      await editSettings(rt, 'claude:solo', { editor: 'cursor' })
      assert.deepEqual(calls[1], {
        cmd: h.path('Applications/Cursor.app/Contents/Resources/app/bin/cursor'),
        args: ['--classic', h.path('.claude-solo'), file],
      })
      await refused(editSettings(rt, 'claude:solo', { editor: 'notepad' as 'zed' }), 'bad-editor')
      assert.equal(calls.length, 2)
    })
  })

  it('takes config `editor` only from the list, and `config get` explains it', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await assert.rejects(editConfigPath(file, 'editor', 'notepad'), ConfigError)
      await editConfigPath(file, 'editor', 'zed')
      assert.equal((await configGet(file, 'editor')).value, 'zed')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).editor, 'zed')
      const key = settableKeys(await loadConfig(file)).find((k) => k.key === 'editor')
      assert.equal(key?.takes, 'one of: system, cursor, vscode, windsurf, zed')
      assert.equal(key?.value, 'zed')
      await h.write(CONFIG, JSON.stringify({ editor: 'notepad' }))
      await assert.rejects(loadConfig(file), ConfigError)
    })
  })

  it('accepts only a relative settings file inside the account directory', () => {
    assert.equal(hostSettingsFile({ settingsFile: 'settings.json' }), 'settings.json')
    for (const bad of ['/etc/passwd', '../x.json', 'a/../../x', ''])
      assert.equal(hostSettingsFile({ settingsFile: bad }), undefined, bad)
    assert.equal(hostSettingsFile({}), undefined)
  })
})
