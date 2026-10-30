import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import {
  diffSnapshots,
  type FakeHome,
  fakeHost,
  readHostLog,
  snapshot,
  withFakeHome,
} from '../../testing/index.ts'
import { taskWorkDir, writeTask } from '../core/ask.ts'
import { createRuntime } from '../runtime.ts'
import type { Env } from '../types.ts'
import { parseArgs } from './args.ts'
import { cmdAsk, cmdKey } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

// Joined at run time so the source never holds a key-shaped string (leak-check).
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-')

function cli(
  h: FakeHome,
  args: string[],
  env: Env = h.env,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url)), ...args], {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '',
      err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('close', (code) => resolve({ code, out, err }))
  })
}
function shape(name: string, out: string) {
  const data = JSON.parse(out)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[name]!, data),
    JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[name]!, data)]),
  )
  return data as Record<string, string | boolean | null>
}
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
    assert.deepEqual((await readHostLog(h, 'claude'))[0]!.argv, ['--permission-mode', 'auto', prompt])
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
it('ask --run starts Claude without permission bypasses, in auto mode, while sideby run keeps them (ADR-0031)', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await fakeHost(h, 'claude')
    const rt = await createRuntime({ env: h.env })
    const cwd = await taskWorkDir(rt.paths)
    const cases: [string[], string[]][] = [
      [['--dangerously-skip-permissions'], ['--permission-mode', 'auto']],
      [
        ['--model', 'opus', '--dangerously-skip-permissions', '--effort', 'high'],
        ['--permission-mode', 'auto', '--model', 'opus', '--effort', 'high'],
      ],
      [
        ['--permission-mode', 'bypassPermissions', '--verbose'],
        ['--permission-mode', 'auto', '--verbose'],
      ],
      [['--permission-mode=bypassPermissions'], ['--permission-mode', 'auto']],
      [
        ['--allow-dangerously-skip-permissions', '--model', 'opus'],
        ['--permission-mode', 'auto', '--model', 'opus'],
      ],
      [
        ['--dangerously-skip-permissions', '--permission-mode', 'plan'],
        ['--permission-mode', 'plan'],
      ],
    ]
    let n = 0
    for (const [args, want] of cases) {
      await h.write('.config/sideby/config.json', JSON.stringify({ accounts: { 'claude:main': { args } } }))
      const id = await writeTask({ kind: 'prompt', account: 'claude:main', prompt: 'hi', cwd }, rt.paths)
      assert.equal((await cli(h, ['ask', '--run', id])).code, 0)
      assert.deepEqual((await readHostLog(h, 'claude'))[n++]!.argv, [...want, 'hi'], args.join(' '))
      assert.equal((await cli(h, ['run', 'claude:main', '--', 'hi'])).code, 0)
      assert.deepEqual((await readHostLog(h, 'claude'))[n++]!.argv, [...args, 'hi'], `run ${args.join(' ')}`)
    }
  })
})

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
    assert.deepEqual(record.argv, ['--permission-mode', 'auto', 'hi'])
    assert.equal(record.env.HOME, h.home)
    assert.equal(record.env.XDG_STATE_HOME, h.path('panel-state'))
  })
})
it('ask --run refuses a --state-dir that is not a private folder of this user', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await fakeHost(h, 'claude')
    const rt = await createRuntime({ env: h.env })
    const id = await writeTask(
      { kind: 'prompt', account: 'claude:main', prompt: 'hi', cwd: await taskWorkDir(rt.paths) },
      rt.paths,
    )
    const shared = h.path('shared-state')
    await mkdir(join(shared, 'ask'), { recursive: true })
    await chmod(shared, 0o777)
    const linked = h.path('linked-state')
    await symlink(rt.paths.stateDir, linked)
    for (const dir of [shared, linked, 'relative/state', h.path('missing')]) {
      const r = await cli(h, ['ask', '--run', id, '--state-dir', dir])
      assert.equal(r.code, 1, dir)
      assert.match(r.err + r.out, /sideby ask/)
    }
    // An `ask` folder others can read is refused too.
    await chmod(join(rt.paths.stateDir, 'ask'), 0o755)
    assert.equal((await cli(h, ['ask', '--run', id, '--state-dir', rt.paths.stateDir])).code, 1)
    await chmod(join(rt.paths.stateDir, 'ask'), 0o700)
    assert.equal((await cli(h, ['ask', '--run', id, '--state-dir', rt.paths.stateDir])).code, 0)
    assert.equal((await readHostLog(h, 'claude')).length, 1)
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
    const unknown = await cli(h, ['terminal', '--set', 'bogus', '--json'])
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
    assert.equal((await cli(h, ['key', 'claude:main', '--json'])).code, 1)
    const key = await cli(h, ['key', 'claude:api', '--json'])
    assert.equal(key.code, 1)
    assert.match(key.out, /tty-required/)
    await fakeHost(h, 'claude', { exitCode: 1, onStart: 'console.log(process.env.ANTHROPIC_AUTH_TOKEN)' })
    const preview = await cli(h, ['try', 'claude:api', '--json'])
    assert.equal(preview.code, 10)
    assert.equal(shape('try', preview.out).confirmed, false)
    const probe = await cli(h, ['try', 'claude:api', '--yes', '--json'])
    assert.equal(probe.code, 1)
    assert.match(String(shape('try', probe.out).output), /\*\*\*/)
    assert.ok(!probe.out.includes('fictional-secret-value'))
    const created = await cli(h, ['plugins', 'new', 'sample', '--json'])
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
it('key accepts hidden TTY input with backspace and never returns the value', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude-api/proxy.env', '# keep\n', 0o600)
    const rt = await createRuntime({ env: h.env })
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        this.isRaw = raw
        return this
      },
    })
    const output: string[] = []
    const pending = cmdKey(
      parseArgs(['claude:api', '--json'], ['json']),
      {
        out: (s) => output.push(s),
        err: () => {
          setTimeout(() => input.write('fake-valueX\u007f\r'), 5)
        },
        stdin: input,
      },
      rt,
    )
    assert.equal(await pending, 0)
    assert.equal(shape('key', output.join('')).var, 'ANTHROPIC_AUTH_TOKEN')
    assert.ok(!output.join('').includes('fake-value'))
    assert.match(await readFile(h.path('.claude-api/proxy.env'), 'utf8'), /fake-value/)
    assert.equal(input.isRaw, false)
    input.destroy()
  })
})

it('shared Panel launch helpers open prompt and login tasks through injected exec', async () => {
  await withFakeHome(async (h) => {
    const { openLoginInTerminal, openRunInTerminal, readTask, startAiTask } = await import('../core/ask.ts')
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    const apps = await h.mkdir('apps/Terminal.app')
    const calls: string[][] = []
    const rt = await createRuntime({
      env: h.env,
      desktop: {
        platform: 'darwin',
        appDirs: [join(apps, '..')],
        exec: async (_cmd, args) => {
          calls.push([...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      },
    })
    const result = await startAiTask(rt, { task: 'free', text: 'a unique user prompt' })
    assert.equal(result.opened, true)
    assert.ok(!JSON.stringify(calls).includes('a unique user prompt'))
    assert.ok(!JSON.stringify(calls).includes('claude:main'))
    const task = await readTask(result.task!, rt.paths)
    assert.match(task.prompt!, /a unique user prompt/)
    const login = await openLoginInTerminal(rt, 'claude:main')
    assert.equal(login.opened, true)
    assert.equal((await readTask(login.task, rt.paths)).kind, 'login')
    const started = await openRunInTerminal(rt, 'main')
    assert.equal(started.opened, true)
    const runTask = await readTask(started.task, rt.paths)
    assert.deepEqual([runTask.kind, runTask.account, runTask.cwd], ['run', 'claude:main', rt.paths.home])
    const out: string[] = []
    const blocked = await createRuntime({
      env: h.env,
      desktop: {
        platform: 'linux',
        exec: async () => {
          throw new Error('must not execute')
        },
      },
    })
    const err: string[] = []
    assert.equal(
      await cmdAsk(parseArgs([], []), { out: (s) => out.push(s), err: (s) => err.push(s) }, blocked),
      1,
    )
    assert.match(out.join(''), /^'\/[^']+' '\/[^']+' ask --run '[a-f0-9]{16}' --state-dir '\/[^']+'$/)
    assert.match(err.join(''), /paste the task command/)
    const remembered = await startAiTask(rt, { text: 'x', account: 'claude:main', remember: true })
    assert.equal(remembered.opened, true)
    assert.equal(JSON.parse(await readFile(rt.paths.configFile, 'utf8')).ask.account, 'claude:main')
  })
})

it('Ctrl-C cancels key input and restores terminal mode', async () => {
  const { readKeyLine } = await import('./commands.ts')
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw
      return this
    },
  })
  const pending = readKeyLine(input as unknown as NodeJS.ReadStream)
  input.write('never-write-this\u0003')
  await assert.rejects(pending, /Cancelled/)
  assert.equal(input.isRaw, false)
  input.destroy()
})

function ttyInput() {
  return Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw
      return this
    },
  })
}

it('an empty key writes nothing and says to run the command again', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fictional-old-value\n', 0o600)
    const rt = await createRuntime({ env: h.env })
    const before = await readFile(h.path('.claude-api/proxy.env'), 'utf8')
    for (const typed of ['\r', '   \r']) {
      const input = ttyInput()
      await assert.rejects(
        cmdKey(
          parseArgs(['claude:api'], []),
          { out: () => {}, err: () => setTimeout(() => input.write(typed), 5), stdin: input },
          rt,
        ),
        /No key entered; nothing was written\. Run `sideby key claude:api` again\./,
      )
      assert.equal(input.isRaw, false)
      input.destroy()
    }
    assert.equal(await readFile(h.path('.claude-api/proxy.env'), 'utf8'), before)
  })
})

it('key input stops reading stdin afterwards, so the process can exit', async () => {
  const { readKeyLine } = await import('./commands.ts')
  const input = ttyInput()
  assert.equal(input.readableFlowing, null)
  const pending = readKeyLine(input as unknown as NodeJS.ReadStream)
  input.write('fictional-key\r')
  assert.equal(await pending, 'fictional-key')
  assert.equal(input.readableFlowing, false)
  input.destroy()
})

it('key input drops whole escape sequences and joins characters split across chunks', async () => {
  const { readKeyLine } = await import('./commands.ts')
  const input = ttyInput()
  const pending = readKeyLine(input as unknown as NodeJS.ReadStream)
  const euro = Buffer.from('€')
  input.write(Buffer.from('ab\u001b[D\u001b[1;5Cc\u001bOAd'))
  input.write(euro.subarray(0, 1))
  input.write(euro.subarray(1))
  input.write(Buffer.from('e\r'))
  assert.equal(await pending, 'abcd€e')
  input.destroy()
})

it('try --model replaces the model the account and short command choose, and a short command keeps its arguments', async () => {
  await withFakeHome(async (h) => {
    await h.write('.codex/config.toml', '')
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fictional-secret-value\n', 0o600)
    await h.write(
      '.config/sideby/config.json',
      JSON.stringify({
        accounts: { 'claude:api': { args: ['--model', 'fake-model'] } },
        aliases: { 'cc-big': { account: 'claude:api', args: ['--model=alias-model', '--verbose'] } },
      }),
    )
    await fakeHost(h, 'codex')
    await fakeHost(h, 'claude')
    // A short command's arguments apply, as in `sideby run`.
    const viaAlias = shape('try', (await cli(h, ['try', 'cc-big', '--json'])).out)
    assert.equal(viaAlias.account, 'claude:api')
    assert.deepEqual(viaAlias.command, [
      'claude',
      '--model',
      'fake-model',
      '--model=alias-model',
      '--verbose',
      '-p',
      'Reply with OK',
    ])
    // --model takes every earlier choice out, so the Host gets one model.
    const preview = shape('try', (await cli(h, ['try', 'cc-big', '--model', 'other-model', '--json'])).out)
    assert.equal(preview.model, 'other-model')
    assert.deepEqual(preview.command, [
      'claude',
      '--verbose',
      '--model',
      'other-model',
      '-p',
      'Reply with OK',
    ])
    const ran = shape(
      'try',
      (await cli(h, ['try', 'cc-big', '--model', 'other-model', '--yes', '--json'])).out,
    )
    assert.equal(ran.model, 'other-model')
    assert.deepEqual((await readHostLog(h, 'claude'))[0]!.argv, [
      '--verbose',
      '--model',
      'other-model',
      '-p',
      'Reply with OK',
    ])
    // Codex's `exec` reads only its own -m.
    assert.deepEqual(
      shape('try', (await cli(h, ['try', 'codex:main', '--model', 'gpt-x', '--json'])).out).command,
      ['codex', 'exec', '--skip-git-repo-check', '-m', 'gpt-x', 'Reply with OK'],
    )
    const bad = await cli(h, ['try', 'claude:api', '--model', 'a b', '--json'])
    assert.equal(bad.code, 1)
    assert.equal(JSON.parse(bad.out).code, 'model-invalid')
  })
})

it('try starts the Host with Family defaults and config arguments before the probe', async () => {
  await withFakeHome(async (h) => {
    await h.write('.codex/config.toml', '')
    await h.write('.codex-team/config.toml', '')
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fictional-secret-value\n', 0o600)
    await h.write(
      '.config/sideby/config.json',
      JSON.stringify({ accounts: { 'claude:api': { args: ['--model', 'fake-model'] } } }),
    )
    await fakeHost(h, 'codex')
    await fakeHost(h, 'claude')
    const preview = shape('try', (await cli(h, ['try', 'codex:team', '--json'])).out)
    assert.deepEqual(preview.command, [
      'codex',
      '-c',
      'cli_auth_credentials_store="file"',
      'exec',
      '--skip-git-repo-check',
      'Reply with OK',
    ])
    assert.equal((await cli(h, ['try', 'codex:team', '--yes', '--json'])).code, 0)
    assert.deepEqual((await readHostLog(h, 'codex'))[0]!.argv, [
      '-c',
      'cli_auth_credentials_store="file"',
      'exec',
      '--skip-git-repo-check',
      'Reply with OK',
    ])
    assert.equal((await cli(h, ['try', 'claude:api', '--yes', '--json'])).code, 0)
    assert.deepEqual((await readHostLog(h, 'claude'))[0]!.argv, [
      '--model',
      'fake-model',
      '-p',
      'Reply with OK',
    ])
  })
})

it('ask --account remembers the chosen account as the next default', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fictional-secret-value\n', 0o600)
    const rt = await createRuntime({
      env: h.env,
      desktop: { platform: 'linux', exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
    })
    const out: string[] = []
    const args = parseArgs(['x', '--account', 'claude:api', '--json'], ['json'], ['account'])
    assert.equal(await cmdAsk(args, { out: (s) => out.push(s), err: () => {} }, rt), 1)
    const result = shape('ask', out.join(''))
    assert.equal(result.account, 'claude:api')
    assert.equal(result.reason, 'unsupported-platform')
    assert.equal(JSON.parse(await readFile(rt.paths.configFile, 'utf8')).ask.account, 'claude:api')
  })
})

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])

it('ask --run gives Codex each attached image as --image=<path> before the prompt, and others only the prompt', async () => {
  await withFakeHome(async (h) => {
    await h.write('.codex/config.toml', '')
    await h.write('.claude/settings.json', '{}')
    await fakeHost(h, 'codex')
    await fakeHost(h, 'claude')
    const rt = await createRuntime({ env: h.env })
    const cwd = await taskWorkDir(rt.paths)
    const dir = await h.mkdir('.local/state/sideby/ai/attachments/0123456789abcdef')
    const image = join(dir, '1.png')
    const video = join(dir, '2.mp4')
    await writeFile(image, PNG_HEAD)
    await writeFile(video, MP4_HEAD)
    const attachments = [
      { path: image, kind: 'image' as const },
      { path: video, kind: 'video' as const },
      { path: join(dir, '3.png'), kind: 'image' as const },
    ]
    const prompt = 'Why does this fail?'
    const codex = await writeTask(
      { kind: 'prompt', account: 'codex:main', prompt, cwd, attachments },
      rt.paths,
    )
    assert.equal((await cli(h, ['ask', '--run', codex])).code, 0)
    const argv = (await readHostLog(h, 'codex'))[0]!.argv
    // The prompt stays the last positional argument; a missing image and the video are left to the prompt's paths.
    assert.deepEqual(argv.slice(-2), [`--image=${image}`, prompt])
    assert.ok(!argv.some((a) => a.includes('2.mp4') || a.includes('3.png')))
    const claude = await writeTask(
      { kind: 'prompt', account: 'claude:main', prompt, cwd, attachments },
      rt.paths,
    )
    assert.equal((await cli(h, ['ask', '--run', claude])).code, 0)
    assert.deepEqual((await readHostLog(h, 'claude'))[0]!.argv, ['--permission-mode', 'auto', prompt])
  })
})

it('ask --attach checks the files, lists them with --print, and copies them into the task with --json', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    const shot = h.path('shot.png')
    const clip = h.path('clip.mp4')
    await writeFile(shot, PNG_HEAD)
    await writeFile(clip, MP4_HEAD)
    await writeFile(h.path('notes.png'), 'just text')
    const state = h.path('.local/state/sideby')

    const print = await cli(h, ['ask', 'look', '--attach', shot, `--attach=${clip}`, '--print'])
    assert.equal(print.code, 0)
    assert.ok(print.out.includes(`Attached files\n- ${shot} (image)\n- ${clip} (video)\n`))
    assert.match(print.out, /ffmpeg/)
    assert.deepEqual(await readdir(state).catch(() => []), [])

    const wrong = await cli(h, ['ask', 'look', '--attach', h.path('notes.png'), '--json'])
    assert.equal(wrong.code, 1)
    assert.equal(JSON.parse(wrong.out).code, 'attachment-type')
    assert.ok(!wrong.out.includes('just text'))
    const many = await cli(h, ['ask', 'x', ...Array(6).fill(['--attach', shot]).flat(), '--print'])
    assert.equal(many.code, 1)
    assert.match(many.err, /at most 5/)

    const rt = await createRuntime({
      env: h.env,
      desktop: { platform: 'linux', exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
    })
    const out: string[] = []
    const args = { ...parseArgs(['look', '--json'], ['json']), attach: [shot, clip] }
    assert.equal(await cmdAsk(args, { out: (s) => out.push(s), err: () => {} }, rt), 1)
    const result = shape('ask', out.join('')) as unknown as {
      task: string
      attachments: { path: string; kind: string; bytes: number }[]
    }
    const dir = join(state, 'ai/attachments', result.task)
    assert.deepEqual(result.attachments, [
      { path: join(dir, '1.png'), kind: 'image', bytes: PNG_HEAD.length },
      { path: join(dir, '2.mp4'), kind: 'video', bytes: MP4_HEAD.length },
    ])
    const task = JSON.parse(await readFile(join(state, 'ask', `${result.task}.json`), 'utf8'))
    assert.deepEqual(task.attachments, [
      { path: join(dir, '1.png'), kind: 'image' },
      { path: join(dir, '2.mp4'), kind: 'video' },
    ])
    assert.ok(task.prompt.includes(`- ${join(dir, '1.png')} (image)`))
  })
})

it('ask --task terminal prints the terminal prompt, and an unknown task lists every kind', async () => {
  await withFakeHome(async (h) => {
    const print = await cli(h, ['ask', 'I use Warp', '--task', 'terminal', '--print'])
    assert.equal(print.code, 0, print.err)
    assert.match(print.out, /write a custom terminal command\.\nIn my words: I use Warp/)
    assert.match(print.out, /`sideby terminal --custom '<template>'`/)
    assert.match(print.out, /src\/core\/terminal\.ts/)
    const bad = await cli(h, ['ask', '--task', 'bogus', '--print'])
    assert.equal(bad.code, 2)
    assert.match(bad.err, /--task free\|fix\|quota\|account\|host\|plugin\|terminal/)
  })
})

it('ask --run gives Antigravity CLI the prompt through --prompt-interactive, without the permission bypass', async () => {
  await withFakeHome(async (h) => {
    await h.mkdir('.gemini/antigravity-cli')
    await fakeHost(h, 'agy')
    await h.write(
      '.config/sideby/config.json',
      JSON.stringify({ accounts: { 'agy:main': { args: ['--dangerously-skip-permissions'] } } }),
    )
    const rt = await createRuntime({ env: h.env })
    const prompt = '--dangerously-skip-permissions is part of this prompt'
    const id = await writeTask(
      { kind: 'prompt', account: 'agy:main', prompt, cwd: await taskWorkDir(rt.paths) },
      rt.paths,
    )
    assert.equal((await cli(h, ['ask', '--run', id])).code, 0)
    assert.deepEqual((await readHostLog(h, 'agy'))[0]!.argv, [`--prompt-interactive=${prompt}`])
  })
})
