// End-to-end CLI tests (spec §5: 1, 2, 3, 11, 12 and the --json contract), run as real child processes
// against a fake HOME and fake Host binaries.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
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
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  err: string
}

function sideby(h: FakeHome, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...h.env, ...extraEnv } as NodeJS.ProcessEnv,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }))
  })
}

function checkSchema(name: string, text: string) {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

async function codexMain(h: FakeHome) {
  await h.write('.codex/config.toml', 'model = "gpt-main"\n')
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.mkdir('.codex/skills')
}

describe('first run', () => {
  it('explains what to do on an empty machine and lists a main account once it exists', async () => {
    await withFakeHome(async (h) => {
      const empty = await sideby(h, [])
      assert.equal(empty.code, 0)
      assert.match(empty.out, /No accounts found yet/)
      assert.match(empty.out, /Install a host first/)
      await codexMain(h)
      await fakeHost(h, 'codex')
      const r = await sideby(h, ['list', '--json'])
      const data = checkSchema('list', r.out)
      assert.deepEqual(
        (data.accounts as { ref: string }[]).map((a) => a.ref),
        ['codex:main'],
      )
      const human = await sideby(h, [])
      assert.match(human.out, /codex:main/)
      assert.match(human.out, /gpt-main/)
    })
  })
})

describe('list identity', () => {
  it('shows the signed-in email in the table and in valid --json, and no token', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      const claims = Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url')
      await h.write(
        '.codex/auth.json',
        JSON.stringify({
          tokens: { id_token: `e30.${claims}.fake-sig-XYZ`, refresh_token: 'fake-refresh-XYZ' },
        }),
        0o600,
      )
      const r = await sideby(h, ['list', '--json'])
      const data = checkSchema('list', r.out)
      assert.deepEqual((data.accounts as { identity?: unknown }[])[0]?.identity, {
        email: 'codex@example.com',
      })
      assert.equal(r.out.includes('fake-sig-XYZ') || r.out.includes('fake-refresh-XYZ'), false)
      const human = await sideby(h, ['list'])
      assert.match(human.out, /EMAIL/)
      assert.match(human.out, /codex@example\.com/)
    })
  })
})

describe('first run with Claude Code', () => {
  it('lists claude:main, suggests the next command, and reports quota setup state as JSON', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude.json', JSON.stringify({ oauthAccount: { id: 'x' } }), 0o600)
      await fakeHost(h, 'claude')
      const r = await sideby(h, [])
      assert.equal(r.code, 0)
      assert.match(r.out, /claude:main/)
      assert.match(r.out, /sideby new <family> <name>/)
      const off = await sideby(h, ['quota', 'teardown', 'claude', '--json'])
      assert.equal(off.code, 1)
      checkSchema('quota-teardown', off.out)
      const plan = await sideby(h, ['quota', 'setup', 'claude', '--json'])
      checkSchema('quota-setup', plan.out)
    })
  })
})

describe('run', () => {
  it('isolates the account: select variable, cleared hijack variables, file-store login, args', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['new', 'codex', 'work'])).code, 0)
      const r = await sideby(h, ['run', 'work', '--', '--resume', 'x y'], {
        OPENAI_API_KEY: 'leak',
        CODEX_HOME: '/wrong',
      })
      assert.equal(r.code, 0, r.err)
      const [rec] = await readHostLog(h, 'codex')
      assert.equal(rec!.env.CODEX_HOME, h.path('.codex-work'))
      assert.equal(rec!.env.OPENAI_API_KEY, undefined)
      assert.deepEqual(rec!.argv, ['-c', 'cli_auth_credentials_store="file"', '--resume', 'x y'])

      await sideby(h, ['run', 'codex:main', 'exec', 'hi'], { CODEX_HOME: '/wrong' })
      const main = (await readHostLog(h, 'codex'))[1]!
      assert.equal(main.env.CODEX_HOME, undefined)
      assert.deepEqual(main.argv, ['exec', 'hi'])

      await sideby(h, ['login', 'codex:work'])
      assert.deepEqual((await readHostLog(h, 'codex'))[2]!.argv, [
        '-c',
        'cli_auth_credentials_store="file"',
        'login',
      ])
    })
  })

  it('tells the host which account it is: SIDEBY_ACCOUNT, and SIDEBY_LABEL from the short command used or owned', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['new', 'codex', '002', '--alias', 'codex002'])).code, 0)
      assert.equal(
        (await sideby(h, ['alias', 'add', 'cx-fast', 'codex:002', '--', '--model', 'mini'])).code,
        0,
      )
      assert.equal((await sideby(h, ['new', 'codex', 'work'])).code, 0)
      const inherited = { SIDEBY_ACCOUNT: 'claude:001', SIDEBY_LABEL: 'cc001' }
      const runs: [string, string, string][] = [
        ['cx-fast', 'codex:002', 'cx-fast'], // started through an alias: that alias, even one with Host arguments
        ['codex:002', 'codex:002', 'codex002'], // by ref: the Account's alias without Host arguments
        ['work', 'codex:work', 'codex:work'], // no alias: the ref
        ['codex:main', 'codex:main', 'codex:main'],
      ]
      for (const [i, [ref]] of runs.entries()) {
        assert.equal((await sideby(h, ['run', ref], inherited)).code, 0)
        const rec = (await readHostLog(h, 'codex'))[i]!
        assert.equal(rec.env.SIDEBY_ACCOUNT, runs[i]![1], ref)
        assert.equal(rec.env.SIDEBY_LABEL, runs[i]![2], ref)
      }
    })
  })

  it('accountTitle sets the title to the label and keeps Codex from replacing it, unless the user sets it', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['new', 'codex', '002', '--alias', 'codex002'])).code, 0)
      const keep = ['-c', 'tui.terminal_title=[]']
      const store = ['-c', 'cli_auth_credentials_store="file"']
      await sideby(h, ['run', 'codex002'])
      assert.deepEqual((await readHostLog(h, 'codex'))[0]!.argv, store, 'off by default')

      const file = h.path('.config/sideby/config.json')
      await writeFile(
        file,
        JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), accountTitle: true }),
      )
      await sideby(h, ['run', 'codex002', '--', 'exec', 'hi'])
      assert.deepEqual((await readHostLog(h, 'codex'))[1]!.argv, [...store, ...keep, 'exec', 'hi'])
      await sideby(h, ['run', 'codex002', '--', '-c', 'tui.terminal_title=["model"]'])
      assert.deepEqual((await readHostLog(h, 'codex'))[2]!.argv, [
        ...store,
        '-c',
        'tui.terminal_title=["model"]',
      ])

      const { createRuntime } = await import('../runtime.ts')
      const rt = await createRuntime({ env: h.env })
      assert.equal((await rt.prepareLaunch('codex:002', [], 'run')).title, '[codex002]')
      assert.equal((await rt.prepareLaunch('codex:main', [], 'run')).title, '[codex:main]')
    })
  })

  it('loads an API account Secret File only into the host and enforces mode 600', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      // An API account copies config.toml; a FIFO cannot be copied, so creation is only partly done.
      const { execFileSync } = await import('node:child_process')
      const { rename } = await import('node:fs/promises')
      await rename(h.path('.codex/config.toml'), h.path('.codex/config.toml.real'))
      execFileSync('mkfifo', [h.path('.codex/config.toml')])
      const partial = await sideby(h, ['new', 'codex', 'partial', '--api'])
      assert.equal(partial.code, 1)
      assert.match(partial.out, /with problems; see below/)
      assert.doesNotMatch(partial.out, /✓ created/)
      const { rm } = await import('node:fs/promises')
      await rm(h.path('.codex/config.toml'))
      await rename(h.path('.codex/config.toml.real'), h.path('.codex/config.toml'))
      const created = await sideby(h, ['new', 'codex', 'relay', '--api', '--json'])
      checkSchema('new', created.out)
      const secret = h.path('.codex-relay', 'proxy.env')
      assert.equal((await stat(secret)).mode & 0o777, 0o600)
      await writeFile(
        secret,
        'export OPENAI_BASE_URL="https://relay.invalid/v1"\nMASTER=sk-test # comment\nOPENAI_API_KEY="$MASTER"\nNOTIFY=$HOME/bin/notify\n',
      )
      assert.equal((await sideby(h, ['run', 'relay'])).code, 0)
      const [rec] = await readHostLog(h, 'codex')
      assert.equal(rec!.env.OPENAI_BASE_URL, 'https://relay.invalid/v1')
      assert.equal(rec!.env.OPENAI_API_KEY, 'sk-test')
      assert.equal(rec!.env.NOTIFY, h.path('bin/notify'))

      await chmod(secret, 0o644)
      const loose = await sideby(h, ['run', 'relay'])
      assert.equal(loose.code, 1)
      assert.match(loose.err, /chmod 600/)
      assert.doesNotMatch(loose.err, /sk-test/)

      await chmod(secret, 0o600)
      await writeFile(secret, 'OPENAI_API_KEY=ok\nthis is not valid\n')
      const bad = await sideby(h, ['run', 'relay'])
      assert.equal(bad.code, 1)
      assert.match(bad.err, /proxy\.env:2: expected KEY=VALUE/)
      assert.doesNotMatch(bad.err, /this is not valid/)
      assert.equal((await readHostLog(h, 'codex')).length, 1)

      // A config alias starts the same account.
      await writeFile(secret, 'OPENAI_API_KEY=ok\n')
      await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { rl: 'codex:relay' } }))
      assert.equal((await sideby(h, ['run', 'rl'])).code, 0)
      assert.equal((await readHostLog(h, 'codex')).at(-1)!.env.CODEX_HOME, h.path('.codex-relay'))
    })
  })

  it('returns the host exit code, and 128+n when a signal ends it', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex', { exitCode: 3 })
      assert.equal((await sideby(h, ['run', 'codex:main'])).code, 3)
      await fakeHost(h, 'codex', { selfSignal: 'SIGTERM' })
      assert.equal((await sideby(h, ['run', 'codex:main'])).code, 143)
    })
  })

  it('explains a missing host and an ambiguous name', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      const missing = await sideby(h, ['run', 'codex:main'])
      assert.equal(missing.code, 1)
      assert.match(missing.err, /Codex is not installed.*github\.com\/openai\/codex/)
      await h.write('.codex-work/config.toml', '')
      await h.write('.grok/config.toml', 'model = "g"\n')
      await h.write('.grok-work/config.toml', '')
      const amb = await sideby(h, ['run', 'work'])
      assert.equal(amb.code, 1)
      assert.match(amb.err, /ambiguous; use one of: codex:work, grok:work/)
      const unknown = await sideby(h, ['frobnicate'])
      assert.equal(unknown.code, 2)
      // Missing accounts or families are 1; only malformed command lines are 2.
      assert.equal((await sideby(h, ['quota', 'setup', 'nofamily'])).code, 1)
      assert.equal((await sideby(h, ['doctor', 'nosuch'])).code, 1)
      assert.equal((await sideby(h, ['new', 'codex'])).code, 2)
      const passthrough = await sideby(h, ['run', 'nosuch', '--', '--json'])
      assert.equal(passthrough.out, '')
      assert.match(passthrough.err, /no account named nosuch/)
    })
  })
})

describe('signals', () => {
  async function startSleeping(h: FakeHome) {
    await codexMain(h)
    await fakeHost(h, 'codex', { sleep: 5 })
    const child = spawn(process.execPath, [MAIN, 'run', 'codex:main'], {
      env: h.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    for (let i = 0; i < 100 && (await readHostLog(h, 'codex')).length === 0; i++)
      await new Promise((r) => setTimeout(r, 50))
    return { child, exited }
  }

  it('a terminal Ctrl+C (signal to the whole process group) reaches the host; sideby survives and reports it', async () => {
    await withFakeHome(async (h) => {
      const { child, exited } = await startSleeping(h)
      process.kill(-child.pid!, 'SIGINT')
      assert.equal(await exited, 100)
      const signals = (await readHostLog(h, 'codex')).filter((r) => r.signal).map((r) => r.signal)
      assert.deepEqual(signals, ['SIGINT'])
    })
  })

  // A detached test process group is orphaned, and the kernel discards stop signals sent to orphaned groups,
  // so Ctrl+Z cannot be reproduced here. Assert the cause instead: sideby must leave SIGTSTP at its default
  // action (stop) while the host runs, so a terminal suspends sideby together with the host.
  it('leaves SIGTSTP at its default action while the host runs, so Ctrl+Z suspends both', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex', { sleep: 0.5 })
      const { runHost } = await import('../core/launch.ts')
      const { createRuntime } = await import('../runtime.ts')
      const rt = await createRuntime({ env: h.env })
      const prepared = await rt.prepareLaunch('codex:main', [], 'run')
      const before = { tstp: process.listenerCount('SIGTSTP'), int: process.listenerCount('SIGINT') }
      const running = runHost(prepared)
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(process.listenerCount('SIGTSTP'), before.tstp)
      assert.equal(process.listenerCount('SIGINT'), before.int + 1)
      assert.equal(await running, 0)
      assert.equal(process.listenerCount('SIGINT'), before.int)
    })
  })

  it('forwards SIGTERM sent only to sideby, exactly once', async () => {
    await withFakeHome(async (h) => {
      const { child, exited } = await startSleeping(h)
      child.kill('SIGTERM')
      assert.equal(await exited, 100)
      const signals = (await readHostLog(h, 'codex')).filter((r) => r.signal).map((r) => r.signal)
      assert.deepEqual(signals, ['SIGTERM'])
    })
  })
})

describe('quota setup through the Runtime (hardening round 2)', () => {
  it('a plugin quota setup that throws is reported as a blocked plan matching the schema', async () => {
    await withFakeHome(async (h) => {
      const dir = '.config/sideby/plugins/lab'
      await h.write(`${dir}/plugin.json`, JSON.stringify({ name: 'lab', version: '1.0.0' }))
      await h.write(
        `${dir}/index.ts`,
        `export default { name: 'lab', register(api) { api.family({ id: 'lab', title: 'Lab', bin: 'lab', installUrl: 'https://example.invalid', selectVar: 'LAB_HOME', layout: { main: '.lab', account: '.lab-<name>' }, hijackVars: [], apiVars: [], sharedItems: [], login: { args: null, hint: '' }, quotaSetup: { summary: 's', plan() { throw new Error('cannot plan') }, async apply() { throw new Error('no') }, async teardown() { throw new Error('nope') } } }) } }\n`,
      )
      const r = await sideby(h, ['quota', 'setup', 'lab', '--json'])
      assert.equal(r.code, 1)
      const data = checkSchema('quota-setup', r.out) as { plan: { status: string; message: string } }
      assert.deepEqual([data.plan.status, data.plan.message], ['blocked', 'cannot plan'])
      const down = await sideby(h, ['quota', 'teardown', 'lab', '--json'])
      checkSchema('quota-teardown', down.out)
    })
  })
})

describe('quota hints (hardening round 3)', () => {
  it('prints the reason detail and suggests setup only when the plan can be applied', async () => {
    await withFakeHome(async (h) => {
      const fam = (id: string, plan: string) =>
        `api.family({ id: '${id}', title: '${id}', bin: '${id}', installUrl: 'https://example.invalid', selectVar: 'X_HOME', layout: { main: '.${id}', account: '.${id}-<name>' }, hijackVars: [], apiVars: [], sharedItems: [], login: { args: null, hint: '' }, async readQuota() { return { status: 'unavailable', reason: 'not-enabled', detail: '${id} needs its own setup' } }, quotaSetup: { summary: 's', async plan() { return { status: '${plan}', file: 'f', diff: '', message: 'm' } }, async apply() { return { status: 'enabled', file: 'f', diff: '', message: 'm' } }, async teardown() { return { ok: true, message: 'm' } } } })`
      await h.write('.config/sideby/plugins/q/plugin.json', JSON.stringify({ name: 'q', version: '1.0.0' }))
      await h.write(
        '.config/sideby/plugins/q/index.ts',
        `export default { name: 'q', register(api) { ${fam('ready', 'ready')}; ${fam('stuck', 'blocked')} } }\n`,
      )
      await h.mkdir('.ready')
      await h.mkdir('.stuck')
      const r = await sideby(h, ['quota'])
      assert.match(r.out, /ready:main: ready needs its own setup/)
      assert.match(r.out, /stuck:main: stuck needs its own setup/)
      assert.match(r.out, /sideby quota setup ready/)
      assert.doesNotMatch(r.out, /sideby quota setup stuck/)
      assert.doesNotMatch(r.out, /quota setup claude/)
    })
  })
})

describe('account script', () => {
  it('a background process started by the script does not keep sideby alive', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ plugins: { 'account-script': { enabled: true } } }),
      )
      await h.write('.codex/sideby-before-launch', '#!/bin/sh\nsleep 5 &\nexit 0\n', 0o700)
      const started = Date.now()
      const r = await sideby(h, ['run', 'codex:main'])
      assert.equal(r.code, 0, r.err)
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`)
    })
  })
})

describe('plugins', () => {
  async function writePlugin(h: FakeHome, name: string, body: string, mode = 0o755) {
    const dir = h.path('.config/sideby/plugins', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(join(dir, 'index.ts'), body)
    await chmod(dir, mode)
    return dir
  }

  it('a launch.before abort stops the host and names the plugin', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await writePlugin(
        h,
        'gateway',
        `export default { name: 'gateway', register(api) { api.on('launch.before', { family: 'codex' }, () => { throw api.abort('gateway is down') }) } }\n`,
      )
      const r = await sideby(h, ['run', 'codex:main'])
      assert.equal(r.code, 1)
      assert.match(r.err, /\[gateway\] gateway is down/)
      assert.equal((await readHostLog(h, 'codex')).length, 0)
    })
  })

  it('an account.create.before abort stops `new` with exit 1, the message, and no folder', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await writePlugin(
        h,
        'one-login',
        `export default { name: 'one-login', register(api) { api.on('account.create.before', { family: 'codex' }, (ctx) => { if (!ctx.api) throw api.abort('codex:' + ctx.name + ' would share a login; use --api') }) } }\n`,
      )
      const before = await snapshot(h.home)
      const r = await sideby(h, ['new', 'codex', 'work'])
      assert.equal(r.code, 1)
      assert.match(r.err, /sideby: \[one-login\] codex:work would share a login; use --api/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const asJson = await sideby(h, ['new', 'codex', 'work', '--json'])
      assert.equal(asJson.code, 1)
      assert.match(JSON.parse(asJson.out).error, /would share a login/)
      assert.equal((await sideby(h, ['new', 'codex', 'work', '--api'])).code, 0)
    })
  })

  it('a hook can add environment variables, and sees only its own settings', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await writePlugin(
        h,
        'env-adder',
        `export default { name: 'env-adder', register(api) { api.on('launch.before', (ctx) => { ctx.env.FROM_PLUGIN = String(ctx.config.value); ctx.args.push('--added') }) } }\n`,
      )
      await h.write('.config/sideby/config.json', JSON.stringify({ plugins: { 'env-adder': { value: 42 } } }))
      assert.equal((await sideby(h, ['run', 'codex:main'])).code, 0)
      const [rec] = await readHostLog(h, 'codex')
      assert.equal(rec!.env.FROM_PLUGIN, '42')
      assert.deepEqual(rec!.argv, ['--added'])
      const listed = await sideby(h, ['plugins', '--json'])
      const data = checkSchema('plugins', listed.out) as { plugins: { name: string; configKeys: string[] }[] }
      assert.deepEqual(data.plugins.find((p) => p.name === 'env-adder')!.configKeys, ['value'])
      assert.doesNotMatch(listed.out, /42/)
    })
  })

  it('refuses a plugin directory others can write, and reports it', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await writePlugin(h, 'loose', `export default { name: 'loose', register() {} }\n`, 0o777)
      const r = await sideby(h, ['plugins', '--json'])
      assert.equal(r.code, 1)
      const data = checkSchema('plugins', r.out)
      assert.match(JSON.stringify(data.errors), /writable by group or others/)
      assert.equal((await sideby(h, ['run', 'codex:main'])).code, 0)
    })
  })
})

describe('short commands', () => {
  it('new --alias adds the alias, rewrites shellInitFile like shell-init prints, and refuses a bad alias first', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({ $schema: 'x', aliases: { codex002: 'codex:002' }, shellInitFile: { zsh: '~/.config/sideby/shell-init.zsh' } }, null, 2)}\n`,
      )
      const bad = await sideby(h, ['new', 'codex', 'work', '--alias', 'cd'])
      assert.equal(bad.code, 1)
      assert.match(bad.err, /shell keyword.*nothing was created/)
      assert.equal(await stat(h.path('.codex-work')).catch(() => null), null)

      const r = await sideby(h, ['new', 'codex', '003', '--alias', 'codex003', '--json'])
      assert.equal(r.code, 0, r.out + r.err)
      const data = checkSchema('new', r.out)
      assert.deepEqual(data.alias, { name: 'codex003', added: true })
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(Object.keys(config), ['$schema', 'aliases', 'shellInitFile'])
      assert.deepEqual(config.aliases, { codex002: 'codex:002', codex003: 'codex:003' })
      const file = await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8')
      assert.equal(file, (await sideby(h, ['shell-init', 'zsh'])).out)
      assert.match(file, /^codex003\(\) \{ command sideby run 'codex003' -- "\$@"; \}$/m)

      // --write regenerates on demand, and says what to configure when nothing is.
      await writeFile(h.path('.config/sideby/shell-init.zsh'), `${file}# stale\n`)
      const w = await sideby(h, ['shell-init', '--write'])
      assert.equal(w.code, 0, w.err)
      assert.match(w.out, /updated ~\/\.config\/sideby\/shell-init\.zsh/)
      assert.equal(await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8'), file)
      const none = await sideby(h, ['shell-init', 'bash', '--write'])
      assert.equal(none.code, 1)
      assert.match(none.err, /no shellInitFile\.bash .*"shellInitFile"/)
      assert.equal((await sideby(h, ['shell-init'])).code, 2)
    })
  })
})

describe('alias add and rm', () => {
  it('adds a short command with host arguments that only run uses, and removes it', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['new', 'codex', 'work'])).code, 0)
      const configFile = '.config/sideby/config.json'
      await h.write(
        configFile,
        JSON.stringify({
          accounts: { 'codex:work': { args: ['--a'] } },
          aliases: { cx: 'codex:work' },
          shellInitFile: { zsh: '~/.config/sideby/shell-init.zsh' },
        }),
      )
      // The target may be a name or another alias; the config keeps the Account ref.
      const r = await sideby(h, ['alias', 'add', 'cx-m', 'cx', '--json', '--', '--model', 'm'])
      assert.equal(r.code, 0, r.out + r.err)
      const data = checkSchema('alias', r.out)
      assert.equal(data.status, 'added')
      assert.equal(data.account, 'codex:work')
      assert.deepEqual(data.args, ['--model', 'm'])
      const config = JSON.parse(await readFile(h.path(configFile), 'utf8'))
      assert.deepEqual(config.aliases, {
        cx: 'codex:work',
        'cx-m': { account: 'codex:work', args: ['--model', 'm'] },
      })
      const file = await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8')
      assert.equal(file, (await sideby(h, ['shell-init', 'zsh'])).out)
      assert.match(file, /^cx-m\(\) \{ command sideby run 'cx-m' -- "\$@"; \}$/m)

      // Family args, then the Account's, then the alias's, then the user's; login and doctor ignore the alias's.
      assert.equal((await sideby(h, ['run', 'cx-m', '--', '--resume'])).code, 0)
      assert.equal((await sideby(h, ['login', 'cx-m'])).code, 0)
      const [run, login] = await readHostLog(h, 'codex')
      assert.deepEqual(run!.argv, [
        '-c',
        'cli_auth_credentials_store="file"',
        '--a',
        '--model',
        'm',
        '--resume',
      ])
      assert.equal(run!.env.CODEX_HOME, h.path('.codex-work'))
      assert.deepEqual(login!.argv, ['-c', 'cli_auth_credentials_store="file"', 'login'])
      const doctor = checkSchema('doctor', (await sideby(h, ['doctor', 'cx-m', '--json'])).out)
      assert.deepEqual(
        (doctor.accounts as { ref: string }[]).map((a) => a.ref),
        ['codex:work'],
      )

      // Adding it again is a no-op; other arguments, a missing Account or a bad name change nothing.
      const written = await readFile(h.path(configFile), 'utf8')
      const again = await sideby(h, ['alias', 'add', 'cx-m', 'codex:work', '--', '--model', 'm'])
      assert.equal(again.code, 0, again.err)
      assert.match(again.out, /already in the config/)
      const other = await sideby(h, ['alias', 'add', 'cx-m', 'codex:work', '--', '--model', 'n'])
      assert.equal(other.code, 1)
      assert.match(other.err, /already starts codex:work with --model m; .*sideby alias rm cx-m/)
      const missing = await sideby(h, ['alias', 'add', 'cx9', 'codex:nope', '--json'])
      assert.equal(missing.code, 1)
      assert.match(
        checkSchema('error', missing.out).error as string,
        /no account codex:nope; run `sideby list`/,
      )
      assert.equal((await sideby(h, ['alias', 'add', 'cd', 'codex:work'])).code, 1)
      assert.equal(await readFile(h.path(configFile), 'utf8'), written)
      assert.equal((await sideby(h, ['alias', 'add', 'cx9'])).code, 2)
      const noSep = await sideby(h, ['alias', 'add', 'cx9', 'codex:work', '--model', 'm'])
      assert.equal(noSep.code, 2)
      assert.match(noSep.err, /unknown option --model; put Host arguments after `--`/)
      assert.equal((await sideby(h, ['alias', 'rm', 'cx9', '--', '-x'])).code, 2)

      const rm = await sideby(h, ['alias', 'rm', 'cx-m', '--json'])
      assert.equal(rm.code, 0, rm.err)
      const removed = checkSchema('alias', rm.out)
      assert.equal(removed.status, 'removed')
      assert.deepEqual(removed.args, ['--model', 'm'])
      assert.deepEqual(JSON.parse(await readFile(h.path(configFile), 'utf8')).aliases, { cx: 'codex:work' })
      assert.doesNotMatch(await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8'), /cx-m/)
      const absent = await sideby(h, ['alias', 'rm', 'cx-m', '--json'])
      assert.equal(absent.code, 0)
      assert.equal(checkSchema('alias', absent.out).status, 'absent')
    })
  })
})

describe('read-only commands', () => {
  it('list, doctor, quota and shell-init never write into host directories; JSON matches the schemas', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await sideby(h, ['new', 'codex', 'work'])
      await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cx2: 'codex:work' } }))
      const before = await snapshot(h.home)
      checkSchema('list', (await sideby(h, ['list', '--json'])).out)
      checkSchema('doctor', (await sideby(h, ['doctor', '--json'])).out)
      checkSchema('quota', (await sideby(h, ['quota', '--json'])).out)
      const init = await sideby(h, ['shell-init', 'zsh'])
      assert.match(init.out, /sideby-codex-work\(\) \{ command sideby run 'codex:work' -- "\$@"; \}/)
      assert.match(init.out, /cx2\(\) \{ command sideby run 'cx2' -- "\$@"; \}/)
      // bash accepts these names outside POSIX mode: the script parses and the functions are callable.
      const { execFileSync } = await import('node:child_process')
      const bashInit = (await sideby(h, ['shell-init', 'bash'])).out
      const typed = execFileSync('/bin/bash', [
        '-c',
        `${bashInit}\ntype sideby-codex-work cx2 >/dev/null && echo ok`,
      ]).toString()
      assert.equal(typed.trim(), 'ok')
      // An alias also works wherever an account is named.
      const doctorAlias = JSON.parse((await sideby(h, ['doctor', 'cx2', '--json'])).out)
      assert.deepEqual(
        doctorAlias.accounts.map((a: { ref: string }) => a.ref),
        ['codex:work'],
      )
      // Only sideby's own state directory (and its parents) may appear.
      const changed = diffSnapshots(before, await snapshot(h.home)).filter(
        (p) => !['.local', '.local/state'].includes(p) && !p.startsWith('.local/state/sideby'),
      )
      assert.deepEqual(changed, [])
    })
  })

  it('reports a broken config with the fix', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{ "aliases": ')
      const r = await sideby(h, ['list'])
      assert.equal(r.code, 1)
      assert.match(r.err, /not valid JSON.*fix the syntax/)
      await h.write('.config/sideby/config.json', JSON.stringify({ pluginDirs: 'nope' }))
      const r2 = await sideby(h, ['list', '--json'])
      assert.equal(r2.code, 1)
      checkSchema('error', r2.out)
      assert.equal(await readFile(h.path('.config/sideby/config.json'), 'utf8'), '{"pluginDirs":"nope"}')
    })
  })
})

describe('next (Handoff, spec §3.13)', () => {
  const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()
  const cache = (h: FakeHome, name: string, five: number, seven: number, resetIn = 2) =>
    h.write(
      `.local/state/sideby/quota/claude/${name}.json`,
      JSON.stringify({
        observedAt: iso(-0.1),
        windows: [
          { label: '5h', windowMinutes: 300, usedPercent: five, resetsAt: iso(resetIn) },
          { label: '7d', windowMinutes: 10080, usedPercent: seven, resetsAt: iso(90) },
        ],
      }),
    )
  async function claudeAccounts(h: FakeHome) {
    await h.write('.claude/settings.json', '{}\n')
    await h.write('.claude.json', JSON.stringify({ oauthAccount: { id: 'main' } }), 0o600)
    for (const n of ['work', 'lab']) {
      await h.write(`.claude-${n}/settings.json`, '{}\n')
      await h.write(`.claude-${n}/.claude.json`, JSON.stringify({ oauthAccount: { id: n } }), 0o600)
    }
    await fakeHost(h, 'claude')
  }

  it('starts the account with the lowest quota pressure, as `run` would, passing host arguments on', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await cache(h, 'main', 95, 40)
      await cache(h, 'work', 30, 50)
      await cache(h, 'lab', 10, 20)
      const r = await sideby(h, ['next', 'claude', '--', '--print', 'hi'])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /Next: claude:lab \(lowest quota pressure, 20%\)/)
      assert.match(r.out, /handoff note/)
      const [rec] = await readHostLog(h, 'claude')
      assert.equal(rec?.env.CLAUDE_CONFIG_DIR, h.path('.claude-lab'))
      assert.deepEqual(rec?.argv.slice(-2), ['--print', 'hi'])
    })
  })

  it('--dry-run and --json only recommend, and never start the host', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await cache(h, 'main', 95, 40)
      await cache(h, 'work', 30, 50)
      const dry = await sideby(h, ['next', 'claude', '--dry-run'])
      assert.equal(dry.code, 0, dry.err)
      assert.match(dry.out, /Next: claude:work/)
      assert.match(dry.out, /sideby run claude:work/)
      const j = await sideby(h, ['next', 'claude', '--json'])
      assert.equal(j.code, 0, j.err)
      const plan = checkSchema('next', j.out) as { pick: string; accounts: { ref: string; state: string }[] }
      assert.equal(plan.pick, 'claude:work')
      assert.deepEqual(
        plan.accounts.map((a) => `${a.ref} ${a.state}`),
        ['claude:work ready', 'claude:lab unknown', 'claude:main full'],
      )
      assert.deepEqual(await readHostLog(h, 'claude'), [])
    })
  })

  it('starts nothing when every account is full and says which comes back first', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await cache(h, 'main', 95, 40, 3)
      await cache(h, 'work', 90, 50, 1)
      await cache(h, 'lab', 99, 20, 5)
      const r = await sideby(h, ['next', 'claude'])
      assert.equal(r.code, 1)
      assert.match(r.err, /every claude account is at its limit; claude:work is back at/)
      const j = await sideby(h, ['next', 'claude', '--json'])
      assert.equal(j.code, 1)
      const plan = checkSchema('next', j.out) as { pick: null; earliestReset: { ref: string } }
      assert.equal(plan.pick, null)
      assert.equal(plan.earliestReset.ref, 'claude:work')
      assert.deepEqual(await readHostLog(h, 'claude'), [])
    })
  })

  it('starts nothing when no account has quota data, and keeps host arguments in the suggested command', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      const r = await sideby(h, ['next', 'claude', '--', '--model', 'opus'])
      assert.equal(r.code, 1)
      assert.match(r.err, /no claude account has quota data yet/)
      assert.match(r.err, /sideby run claude:main -- --model opus/)
      const j = await sideby(h, ['next', 'claude', '--json'])
      assert.equal(j.code, 1)
      assert.equal((checkSchema('next', j.out) as { hasQuota: boolean }).hasQuota, false)
      assert.deepEqual(await readHostLog(h, 'claude'), [])
      await cache(h, 'main', 95, 40)
      await cache(h, 'work', 20, 30)
      const dry = await sideby(h, ['next', 'claude', '--dry-run', '--', '--model', 'opus 4'])
      assert.match(dry.out, /sideby run claude:work -- --model 'opus 4'/)
      const typo = await sideby(h, ['next', 'claude', '--model', 'opus'])
      assert.equal(typo.code, 2)
      assert.match(typo.err, /put Host arguments after `--`/)
    })
  })

  it('leaves API accounts out unless --include-api', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      for (const n of ['main', 'work', 'lab']) await cache(h, n, 99, 50)
      await h.write('.claude-key/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
      const r = await sideby(h, ['next', 'claude', '--dry-run'])
      assert.equal(r.code, 1)
      assert.match(r.err, /add --include-api/)
      const api = await sideby(h, ['next', 'claude', '--dry-run', '--include-api'])
      assert.equal(api.code, 0, api.err)
      assert.match(api.out, /Next: claude:key \(API account, pay per use\)/)
    })
  })

  it('a family without a public quota source, a missing family or argument each say what to do', async () => {
    await withFakeHome(async (h) => {
      const grok = await sideby(h, ['next', 'grok', '--json'])
      assert.equal(grok.code, 1)
      const e = checkSchema('error', grok.out) as { code: string; error: string }
      assert.equal(e.code, 'no-quota-source')
      assert.match(e.error, /pick one yourself/)
      const none = await sideby(h, ['next', 'claude'])
      assert.equal(none.code, 1)
      assert.match(none.err, /sideby new claude <name>/)
      const usage = await sideby(h, ['next', '--json'])
      assert.equal(usage.code, 2)
      assert.equal((checkSchema('error', usage.out) as { code: string }).code, 'usage')
    })
  })
})

describe('confirmation exit code', () => {
  it('quota setup without --yes shows the change and exits 10, changing nothing', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude.json', JSON.stringify({ oauthAccount: { id: 'x' } }), 0o600)
      await fakeHost(h, 'claude')
      await fakeHost(h, 'sideby')
      const before = await snapshot(h.home)
      const r = await sideby(h, ['quota', 'setup', 'claude'])
      assert.equal(r.code, 10, r.err)
      assert.match(r.out, /--yes/)
      const j = await sideby(h, ['quota', 'setup', 'claude', '--json'])
      assert.equal(j.code, 10)
      assert.equal((checkSchema('quota-setup', j.out) as { applied: boolean }).applied, false)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })
})

describe('resume (spec §3.15)', () => {
  const ID = '0a4964a7-fb75-40c0-a9eb-f0755cc54449'

  /** Claude main plus `claude:work`, which holds session `ID`. */
  async function claudeWithSession(h: FakeHome, config: object = {}) {
    await h.mkdir('.claude/projects')
    await h.write(`.claude-work/projects/-work-app/${ID}.jsonl`, '{}\n')
    await h.write('.config/sideby/config.json', `${JSON.stringify(config)}\n`)
    await fakeHost(h, 'claude')
  }

  it('starts the Account that holds the session, and runs the Host unchanged otherwise', async () => {
    await withFakeHome(async (h) => {
      await claudeWithSession(h, { accounts: { 'claude:work': { args: ['--model', 'opus'] } } })
      const routed = await sideby(h, ['resume', 'claude', '--', '--resume', ID], {
        ANTHROPIC_API_KEY: 'leak',
      })
      assert.equal(routed.code, 0, routed.err)
      assert.match(routed.err, new RegExp(`session ${ID} is in claude:work`))
      const [rec] = await readHostLog(h, 'claude')
      assert.equal(rec!.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.equal(rec!.env.ANTHROPIC_API_KEY, undefined)
      assert.deepEqual(rec!.argv, ['--model', 'opus', '--resume', ID])

      // A new session: the Host runs exactly as typed, keeping the environment.
      const plain = await sideby(h, ['resume', 'claude', '--', '-p', 'hi'], { ANTHROPIC_API_KEY: 'kept' })
      assert.equal(plain.code, 0, plain.err)
      assert.equal(plain.err, '')
      const second = (await readHostLog(h, 'claude'))[1]!
      assert.equal(second.env.CLAUDE_CONFIG_DIR, undefined)
      assert.equal(second.env.ANTHROPIC_API_KEY, 'kept')
      assert.deepEqual(second.argv, ['-p', 'hi'])

      const pi = await sideby(h, ['resume', 'pi', '--', '--resume', ID])
      assert.equal(pi.code, 1)
      assert.match(pi.err, /cannot be routed; start an account yourself with `sideby run/)
      assert.equal((await sideby(h, ['resume'])).code, 2)
    })
  })

  it('says when a never-saved session starts anew in the Account that started it', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await h.mkdir('.claude-work/projects')
      await h.mkdir(`.claude-work/session-env/${ID}`)
      await fakeHost(h, 'claude')
      const r = await sideby(h, ['resume', 'claude', '--', '--dangerously-skip-permissions', '--resume', ID])
      assert.equal(r.code, 0, r.err)
      assert.match(r.err, new RegExp(`session ${ID} was never saved; starting a new session in claude:work`))
      const [rec] = await readHostLog(h, 'claude')
      assert.equal(rec!.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.deepEqual(rec!.argv, ['--dangerously-skip-permissions'])
    })
  })

  it('shell-init defines the Host-named function only with resumeRouting and a non-main Account', async () => {
    await withFakeHome(async (h) => {
      await claudeWithSession(h)
      await h.write('.codex/AGENTS.md', '# rules\n')
      const off = await sideby(h, ['shell-init', 'zsh'])
      assert.doesNotMatch(off.out, /^function /m)
      await h.write('.config/sideby/config.json', `${JSON.stringify({ resumeRouting: true })}\n`)
      const on = await sideby(h, ['shell-init', 'zsh'])
      const glob = '????????-????-????-????-????????????'
      assert.ok(
        on.out.includes(
          `function claude { local a; if [ -z "\${CLAUDE_CONFIG_DIR-}" ]; then for a in "$@"; do case $a in ${glob}|--resume=${glob}) command sideby resume 'claude' -- "$@"; return;; esac; done; fi; command claude "$@"; }\n`,
        ),
        on.out,
      )
      // Codex has only its Main Account here, so there is nowhere to route to.
      assert.doesNotMatch(on.out, /function codex/)
      // An Alias with the Host's name wins.
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({ resumeRouting: true, aliases: { claude: 'claude:work' } })}\n`,
      )
      assert.doesNotMatch((await sideby(h, ['shell-init', 'zsh'])).out, /function claude/)
    })
  })

  for (const shell of ['bash', 'zsh'] as const) {
    it(`the ${shell} function routes a bare resume even behind an alias of the same name`, async (t) => {
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync(shell, ['-c', 'true'])
      } catch {
        t.skip(`${shell} is not installed`)
        return
      }
      await withFakeHome(async (h) => {
        await claudeWithSession(h, { resumeRouting: true })
        // A sideby on PATH that also counts its calls, so the test sees when the function skips it.
        const calls = h.path('sideby.calls')
        await h.write(
          'bin-sideby',
          `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)} "$@"\n`,
          0o755,
        )
        const { rename } = await import('node:fs/promises')
        await rename(h.path('bin-sideby'), join(h.bin, 'sideby'))
        const init = h.path('shell-init.sh')
        await writeFile(init, (await sideby(h, ['shell-init', shell])).out)
        // The alias comes first, as in a typical rc file. A sourced file is parsed line by line, like an rc file
        // followed by typed commands; a `-c` string would be parsed before the alias exists.
        const script = h.path('session.sh')
        await writeFile(
          script,
          [
            ...(shell === 'bash' ? ['shopt -s expand_aliases'] : []),
            `alias claude='claude --dangerously-skip-permissions'`,
            `source ${JSON.stringify(init)}`,
            `claude --resume ${ID}`,
            `CLAUDE_CONFIG_DIR=/picked claude --resume ${ID}`,
            'claude -p hi',
          ].join('\n'),
        )
        const run = `source ${JSON.stringify(script)}`
        execFileSync(shell, shell === 'zsh' ? ['-f', '-c', run] : ['--norc', '-c', run], {
          env: h.env as NodeJS.ProcessEnv,
          stdio: 'pipe',
        })
        const [routed, picked, plain] = await readHostLog(h, 'claude')
        assert.equal(routed!.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
        assert.deepEqual(routed!.argv, ['--dangerously-skip-permissions', '--resume', ID])
        assert.equal(picked!.env.CLAUDE_CONFIG_DIR, '/picked')
        assert.deepEqual(picked!.argv, ['--dangerously-skip-permissions', '--resume', ID])
        assert.deepEqual(plain!.argv, ['--dangerously-skip-permissions', '-p', 'hi'])
        // Only the routed resume started sideby; the chosen Account and the plain command went straight to the Host.
        assert.equal(await readFile(calls, 'utf8'), 'x\n')
      })
    })
  }
})

describe('setup by an agent (spec §3.16)', () => {
  async function claudeMain(h: FakeHome) {
    await h.write('.claude/settings.json', '{}\n')
    await h.mkdir('.claude/skills')
    await fakeHost(h, 'claude')
  }

  it('families states every shared item with its mode, meaning and source', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({ extraSharedItems: { claude: [{ path: 'scripts', mode: 'link' }] } })}\n`,
      )
      const r = await sideby(h, ['families', 'claude', '--json'])
      assert.equal(r.code, 0, r.err)
      const data = checkSchema('families', r.out) as unknown as {
        families: {
          id: string
          layout: { main: string; account: string }
          selectVar: string
          quotaSetup: boolean
          shared: { path: string; mode: string; key?: string; source: string; meaning: string }[]
        }[]
      }
      const [claude] = data.families
      assert.equal(data.families.length, 1)
      assert.deepEqual(claude!.layout, { main: '.claude', account: '.claude-<name>' })
      assert.equal(claude!.selectVar, 'CLAUDE_CONFIG_DIR')
      assert.equal(claude!.quotaSetup, true)
      const by = new Map(claude!.shared.map((s) => [s.path, s]))
      assert.equal(by.get('skills')?.mode, 'link')
      assert.equal(by.get('skills')?.source, 'family')
      assert.equal(by.get('.claude.json')?.key, 'mcpServers')
      assert.equal(by.get('scripts')?.source, 'config')
      for (const s of claude!.shared) assert.ok(s.meaning.length > 0, s.path)

      const all = checkSchema('families', (await sideby(h, ['families', '--json'])).out)
      assert.deepEqual(
        (all.families as { id: string }[]).map((f) => f.id),
        ['claude', 'codex', 'grok', 'pi'],
      )
      const grok = (all.families as { id: string; shared: { path: string; meaning: string }[] }[]).find(
        (f) => f.id === 'grok',
      )!
      const config = grok.shared.find((s) => s.path === 'config.toml')!
      assert.match(config.meaning, /a copy of the Main Account's/)
      assert.doesNotMatch(config.meaning, /a link to the Main Account's/)

      const human = await sideby(h, ['families', 'claude'])
      assert.match(human.out, /CLAUDE_CONFIG_DIR/)
      assert.match(human.out, /sign-in, sessions and history/)
      const unknown = await sideby(h, ['families', 'nope', '--json'])
      assert.equal(unknown.code, 1)
      assert.match(checkSchema('error', unknown.out).error as string, /available: claude, codex, grok, pi/)
      assert.equal((await sideby(h, ['families', 'claude', 'codex'])).code, 2)
    })
  })

  it('new --next continues the numbering and the short-command pattern, and leaves out a taken one', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      for (const n of ['001', '002'])
        assert.equal((await sideby(h, ['new', 'claude', n, '--alias', `cc${n}`])).code, 0)

      const r = await sideby(h, ['new', 'claude', '--next', '--json'])
      assert.equal(r.code, 0, r.out + r.err)
      const data = checkSchema('new', r.out)
      assert.deepEqual(data.suggestion, { name: '003', alias: 'cc003' })
      assert.deepEqual(data.alias, { name: 'cc003', added: true })
      assert.ok((await stat(h.path('.claude-003'))).isDirectory())

      // cc004 already starts another Account: the Account is still created, without a short command.
      assert.equal((await sideby(h, ['alias', 'add', 'cc004', 'claude:main'])).code, 0)
      const taken = await sideby(h, ['new', 'claude', '--next', '--json'])
      assert.equal(taken.code, 0, taken.out)
      const t = checkSchema('new', taken.out)
      assert.equal((t.suggestion as { name: string }).name, '004')
      assert.match((t.suggestion as { aliasProblem: string }).aliasProblem, /^cc004: /)
      assert.equal(t.alias, undefined)
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.equal(config.aliases.cc004, 'claude:main')

      // An explicit --alias wins over the pattern.
      const own = checkSchema(
        'new',
        (await sideby(h, ['new', 'claude', '--next', '--alias', 'c5', '--json'])).out,
      )
      assert.deepEqual(own.suggestion, { name: '005' })
      assert.deepEqual(own.alias, { name: 'c5', added: true })

      const both = await sideby(h, ['new', 'claude', '006', '--next'])
      assert.equal(both.code, 2)
      assert.match(both.err, /--next picks the name/)
      assert.equal(await stat(h.path('.claude-006')).catch(() => null), null)
    })
  })

  it('prints help for one command, and the general help with agent guidance otherwise', async () => {
    await withFakeHome(async (h) => {
      const one = await sideby(h, ['new', '--help'])
      assert.equal(one.code, 0)
      assert.match(one.out, /^sideby new <family> <name>/)
      assert.match(one.out, /--next/)
      assert.match((await sideby(h, ['help', 'login'])).out, /^sideby login <account>/)
      assert.match((await sideby(h, ['families', '--help'])).out, /^sideby families/)
      const general = await sideby(h, ['run', '--help'])
      assert.match(general.out, /^sideby — run every AI coding account/)
      assert.match(general.out, /For AI agents:/)
    })
  })
})

describe('sideby handoff (spec §3.17)', () => {
  it('ready refuses outside an Auto Handoff run and says how to get one', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['handoff', 'ready', '--json'])
      assert.equal(r.code, 1)
      const data = JSON.parse(r.out) as { code: string; error: string }
      assert.equal(data.code, 'not-in-handoff-run')
      assert.match(data.error, /handoff\.auto/)
    })
  })

  it('ready inside a run copies the user’s Brief and writes the request', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      await h.write('.claude-002/projects/.keep', '')
      await fakeHost(h, 'claude')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const dir = await h.mkdir('.local/state/sideby/handoffs/c1')
      const mine = await h.write('notes.md', '# my brief\n')
      const r = await sideby(h, ['handoff', 'ready', '--brief', mine, '--json'], {
        SIDEBY_HANDOFF_RUN: 'r1',
        SIDEBY_HANDOFF_DIR: dir,
        SIDEBY_HANDOFF_FAMILY: 'claude',
        SIDEBY_ACCOUNT: 'claude:001',
      })
      assert.equal(r.code, 0, r.err)
      const data = checkSchema('handoff-ready', r.out)
      assert.equal(await readFile(String(data.brief), 'utf8'), '# my brief\n')
      const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as {
        runId: string
        trigger: string
      }
      assert.deepEqual([request.runId, request.trigger], ['r1', 'manual'])
    })
  })

  it('ready exits 1 and writes nothing when no account can take over', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const dir = await h.mkdir('.local/state/sideby/handoffs/c1')
      const r = await sideby(h, ['handoff', 'ready', '--json'], {
        SIDEBY_HANDOFF_RUN: 'r1',
        SIDEBY_HANDOFF_DIR: dir,
        SIDEBY_HANDOFF_FAMILY: 'claude',
        SIDEBY_ACCOUNT: 'claude:001',
      })
      assert.equal(r.code, 1)
      assert.equal((JSON.parse(r.out) as { code: string }).code, 'no-pick')
      await assert.rejects(readFile(join(dir, 'request.json'), 'utf8'))
    })
  })

  it('setup grok shows the change with exit 10, writes one file with --yes, and teardown undoes it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/skills/.keep', '')
      await fakeHost(h, 'sideby')
      const before = await snapshot(h.home)
      const shown = await sideby(h, ['handoff', 'setup', 'grok'])
      assert.equal(shown.code, 10, shown.err)
      assert.match(shown.out, /sideby-handoff\.json/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const applied = await sideby(h, ['handoff', 'setup', 'grok', '--yes', '--json'])
      assert.equal(applied.code, 0, applied.err)
      checkSchema('handoff-setup', applied.out)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [
        '.grok/hooks',
        '.grok/hooks/sideby-handoff.json',
      ])
      const undone = await sideby(h, ['handoff', 'teardown', 'grok', '--json'])
      assert.equal(undone.code, 0)
      checkSchema('handoff-teardown', undone.out)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('setup is refused for a Family that needs none', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['handoff', 'setup', 'claude'])
      assert.equal(r.code, 1)
      assert.match(r.err, /needs no handoff setup/)
    })
  })
})

describe('sideby handoff status, enable and disable (spec §3.17)', () => {
  it('status lists what is missing, with enable first while Auto Handoff is off', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      await h.write('.grok/skills/.keep', '')
      const r = await sideby(h, ['handoff', 'status', '--json'])
      assert.equal(r.code, 0, r.err)
      const st = checkSchema('handoff-status', r.out) as {
        auto: boolean
        nextSteps: string[]
        families: { family: string; ready: boolean; problems: string[] }[]
      }
      assert.equal(st.auto, false)
      assert.equal(st.nextSteps[0], 'sideby handoff enable')
      assert.ok(st.nextSteps.includes('sideby quota setup claude'))
      assert.ok(st.nextSteps.includes('sideby handoff setup grok'))
      assert.deepEqual(
        st.families.map((f) => f.ready),
        [false, false],
      )
    })
  })

  it('enable shows the change with exit 10, writes only the handoff key with --yes, disable keeps the rest', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      await h.write('.codex/config.toml', 'model = "m"\n')
      const config = { $schema: 'x', aliases: { cc001: 'claude:001', codex001: 'codex:main' } }
      await h.write('.config/sideby/config.json', JSON.stringify(config))
      const before = await snapshot(h.home)
      const shown = await sideby(h, ['handoff', 'enable', '--order', 'claude=codex001', '--threshold', '90'])
      assert.equal(shown.code, 10, shown.err)
      assert.match(shown.out, /\+ {3}"auto": true/)
      assert.match(shown.out, /sideby handoff enable --order claude=codex001 --threshold 90 --yes/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const applied = await sideby(h, [
        'handoff',
        'enable',
        '--order',
        'claude=codex001',
        '--threshold',
        '90',
        '--yes',
        '--json',
      ])
      assert.equal(applied.code, 0, applied.err)
      checkSchema('handoff-enable', applied.out)
      const written = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(Object.keys(written), ['$schema', 'aliases', 'handoff'])
      assert.deepEqual(written.handoff, {
        auto: true,
        threshold: 90,
        families: { claude: { policy: 'order', order: ['codex001'] } },
      })
      const off = await sideby(h, ['handoff', 'disable', '--yes', '--json'])
      assert.equal(off.code, 0)
      checkSchema('handoff-disable', off.out)
      const after = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(after.handoff, { ...written.handoff, auto: false })
      assert.equal((await sideby(h, ['handoff', 'disable'])).code, 0, 'already off: nothing to confirm')
    })
  })

  it('enable refuses an order with an unknown account and lists the ones it knows', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      const r = await sideby(h, ['handoff', 'enable', '--order', 'claude=cc009', '--json'])
      assert.equal(r.code, 1)
      const data = JSON.parse(r.out) as { code: string; error: string }
      assert.equal(data.code, 'unknown-account')
      assert.match(data.error, /claude:001/)
    })
  })
})
