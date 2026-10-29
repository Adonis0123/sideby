// End-to-end CLI tests (spec §5: 1, 2, 3, 11, 12 and the --json contract), run as real child processes
// against a fake HOME and fake Host binaries.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
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

describe('list in Display Order (spec §3.25)', () => {
  it('puts the listed families and accounts first, the others after in their usual order', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      for (const d of ['.claude', '.claude-001', '.claude-003', '.claude-002'])
        await h.write(`${d}/settings.json`, '{}\n')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ display: { families: ['codex'], accounts: { claude: ['003', 'gone', 'main'] } } }),
      )
      const r = await sideby(h, ['list', '--json'])
      const data = checkSchema('list', r.out) as { accounts: { ref: string }[]; families: { id: string }[] }
      assert.deepEqual(
        data.accounts.map((a) => a.ref),
        ['codex:main', 'claude:003', 'claude:main', 'claude:001', 'claude:002'],
      )
      assert.equal(data.families[0]?.id, 'codex')
      const q = await sideby(h, ['quota', 'claude', '--json'])
      assert.deepEqual(
        (JSON.parse(q.out) as { accounts: { ref: string }[] }).accounts.map((a) => a.ref),
        ['claude:003', 'claude:main', 'claude:001', 'claude:002'],
      )
    })
  })

  it('puts Pinned Accounts first in their family and marks them in --json', async () => {
    await withFakeHome(async (h) => {
      for (const d of ['.claude', '.claude-001', '.claude-002', '.claude-003'])
        await h.write(`${d}/settings.json`, '{}\n')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ display: { accounts: { claude: ['003'] }, pinned: { claude: ['002', 'gone'] } } }),
      )
      const r = await sideby(h, ['list', '--json'])
      const data = checkSchema('list', r.out) as { accounts: { ref: string; pinned?: boolean }[] }
      assert.deepEqual(
        data.accounts.map((a) => [a.ref, a.pinned ?? false]),
        [
          ['claude:002', true],
          ['claude:003', false],
          ['claude:main', false],
          ['claude:001', false],
        ],
      )
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

  it('tells a broken install (a dangling link on PATH) from a missing one, with the install command', async () => {
    await withFakeHome(async (h) => {
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await codexMain(h)
      // What an upgrade cut off half way leaves: the link stays, its target is gone.
      await symlink(join(h.bin, 'gone', 'cli.js'), join(h.bin, 'pi'))
      const listed = await sideby(h, ['list', '--json'])
      assert.equal(listed.code, 0)
      const data = JSON.parse(listed.out)
      const pi = data.families.find((f: { id: string }) => f.id === 'pi')
      assert.equal(pi.installed, false)
      assert.equal(pi.brokenBin, join(h.bin, 'pi'))
      assert.equal(pi.installCommand, 'curl -fsSL https://pi.dev/install.sh | sh')
      const codex = data.families.find((f: { id: string }) => f.id === 'codex')
      assert.equal(codex.installed, false)
      assert.equal(codex.brokenBin, undefined)
      assert.equal(data.accounts.find((a: { ref: string }) => a.ref === 'pi:main').hostInstalled, false)
      const text = await sideby(h, ['list'])
      assert.match(text.out, /\(host install broken\)/)
      assert.match(
        text.out,
        /pi's install is broken .*reinstall it: `curl -fsSL https:\/\/pi\.dev\/install\.sh \| sh`/,
      )
      assert.match(text.out, /Codex is not installed; install it: https:\/\/github\.com\/openai\/codex/)
      const run = await sideby(h, ['run', 'pi:main'])
      assert.equal(run.code, 1)
      assert.match(run.err, /pi is not installed.*`curl -fsSL https:\/\/pi\.dev\/install\.sh \| sh`/)
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

  // The Host may run before the line after spawn(): a signal then must already meet sideby's handlers, or its
  // default action ends sideby (exit by signal, seen on slow CI runners). spawn() reads the env while starting the
  // Host, so the env records how many handlers were in place at that moment.
  it('installs its signal handlers before the host starts', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      const { runHost } = await import('../core/launch.ts')
      const { createRuntime } = await import('../runtime.ts')
      const rt = await createRuntime({ env: h.env })
      const prepared = await rt.prepareLaunch('codex:main', [], 'run')
      const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }
      let atSpawn: { term: number; int: number } | undefined
      const env = new Proxy(prepared.env, {
        ownKeys(t) {
          atSpawn ??= { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') }
          return Reflect.ownKeys(t)
        },
      })
      assert.equal(await runHost({ ...prepared, env }), 0)
      assert.deepEqual(atSpawn, { term: before.term + 1, int: before.int + 1 })
      assert.equal(process.listenerCount('SIGTERM'), before.term)
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

  it("a plugin that imports node:sqlite adds no SQLite warning to a command's stderr, and other warnings still show", async () => {
    await withFakeHome(async (h) => {
      await writePlugin(
        h,
        'db-reader',
        `import { DatabaseSync } from 'node:sqlite'\nprocess.emitWarning('db-reader: something else', 'ExperimentalWarning')\nexport default { name: 'db-reader', register() { void DatabaseSync } }\n`,
      )
      const r = await sideby(h, ['list', '--json'])
      assert.equal(r.code, 0, r.err)
      assert.doesNotMatch(r.err, /SQLite/)
      assert.match(r.err, /ExperimentalWarning: db-reader: something else/)
    })
  })

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
      assert.match(file, /^function codex003 \{ command sideby run 'codex003' -- "\$@"; \}$/m)

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
      assert.match(file, /^function cx-m \{ command sideby run 'cx-m' -- "\$@"; \}$/m)

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
      assert.match(init.out, /function cx2 \{ command sideby run 'cx2' -- "\$@"; \}/)
      // bash accepts these names outside POSIX mode: the script parses and the functions are callable.
      const { execFileSync } = await import('node:child_process')
      const bashInit = (await sideby(h, ['shell-init', 'bash'])).out
      const typed = execFileSync('/bin/bash', [
        '-c',
        `${bashInit}\ntype sideby-codex-work cx2 >/dev/null && echo ok`,
      ]).toString()
      assert.equal(typed.trim(), 'ok')
      // A user's own zsh alias of the same name must not break the script: every function is still defined.
      const zshPath = '/bin/zsh'
      if (await stat(zshPath).catch(() => null)) {
        // Outside the fake HOME, which this test checks for writes.
        const file = join(h.bin, 'init.zsh')
        await writeFile(file, (await sideby(h, ['shell-init', 'zsh'])).out)
        const zsh = execFileSync(zshPath, [
          '-fc',
          `alias cx2=echo; eval "$(cat '${file}')"; type sideby-codex-work cx2 >/dev/null && echo ok`,
        ]).toString()
        assert.equal(zsh.trim(), 'ok')
      }
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
      const pi = await sideby(h, ['next', 'pi', '--json'])
      assert.equal(pi.code, 1)
      const e = checkSchema('error', pi.out) as { code: string; error: string }
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

  it('a pick command starts the account with the most room, or the main account without quota data (ADR-0035)', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ shellInitFile: { zsh: '~/.config/sideby/shell-init.zsh' } }),
      )
      // A name that hides a command on PATH waits for --yes and writes nothing.
      await writeFile(join(h.bin, 'cc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const configBefore = await readFile(h.path('.config/sideby/config.json'), 'utf8')
      const ask = await sideby(h, ['alias', 'add', 'cc', '--pick', 'claude', '--json'])
      assert.equal(ask.code, 10, ask.err)
      const asked = checkSchema('alias', ask.out)
      assert.equal(asked.status, 'confirm')
      assert.equal(asked.shadows, join(h.bin, 'cc'))
      assert.equal(await readFile(h.path('.config/sideby/config.json'), 'utf8'), configBefore)
      const human = await sideby(h, ['alias', 'add', 'cc', '--pick', 'claude'])
      assert.equal(human.code, 10)
      assert.match(human.out, /already a command .*bin\/cc.*--yes/s)
      const add = await sideby(h, ['alias', 'add', 'cc', '--pick', 'claude', '--yes', '--json'])
      assert.equal(add.code, 0, add.err)
      const added = checkSchema('alias', add.out)
      assert.deepEqual([added.status, added.kind, added.family], ['added', 'pick', 'claude'])
      assert.deepEqual(
        JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')).pickCommands,
        {
          cc: 'claude',
        },
      )
      const init = await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8')
      assert.match(init, /^function cc \{ command sideby run 'cc' -- "\$@"; \}$/m)

      // No quota data: the main account, and the line says why.
      const first = await sideby(h, ['run', 'cc', '--', '--print', 'hi'])
      assert.equal(first.code, 0, first.err)
      assert.match(first.err, /cc → claude:main \(no quota data yet/)
      // With quota data: the account with the lowest pressure.
      await cache(h, 'main', 95, 40)
      await cache(h, 'work', 30, 50)
      await cache(h, 'lab', 10, 20)
      const second = await sideby(h, ['run', 'cc'])
      assert.equal(second.code, 0, second.err)
      assert.match(second.err, /cc → claude:lab \(20% used, the most room\)/)
      const [one, two] = await readHostLog(h, 'claude')
      assert.equal(one?.env.CLAUDE_CONFIG_DIR, undefined)
      assert.deepEqual(one?.argv.slice(-2), ['--print', 'hi'])
      assert.equal(two?.env.CLAUDE_CONFIG_DIR, h.path('.claude-lab'))
      // Every account full: nothing starts, and it says which comes back first.
      await cache(h, 'work', 99, 50, 1)
      await cache(h, 'lab', 99, 20, 5)
      const full = await sideby(h, ['run', 'cc'])
      assert.equal(full.code, 1)
      assert.match(full.err, /cc: every claude account is at its limit; claude:work is back at/)
      assert.equal((await readHostLog(h, 'claude')).length, 2)

      // One namespace: an alias cannot take the name, and a pick command cannot take an alias's.
      const clash = await sideby(h, ['alias', 'add', 'cc', 'claude:work', '--json'])
      assert.equal(clash.code, 1)
      assert.match(checkSchema('error', clash.out).error as string, /already a pick command/)
      assert.equal((await sideby(h, ['alias', 'add', 'cc8', 'claude:work'])).code, 0)
      assert.equal((await sideby(h, ['alias', 'add', 'cc8', '--pick', 'claude'])).code, 1)
      assert.equal((await sideby(h, ['alias', 'add', 'claude', '--pick', 'claude'])).code, 1)
      assert.equal((await sideby(h, ['alias', 'add', 'cx', '--pick', 'nope'])).code, 1)
      assert.equal((await sideby(h, ['alias', 'add', 'cx', 'claude:work', '--pick', 'claude'])).code, 2)

      const list = await sideby(h, ['alias', 'list', '--json'])
      assert.equal(list.code, 0, list.err)
      assert.deepEqual((checkSchema('alias-list', list.out) as { shortCommands: unknown[] }).shortCommands, [
        { name: 'cc', kind: 'pick', family: 'claude' },
        { name: 'cc8', kind: 'account', account: 'claude:work' },
      ])
      assert.match((await sideby(h, ['alias', 'list'])).out, /cc\s+the claude account with the most room/)

      const rm = await sideby(h, ['alias', 'rm', 'cc', '--json'])
      assert.equal(rm.code, 0, rm.err)
      const removed = checkSchema('alias', rm.out)
      assert.deepEqual([removed.status, removed.kind, removed.family], ['removed', 'pick', 'claude'])
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.equal(config.pickCommands, undefined)
      assert.doesNotMatch(await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8'), /^function cc /m)
    })
  })

  it('shell-init setup shows the line first, adds it with --yes, and undo takes it out', async () => {
    await withFakeHome(async (h) => {
      const env = { SHELL: '/bin/zsh' }
      await h.write('.zshrc', 'export EDITOR=vim\n')
      const preview = await sideby(h, ['shell-init', 'setup', '--json'], env)
      assert.equal(preview.code, 10, preview.err)
      const data = checkSchema('shell-init-setup', preview.out)
      assert.deepEqual([data.status, data.shell, data.rc], ['confirm', 'zsh', '~/.zshrc'])
      assert.equal(await readFile(h.path('.zshrc'), 'utf8'), 'export EDITOR=vim\n')
      const human = await sideby(h, ['shell-init', 'setup'], env)
      assert.equal(human.code, 10)
      assert.match(human.out, /eval "\$\(sideby shell-init zsh\)"/)
      const yes = await sideby(h, ['shell-init', 'setup', '--yes', '--json'], env)
      assert.equal(yes.code, 0, yes.err)
      assert.equal(checkSchema('shell-init-setup', yes.out).status, 'added')
      assert.match(await readFile(h.path('.zshrc'), 'utf8'), /^eval "\$\(sideby shell-init zsh\)"$/m)
      const again = await sideby(h, ['shell-init', 'setup', '--json'], env)
      assert.equal(again.code, 0)
      assert.equal(checkSchema('shell-init-setup', again.out).status, 'loaded')
      const undo = await sideby(h, ['shell-init', 'setup', '--undo', '--json'], env)
      assert.equal(checkSchema('shell-init-setup', undo.out).status, 'removed')
      assert.equal(await readFile(h.path('.zshrc'), 'utf8'), 'export EDITOR=vim\n')
      assert.equal((await sideby(h, ['shell-init', 'setup', 'fish'])).code, 2)
    })
  })

  it('new offers a pick command once, when a family gets its second subscription account', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      const second = await sideby(h, ['new', 'codex', 'work', '--json'])
      assert.equal(second.code, 0, second.err)
      const offer = checkSchema('new', second.out).pickCommandOffer as { name: string; command: string }
      assert.deepEqual(offer, { name: 'cx', command: 'sideby alias add cx --pick codex' })
      const third = await sideby(h, ['new', 'codex', 'lab'])
      assert.doesNotMatch(third.out, /--pick/)
    })
  })
})

describe('same login (spec §3.21)', () => {
  const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()
  const cache = (h: FakeHome, name: string, five: number, ageHours: number) =>
    h.write(
      `.local/state/sideby/quota/claude/${name}.json`,
      JSON.stringify({
        observedAt: iso(-ageHours),
        windows: [
          { label: '5h', windowMinutes: 300, usedPercent: five, resetsAt: iso(2) },
          { label: '7d', windowMinutes: 10080, usedPercent: five, resetsAt: iso(90) },
        ],
      }),
    )
  const login = (email: string, org?: string) =>
    JSON.stringify({ oauthAccount: { emailAddress: email, ...(org ? { organizationName: org } : {}) } })
  /** main and 001 signed in as one login, work as another one. */
  async function twoDirsOneLogin(h: FakeHome) {
    await h.write('.claude/settings.json', '{}\n')
    await h.write('.claude.json', login('me@example.com', 'Acme'), 0o600)
    await h.write('.claude-001/settings.json', '{}\n')
    await h.write('.claude-001/.claude.json', login('ME@example.com', 'acme'), 0o600)
    await h.write('.claude-work/settings.json', '{}\n')
    await h.write('.claude-work/.claude.json', login('me@example.com', 'Other'), 0o600)
    await fakeHost(h, 'claude')
  }

  it('lists the same login on each member, in valid --json and as `= main` in the table', async () => {
    await withFakeHome(async (h) => {
      await twoDirsOneLogin(h)
      const r = await sideby(h, ['list', '--json'])
      const data = checkSchema('list', r.out) as { accounts: { ref: string; sameLogin?: string[] }[] }
      const by = Object.fromEntries(data.accounts.map((a) => [a.ref, a.sameLogin]))
      assert.deepEqual(by, {
        'claude:main': ['claude:001'],
        'claude:001': ['claude:main'],
        'claude:work': undefined,
      })
      const human = await sideby(h, ['list'])
      assert.match(human.out, /claude:001 = main/)
      assert.match(human.out, /claude:main = 001/)
      assert.match(human.out, /share one quota/)
    })
  })

  it('shows the freshest reading of the login on every member, with where it came from', async () => {
    await withFakeHome(async (h) => {
      await twoDirsOneLogin(h)
      await cache(h, 'main', 25, 6)
      await cache(h, '001', 64, 0.1)
      await cache(h, 'work', 10, 0.1)
      const r = await sideby(h, ['quota', '--json'])
      const data = checkSchema('quota', r.out) as {
        accounts: { ref: string; quota: { windows?: { usedPercent: number }[]; from?: string } }[]
      }
      const by = Object.fromEntries(data.accounts.map((a) => [a.ref, a.quota]))
      assert.equal(by['claude:main']?.from, 'claude:001')
      assert.equal(by['claude:main']?.windows?.[0]?.usedPercent, 64)
      assert.equal(by['claude:001']?.from, undefined)
      assert.equal(by['claude:work']?.from, undefined)
      assert.equal(by['claude:work']?.windows?.[0]?.usedPercent, 10)
      const human = await sideby(h, ['quota'])
      assert.match(human.out, /read from claude:001 \(same login\)/)
    })
  })

  it('next from 001 never picks main, which shares its quota', async () => {
    await withFakeHome(async (h) => {
      await twoDirsOneLogin(h)
      await cache(h, 'main', 25, 6)
      await cache(h, '001', 30, 0.1)
      await cache(h, 'work', 50, 0.1)
      const plain = checkSchema('next', (await sideby(h, ['next', 'claude', '--json'])).out) as {
        pick: string
      }
      assert.equal(plain.pick, 'claude:main', 'without a current account main wins the tie of one quota')
      const j = await sideby(h, ['next', 'claude', '--json'], { SIDEBY_ACCOUNT: 'claude:001' })
      const plan = checkSchema('next', j.out) as {
        from: string
        pick: string
        accounts: { ref: string; sameLoginAs?: string; quotaFrom?: string }[]
      }
      assert.equal(plan.from, 'claude:001')
      assert.notEqual(plan.pick, 'claude:main')
      const main = plan.accounts.find((a) => a.ref === 'claude:main')
      assert.equal(main?.sameLoginAs, 'claude:001')
      assert.equal(main?.quotaFrom, 'claude:001')
      const dry = await sideby(h, ['next', 'claude', '--dry-run'], { SIDEBY_ACCOUNT: 'claude:001' })
      assert.match(dry.out, /same login as claude:001, which shares its quota; skipped/)
      // Another Family's current Account does not count.
      const other = await sideby(h, ['next', 'claude', '--json'], { SIDEBY_ACCOUNT: 'codex:main' })
      assert.equal((JSON.parse(other.out) as { from?: string }).from, undefined)
    })
  })

  it('does not group codex accounts with the same email but no workspace claim', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['new', 'codex', 'team'])).code, 0)
      const claims = Buffer.from(JSON.stringify({ email: 'codex@example.com' })).toString('base64url')
      for (const dir of ['.codex', '.codex-team'])
        await h.write(
          `${dir}/auth.json`,
          JSON.stringify({ tokens: { id_token: `e30.${claims}.fake-sig` } }),
          0o600,
        )
      const data = checkSchema('list', (await sideby(h, ['list', '--json'])).out) as {
        accounts: { identity?: { email?: string }; sameLogin?: string[] }[]
      }
      assert.equal(data.accounts.length, 2)
      for (const a of data.accounts) {
        assert.equal(a.identity?.email, 'codex@example.com')
        assert.equal(a.sameLogin, undefined)
      }
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
      const aliased = (await sideby(h, ['shell-init', 'zsh'])).out
      assert.doesNotMatch(aliased, /sideby resume/)
      assert.match(aliased, /^function claude \{ command sideby run 'claude' -- "\$@"; \}$/m)
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
        ['claude', 'codex', 'grok', 'pi', 'agy'],
      )
      const agy = (
        all.families as { id: string; mainOnly?: boolean; selectVar?: string; layout: object }[]
      ).find((f) => f.id === 'agy')!
      assert.equal(agy.mainOnly, true)
      assert.equal(agy.selectVar, undefined)
      assert.deepEqual(agy.layout, { main: '.gemini/antigravity-cli' })
      assert.match((await sideby(h, ['families', 'agy'])).out, /main only: Antigravity CLI keeps one sign-in/)
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
      assert.match(
        checkSchema('error', unknown.out).error as string,
        /available: claude, codex, grok, pi, agy/,
      )
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

  it('ready --to hands back to an account the chain already used, and names who takes over', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-003/projects/.keep', '')
      await h.write('.claude-008/projects/.keep', '')
      await fakeHost(h, 'claude')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ aliases: { cc008: 'claude:008' }, handoff: { auto: true, sameFamily: true } }),
      )
      const dir = await h.mkdir('.local/state/sideby/handoffs/c1')
      await h.write(
        '.local/state/sideby/handoffs/c1/chain.json',
        JSON.stringify({
          hops: [
            { ref: 'claude:008', startedAt: '' },
            { ref: 'claude:003', startedAt: '' },
          ],
        }),
      )
      const env = {
        SIDEBY_HANDOFF_RUN: 'r2',
        SIDEBY_HANDOFF_DIR: dir,
        SIDEBY_HANDOFF_FAMILY: 'claude',
        SIDEBY_ACCOUNT: 'claude:003',
      }
      const plain = await sideby(h, ['handoff', 'ready', '--json'], env)
      assert.equal(plain.code, 1, 'without --to the chain never goes back to claude:008')
      assert.equal((JSON.parse(plain.out) as { code: string }).code, 'no-pick')

      const r = await sideby(h, ['handoff', 'ready', '--to', 'cc008', '--json'], env)
      assert.equal(r.code, 0, r.err)
      assert.equal(checkSchema('handoff-ready', r.out).next, 'claude:008')
      const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as { to: string }
      assert.equal(request.to, 'claude:008')
      assert.match(
        (await sideby(h, ['handoff', 'ready', '--to', 'cc008'], env)).out,
        /^claude:008 takes over/,
      )

      // A parent from before --to would ignore it and pick another account: refuse instead of naming the wrong one.
      await h.write(
        '.local/state/sideby/handoffs/c1/plan.json',
        JSON.stringify({ runId: 'r2', brief: '', at: '', decision: 'pick', prepareAt: 80, threshold: 95 }),
      )
      const old = await sideby(h, ['handoff', 'ready', '--to', 'cc008', '--json'], env)
      assert.equal(old.code, 1)
      assert.equal((JSON.parse(old.out) as { code: string }).code, 'parent-too-old')
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

describe('model (spec §3.19)', () => {
  it('shows the model and effort, previews a change with exit 10 and writes it only with --yes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet"}\n')
      await fakeHost(h, 'claude')
      const shown = await sideby(h, ['model', 'claude:main'])
      assert.equal(shown.code, 0)
      assert.match(shown.out, /model {3}sonnet {2}\(from the host config\)/)
      const data = checkSchema('model', (await sideby(h, ['model', 'claude:main', '--json'])).out)
      assert.deepEqual(data.model, { value: 'sonnet', from: 'host' })
      const preview = await sideby(h, ['model', 'claude:main', 'opus', '--effort', 'high'])
      assert.equal(preview.code, 10)
      await assert.rejects(readFile(h.path('.config/sideby/config.json'), 'utf8'))
      const done = await sideby(h, ['model', 'claude:main', 'opus', '--effort', 'high', '--yes', '--json'])
      assert.equal(done.code, 0)
      const out = checkSchema('model', done.out) as { change: { applied: boolean; args: string[] } }
      assert.equal(out.change.applied, true)
      assert.deepEqual(out.change.args, ['--model', 'opus', '--effort', 'high'])
      assert.equal(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')).model, 'sonnet')
      const bad = await sideby(h, ['model', 'claude:main', '--effort', 'huge', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(JSON.parse(bad.out).code, 'bad-value')
      assert.equal((await sideby(h, ['model', 'claude:main', '--yes'])).code, 2)
    })
  })
})

describe('theme (spec §3.34)', () => {
  it('lists, checks, imports, switches, undoes and removes Themes with --json output that matches its schema', async () => {
    await withFakeHome(async (h) => {
      const list = checkSchema('theme', (await sideby(h, ['theme', '--json'])).out)
      assert.deepEqual(
        (list.themes as { id: string; active: boolean }[]).map((t) => [t.id, t.active]),
        [
          ['teal', true],
          ['leaf', false],
          ['celeste', false],
          ['claude', false],
          ['codex', false],
        ],
      )
      const file = await h.write(
        'work/faint.json',
        JSON.stringify({ schemaVersion: 1, name: 'Faint', accent: '#cc3366', light: { muted: '#cccccc' } }),
      )
      const check = await sideby(h, ['theme', 'check', file, '--json'])
      assert.equal(check.code, 1)
      const report = checkSchema('theme-check', check.out)
      assert.equal(report.ok, false)
      assert.ok(
        (report.pairs as { fg: string; ok: boolean; suggest?: string }[]).some(
          (p) => p.fg === 'muted' && !p.ok && p.suggest,
        ),
      )
      const imported = checkSchema(
        'theme-import',
        (await sideby(h, ['theme', 'import', file, '--id', 'mine', '--json'])).out,
      )
      assert.equal(imported.replaced, false)
      const again = await sideby(h, ['theme', 'import', file, '--id', 'mine', '--json'])
      assert.equal(again.code, 10)
      checkSchema('theme-import', again.out)
      const used = checkSchema('theme-use', (await sideby(h, ['theme', 'use', 'mine', '--json'])).out)
      assert.deepEqual([used.before, used.after], ['default', 'mine'])
      assert.equal(
        JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')).panel.colorTheme,
        'mine',
      )
      checkSchema('theme-use', (await sideby(h, ['theme', 'use', '--undo', '--json'])).out)
      checkSchema('theme-export', (await sideby(h, ['theme', 'export', 'codex', '--json'])).out)
      assert.equal((await sideby(h, ['theme', 'remove', 'mine'])).code, 10)
      const removed = checkSchema(
        'theme-remove',
        (await sideby(h, ['theme', 'remove', 'mine', '--yes', '--json'])).out,
      )
      assert.equal(removed.removed, true)
      const unknown = await sideby(h, ['theme', 'use', 'ocean'])
      assert.equal(unknown.code, 1)
      assert.match(unknown.err, /sideby theme list/)
    })
  })
})

describe('config get|set|unset (spec §3.29)', () => {
  it('previews a change with exit 10, writes it with --yes, and lists every key', async () => {
    await withFakeHome(async (h) => {
      const file = h.path('.config/sideby/config.json')
      const preview = await sideby(h, ['config', 'set', 'panel.theme', 'dark'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /panel\.theme: \(not set\) → "dark"/)
      await assert.rejects(readFile(file, 'utf8'))
      const done = checkSchema(
        'config-set',
        (await sideby(h, ['config', 'set', 'panel.theme', 'dark', '--yes', '--json'])).out,
      )
      assert.deepEqual([done.applied, done.after], [true, 'dark'])
      assert.equal(JSON.parse(await readFile(file, 'utf8')).panel.theme, 'dark')
      const one = checkSchema('config-get', (await sideby(h, ['config', 'get', 'panel.theme', '--json'])).out)
      assert.deepEqual([one.set, one.value], [true, 'dark'])
      const all = checkSchema('config-get', (await sideby(h, ['config', '--json'])).out)
      assert.ok((all.keys as { key: string }[]).some((k) => k.key === 'handoff.threshold'))
      const same = await sideby(h, ['config', 'set', 'panel.theme', 'dark'])
      assert.equal(same.code, 0)
      const unset = await sideby(h, ['config', 'unset', 'panel.theme', '--yes'])
      assert.equal(unset.code, 0)
      assert.equal(JSON.parse(await readFile(file, 'utf8')).panel, undefined)
    })
  })

  it('refuses bad values, plugin settings and non-model account arguments with exit 1, and bad shapes with 2', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      await h.mkdir('.claude/skills')
      const bad = await sideby(h, ['config', 'set', 'handoff.threshold', '200', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(checkSchema('error', bad.out).code, 'bad-value')
      const plugin = await sideby(h, ['config', 'get', 'plugins.x.token', '--json'])
      assert.equal(plugin.code, 1)
      assert.equal(JSON.parse(plugin.out).code, 'plugin-config')
      const args = await sideby(h, [
        'config',
        'set',
        'accounts.claude:main.args',
        '["--dangerously-skip-permissions"]',
      ])
      assert.equal(args.code, 1)
      assert.match(args.err, /model and effort/)
      const ok = await sideby(h, ['config', 'set', 'accounts.claude:main.args', '["--model","opus"]'])
      assert.equal(ok.code, 10)
      assert.equal((await sideby(h, ['config', 'set', 'panel.theme'])).code, 2)
      assert.equal((await sideby(h, ['config', 'frob'])).code, 2)
    })
  })

  it('checks handoff names as `sideby handoff` does', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      await h.mkdir('.claude/skills')
      const order = await sideby(h, [
        'config',
        'set',
        'handoff.families.claude',
        '{"policy":"order","order":["claude:nope"]}',
        '--json',
      ])
      assert.equal(order.code, 1)
      assert.equal(checkSchema('error', order.out).code, 'unknown-account')
      const family = await sideby(h, ['config', 'set', 'handoff.familyOrder', '["nope"]'])
      assert.equal(family.code, 1)
      assert.match(family.err, /unknown family "nope"/)
      const cross = await sideby(h, ['config', 'set', 'handoff.crossOrganization', '["ghost"]'])
      assert.equal(cross.code, 1)
      assert.match(cross.err, /ghost is not an account/)
      const ok = await sideby(h, ['config', 'set', 'handoff.crossOrganization', '["claude:main"]'])
      assert.equal(ok.code, 10)
    })
  })
})

describe('autostart (spec §3.29)', () => {
  it('reports the state in the schema and refuses or skips without touching launchd', async () => {
    await withFakeHome(async (h) => {
      const status = checkSchema('autostart', (await sideby(h, ['autostart', '--json'])).out)
      assert.equal(status.state, 'off')
      const supported = process.platform === 'darwin' || process.platform === 'linux'
      assert.equal(status.supported, supported)
      const off = await sideby(h, ['autostart', 'off', '--json'])
      assert.equal(off.code, supported ? 0 : 1)
      await h.write('Library/LaunchAgents/dev.sideby.panel.plist', '<plist/>\n', 0o644)
      if (process.platform === 'darwin') {
        assert.equal(
          checkSchema('autostart', (await sideby(h, ['autostart', '--json'])).out).state,
          'foreign',
        )
        const refused = await sideby(h, ['autostart', 'off', '--yes', '--json'])
        assert.equal(refused.code, 1)
        assert.equal(JSON.parse(refused.out).code, 'foreign')
      }
      assert.equal(
        await readFile(h.path('Library/LaunchAgents/dev.sideby.panel.plist'), 'utf8'),
        '<plist/>\n',
      )
      assert.equal((await sideby(h, ['autostart', 'maybe'])).code, 2)
      assert.equal((await sideby(h, ['autostart', '--yes'])).code, 2)
    })
  })
})

describe('menubar (spec §3.31)', () => {
  it('reports its state, shows the change before --yes, and prints what the menu shows', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const status = checkSchema('menubar', (await sideby(h, ['menubar', '--json'])).out)
      assert.deepEqual([status.state, status.supported], ['off', process.platform === 'darwin'])
      const shown = await sideby(h, ['menubar', 'on', '--json'])
      // A checkout in a temporary folder cannot start at login, so `on` refuses it there (`temp-dir`).
      const inTemp = shown.code === 1 && JSON.parse(shown.out).code === 'temp-dir'
      if (process.platform === 'darwin' && !inTemp) {
        assert.equal(shown.code, 10)
        const plan = checkSchema('menubar', shown.out)
        assert.equal((plan.programArguments as string[])[0], '/usr/bin/osascript')
        assert.match((await sideby(h, ['menubar', 'on'])).out, /dev\.sideby\.menubar\.plist.*--yes/s)
      } else assert.equal(shown.code, 1)
      // Nothing is written before --yes.
      await assert.rejects(readFile(h.path('Library/LaunchAgents/dev.sideby.menubar.plist')))
      const snap = checkSchema(
        'menubar-snapshot',
        (await sideby(h, ['menubar', 'snapshot', '--json', '--lang', 'zh'])).out,
      ) as { lang: string; sections: { rows: { ref: string }[] }[] }
      assert.equal(snap.lang, 'zh')
      assert.deepEqual(
        snap.sections.map((x) => x.rows.map((r) => r.ref)),
        [['claude:main']],
      )
      assert.equal((await sideby(h, ['menubar', 'maybe'])).code, 2)
      assert.equal((await sideby(h, ['menubar', '--yes'])).code, 2)
      assert.equal((await sideby(h, ['menubar', 'start'])).code, 2)
    })
  })

  it('changes the shortcut, refuses one macOS uses, and says when the menu bar item could not register it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const first = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual(
        [first.keys, first.label, first.isDefault, first.registered],
        ['opt+x', '⌥X', true, null],
      )
      const refused = await sideby(h, ['menubar', 'hotkey', 'cmd+q', '--json'])
      assert.equal(refused.code, 1)
      assert.equal(JSON.parse(refused.out).code, 'hotkey.reserved')
      assert.equal(
        JSON.parse((await sideby(h, ['menubar', 'hotkey', 'shift+k', '--json'])).out).code,
        'hotkey.needs-modifier',
      )
      // Any order and spelling; written the way config keeps it.
      const set = checkSchema(
        'menubar-hotkey',
        (await sideby(h, ['menubar', 'hotkey', 'Cmd+Ctrl+K', '--json'])).out,
      )
      assert.deepEqual([set.changed, (set.hotkey as { keys: string }).keys], [true, 'ctrl+cmd+k'])
      assert.match(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /"hotkey": "ctrl\+cmd\+k"/)
      // The menu bar script reports that another app holds the key; status and `hotkey` say so.
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'taken'])
      const taken = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual([taken.label, taken.registered], ['⌃⌘K', false])
      assert.match((await sideby(h, ['menubar', 'hotkey'])).out, /macOS did not accept it/)
      // A report about a shortcut config no longer holds says nothing about the current one.
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'ok', '--hotkey-label', '⌥⌘S'])
      const older = checkSchema('menubar-hotkey', (await sideby(h, ['menubar', 'hotkey', '--json'])).out)
      assert.deepEqual([older.label, older.registered], ['⌃⌘K', null])
      await sideby(h, ['menubar', 'snapshot', '--json', '--hotkey', 'taken', '--hotkey-label', '⌃⌘K'])
      // Back to the default removes the key from config.
      await sideby(h, ['menubar', 'hotkey', 'default'])
      assert.doesNotMatch(await readFile(h.path('.config/sideby/config.json'), 'utf8'), /hotkey/)
      assert.equal((await sideby(h, ['menubar', 'snapshot', '--hotkey', 'maybe'])).code, 2)
    })
  })
})

describe('_notice on --json outputs (spec §3.23)', () => {
  it('carries a newer version from the cache and an outdated skill, on results and errors, and not when turned off', async () => {
    await withFakeHome(async (h) => {
      // Checked just now, so no Update Check starts: tests never make the request.
      const now = new Date().toISOString()
      await h.write(
        '.local/state/sideby/update.json',
        JSON.stringify({ checkedAt: now, triedAt: now, latest: '99.0.0' }),
      )
      await h.write('.agents/skills/sideby/SKILL.md', '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n')
      const on = { SIDEBY_NO_UPDATE_NOTIFIER: '' }
      const list = checkSchema('list', (await sideby(h, ['list', '--json'], on)).out)
      const n = list._notice as { update: { latest: string; command: string }; skill: { installed: string } }
      assert.deepEqual(
        [n.update.latest, n.update.command, n.skill.installed],
        ['99.0.0', 'sideby update', '0.0.1'],
      )
      const err = await sideby(h, ['quota', 'nope:x', '--json'], on)
      assert.equal(err.code, 1)
      assert.ok((checkSchema('error', err.out)._notice as object | undefined) !== undefined)
      assert.equal(checkSchema('list', (await sideby(h, ['list', '--json'])).out)._notice, undefined)
      const update = JSON.parse(
        (await sideby(h, ['update', '--json'], { ...on, SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' })).out,
      )
      assert.equal(update._notice, undefined)
    })
  })
})

describe('remote-control (spec §3.22)', () => {
  it('shows the state, previews turning it off with exit 10, writes only with --yes, and undoes it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet","remoteControlAtStartup":true}\n')
      await fakeHost(h, 'claude')
      const status = checkSchema('remote-control', (await sideby(h, ['remote-control', '--json'])).out)
      assert.deepEqual(
        (status.groups as { state: string; accounts: string[] }[]).map((g) => [g.state, g.accounts]),
        [['on', ['claude:main']]],
      )
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['remote-control', 'off'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /remoteControlAtStartup true -> false/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const done = await sideby(h, ['remote-control', 'off', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('remote-control', done.out).applied, true)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
        remoteControlAtStartup: false,
      })
      assert.equal((await sideby(h, ['remote-control', 'undo'])).code, 10)
      assert.equal((await sideby(h, ['remote-control', 'undo', '--yes'])).code, 0)
      assert.equal(
        JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')).remoteControlAtStartup,
        true,
      )
      assert.equal((await sideby(h, ['remote-control', 'undo', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['remote-control', 'nope'])).code, 2)
    })
  })
  it('turns it on the same way: a preview with exit 10, then --yes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet","remoteControlAtStartup":false}\n')
      await fakeHost(h, 'claude')
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['remote-control', 'on'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /remoteControlAtStartup false -> true/)
      assert.match(preview.out, /every device signed in/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const done = await sideby(h, ['remote-control', 'on', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('remote-control', done.out).action, 'on')
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
        remoteControlAtStartup: true,
      })
      // Already on: nothing to change, exit 1 (spec §3.22).
      assert.equal((await sideby(h, ['remote-control', 'on', '--yes'])).code, 1)
    })
  })
})

describe('tune (spec §3.18)', () => {
  /** A Claude main Account with one session of 210 turns and an auto compaction, dated just now. */
  async function withSession(h: FakeHome): Promise<void> {
    await h.write('.claude/settings.json', '{"autoCompactWindow":190000}\n')
    await h.write('.claude.json', JSON.stringify({ oauthAccount: { id: 'x' } }), 0o600)
    await fakeHost(h, 'claude')
    const start = Date.now() - 3_600_000
    const rows: object[] = []
    for (let i = 0; i < 210; i++)
      rows.push({
        type: 'assistant',
        timestamp: new Date(start + i * 1000).toISOString(),
        sessionId: 's1',
        message: {
          id: `m${i}`,
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 10_000 + i * 900,
            cache_creation_input_tokens: 900,
            output_tokens: 200,
          },
        },
      })
    rows.push({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: new Date(start + 5000).toISOString(),
      sessionId: 's1',
      compactMetadata: { trigger: 'auto', preTokens: 190_000, postTokens: 20_000 },
    })
    await h.write('.claude/projects/p/s1.jsonl', `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
  }

  it('prints a JSON result that matches the schema, for one account, a family and all accounts', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      for (const args of [
        ['tune', '--json'],
        ['tune', 'claude', '--json'],
        ['tune', 'claude:main', '--json'],
      ]) {
        const r = await sideby(h, args)
        assert.equal(r.code, 0, args.join(' '))
        const data = checkSchema('tune', r.out)
        assert.equal(data.schemaVersion, 1)
        const accounts = data.accounts as { ref: string; tuning: { status: string; estimate?: boolean } }[]
        assert.equal(accounts[0]?.ref, 'claude:main')
        assert.equal(accounts[0]?.tuning.status, 'ok')
        assert.equal(accounts[0]?.tuning.estimate, true)
      }
    })
  })

  it('prints a readable table and leaves the Host directory untouched', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const before = await snapshot(h.path('.claude'))
      const r = await sideby(h, ['tune'])
      assert.equal(r.code, 0)
      assert.match(r.out, /claude:main/)
      assert.match(r.out, /claude-opus-5-5/)
      assert.match(r.out, /Estimates/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
    })
  })

  it('exits 1 for an unknown account, 2 for extra arguments, and gives a JSON error', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const missing = await sideby(h, ['tune', 'claude:nope', '--json'])
      assert.equal(missing.code, 1)
      assert.equal((JSON.parse(missing.out) as { schemaVersion: number }).schemaVersion, 1)
      assert.equal((await sideby(h, ['tune', 'a', 'b'])).code, 2)
      assert.equal((await sideby(h, ['tune', '--nope'])).code, 2)
    })
  })

  it('says a known family has no accounts yet instead of reporting an unknown account', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const human = await sideby(h, ['tune', 'codex'])
      assert.equal(human.code, 0)
      assert.match(human.out, /No codex accounts yet.*sideby new codex/s)
      const data = checkSchema('tune', (await sideby(h, ['tune', 'codex', '--json'])).out)
      assert.deepEqual(data.accounts, [])
    })
  })

  it('applies a suggestion only after the change is shown and --yes is given, and undoes it', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const settings = h.path('.claude/settings.json')
      const before = await readFile(settings, 'utf8')
      const preview = await sideby(h, ['tune', 'apply', 'claude:main', '120000'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /Use 120K for claude:main/)
      assert.match(preview.out, /~\/\.claude\/settings\.json/)
      assert.equal(await readFile(settings, 'utf8'), before)
      const shown = checkSchema(
        'tune-change',
        (await sideby(h, ['tune', 'apply', 'claude:main', '120000', '--json'])).out,
      )
      assert.equal(shown.applied, false)
      const done = await sideby(h, ['tune', 'apply', 'claude:main', '120k', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('tune-change', done.out).applied, true)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 120_000)
      const undo = await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])
      assert.equal(undo.code, 0)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 190_000)
    })
  })

  it('does not take --yes on the read-only listing', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      assert.equal((await sideby(h, ['tune', '--yes'])).code, 2)
    })
  })

  it('goes back to the default with the word default', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const settings = h.path('.claude/settings.json')
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'default'])).code, 10)
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'default', '--yes'])).code, 0)
      assert.equal('autoCompactWindow' in JSON.parse(await readFile(settings, 'utf8')), false)
      assert.equal((await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])).code, 0)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 190_000)
    })
  })

  it('uses the suggestion when no size is given, and refuses where there is none', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const r = await sideby(h, ['tune', 'apply', 'claude:main', '--json'])
      assert.equal(r.code, 10)
      const plan = checkSchema('tune-change', r.out).plan as { next: number }
      assert.ok(plan.next >= 10_000)
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'lots', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['tune', 'apply'])).code, 2)
      assert.equal((await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])).code, 1)
    })
  })

  it('marks Grok and pi as having no public source', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/auth.json', JSON.stringify({ a: { email: 'g@example.com' } }), 0o600)
      await h.mkdir('.grok/skills')
      await fakeHost(h, 'grok')
      const r = await sideby(h, ['tune', '--json'])
      const data = checkSchema('tune', r.out)
      const grok = (data.accounts as { ref: string; tuning: { reason?: string } }[]).find((a) =>
        a.ref.startsWith('grok'),
      )
      assert.equal(grok?.tuning.reason, 'no-source')
    })
  })
})

describe('sideby desktop (spec §3.20)', () => {
  it('refuses before starting anything: no account, an API account, a family without a desktop app', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-deepseek/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.write('.grok/skills/x.md', 'x\n')
      assert.equal((await sideby(h, ['desktop'])).code, 2)
      const api = await sideby(h, ['desktop', 'claude:deepseek', '--json'])
      assert.equal(api.code, 1)
      assert.equal(checkSchema('error', api.out).code, 'api-account')
      const pi = await sideby(h, ['desktop', 'pi:main'])
      assert.equal(pi.code, 1)
      assert.match(pi.err, /no desktop app sideby can open \(only claude and codex accounts do\)/)
      const grok = await sideby(h, ['desktop', 'grok:main'])
      assert.match(grok.err, /use `sideby desktop grok-bot:<name>`/)
      // Grok Bot windows: none of these reach a real app.
      assert.equal((await sideby(h, ['desktop', 'claude:main', '--remove'])).code, 2)
      const bad = await sideby(h, ['desktop', 'grok-bot:Bad', '--remove', '--json'])
      assert.equal(bad.code, 1)
      assert.equal(checkSchema('error', bad.out).code, 'invalid-name')
      const main = await sideby(h, ['desktop', 'grok-bot', '--remove', '--json'])
      assert.equal(checkSchema('error', main.out).code, 'main-profile')
      const help = await sideby(h, ['desktop', '--help'])
      assert.match(help.out, /sideby desktop <account>/)
      assert.match(help.out, /sideby desktop grok-bot:<name> \[--remove \[--yes\]\]/)
    })
  })
})

describe('sideby edit (spec §3.30)', () => {
  it('prints where the settings file is with --path and says what to do when it is missing, opening nothing', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-empty/CLAUDE.md', '# rules\n')
      assert.equal((await sideby(h, ['edit'])).code, 2)
      const path = await sideby(h, ['edit', 'claude:main', '--path', '--json'])
      assert.equal(path.code, 0)
      const r = checkSchema('edit', path.out)
      assert.equal(r.opened, false)
      assert.equal(r.path, h.path('.claude/settings.json'))
      assert.equal(
        (await sideby(h, ['edit', 'claude:main', '--path'])).out.trim(),
        h.path('.claude/settings.json'),
      )
      const missing = await sideby(h, ['edit', 'claude:empty', '--json'])
      assert.equal(missing.code, 1)
      assert.equal(checkSchema('error', missing.out).code, 'settings-missing')
      assert.match((await sideby(h, ['edit', '--help'])).out, /sideby edit <account> \[--path\]/)
    })
  })
})

describe('sideby update (spec §3.23)', () => {
  /** A registry on localhost answering `latest`, so the test never leaves the machine. */
  async function fakeRegistry(latest: string) {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/-/package/sideby/dist-tags' ? 200 : 404, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ latest }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as import('node:net').AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  it('says when this is the newest version, and names the command where it cannot update itself', async () => {
    await withFakeHome(async (h) => {
      const { packageVersion } = await import('../core/version.ts')
      const same = await fakeRegistry(packageVersion())
      try {
        const r = await sideby(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: same.url })
        assert.equal(r.code, 0, r.err)
        const data = checkSchema('update', r.out)
        assert.equal(data.available, false)
      } finally {
        await same.close()
      }
      const newer = await fakeRegistry('99.0.0')
      try {
        // These tests run from the source checkout, which sideby never updates itself.
        const r = await sideby(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: newer.url })
        assert.equal(r.code, 1)
        const data = checkSchema('update', r.out)
        assert.deepEqual(
          [data.available, data.canRun, data.command],
          [true, false, 'git pull && pnpm install'],
        )
        const text = await sideby(h, ['update'], { SIDEBY_UPDATE_REGISTRY: newer.url })
        assert.match(text.err, /cannot update itself: it runs from a source checkout/)
        // The cache now knows 99.0.0, but without a terminal no command prints a notice.
        const list = await sideby(h, ['list'], { SIDEBY_NO_UPDATE_NOTIFIER: '' })
        assert.doesNotMatch(list.err, /is available/)
      } finally {
        await newer.close()
      }
    })
  })

  it('--skill updates only the installed skill, even with a newer sideby out, and asks no registry', async () => {
    await withFakeHome(async (h) => {
      // Checked just now, so no Update Check starts: the last check knows of a newer sideby.
      const now = new Date().toISOString()
      await h.write(
        '.local/state/sideby/update.json',
        JSON.stringify({ checkedAt: now, triedAt: now, latest: '99.0.0' }),
      )
      await h.write('.agents/skills/sideby/SKILL.md', '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n')
      await fakeHost(h, 'npx')
      await fakeHost(h, 'npm')
      // A registry that cannot be reached: --skill never asks it.
      const env = { SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' }
      const preview = await sideby(h, ['update', '--skill', '--json'], env)
      assert.equal(preview.code, 10, preview.err)
      assert.equal(checkSchema('update', preview.out).updated, false)
      assert.deepEqual(await readHostLog(h, 'npx'), [])
      const r = await sideby(h, ['update', '--skill', '--yes', '--json'], env)
      assert.equal(r.code, 0, r.err)
      const data = checkSchema('update', r.out)
      assert.deepEqual(
        [data.available, data.latest, data.updated, data.skillUpdated],
        [true, '99.0.0', false, true],
      )
      assert.deepEqual(
        (await readHostLog(h, 'npx')).map((x) => x.argv),
        [['-y', 'skills', 'update', 'sideby', '-g', '-y']],
      )
      assert.deepEqual(await readHostLog(h, 'npm'), [], 'the CLI is never installed')
      const text = await sideby(h, ['update', '--skill', '--yes'], env)
      assert.match(text.out, /99\.0\.0 is available; updating sideby itself is separate: `sideby update`/)
    })
  })

  it('reports a registry it cannot reach as an error with what to do', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' })
      assert.equal(r.code, 1)
      const data = checkSchema('error', r.out)
      assert.match(String(data.error), /could not reach http:\/\/127\.0\.0\.1:9/)
    })
  })
})

describe('Panel CLI parity', () => {
  it('pins a Same Login once, preserves order, prunes stale names and enforces the limit', async () => {
    await withFakeHome(async (h) => {
      for (const name of ['main', 'work', 'team', 'lab', 'extra']) {
        const dir = name === 'main' ? '.claude' : `.claude-${name}`
        await h.write(`${dir}/settings.json`, '{}')
        const email = ['main', 'work'].includes(name) ? 'me@example.com' : `${name}@example.com`
        await h.write(
          name === 'main' ? '.claude.json' : `${dir}/.claude.json`,
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
          0o600,
        )
      }
      await fakeHost(h, 'claude')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({
          aliases: { cx: 'claude:work' },
          display: {
            families: ['claude'],
            accounts: { claude: ['lab', 'main'] },
            pinned: { claude: ['gone'] },
          },
        }),
      )
      const hostDirs = ['.claude', '.claude-work', '.claude-team', '.claude-lab', '.claude-extra']
      const before = await Promise.all(hostDirs.map((dir) => snapshot(h.path(dir))))
      const loginBefore = await readFile(h.path('.claude.json'), 'utf8')
      const pin = await sideby(h, ['pin', 'cx', '--json'])
      assert.equal(pin.code, 0, pin.out)
      const data = checkSchema('pin', pin.out)
      assert.equal(data.changed, true)
      let config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(new Set(config.display.pinned.claude), new Set(['main', 'work']))
      assert.deepEqual(config.display.accounts.claude, ['lab', 'main'])
      assert.deepEqual(config.display.families, ['claude'])
      assert.equal(checkSchema('pin', (await sideby(h, ['pin', 'claude:main', '--json'])).out).changed, false)
      for (const name of ['team', 'lab']) assert.equal((await sideby(h, ['pin', `claude:${name}`])).code, 0)
      const full = await sideby(h, ['pin', 'claude:extra', '--json'])
      assert.equal(full.code, 1)
      assert.match(String(checkSchema('error', full.out).error), /unpin/i)
      const unpin = await sideby(h, ['unpin', 'cx', '--json'])
      assert.equal(unpin.code, 0)
      assert.equal(checkSchema('unpin', unpin.out).pinned, false)
      config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(config.display.pinned.claude, ['team', 'lab'])
      const noop = await sideby(h, ['unpin', 'cx'])
      assert.equal(noop.code, 0)
      assert.match(noop.out, /not pinned/i)
      const missing = await sideby(h, ['pin', 'claude:missing', '--json'])
      assert.equal(missing.code, 1)
      checkSchema('error', missing.out)
      for (const [i, dir] of hostDirs.entries())
        assert.deepEqual(diffSnapshots(before[i]!, await snapshot(h.path(dir))), [])
      assert.equal(await readFile(h.path('.claude.json'), 'utf8'), loginBefore)
    })
  })

  it('hides a Same Login or a Family from list and the menu bar, keeps it in --json and through a reset', async () => {
    await withFakeHome(async (h) => {
      for (const name of ['main', 'work', 'old']) {
        const dir = name === 'main' ? '.claude' : `.claude-${name}`
        await h.write(`${dir}/settings.json`, '{}')
        const email = name === 'old' ? 'old@example.com' : 'me@example.com'
        await h.write(
          name === 'main' ? '.claude.json' : `${dir}/.claude.json`,
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
          0o600,
        )
      }
      await fakeHost(h, 'claude')
      await codexMain(h)
      await fakeHost(h, 'codex')
      const hostDirs = ['.claude', '.claude-work', '.claude-old', '.codex']
      const before = await Promise.all(hostDirs.map((dir) => snapshot(h.path(dir))))
      const hide = await sideby(h, ['hide', 'claude:work', '--json'])
      assert.equal(hide.code, 0, hide.out)
      const data = checkSchema('hide', hide.out)
      assert.equal(data.kind, 'account')
      assert.equal(data.changed, true)
      let config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      // The Same Login of main and work is hidden whole.
      assert.deepEqual(new Set(config.display.hidden.claude), new Set(['main', 'work']))
      assert.equal(
        checkSchema('hide', (await sideby(h, ['hide', 'claude:main', '--json'])).out).changed,
        false,
      )
      const text = await sideby(h, ['list'])
      assert.equal(text.code, 0)
      assert.doesNotMatch(text.out, /claude:main|claude:work/)
      assert.match(text.out, /claude:old/)
      assert.match(text.out, /2 hidden; sideby list --all/)
      assert.match((await sideby(h, ['list', '--all'])).out, /claude:work.*\(hidden\)/)
      const listed = checkSchema('list', (await sideby(h, ['list', '--json'])).out) as {
        accounts: { ref: string; hidden?: true }[]
      }
      assert.deepEqual(
        listed.accounts
          .filter((x) => x.hidden)
          .map((x) => x.ref)
          .sort(),
        ['claude:main', 'claude:work'],
      )
      const hideFamily = checkSchema('hide', (await sideby(h, ['hide', 'codex', '--json'])).out)
      assert.equal(hideFamily.kind, 'family')
      const menu = checkSchema('menubar-snapshot', (await sideby(h, ['menubar', 'snapshot', '--json'])).out)
      const refs = JSON.stringify(menu)
      assert.doesNotMatch(refs, /claude:work|codex:main/)
      assert.match(refs, /claude:old/)
      const order = checkSchema('order', (await sideby(h, ['order', '--reset', '--json'])).out)
      assert.deepEqual((order.display as { hiddenFamilies?: string[] }).hiddenFamilies, ['codex'])
      assert.ok(
        (order.families as { family: string; hidden: boolean }[]).find((f) => f.family === 'codex')?.hidden,
      )
      const blocked = await sideby(h, ['unhide', 'codex:main', '--json'])
      assert.equal(blocked.code, 1)
      assert.match(String(checkSchema('error', blocked.out).error), /sideby unhide codex/)
      assert.equal((await sideby(h, ['unhide', 'codex'])).code, 0)
      assert.equal((await sideby(h, ['unhide', 'claude:work'])).code, 0)
      config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.equal(config.display, undefined)
      for (const [i, dir] of hostDirs.entries())
        assert.deepEqual(diffSnapshots(before[i]!, await snapshot(h.path(dir))), [])
    })
  })

  it('shows empty families, sets orders, and resets while keeping pins', async () => {
    await withFakeHome(async (h) => {
      const empty = await sideby(h, ['order', '--json'])
      assert.equal(empty.code, 0)
      const initial = checkSchema('order', empty.out)
      assert.deepEqual(initial.display, {})
      // Desktop app groups (Grok Bot) depend on the apps this machine has installed; check the tools only.
      const tools = (initial.families as { family: string; accounts: unknown[] }[]).filter((f) =>
        ['claude', 'codex', 'grok', 'pi'].includes(f.family),
      )
      assert.equal(tools.length, 4)
      assert.ok(tools.every((f) => f.accounts.length === 0))
      assert.equal((await sideby(h, ['order', 'codex', 'work'])).code, 1)
      await codexMain(h)
      await h.write('.codex-work/config.toml', '')
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['pin', 'codex:main'])).code, 0)
      assert.equal((await sideby(h, ['order', 'codex', 'work', 'main'])).code, 0)
      assert.equal((await sideby(h, ['order', '--families', 'codex', 'claude'])).code, 0)
      const shown = checkSchema('order', (await sideby(h, ['order', '--json'])).out)
      assert.deepEqual(shown.display, {
        families: ['codex', 'claude'],
        accounts: { codex: ['work', 'main'] },
        pinned: { codex: ['main'] },
      })
      assert.match((await sideby(h, ['order'])).out, /main.*pinned/)
      const before = await readFile(h.path('.config/sideby/config.json'), 'utf8')
      const bad = await sideby(h, ['order', 'codex', 'missing', 'other', '--json'])
      assert.equal(bad.code, 1)
      assert.match(String(checkSchema('error', bad.out).error), /missing.*other/)
      assert.equal((await sideby(h, ['order', '--families', 'missing'])).code, 1)
      assert.equal((await sideby(h, ['order', 'codex', 'main', 'main'])).code, 2)
      assert.equal((await sideby(h, ['order', '--families', 'codex', 'codex'])).code, 2)
      assert.equal(await readFile(h.path('.config/sideby/config.json'), 'utf8'), before)
      const reset = await sideby(h, ['order', '--reset', '--json'])
      assert.equal(reset.code, 0)
      assert.deepEqual(checkSchema('order', reset.out).display, { pinned: { codex: ['main'] } })
    })
  })

  it('sets quota checks and Auto Update without touching Host files', async () => {
    await withFakeHome(async (h) => {
      for (const on of ['off', 'on']) {
        const r = await sideby(h, ['quota', 'check', 'grok', on, '--json'])
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('quota-check', r.out).on, on === 'on')
        const cfg = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.equal(cfg.quota?.check?.grok !== false, on === 'on')
      }
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ update: { check: false }, aliases: { cx: 'codex:main' } }),
      )
      for (const on of ['on', 'off']) {
        const r = await sideby(h, ['update', '--auto', on, '--json'])
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('update-auto', r.out).auto, on === 'on')
        const cfg = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(cfg.update, { check: false, auto: on === 'on' })
        assert.deepEqual(cfg.aliases, { cx: 'codex:main' })
      }
      for (const args of [
        ['quota', 'check', 'missing', 'on'],
        ['quota', 'check', 'claude', 'off'],
        ['update', '--auto', 'maybe'],
        ['order', '--reset', 'codex'],
      ]) {
        const r = await sideby(h, [...args, '--json'])
        assert.notEqual(r.code, 0)
        checkSchema('error', r.out)
      }
      const status = await sideby(h, ['handoff', 'status', '--json'])
      assert.equal(status.code, 0)
      const overview = checkSchema('handoff-status', status.out).overview as {
        takeover: unknown[]
        recent: unknown[]
      }
      assert.deepEqual(overview.takeover, [])
      assert.deepEqual(overview.recent, [])
      await codexMain(h)
      await fakeHost(h, 'codex')
      await h.write('.config/sideby/config.json', JSON.stringify({ handoff: { auto: true } }))
      await h.write(
        '.local/state/sideby/handoffs/example/chain.json',
        JSON.stringify({
          hops: [
            { ref: 'codex:main', trigger: 'threshold', briefSource: 'agent' },
            { ref: 'claude:work', startedAt: '2026-10-17T00:00:00Z', brief: 'must not be returned' },
          ],
        }),
      )
      const enabled = await sideby(h, ['handoff', 'status', '--json'])
      assert.equal(enabled.code, 0)
      const active = checkSchema('handoff-status', enabled.out).overview as {
        takeover: { ref: string; decision: { kind: string } }[]
        recent: unknown[]
      }
      assert.equal(active.takeover[0]?.ref, 'codex:main')
      assert.equal(active.takeover[0]?.decision.kind, 'none')
      assert.deepEqual(active.recent, [
        {
          from: 'codex:main',
          to: 'claude:work',
          at: '2026-10-17T00:00:00Z',
          trigger: 'threshold',
          briefSource: 'agent',
        },
      ])
      assert.doesNotMatch(enabled.out, /must not be returned/)

      // The Handoff Rules (ADR-0046): every rule with the settings that change it, and the new switches.
      const rules = await sideby(h, ['handoff', 'rules', '--json'])
      assert.equal(rules.code, 0, rules.out)
      const view = checkSchema('handoff-rules', rules.out) as {
        auto: boolean
        rules: { id: string; settings: string[] }[]
        apiUndecided: boolean
      }
      assert.equal(view.auto, true)
      assert.equal(view.apiUndecided, false)
      assert.deepEqual(view.rules.find((r) => r.id === 'api')?.settings, ['api'])
      const preview = await sideby(h, [
        'handoff',
        'enable',
        '--other-ai',
        '--ai-order',
        'codex,claude',
        '--api',
        '--json',
      ])
      assert.equal(preview.code, 10, preview.out)
      const shown = checkSchema('handoff-enable', preview.out) as {
        applied: boolean
        settings: { otherFamilies: boolean; familyOrder: string[]; api: boolean }
      }
      assert.equal(shown.applied, false)
      assert.deepEqual(
        [shown.settings.otherFamilies, shown.settings.familyOrder, shown.settings.api],
        [true, ['codex', 'claude'], true],
      )
      const bad = await sideby(h, ['handoff', 'enable', '--ai-order', 'nope', '--json'])
      assert.notEqual(bad.code, 0)
      checkSchema('error', bad.out)
    })
  })
})

describe('sideby sessions (spec §3.32)', () => {
  const ID_A = '61230c3d-1111-4111-8111-111111111111'
  const ID_B = '0799701d-2222-4222-8222-222222222222'
  const PROC_START = 'Tue Oct 20 02:14:43 2026'

  /** A fake `ps` that lists the given processes, and fake clipboards that write what they get to `<bin>/clip.txt`. */
  async function fakeMachine(h: FakeHome, pids: number[], clipboard = true) {
    const lines = pids.map((p) => `${p} 1 ${PROC_START} claude`).join('\n')
    const script = (body: string) => `#!${process.execPath}\n${body}\n`
    await writeFile(join(h.bin, 'ps'), script(`process.stdout.write(${JSON.stringify(`${lines}\n`)})`), {
      mode: 0o755,
    })
    if (!clipboard) return
    const clip = join(h.bin, 'clip.txt')
    for (const name of ['pbcopy', 'wl-copy', 'xclip'])
      await writeFile(
        join(h.bin, name),
        script(
          `let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(clip)},d))`,
        ),
        { mode: 0o755 },
      )
  }

  async function claudeSessions(h: FakeHome, twoInWork: boolean) {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-work/settings.json', '{}')
    await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:work' } }))
    const rec = (pid: number, sessionId: string, name: string, status: string) =>
      h.write(
        `.claude-work/sessions/${pid}.json`,
        JSON.stringify({
          pid,
          sessionId,
          name,
          cwd: '/work/repo',
          status,
          procStart: PROC_START,
          updatedAt: 1792462484569,
        }),
      )
    await rec(4101, ID_A, 'knip cleanup', 'blocked')
    if (twoInWork) await rec(4102, ID_B, 'release notes', 'idle')
    await h.write(`.claude-work/projects/-work-repo/${ID_A}.jsonl`, '{}\n')
  }

  it('lists running sessions, needing you first, in text and --json', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const human = await sideby(h, ['sessions'])
      assert.equal(human.code, 0, human.err)
      const rows = human.out.split('\n')
      assert.match(rows[1]!, /^cc002 · knip cleanup · 61230c3d\s+needs you\s+\/work\/repo/)
      assert.match(rows[2]!, /^cc002 · release notes · 0799701d\s+idle/)
      const r = await sideby(h, ['sessions', 'cc002', '--json'])
      const data = checkSchema('sessions', r.out)
      const list = data.sessions as { label: string; reference: string; transcript?: string }[]
      assert.equal(list.length, 2)
      assert.match(
        list[0]!.reference,
        /^cc002's session 61230c3d \(knip cleanup\), working directory \/work\/repo, record at /,
      )
      const empty = await sideby(h, ['sessions', 'claude:main'])
      assert.match(
        empty.out,
        /claude:main has no running session now\. Start one with `sideby run <account>`/,
      )
    })
  })

  it("shows the Run a session works for from the orchestrator's Session Index (ADR-0041)", async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const board = await h.write('state/ad/boards/r1.html', '<!doctype html>\n', 0o600)
      const other = await h.write('state/ad/boards/r2.html', '<!doctype html>\n', 0o600)
      const entry = (b: string, runTitle: string, role: string, lane: string) => ({
        run: 'r',
        runTitle,
        board: b,
        lane,
        laneTitle: 'sideby link',
        role,
        url: `file://${b}#lane-${lane}`,
      })
      await h.write(
        'state/ad/session-index.json',
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          generatedAt: '2026-10-20T07:00:00Z',
          sessions: {
            [ID_A]: {
              entries: [entry(other, 'Review pass', 'review', 'R'), entry(board, 'Run board', 'write', 'D2')],
            },
          },
        }),
      )
      const env = { AGENT_DISPATCH_STATE_DIR: h.path('state/ad') }
      const human = await sideby(h, ['sessions'], env)
      assert.equal(human.code, 0, human.err)
      assert.match(human.out, /RUN/)
      assert.match(human.out, /knip cleanup · 61230c3d.*Run board \+1/)
      assert.match(human.out, /Run: Run board {2}~\/state\/ad\/boards\/r1\.html\n/)
      assert.match(human.out, /Run: Review pass {2}~\/state\/ad\/boards\/r2\.html\n/)
      const r = await sideby(h, ['sessions', '--json'], env)
      const data = checkSchema('sessions', r.out)
      const list = data.sessions as { sessionId: string; run?: unknown }[]
      assert.deepEqual(list.find((s) => s.sessionId === ID_A)?.run, {
        title: 'Run board',
        laneTitle: 'sideby link',
        role: 'write',
        board,
        url: `file://${board}#lane-D2`,
        others: [{ title: 'Review pass', laneTitle: 'sideby link', role: 'review', board: other }],
      })
      assert.equal(list.find((s) => s.sessionId === ID_B)?.run, undefined)
      // Without the index, nothing changes.
      const plain = await sideby(h, ['sessions'])
      assert.doesNotMatch(plain.out, /RUN|Run:/)
    })
  })

  it('copies one session, lists several instead of guessing, and prints the text without a clipboard', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const several = await sideby(h, ['sessions', 'copy', 'cc002'])
      assert.equal(several.code, 1)
      assert.match(
        several.err,
        /cc002 runs 2 sessions now; copy one by its id:\n {2}sideby sessions copy 61230c3d/,
      )
      const severalJson = await sideby(h, ['sessions', 'copy', 'cc002', '--json'])
      assert.equal(severalJson.code, 1)
      assert.equal(JSON.parse(severalJson.out).code, 'several-sessions')

      const id = await sideby(h, ['sessions', 'copy', '61230c3d', '--as', 'id', '--json'])
      assert.equal(id.code, 0, id.err)
      const data = checkSchema('sessions-copy', id.out)
      assert.deepEqual([data.copied, data.as, data.text], [true, 'id', ID_A])
      assert.equal(await readFile(join(h.bin, 'clip.txt'), 'utf8'), ID_A)

      const zh = await sideby(h, ['sessions', 'copy', ID_A, '--lang', 'zh'])
      assert.equal(zh.code, 0, zh.err)
      assert.match(zh.out, /copied a reference to cc002 · knip cleanup · 61230c3d/)
      assert.match(
        await readFile(join(h.bin, 'clip.txt'), 'utf8'),
        /^cc002 的会话 61230c3d（knip cleanup），工作目录 \/work\/repo/,
      )
      const bad = await sideby(h, ['sessions', 'copy', ID_A, '--as', 'path'])
      assert.equal(bad.code, 2)
    })
    await withFakeHome(async (h) => {
      await claudeSessions(h, false)
      await fakeMachine(h, [4101], false)
      // Only the fake bin: no pbcopy, wl-copy or xclip anywhere on PATH.
      const env = { PATH: h.bin }
      const r = await sideby(h, ['sessions', 'copy', 'cc002', '--as', 'resume'], env)
      assert.equal(r.code, 0, r.err)
      assert.equal(r.out.trim(), `sideby resume claude -- --resume ${ID_A}`)
      assert.match(r.err, /no clipboard program found .*copy the text above yourself/)
      const j = checkSchema(
        'sessions-copy',
        (await sideby(h, ['sessions', 'copy', 'cc002', '--json'], env)).out,
      )
      assert.equal(j.copied, false)
      const none = await sideby(h, ['sessions', 'copy', 'claude:main'], env)
      assert.equal(none.code, 1)
      assert.match(
        none.err,
        /claude:main has no running session now; start one with `sideby run claude:main`/,
      )
    })
  })
})

describe('sideby send and messages (spec §3.32 step 2)', () => {
  const ID_A = '61230c3d-1111-4111-8111-111111111111'
  const ID_G = '01a14d11-4444-4444-8444-444444444444'
  const PROC_START = 'Tue Oct 20 02:14:43 2026'
  const script = (body: string) => `#!${process.execPath}\n${body}\n`

  /** cc002 runs one Claude session whose message socket a server in this test serves; grok:main runs one too. */
  async function setUp(h: FakeHome, settings = '{}') {
    const { createServer } = await import('node:net')
    const tmp = join(h.home, '..', 'tmp')
    await mkdir(join(tmp, 'cc-socks'), { recursive: true, mode: 0o700 })
    await chmod(join(tmp, 'cc-socks'), 0o700)
    const sock = join(tmp, 'cc-socks', '4101.sock')
    const got: string[] = []
    const server = createServer((c) => {
      let d = ''
      c.on('data', (x) => (d += x)).on('end', () => got.push(d))
    })
    await new Promise<void>((r) => server.listen(sock, r))
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-work/settings.json', settings)
    await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:work' } }))
    await h.write(
      '.claude-work/sessions/4101.json',
      JSON.stringify({
        pid: 4101,
        sessionId: ID_A,
        name: 'knip cleanup',
        cwd: '/work/repo',
        status: 'idle',
        procStart: PROC_START,
        messagingSocketPath: sock,
      }),
    )
    await h.mkdir('.grok/skills')
    await h.write(
      '.grok/active_sessions.json',
      JSON.stringify([
        { session_id: ID_G, pid: 555, pid_start: Date.UTC(2026, 9, 20, 2, 14, 43) * 1000, cwd: '/work/g' },
      ]),
    )
    const lines = `4101 1 ${PROC_START} claude\n555 1 ${PROC_START} grok\n`
    await writeFile(join(h.bin, 'ps'), script(`process.stdout.write(${JSON.stringify(lines)})`), {
      mode: 0o755,
    })
    const clip = join(h.bin, 'clip.txt')
    for (const name of ['pbcopy', 'wl-copy', 'xclip'])
      await writeFile(
        join(h.bin, name),
        script(
          `let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(clip)},d))`,
        ),
        { mode: 0o755 },
      )
    return { env: { TMPDIR: tmp }, got, clip, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  it('delivers to a Claude session, asks for a paste elsewhere, and lists both', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"crossSessionInbound":"accept"}')
      try {
        const human = await sideby(h, ['send', 'cc002', 'the tests pass now'], m.env)
        assert.equal(human.code, 0, human.err)
        assert.match(
          human.out,
          /^✓ delivered to cc002 · knip cleanup · 61230c3d \(message [0-9a-f]{8}\)\n {2}Kept at ~\/\.local\/state\/sideby\/messages\//,
        )
        assert.equal(m.got.length, 1)
        assert.match(
          JSON.parse(m.got[0]!).message.content,
          /^sideby message [0-9a-f]{8} from the user via sideby\nthe tests pass now$/,
        )

        const g = await sideby(h, ['send', 'grok:main', 'read', 'the plan', '--json'], m.env)
        assert.equal(g.code, 0, g.err)
        const data = checkSchema('send', g.out)
        const msg = data.message as { status: string; pasteText: string; note: string; id: string }
        assert.equal(msg.status, 'paste-needed')
        assert.equal(data.copied, true)
        assert.equal(await readFile(m.clip, 'utf8'), msg.pasteText)
        assert.match(msg.note, /Grok Build cannot receive messages directly yet/)
        const gh = await sideby(h, ['send', 'grok:main', 'again'], m.env)
        assert.match(
          gh.out,
          /needs a paste\n {2}Grok Build cannot receive messages directly .*\n {2}Paste this into the tab of grok:main · g · 01a14d11 \(it is on the clipboard\):\n {2}Read the message sideby kept for you at /,
        )

        const list = checkSchema('messages', (await sideby(h, ['messages', '--json'])).out)
        assert.deepEqual(
          (list.messages as { status: string }[]).map((x) => x.status),
          ['paste-needed', 'paste-needed', 'delivered'],
        )
        const to = checkSchema('messages', (await sideby(h, ['messages', '--to', 'cc002', '--json'])).out)
        assert.equal((to.messages as unknown[]).length, 1)
        const table = await sideby(h, ['messages'])
        assert.match(table.out.split('\n')[0]!, /^SENT\s+TO\s+STATUS\s+ID\s+FROM$/)
        assert.match(table.out, /needs paste/)
        // Only the newest Message to grok:main is waiting there, so its line is printed once.
        assert.equal(table.out.match(/Paste this line into /g)?.length, 1)
        assert.match(
          table.out,
          /Paste this line into grok:main · g · 01a14d11 \(Grok Build cannot receive .*\):\n {2}Read the message sideby kept/,
        )

        const shot = await h.write('notes.txt', 'text')
        const bad = await sideby(h, ['send', 'cc002', 'look', '--image', shot], m.env)
        assert.equal(bad.code, 1)
        assert.match(bad.err, /notes\.txt is not a PNG, JPEG, GIF or WebP image/)
        assert.equal((await sideby(h, ['send', 'cc002'])).code, 2)
        const none = await sideby(h, ['send', 'nobody', 'x', '--json'], m.env)
        assert.equal(JSON.parse(none.out).code, 'no-session')
      } finally {
        await m.close()
      }
      const empty = await withFakeHome(async (e) => (await sideby(e, ['messages'])).out)
      assert.match(empty, /No messages yet\. Send one with `sideby send <account\|session> "<text>"`\./)
    })
  })

  it('shows and sets crossSessionInbound with a preview, --yes and undo', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"model":"x"}')
      await m.close()
      const status = await sideby(h, ['messages', 'inbound'])
      assert.equal(status.code, 0, status.err)
      assert.match(status.out, /not set claude:main/)
      assert.match(status.out, /Run `sideby messages inbound accept`/)
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['messages', 'inbound', 'accept'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /~\/\.claude-work\/settings\.json: crossSessionInbound not set -> "accept"/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const j = checkSchema(
        'messages-inbound',
        (await sideby(h, ['messages', 'inbound', 'accept', '--json'])).out,
      )
      assert.equal(j.applied, false)
      const groups = j.groups as { file: string; change?: unknown }[]
      assert.ok(groups.some((g) => g.file === '~/.claude-work/settings.json'))
      for (const g of groups)
        assert.deepEqual(g.change, { key: 'crossSessionInbound', from: null, to: 'accept' })
      assert.deepEqual(j.leftAlone, [])
      const done = await sideby(h, ['messages', 'inbound', 'accept', '--yes', '--json'])
      assert.equal(done.code, 0, done.out)
      assert.equal(checkSchema('messages-inbound', done.out).applied, true)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude-work/settings.json'), 'utf8')), {
        model: 'x',
        crossSessionInbound: 'accept',
      })
      const undo = await sideby(h, ['messages', 'inbound', 'undo', '--yes'])
      assert.equal(undo.code, 0, undo.out)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude-work/settings.json'), 'utf8')), {
        model: 'x',
      })
      assert.equal((await sideby(h, ['messages', 'inbound', 'maybe'])).code, 2)
    })
  })

  it('sends a screenshot alone, and says nothing changed when every account refuses', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"crossSessionInbound":"refuse"}')
      try {
        const shot = h.path('shot.png')
        await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
        const r = await sideby(h, ['send', 'cc002', '--image', shot, '--json'], m.env)
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('send', r.out).copied, true)
      } finally {
        await m.close()
      }
      await h.write('.claude/settings.json', '{"crossSessionInbound":"refuse"}')
      const a = await sideby(h, ['messages', 'inbound', 'accept', '--yes'])
      assert.equal(a.code, 1)
      assert.match(a.out, /^Nothing was changed\. claude:main: you set it to refuse/)
      await h.write('.claude-work/settings.json', '{"crossSessionInbound":"hold"}')
      const p = await sideby(h, ['messages', 'inbound', 'accept', '--json'])
      assert.equal(p.code, 10, p.out)
      const j = checkSchema('messages-inbound', p.out)
      assert.deepEqual(
        (j.groups as { change?: unknown }[]).map((g) => g.change),
        [{ key: 'crossSessionInbound', from: 'hold', to: 'accept' }],
      )
      const left = j.leftAlone as { accounts: string[]; state: string; reason: string }[]
      assert.deepEqual(
        left.map((g) => [g.accounts, g.state]),
        [[['claude:main'], 'refuse']],
      )
      assert.match(left[0]!.reason, /you set it to refuse/)
    })
  })

  it('lines up the sessions table by display width and cuts long titles', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h)
      await m.close()
      await h.write(
        '.claude-work/sessions/4101.json',
        JSON.stringify({
          pid: 4101,
          sessionId: ID_A,
          name: '修复会话标题对齐问题',
          cwd: '/work/repo',
          status: 'idle',
          procStart: PROC_START,
        }),
      )
      await writeFile(
        h.path('.grok/active_sessions.json'),
        JSON.stringify([
          {
            session_id: ID_G,
            pid: 555,
            pid_start: Date.UTC(2026, 9, 20, 2, 14, 43) * 1000,
            cwd: `/work/${'a-very-long-directory-name-'.repeat(3)}`,
          },
        ]),
      )
      const r = await sideby(h, ['sessions'])
      assert.equal(r.code, 0, r.err)
      const rows = r.out.split('\n').filter((l) => / {2}(idle|—|running)/.test(l))
      assert.equal(rows.length, 2)
      // The status column starts at the same terminal column on both rows (a Chinese character takes two).
      const { displayWidth } = await import('./format.ts')
      const col = (l: string) => displayWidth(l.slice(0, l.search(/ {2}(idle|—|running)/)))
      assert.equal(col(rows[0]!), col(rows[1]!))
      assert.ok(r.out.includes('…'), 'a long title is cut')
      assert.ok(r.out.includes('修复会话标题对齐问题'))
    })
  })
})
