import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chmod, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { BUILTIN_PLUGINS } from '../families/index.ts'
import { createRuntime } from '../runtime.ts'
import {
  pickTaskAccount,
  readTask,
  taskWorkDir,
  terminals,
  tryAccount,
  tryPreview,
  writeTask,
} from './ask.ts'

it('keeps tasks private, consumes once, and rejects invalid or stale files', async () => {
  await withFakeHome(async (h) => {
    const rt = await createRuntime({ env: h.env })
    const task = {
      kind: 'prompt' as const,
      account: 'claude:main',
      prompt: "' $(no) `no`\nhello",
      cwd: h.home,
    }
    const id = await writeTask(task, rt.paths)
    const file = join(rt.paths.stateDir, 'ask', `${id}.json`)
    assert.match(id, /^[a-f0-9]{16}$/)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await readTask(id, rt.paths), {
      ...task,
      home: rt.paths.home,
      configDir: rt.paths.configDir,
      stateDir: rt.paths.stateDir,
    })
    await assert.rejects(readTask(id, rt.paths), /sideby ask/)
    await assert.rejects(readTask('../bad', rt.paths), /sideby ask/)
    const bad = await writeTask(task, rt.paths)
    const badFile = join(rt.paths.stateDir, 'ask', `${bad}.json`)
    await chmod(badFile, 0o644)
    await assert.rejects(readTask(bad, rt.paths))
    await chmod(badFile, 0o600)
    await utimes(badFile, 0, 0)
    await assert.rejects(readTask(bad, rt.paths))
    assert.deepEqual(await pickTaskAccount(rt), { reason: 'no-accounts' })
  })
})

it('ranks signed-in subscriptions across families and respects explicit choices', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-work/settings.json', '{}')
    await h.write('.codex/config.toml', '')
    await h.write('.claude-api/proxy.env', '', 0o600)
    const rt = await createRuntime({ env: h.env })
    const original = rt.status
    const loggedOut = new Set<string>()
    rt.status = async (a) => ({
      ...(await original(a)),
      login: loggedOut.has(a.ref) ? 'logged-out' : 'logged-in',
    })
    const pressure: Record<string, number> = { 'claude:main': 70, 'claude:work': 40, 'codex:main': 20 }
    rt.quota = async (a) => ({
      status: 'ok',
      source: 'test',
      observedAt: new Date().toISOString(),
      windows: [
        {
          label: '5h',
          windowMinutes: 300,
          usedPercent: pressure[a.ref] ?? 100,
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    })
    const chosen = async () => {
      const p = await pickTaskAccount(rt)
      return 'account' in p ? p.account.ref : p.reason
    }
    assert.equal(await chosen(), 'codex:main')
    rt.config.ask = { account: 'claude:work' }
    assert.equal(await chosen(), 'claude:work')
    loggedOut.add('claude:work')
    assert.equal(await chosen(), 'codex:main')
    rt.quota = async () => ({ status: 'unavailable', reason: 'no-source' })
    assert.equal(await chosen(), 'claude:main')
    const api = await pickTaskAccount(rt, { account: 'claude:api' })
    assert.ok('account' in api && api.account.kind === 'api')
    rt.config.ask = { account: 'claude:api' }
    assert.equal(await chosen(), 'claude:api')
    rt.config.ask = { account: 'claude:work' }
    loggedOut.add('claude:main')
    loggedOut.add('codex:main')
    assert.equal(await chosen(), 'none-signed-in')
    loggedOut.clear()
    delete rt.config.ask
    rt.quota = async () => ({
      status: 'ok',
      source: 'test',
      observedAt: new Date().toISOString(),
      windows: [
        {
          label: '5h',
          windowMinutes: 300,
          usedPercent: 100,
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    })
    assert.equal(await chosen(), 'all-full')
  })
})

it('rejects symlinks, non-regular tasks and a different owner', async () => {
  await withFakeHome(async (h) => {
    const { mkdir, symlink } = await import('node:fs/promises')
    const { mock } = await import('node:test')
    const rt = await createRuntime({ env: h.env })
    const id = await writeTask({ kind: 'login', account: 'claude:main', cwd: h.home }, rt.paths)
    const dir = join(rt.paths.stateDir, 'ask')
    await symlink(join(dir, `${id}.json`), join(dir, '1111111111111111.json'))
    await assert.rejects(readTask('1111111111111111', rt.paths))
    await mkdir(join(dir, '2222222222222222.json'))
    await assert.rejects(readTask('2222222222222222', rt.paths))
    const uid = process.getuid!()
    const owner = mock.method(process as NodeJS.Process & { getuid: () => number }, 'getuid', () => uid + 1)
    try {
      await assert.rejects(readTask(id, rt.paths))
    } finally {
      owner.mock.restore()
    }
    assert.equal((await readTask(id, rt.paths)).kind, 'login')
  })
})

it('config writers keep other keys and reject concurrent changes and unknown terminals', async () => {
  await withFakeHome(async (h) => {
    const { editConfigAsk, editConfigTerminal, loadConfig } = await import('./config.ts')
    const { readFile } = await import('node:fs/promises')
    const rt = await createRuntime({ env: h.env })
    await h.write(
      '.config/sideby/config.json',
      '{"ignore":[],"terminal":{"custom":"test {cmd} {cwd}"},"accountTitle":true}\n',
    )
    await editConfigTerminal(rt.paths.configFile, { preferred: 'orca' })
    await editConfigAsk(rt.paths.configFile, 'claude:main')
    const raw = await readFile(rt.paths.configFile, 'utf8')
    assert.ok(
      raw.indexOf('ignore') < raw.indexOf('terminal') &&
        raw.indexOf('terminal') < raw.indexOf('accountTitle'),
    )
    assert.equal((await loadConfig(rt.paths.configFile)).terminal?.custom, 'test {cmd} {cwd}')
    await assert.rejects(editConfigTerminal(rt.paths.configFile, { preferred: 'bogus' }))
    await editConfigTerminal(rt.paths.configFile, { preferred: undefined })
    assert.equal((await loadConfig(rt.paths.configFile)).terminal?.custom, 'test {cmd} {cwd}')
    // A getter changes the file after the writer captures its original hash.
    const changed = '{"ignore":["claude:work"]}\n'
    await assert.rejects(
      editConfigTerminal(rt.paths.configFile, {
        get preferred() {
          writeFileSync(rt.paths.configFile, changed)
          return 'orca'
        },
      }),
    )
    assert.equal(await readFile(rt.paths.configFile, 'utf8'), changed)
  })
})

it('only API accounts are never selected automatically', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude-api/proxy.env', '', 0o600)
    const rt = await createRuntime({ env: h.env })
    assert.deepEqual(await pickTaskAccount(rt), { reason: 'none-signed-in' })
  })
})

it('keeps task directories at 700, refuses a linked one, and removes tasks older than an hour', async () => {
  await withFakeHome(async (h) => {
    const { readdir, rename, mkdir, symlink, writeFile } = await import('node:fs/promises')
    const rt = await createRuntime({ env: h.env })
    const task = { kind: 'login' as const, account: 'claude:main', cwd: h.home }
    const fresh = await writeTask(task, rt.paths)
    const dir = join(rt.paths.stateDir, 'ask')
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(await taskWorkDir(rt.paths))).mode & 0o777, 0o700)
    const stale = await writeTask(task, rt.paths)
    await utimes(join(dir, `${stale}.json`), 0, 0)
    await writeFile(join(dir, 'notes.txt'), 'not a task')
    await utimes(join(dir, 'notes.txt'), 0, 0)
    const next = await writeTask(task, rt.paths)
    assert.deepEqual((await readdir(dir)).sort(), [`${fresh}.json`, `${next}.json`, 'notes.txt'].sort())
    await rename(dir, join(rt.paths.stateDir, 'elsewhere'))
    await mkdir(join(h.home, 'target'), { recursive: true })
    await symlink(join(h.home, 'target'), dir)
    await assert.rejects(writeTask(task, rt.paths), /Unsafe task directory/)
    assert.deepEqual(await readdir(join(h.home, 'target')), [])
  })
})

it('looks for terminals only in the injected app folders', async () => {
  await withFakeHome(async (h) => {
    const apps = await h.mkdir('apps')
    const rt = await createRuntime({
      env: h.env,
      desktop: {
        platform: 'darwin',
        appDirs: [apps],
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      },
    })
    assert.deepEqual((await terminals(rt)).installed, [])
    await h.mkdir('apps/iTerm.app')
    const found = await terminals(rt)
    assert.deepEqual(found.installed, [{ id: 'iterm2', appPath: join(apps, 'iTerm.app') }])
    assert.equal(found.guess.id, 'terminal')
  })
})

it('try previews without launch.before hooks and runs them exactly once when it runs', async () => {
  await withFakeHome(async (h) => {
    await h.write('.claude/settings.json', '{}')
    await h.write(
      '.config/sideby/config.json',
      JSON.stringify({ accounts: { 'claude:main': { args: ['--x'] } } }),
    )
    let calls = 0
    const counter = {
      plugin: {
        name: 'counter',
        register(api: import('../types.ts').PluginApi) {
          api.on('launch.before', (ctx) => {
            calls++
            ctx.args.push('--from-hook')
          })
        },
      },
      version: '0.0.0',
      description: 'counts launch.before',
      defaultEnabled: true,
    }
    const rt = await createRuntime({ env: h.env, builtins: [...BUILTIN_PLUGINS, counter] })
    const preview = await tryPreview(rt, 'claude:main')
    assert.equal(calls, 0)
    assert.deepEqual(preview.command, ['claude', '--x', '-p', 'Reply with OK'])
    const seen: string[][] = []
    const result = await tryAccount(rt, 'claude:main', async (req) => {
      seen.push([req.bin, ...req.args])
      return { exitCode: 0, stdout: 'OK', stderr: '', timedOut: false }
    })
    assert.equal(calls, 1)
    assert.deepEqual(seen, [['claude', '--x', '-p', 'Reply with OK', '--from-hook']])
    assert.deepEqual(result.command, seen[0])
  })
})
