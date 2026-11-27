import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { diffSnapshots, fakeHost, readHostLog, snapshot, withFakeHome } from '../../testing/index.ts'
import { taskWorkDir, writeTask } from '../core/ask.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cli, cliSpawn, FAKE_KEY, shape } from './ask-test-helpers.ts'
import { cmdAsk } from './commands.ts'

it('ask --run drops the Codex bypass flags for an AI Task only (ADR-0031)', async () => {
  await withFakeHome(async (h) => {
    await h.write('.codex/config.toml', '')
    await fakeHost(h, 'codex')
    const args = ['--yolo', '-m', 'gpt-5', '--dangerously-bypass-approvals-and-sandbox']
    await h.write('.config/sideby/config.json', JSON.stringify({ accounts: { 'codex:main': { args } } }))
    const rt = await createRuntime({ env: h.env })
    const id = await writeTask(
      { kind: 'prompt', account: 'codex:main', prompt: 'hi', cwd: await taskWorkDir(rt.paths) },
      rt.paths,
    )
    assert.equal((await cli(h, ['ask', '--run', id])).code, 0)
    assert.deepEqual((await readHostLog(h, 'codex'))[0]!.argv, ['-m', 'gpt-5', 'hi'])
    assert.equal((await cli(h, ['run', 'codex:main', '--', 'hi'])).code, 0)
    assert.deepEqual((await readHostLog(h, 'codex'))[1]!.argv, [...args, 'hi'])
  })
})

it("ask --run finds and runs a task the Panel wrote under another state folder, with the Panel's HOME", async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await fakeHost(h, 'claude', { exitCode: 3 })
    // The Panel runs with its own XDG_STATE_HOME; the terminal that opens has none.
    const panelEnv = { ...h.env, XDG_STATE_HOME: h.path('panel-state') }
    const rt = await createRuntime({ env: panelEnv })
    const id = await writeTask(
      { kind: 'prompt', account: 'claude:main', prompt: 'hi', cwd: await taskWorkDir(rt.paths) },
      rt.paths,
    )
    const { XDG_STATE_HOME: _, ...terminalEnv } = h.env
    terminalEnv.HOME = h.path('elsewhere')
    await h.mkdir('elsewhere')
    assert.equal((await cli(h, ['ask', '--run', id], terminalEnv)).code, 1, 'not found without the folder')
    assert.equal((await cli(h, ['ask', '--run', id, '--state-dir', rt.paths.stateDir], terminalEnv)).code, 3)
    const record = (await readHostLog(h, 'claude'))[0]!
    const at = record.argv.indexOf('--settings')
    const stripped =
      at >= 0 && record.argv[at + 1]?.endsWith('/runs/claude-settings.json')
        ? [...record.argv.slice(0, at), ...record.argv.slice(at + 2)]
        : record.argv
    assert.deepEqual(stripped, ['--permission-mode', 'auto', 'hi'])
    assert.equal(record.env.HOME, h.home)
    assert.equal(record.env.XDG_STATE_HOME, h.path('panel-state'))
  })
})
it('terminal failure returns paste command, strips secrets, and never writes Host directories', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    const apps = await h.mkdir('apps/Terminal.app')
    const rt = await createRuntime({
      env: h.env,
      desktop: {
        platform: 'darwin',
        appDirs: [join(apps, '..')],
        exec: async () => ({ code: -1743, stdout: '', stderr: '' }),
      },
    })
    const before = await snapshot(h.path('.claude'))
    const out: string[] = [],
      err: string[] = []
    const args = parseArgs([FAKE_KEY, '--json'], ['json'])
    assert.equal(await cmdAsk(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, rt), 1)
    const result = shape('ask', out.join(''))
    assert.equal(result.opened, false)
    assert.equal(result.removedSecrets, true)
    assert.match(
      String(result.command),
      /^'\/[^']+' '\/[^']+\/cli\/main\.ts' ask --run '[a-f0-9]{16}' --state-dir '\/[^']+'$/,
    )
    assert.equal(result.reason, 'automation-denied')
    assert.match(String(result.detail), /Automation/)
    assert.match(err.join(''), /Automation/)
    assert.ok(!out.join('').includes(FAKE_KEY))
    assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
  })
})
it('CLI print, empty fallback, terminal persistence, key refusal, probe and plugins have JSON contracts', async () => {
  await withFakeHome(async (h) => {
    const print = await cli(h, ['ask', 'hello', '--print'])
    assert.equal(print.code, 0)
    assert.match(print.out, /hello/)
    const empty = await cli(h, ['ask', '--json'])
    assert.equal(empty.code, 1)
    assert.equal(shape('ask', empty.out).reason, 'no-accounts')
    assert.match(String(shape('ask', empty.out).detail), /sideby new <family> --next/)
    const unknown = await cliSpawn(h, ['terminal', '--set', 'bogus', '--json'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.out, /terminal, iterm2, ghostty.*custom.*sideby terminal/)
    const noTemplate = await cli(h, ['terminal', '--set', 'custom', '--json'])
    assert.equal(noTemplate.code, 1)
    assert.match(noTemplate.out, /sideby terminal --custom/)
    assert.equal((await cli(h, ['terminal', '--custom', 'my-term {cmd}', '--json'])).code, 1)
    const custom = await cli(h, ['terminal', '--custom', 'my-term --cwd {cwd} -e {cmd}', '--json'])
    assert.equal(custom.code, 0)
    assert.equal(shape('terminal', custom.out).preferred, 'custom')
    const saved = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
    assert.equal(saved.terminal.custom, 'my-term --cwd {cwd} -e {cmd}')
    const terminal = await cli(h, ['terminal', '--set', 'orca', '--json'])
    assert.equal(terminal.code, 0)
    assert.equal(shape('terminal', terminal.out).preferred, 'orca')
    assert.equal(shape('terminal', (await cli(h, ['terminal', '--unset', '--json'])).out).preferred, null)
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fictional-secret-value\n', 0o600)
    assert.equal((await cliSpawn(h, ['key', 'claude:main', '--json'])).code, 1)
    const key = await cli(h, ['key', 'claude:api', '--json'])
    assert.equal(key.code, 1)
    assert.match(key.out, /tty-required/)
    await fakeHost(h, 'claude', { exitCode: 1, onStart: 'console.log(process.env.ANTHROPIC_AUTH_TOKEN)' })
    const preview = await cliSpawn(h, ['try', 'claude:api', '--json'])
    assert.equal(preview.code, 10)
    assert.equal(shape('try', preview.out).confirmed, false)
    const probe = await cli(h, ['try', 'claude:api', '--yes', '--json'])
    assert.equal(probe.code, 1)
    assert.match(String(shape('try', probe.out).output), /\*\*\*/)
    assert.ok(!probe.out.includes('fictional-secret-value'))
    const created = await cliSpawn(h, ['plugins', 'new', 'sample', '--json'])
    assert.equal(created.code, 0)
    shape('plugins-new', created.out)
    assert.equal((await cli(h, ['plugins', 'new', 'sample', '--json'])).code, 1)
    const check = await cli(h, ['plugins', 'check', 'sample', '--json'])
    assert.equal(check.code, 1)
    assert.equal(shape('plugins-check', check.out).ok, false)
    for (const name of ['index.ts', 'index.test.ts']) {
      const file = h.path('.config/sideby/plugins/sample', name)
      await writeFile(
        file,
        (await readFile(file, 'utf8'))
          .split('\n')
          .filter((line) => !line.includes('TODO(sideby)'))
          .join('\n'),
      )
    }
    const valid = await cli(h, ['plugins', 'check', 'sample', '--json'])
    assert.equal(valid.code, 0)
    assert.equal(shape('plugins-check', valid.out).ok, true)
    await fakeHost(h, 'claude')
    const ok = await cli(h, ['try', 'claude:api', '--yes', '--json'])
    assert.equal(ok.code, 0)
    assert.equal(shape('try', ok.out).ok, true)
  })
})
