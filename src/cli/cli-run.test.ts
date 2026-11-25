import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  diffSnapshots,
  type FakeHome,
  fakeHost,
  readHostLog,
  snapshot,
  withFakeHome,
} from '../../testing/index.ts'
import { checkSchema, codexMain, MAIN, sideby, sidebySpawn } from './cli-test-helpers.ts'

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

describe('a config written by a newer sideby (ADR-0080)', () => {
  it('lists, checks and reads config; says which key it ignores; refuses a new one', async () => {
    await withFakeHome(async (h) => {
      await codexMain(h)
      await fakeHost(h, 'codex')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ futureTop: true, claude: { futureKey: 1, carryTrust: true } }),
      )
      const list = await sideby(h, ['list'])
      assert.equal(list.code, 0, list.err)
      assert.match(list.out, /codex:main/)
      assert.match(list.err, /config key "claude\.futureKey" is not one sideby .* knows/)
      assert.match(list.err, /sideby config unset futureTop --yes/)
      const json = await sideby(h, ['list', '--json'])
      assert.equal(json.code, 0)
      checkSchema('list', json.out)
      const doctor = await sideby(h, ['doctor'])
      assert.match(doctor.out, /! config key "futureTop"/)
      // Reading the config touches no Host directory (what `pnpm local` runs to check a build).
      const before = await snapshot(h.home)
      const get = await sideby(h, ['config', 'get', '--json'])
      assert.equal(get.code, 0, get.err)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const typo = await sideby(h, ['config', 'set', 'claude.typoKey', 'true', '--yes', '--json'])
      assert.notEqual(typo.code, 0)
      assert.match(typo.out, /not a config key/)
      assert.equal((await sideby(h, ['config', 'unset', 'futureTop', '--yes'])).code, 0)
      assert.equal((await sideby(h, ['config', 'set', 'claude.carryTrust', 'false', '--yes'])).code, 0)
      assert.deepEqual(JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')), {
        claude: { futureKey: 1, carryTrust: false },
      })
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
      const r = await sidebySpawn(h, [])
      assert.equal(r.code, 0)
      assert.match(r.out, /claude:main/)
      assert.match(r.out, /sideby new <family> <name>/)
      const off = await sidebySpawn(h, ['quota', 'teardown', 'claude', '--json'])
      assert.equal(off.code, 1)
      checkSchema('quota-teardown', off.out)
      const plan = await sidebySpawn(h, ['quota', 'setup', 'claude', '--json'])
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

      await sidebySpawn(h, ['login', 'codex:work'])
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
      const created = await sidebySpawn(h, ['new', 'codex', 'relay', '--api', '--json'])
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
