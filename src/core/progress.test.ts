// Progress Reminders in the sessions sideby starts (spec §3.42, ADR-0076): off by default, the hooks go in through
// Claude's one `--settings` (shared with Network Guard, Unattended Mode and Auto Handoff) and never into a Host
// directory, Codex gets none, and the switch the CLI and the Panel use writes only config `progress`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { createRuntime } from '../runtime.ts'
import { readProgressEvery } from './progress-state.ts'
import { withClaudeSessionHooks } from './session-hooks.ts'

const builtins = [claudePlugin, codexPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

async function setup(h: FakeHome, config: object) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-001/settings.json', '{}')
  await h.write('.codex/auth.json', '{}', 0o600)
  await h.write('.codex/config.toml', '')
  await h.write('.config/sideby/config.json', JSON.stringify(config))
  return createRuntime({
    env: { ...h.env, LANG: 'en_US.UTF-8' },
    builtins,
    network: { fetcher: async () => 'ip=203.0.113.7\nloc=US\n', print: 'p' },
  })
}

const settingsOf = async (args: readonly string[]) => {
  const at = args.indexOf('--settings')
  assert.ok(at >= 0, 'has --settings')
  return { file: args[at + 1]!, hooks: JSON.parse(await readFile(args[at + 1]!, 'utf8')).hooks }
}

describe('Progress Reminders at launch', () => {
  it('adds nothing while the setting is off (the default)', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      const { hooks } = await settingsOf(p.args)
      assert.deepEqual(Object.keys(hooks), ['SessionStart'])
      assert.equal(p.env.SIDEBY_PROGRESS_EVERY, undefined)
      assert.deepEqual(rt.progressView(), {
        on: false,
        defaultEvery: 30,
        choices: [5, 10, 15, 30, 60],
        families: ['claude'],
      })
    })
  })

  it('adds a background Stop entry with asyncRewake and a background prompt entry, writing nothing into a Host directory', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { progress: { every: 10 } })
      const before = await snapshot(h.path('.claude-001'))
      const main = await snapshot(h.path('.claude'))
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      const { file, hooks } = await settingsOf(p.args)
      assert.match(file, /progress\/claude-settings-runs\.json$/)
      assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
      const stop = hooks.Stop[0].hooks[0]
      assert.match(stop.command, /progress-hook claude Stop$/)
      assert.equal(stop.asyncRewake, true)
      assert.equal(stop.timeout, 18000)
      const prompt = hooks.UserPromptSubmit[0].hooks[0]
      assert.match(prompt.command, /progress-hook claude UserPromptSubmit$/)
      assert.equal(prompt.async, true)
      assert.equal(prompt.asyncRewake, undefined)
      assert.equal(prompt.timeout, 10)
      assert.equal(p.env.SIDEBY_PROGRESS_EVERY, '10')
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude-001'))), [])
      assert.deepEqual(diffSnapshots(main, await snapshot(h.path('.claude'))), [])
    })
  })

  it('goes into the same settings file as the other session hooks and Auto Handoff’s, after them', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {
        progress: { every: 5 },
        unattended: {},
        network: { guard: true, allow: ['US'] },
      })
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      const own = await settingsOf(p.args)
      assert.match(own.file, /network\/claude-settings-unattended-progress-runs\.json$/)
      const handoff = await h.write(
        'state/handoff.json',
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'w', asyncRewake: true, timeout: 18000 }] }],
          },
        }),
      )
      const { hooks } = await settingsOf(
        await withClaudeSessionHooks(['--settings', handoff], p.sessionHookArgs!),
      )
      // Auto Handoff's IdleWatch first, then Unattended Mode's Stop and its Answer Wait, then the reminder's.
      assert.equal(hooks.Stop.length, 4)
      assert.equal(hooks.Stop[0].hooks[0].command, 'w')
      assert.match(hooks.Stop[1].hooks[0].command, /unattended-hook claude Stop$/)
      assert.match(hooks.Stop[2].hooks[0].command, /unattended-hook claude StopWait$/)
      assert.match(hooks.Stop[3].hooks[0].command, /progress-hook claude Stop$/)
      assert.ok(
        hooks.UserPromptSubmit.some((g: { hooks: { command: string }[] }) =>
          /progress-hook claude UserPromptSubmit$/.test(g.hooks[0]!.command),
        ),
      )
    })
  })

  it('a Runtime that runs on (an Auto Handoff chain) follows the setting as it is at each start', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      assert.equal((await rt.prepareLaunch('claude:001', [], 'run')).env.SIDEBY_PROGRESS_EVERY, undefined)
      // Turned on, changed and turned off from elsewhere (the CLI or the Panel) while this Runtime runs.
      await h.write('.config/sideby/config.json', JSON.stringify({ progress: { every: 5 } }))
      const on = await rt.prepareLaunch('claude:001', [], 'run')
      assert.equal(on.env.SIDEBY_PROGRESS_EVERY, '5')
      assert.deepEqual(Object.keys((await settingsOf(on.args)).hooks).sort(), [
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ])
      await h.write('.config/sideby/config.json', JSON.stringify({ progress: { every: 30 } }))
      assert.equal((await rt.prepareLaunch('claude:001', [], 'run')).env.SIDEBY_PROGRESS_EVERY, '30')
      await h.write('.config/sideby/config.json', '{}')
      const off = await rt.prepareLaunch('claude:001', [], 'run')
      assert.equal(off.env.SIDEBY_PROGRESS_EVERY, undefined)
      assert.deepEqual(Object.keys((await settingsOf(off.args)).hooks), ['SessionStart'])
    })
  })

  it('gives Codex, a sign-in and a session with its own --settings no reminder hooks', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { progress: { every: 10 } })
      const codex = await rt.prepareLaunch('codex:main', [], 'run')
      assert.doesNotMatch(codex.args.join(' '), /progress-hook/)
      assert.equal(codex.env.SIDEBY_PROGRESS_EVERY, undefined)
      assert.equal((await rt.prepareLaunch('claude:001', [], 'login')).args.includes('--settings'), false)
      const own = await rt.prepareLaunch('claude:001', ['--settings', 'mine.json'], 'run')
      assert.deepEqual(own.args, ['--settings', 'mine.json'])
      assert.match(own.notice ?? '', /no progress reminders/)
    })
  })
})

describe('Progress Reminders setting', () => {
  it('turns on, changes the interval and turns off through config `progress` only', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { $schema: 'x' })
      const file = h.path('.config/sideby/config.json')
      assert.deepEqual(await rt.setProgress(10), { changed: true, after: 10 })
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { $schema: 'x', progress: { every: 10 } })
      assert.equal(rt.progressView().every, 10)
      assert.deepEqual(await rt.setProgress(10), { changed: false, before: 10, after: 10 })
      assert.deepEqual(await rt.setProgress(30), { changed: true, before: 10, after: 30 })
      assert.deepEqual(await rt.setProgress(undefined), { changed: true, before: 30 })
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { $schema: 'x' })
      assert.equal(rt.progressView().on, false)
      await assert.rejects(rt.setProgress(0), /progress\.every/)
      await assert.rejects(rt.setProgress(241), /progress\.every/)
    })
  })

  it('is read fresh by the hook: no file is off, a broken file falls back to the launch value', async () => {
    await withFakeHome(async (h) => {
      const file = h.path('.config/sideby/config.json')
      assert.equal(await readProgressEvery(file, { SIDEBY_PROGRESS_EVERY: '10' }), undefined)
      await h.write('.config/sideby/config.json', JSON.stringify({ progress: { every: 15 } }))
      assert.equal(await readProgressEvery(file, {}), 15)
      await h.write('.config/sideby/config.json', JSON.stringify({}))
      assert.equal(await readProgressEvery(file, { SIDEBY_PROGRESS_EVERY: '10' }), undefined)
      await h.write('.config/sideby/config.json', '{ not json')
      assert.equal(await readProgressEvery(file, { SIDEBY_PROGRESS_EVERY: '10' }), 10)
      assert.equal(await readProgressEvery(file, { SIDEBY_PROGRESS_EVERY: 'x' }), undefined)
    })
  })
})
