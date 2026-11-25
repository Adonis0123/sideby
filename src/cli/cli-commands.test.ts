import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
import { checkSchema, codexMain, sideby, sidebySpawn } from './cli-test-helpers.ts'

describe('quota setup through the Runtime (hardening round 2)', () => {
  it('a plugin quota setup that throws is reported as a blocked plan matching the schema', async () => {
    await withFakeHome(async (h) => {
      const dir = '.config/sideby/plugins/lab'
      await h.write(`${dir}/plugin.json`, JSON.stringify({ name: 'lab', version: '1.0.0' }))
      await h.write(
        `${dir}/index.ts`,
        `export default { name: 'lab', register(api) { api.family({ id: 'lab', title: 'Lab', bin: 'lab', installUrl: 'https://example.invalid', selectVar: 'LAB_HOME', layout: { main: '.lab', account: '.lab-<name>' }, hijackVars: [], apiVars: [], sharedItems: [], login: { args: null, hint: '' }, quotaSetup: { summary: 's', plan() { throw new Error('cannot plan') }, async apply() { throw new Error('no') }, async teardown() { throw new Error('nope') } } }) } }\n`,
      )
      const r = await sidebySpawn(h, ['quota', 'setup', 'lab', '--json'])
      assert.equal(r.code, 1)
      const data = checkSchema('quota-setup', r.out) as { plan: { status: string; message: string } }
      assert.deepEqual([data.plan.status, data.plan.message], ['blocked', 'cannot plan'])
      const down = await sidebySpawn(h, ['quota', 'teardown', 'lab', '--json'])
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
      const r = await sidebySpawn(h, ['list', '--json'])
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
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ plugins: { 'env-adder': { value: 'kept-out-of-the-listing' } } }),
      )
      assert.equal((await sideby(h, ['run', 'codex:main'])).code, 0)
      const [rec] = await readHostLog(h, 'codex')
      assert.equal(rec!.env.FROM_PLUGIN, 'kept-out-of-the-listing')
      assert.deepEqual(rec!.argv, ['--added'])
      const listed = await sideby(h, ['plugins', '--json'])
      const data = checkSchema('plugins', listed.out) as { plugins: { name: string; configKeys: string[] }[] }
      assert.deepEqual(data.plugins.find((p) => p.name === 'env-adder')!.configKeys, ['value'])
      // A value no temporary folder name can hold by chance, as a short number can.
      assert.doesNotMatch(listed.out, /kept-out-of-the-listing/)
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

describe('model (spec §3.19)', () => {
  it('shows the model and effort, previews a change with exit 10 and writes it only with --yes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet"}\n')
      await fakeHost(h, 'claude')
      const shown = await sideby(h, ['model', 'claude:main'])
      assert.equal(shown.code, 0)
      assert.match(shown.out, /model {3}sonnet {2}\(from the host config\)/)
      const data = checkSchema('model', (await sidebySpawn(h, ['model', 'claude:main', '--json'])).out)
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
      const list = checkSchema('theme', (await sidebySpawn(h, ['theme', '--json'])).out)
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
