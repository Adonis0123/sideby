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
      assert.match(init.out, /cx2\(\) \{ command sideby run 'codex:work' -- "\$@"; \}/)
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
