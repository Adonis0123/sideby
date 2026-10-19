// Opening an Account's Host settings file in the user's editor (spec §3.30, ADR-0033). Every program goes through
// a fake `exec`, so no test opens a real editor.
import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { createRuntime } from '../runtime.ts'
import type { ExecResult } from './desktop-app.ts'
import { editSettings, hostSettingsFile } from './edit-settings.ts'
import { UserError } from './errors.ts'

const SECRET = 'fake-key-never-shown'

async function setup(
  h: FakeHome,
  platform: NodeJS.Platform,
  opts: { wslMount?: string; code?: number } = {},
) {
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
    return { code: opts.code ?? 0, stdout: '', stderr: '' }
  }
  const rt = await createRuntime({
    env: h.env,
    desktop: { platform, exec, ...(opts.wslMount ? { wslMount: opts.wslMount } : {}) },
  })
  return { rt, calls }
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

  it('accepts only a relative settings file inside the account directory', () => {
    assert.equal(hostSettingsFile({ settingsFile: 'settings.json' }), 'settings.json')
    for (const bad of ['/etc/passwd', '../x.json', 'a/../../x', ''])
      assert.equal(hostSettingsFile({ settingsFile: bad }), undefined, bad)
    assert.equal(hostSettingsFile({}), undefined)
  })
})
