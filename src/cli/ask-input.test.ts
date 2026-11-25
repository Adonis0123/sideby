import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { it } from 'node:test'
import { diffSnapshots, fakeHost, readHostLog, snapshot, withFakeHome } from '../../testing/index.ts'
import { taskWorkDir, writeTask } from '../core/ask.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cli, MP4_HEAD, PNG_HEAD, shape, ttyInput } from './ask-test-helpers.ts'
import { cmdAsk, cmdKey } from './commands.ts'

it("ask --run keeps the account's own arguments, and adds no auto mode, with ask.permissions account (ADR-0070)", async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.codex/config.toml', '')
    await fakeHost(h, 'claude')
    await fakeHost(h, 'codex')
    const rt = await createRuntime({ env: h.env })
    const cwd = await taskWorkDir(rt.paths)
    const claude = ['--model', 'opus', '--dangerously-skip-permissions']
    const codex = ['--dangerously-bypass-approvals-and-sandbox']
    const accounts = { 'claude:main': { args: claude }, 'codex:main': { args: codex } }
    const start = async (account: string) => {
      const id = await writeTask({ kind: 'prompt', account, prompt: 'hi', cwd }, rt.paths)
      assert.equal((await cli(h, ['ask', '--run', id])).code, 0)
    }
    // The default, also when written out: the checks stay on.
    await h.write('.config/sideby/config.json', JSON.stringify({ accounts, ask: { permissions: 'checked' } }))
    await start('claude:main')
    assert.deepEqual((await readHostLog(h, 'claude'))[0]!.argv, [
      '--permission-mode',
      'auto',
      '--model',
      'opus',
      'hi',
    ])
    await h.write('.config/sideby/config.json', JSON.stringify({ accounts, ask: { permissions: 'account' } }))
    await start('claude:main')
    await start('codex:main')
    assert.deepEqual((await readHostLog(h, 'claude'))[1]!.argv, [...claude, 'hi'])
    assert.deepEqual((await readHostLog(h, 'codex'))[0]!.argv, [...codex, 'hi'])
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

it('starts the fixed read-only network diagnosis through preferred Orca without a real AI session', async () => {
  await withFakeHome(async (h) => {
    const { readTask, startAiTask } = await import('../core/ask.ts')
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    await h.write('.config/sideby/config.json', JSON.stringify({ terminal: { preferred: 'orca' } }))
    const apps = await h.mkdir('apps/Orca.app')
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
    const result = await startAiTask(rt, {
      task: 'network-diagnose',
      context: {
        networkDiagnose: ['api.anthropic.com: proxy direct; Guard not-checked'],
      },
    })
    assert.equal(result.opened, true)
    assert.equal(result.terminal, 'orca')
    const task = await readTask(result.task!, rt.paths)
    assert.match(task.prompt!, /fixed read-only task/)
    assert.match(task.prompt!, /proxy direct/)
    assert.doesNotMatch(task.prompt!, /In my words|proxy\.example\.com/)
    assert.doesNotMatch(task.prompt!, /user|password|private|token|secret|fragment|npx skills add/)
    const launch = calls.find((args) => args[0] === 'terminal' && args[1] === 'create')
    assert.ok(launch)
    assert.deepEqual(launch.slice(0, 4), ['terminal', 'create', '--worktree', 'active'])
    const command = launch[launch.indexOf('--command') + 1]!
    assert.match(command, /ask --run '[a-f0-9]{16}'/)
    assert.match(command, /--state-dir/)
  })
})

it('rejects fixed network diagnosis text and attachments before writing the task', async () => {
  await withFakeHome(async (h) => {
    const { startAiTask } = await import('../core/ask.ts')
    const file = h.path('diagnostic.png')
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const rt = await createRuntime({ env: h.env })
    const before = await snapshot(h.home)
    await assert.rejects(
      startAiTask(rt, { task: 'network-diagnose', text: 'user:password@proxy.example.com:8080/private' }),
      /remove added text and attachments/,
    )
    await assert.rejects(
      startAiTask(rt, { task: 'network-diagnose', files: [file] }),
      /remove added text and attachments/,
    )
    await assert.rejects(
      startAiTask(rt, {
        task: 'network-diagnose',
        context: { networkDiagnose: ['raw http://user:pass@word@127.0.0.1:10809/private'] },
      }),
      /redacted diagnostic facts/,
    )
    assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
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

it('ask --task network-diagnose builds current offline facts without starting an AI', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    const print = await cli(h, ['ask', '--task', 'network-diagnose', '--print'], {
      ...h.env,
      HTTPS_PROXY: 'socks5://127.0.0.1',
      LANG: 'en_US.UTF-8',
    })
    assert.equal(print.code, 0, print.err)
    assert.match(print.out, /diagnosed: .* \(offline; no trace sent\)/)
    assert.match(print.out, /proxy socks5:\/\/127\.0\.0\.1/)
    assert.match(print.out, /no local TCP listener probe/)
    assert.match(print.out, /Guard not-checked/)
    assert.doesNotMatch(print.out, /npx skills add/)
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
