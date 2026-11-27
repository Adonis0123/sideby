import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, fakeHost, snapshot, withFakeHome } from '../../../testing/index.ts'
import { createRuntime } from '../../runtime.ts'
import { claudePlugin } from './index.ts'
import {
  claudeModDir,
  claudeVersion,
  MOD_MIN_VERSION,
  ORCA_AGENT_VIEW_VAR,
  parseClaudeVersion,
  versionAtLeast,
  withClaudeMod,
} from './mod.ts'

const builtins = [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }]

describe('Claude Code version', () => {
  it('reads the version Claude Code prints and compares it part by part', () => {
    assert.equal(parseClaudeVersion('2.1.304 (Claude Code)\n'), '2.1.304')
    assert.equal(parseClaudeVersion('Claude Code'), undefined)
    assert.equal(versionAtLeast('2.1.287', MOD_MIN_VERSION), true)
    assert.equal(versionAtLeast('2.1.300', MOD_MIN_VERSION), true)
    assert.equal(versionAtLeast('2.1.286', MOD_MIN_VERSION), false)
    assert.equal(versionAtLeast('2.10.0', MOD_MIN_VERSION), true)
    assert.equal(versionAtLeast('1.9.999', MOD_MIN_VERSION), false)
  })

  it('asks a binary once, and again after it changes', async () => {
    await withFakeHome(async (h) => {
      const bin = await h.write('bin-claude', '#!/bin/sh\n', 0o755)
      const state = h.path('state')
      let asked = 0
      const run = async () => {
        asked++
        return '2.1.300 (Claude Code)\n'
      }
      assert.equal(await claudeVersion(bin, h.env, state, run), '2.1.300')
      assert.equal(await claudeVersion(bin, h.env, state, run), '2.1.300')
      assert.equal(asked, 1)
      await writeFile(bin, '#!/bin/sh\n# updated\n')
      assert.equal(await claudeVersion(bin, h.env, state, run), '2.1.300')
      assert.equal(asked, 2)
      const kept = JSON.parse(await readFile(join(state, 'cache', 'claude-version.json'), 'utf8'))
      assert.equal(kept.version, '2.1.300')
    })
  })

  it('gives no version when the binary cannot answer', async () => {
    await withFakeHome(async (h) => {
      const bin = await h.write('bin-claude', '#!/bin/sh\n', 0o755)
      const fail = async () => {
        throw new Error('exit 1')
      }
      assert.equal(await claudeVersion(bin, h.env, h.path('state'), fail), undefined)
      assert.equal(await claudeVersion(h.path('missing'), h.env, h.path('state'), fail), undefined)
    })
  })
})

describe('withClaudeMod', () => {
  const at = (version: string) => async () => `${version} (Claude Code)\n`

  it('puts --plugin-dir first, so a subcommand such as `mcp list` and a prompt after -- both still work', async () => {
    await withFakeHome(async (h) => {
      const bin = await h.write('bin-claude', '#!/bin/sh\n', 0o755)
      const opts = { bin, env: h.env, stateDir: h.path('state'), dir: '/pkg/mods/claude', run: at('2.1.300') }
      assert.deepEqual(await withClaudeMod(['mcp', 'list'], opts), [
        '--plugin-dir',
        '/pkg/mods/claude',
        'mcp',
        'list',
      ])
      assert.deepEqual(await withClaudeMod(['--', '-p'], opts), [
        '--plugin-dir',
        '/pkg/mods/claude',
        '--',
        '-p',
      ])
    })
  })

  it('leaves the arguments alone for a headless run, an older Claude Code or no Claude Code', async () => {
    await withFakeHome(async (h) => {
      const bin = await h.write('bin-claude', '#!/bin/sh\n', 0o755)
      const base = { env: h.env, dir: '/pkg/mods/claude' }
      const args = ['-p', 'hi']
      assert.deepEqual(
        await withClaudeMod(args, { ...base, bin, stateDir: h.path('s1'), run: at('2.1.300') }),
        args,
      )
      assert.deepEqual(
        await withClaudeMod([], { ...base, bin, stateDir: h.path('s2'), run: at('2.1.286') }),
        [],
      )
      assert.deepEqual(
        await withClaudeMod([], { ...base, bin: null, stateDir: h.path('s3'), run: at('2.1.300') }),
        [],
      )
    })
  })

  it('finds the mod folder shipped with sideby', async () => {
    const dir = claudeModDir()
    assert.ok(dir)
    const manifest = JSON.parse(await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    assert.equal(manifest.name, 'sideby')
    const hooks = JSON.parse(await readFile(join(dir, 'hooks', 'hooks.json'), 'utf8'))
    assert.deepEqual(hooks, { modules: ['./register.js'] })
  })
})

describe('sideby run loads the mod (spec §3.32 step 3)', () => {
  async function setup(
    h: Parameters<Parameters<typeof withFakeHome>[0]>[0],
    version: string,
    config: object = {},
  ) {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-001/settings.json', '{}')
    await h.write('.config/sideby/config.json', JSON.stringify(config))
    await fakeHost(h, 'claude', { version: `${version} (Claude Code)` })
    return createRuntime({ env: h.env, builtins })
  }

  const dropRunsSettings = (argv: readonly string[]) => {
    const i = argv.indexOf('--settings')
    return i >= 0 && argv[i + 1]?.endsWith('/runs/claude-settings.json')
      ? [...argv.slice(0, i), ...argv.slice(i + 2)]
      : [...argv]
  }

  it('gives a Claude Code that runs mods the mod folder, and writes nothing into an Account', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, '2.1.300')
      const before = await snapshot(h.home)
      const launch = await rt.prepareLaunch('claude:001', ['--', 'hello'], 'run')
      assert.deepEqual(dropRunsSettings(launch.args), ['--plugin-dir', claudeModDir(), '--', 'hello'])
      // Only sideby's own version cache and session settings appear, in its state folder.
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [
        '.local',
        '.local/state',
        '.local/state/sideby',
        '.local/state/sideby/cache',
        '.local/state/sideby/cache/claude-version.json',
        '.local/state/sideby/runs',
        '.local/state/sideby/runs/claude-settings.json',
      ])
    })
  })

  it('leaves it out for an older Claude Code, under config claudeMod false, and for sign-in', async () => {
    await withFakeHome(async (h) => {
      const old = await setup(h, '2.1.286')
      assert.deepEqual(dropRunsSettings((await old.prepareLaunch('claude:001', [], 'run')).args), [])
    })
    await withFakeHome(async (h) => {
      const off = await setup(h, '2.1.300', { claudeMod: false })
      assert.deepEqual(dropRunsSettings((await off.prepareLaunch('claude:001', [], 'run')).args), [])
    })
    await withFakeHome(async (h) => {
      const rt = await setup(h, '2.1.300')
      assert.ok(!(await rt.prepareLaunch('claude:001', [], 'login')).args.includes('--plugin-dir'))
    })
  })
})

describe("sideby loads Orca's agent-view plugin (spec §3.32 step 3)", () => {
  const dropRunsSettings = (argv: readonly string[]) => {
    const i = argv.indexOf('--settings')
    return i >= 0 && argv[i + 1]?.endsWith('/runs/claude-settings.json')
      ? [...argv.slice(0, i), ...argv.slice(i + 2)]
      : [...argv]
  }
  async function setup(h: Parameters<Parameters<typeof withFakeHome>[0]>[0], orca: string) {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-001/settings.json', '{}')
    await h.write('.config/sideby/config.json', JSON.stringify({ claudeMod: false }))
    await fakeHost(h, 'claude', { version: '2.1.300 (Claude Code)' })
    return createRuntime({ env: { ...h.env, [ORCA_AGENT_VIEW_VAR]: orca }, builtins })
  }

  it("puts an Orca terminal's folder first for an interactive Claude, with the mod off, also on resume", async () => {
    await withFakeHome(async (h) => {
      await h.write('orca/agent-view/.claude-plugin/plugin.json', '{}')
      const dir = h.path('orca/agent-view')
      const rt = await setup(h, dir)
      assert.deepEqual(dropRunsSettings((await rt.prepareLaunch('claude:001', ['--', 'hi'], 'run')).args), [
        '--plugin-dir',
        dir,
        '--',
        'hi',
      ])
      assert.deepEqual(
        dropRunsSettings((await rt.prepareLaunch('claude:001', ['--plugin-dir', dir], 'run')).args),
        ['--plugin-dir', dir],
      )
      assert.deepEqual((await rt.prepareLaunch('claude:001', ['-cp', 'hi'], 'run')).args, ['-cp', 'hi'])
      assert.ok(!(await rt.prepareLaunch('claude:001', [], 'login')).args.includes('--plugin-dir'))
      // WHY: `sideby resume claude --` with no session id runs the Host unchanged, outside `prepareLaunch`.
      assert.deepEqual((await rt.resumeLaunch('claude', [])).launch.args, ['--plugin-dir', dir])
      for (const other of ['orca/agent-view', h.path('missing')]) {
        const off = await setup(h, other)
        assert.deepEqual(dropRunsSettings((await off.prepareLaunch('claude:001', [], 'run')).args), [], other)
      }
    })
  })
})
