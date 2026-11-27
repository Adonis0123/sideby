import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { it } from 'node:test'
import { diffSnapshots, fakeHost, readHostLog, snapshot, withFakeHome } from '../../testing/index.ts'
import { taskWorkDir, writeTask } from '../core/ask.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cli, shape } from './ask-test-helpers.ts'
import { cmdAsk } from './commands.ts'

it('ask --run passes one prompt argument, cwd, Host exit code, and login arguments', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await fakeHost(h, 'claude', {
      exitCode: 7,
      onStart: "fs.writeFileSync(path.join(process.env.HOME, 'cwd.txt'), process.cwd())",
    })
    const rt = await createRuntime({ env: h.env })
    const cwd = await taskWorkDir(rt.paths)
    const prompt = 'quotes \'" $(do-not-run) `also-not`\nsecond line'
    const id = await writeTask({ kind: 'prompt', account: 'claude:main', prompt, cwd }, rt.paths)
    assert.equal((await cli(h, ['ask', '--run', id])).code, 7)
    const firstArgv = (await readHostLog(h, 'claude'))[0]!.argv
    const at = firstArgv.indexOf('--settings')
    const stripped =
      at >= 0 && firstArgv[at + 1]?.endsWith('/runs/claude-settings.json')
        ? [...firstArgv.slice(0, at), ...firstArgv.slice(at + 2)]
        : firstArgv
    assert.deepEqual(stripped, ['--permission-mode', 'auto', prompt])
    assert.equal(await readFile(h.path('cwd.txt'), 'utf8'), cwd)
    const login = await writeTask({ kind: 'login', account: 'claude:main', cwd }, rt.paths)
    assert.equal((await cli(h, ['ask', '--run', login])).code, 7)
    assert.deepEqual((await readHostLog(h, 'claude'))[1]!.argv, ['auth', 'login'])
    // The Menu Bar Item's `run` (spec §3.31): the Host as `sideby run` starts it, with no prompt.
    const run = await writeTask({ kind: 'run', account: 'claude:main', cwd: h.home }, rt.paths)
    assert.equal((await cli(h, ['ask', '--run', run])).code, 7)
    assert.ok(!(await readHostLog(h, 'claude'))[2]!.argv.includes('--permission-mode'))
    assert.equal(await readFile(h.path('cwd.txt'), 'utf8'), await realpath(h.home))
  })
})
it('ask --permissions shows the setting, shows a change and waits for --yes, then writes it (ADR-0070)', async () => {
  await withFakeHome(async (h) => {
    await h.write('.config/sideby/config.json', JSON.stringify({ ask: { account: 'claude:work' } }))
    const read = async () => JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
    const now = await cli(h, ['ask', '--permissions', '--json'])
    assert.equal(now.code, 0)
    assert.equal(shape('ask-permissions', now.out).permissions, 'checked')
    assert.match((await cli(h, ['ask', '--permissions'])).out, /keep the permission checks on/)

    const before = await snapshot(h.path('.config'))
    const preview = await cli(h, ['ask', '--permissions', 'account'])
    assert.equal(preview.code, 10)
    assert.match(preview.out, /ask\.permissions checked → account/)
    assert.match(preview.out, /--dangerously-skip-permissions/)
    assert.match(preview.out, /sideby ask --permissions account --yes/)
    assert.deepEqual(
      diffSnapshots(before, await snapshot(h.path('.config'))),
      [],
      'nothing written without --yes',
    )
    const shown = await cli(h, ['ask', '--permissions', 'account', '--json'])
    assert.equal(shown.code, 10)
    assert.deepEqual(
      { ...shape('ask-permissions', shown.out), file: undefined },
      {
        schemaVersion: 1,
        permissions: 'checked',
        changed: true,
        applied: false,
        before: 'checked',
        after: 'account',
        file: undefined,
      },
    )

    const yes = await cli(h, ['ask', '--permissions', 'account', '--yes', '--json'])
    assert.equal(yes.code, 0)
    const done = shape('ask-permissions', yes.out)
    assert.equal(done.permissions, 'account')
    assert.equal(done.applied, true)
    assert.deepEqual((await read()).ask, { account: 'claude:work', permissions: 'account' })
    assert.match((await cli(h, ['ask', '--permissions', 'account'])).out, /Nothing to change/)

    // Back to checked needs --yes too, and removes the key; the other ask settings stay.
    assert.equal((await cli(h, ['ask', '--permissions', 'checked'])).code, 10)
    assert.equal((await cli(h, ['ask', '--permissions', 'checked', '--yes'])).code, 0)
    assert.deepEqual((await read()).ask, { account: 'claude:work' })

    // Mistakes say what to type instead.
    const bad = await cli(h, ['ask', '--permissions', 'off'])
    assert.equal(bad.code, 2)
    assert.match(bad.err, /sideby ask --permissions account/)
    assert.equal((await cli(h, ['ask', '--permissions', 'account', '--task', 'fix'])).code, 2)
    assert.equal((await cli(h, ['ask', 'hello', '--yes'])).code, 2)
  })
})

it('sideby ask says how the AI Task starts: checks on, or the account arguments with ask.permissions account', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    await h.mkdir('apps/Terminal.app')
    const opened = async () => {
      const rt = await createRuntime({
        env: h.env,
        desktop: {
          platform: 'darwin',
          appDirs: [h.path('apps')],
          exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        },
      })
      const out: string[] = []
      const a = parseArgs(['hi', '--account', 'claude:main'], ['json'], ['account']) as Parameters<
        typeof cmdAsk
      >[0]
      assert.equal(await cmdAsk(a, { out: (l) => out.push(l), err: () => {} }, rt), 0)
      return out.join('\n')
    }
    assert.match(await opened(), /Its permission checks stay on/)
    await h.write('.config/sideby/config.json', JSON.stringify({ ask: { permissions: 'account' } }))
    const line = await opened()
    assert.match(line, /starts with the account's own arguments, so its permission checks may be off/)
    assert.doesNotMatch(line, /stay on/)
  })
})
