import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
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
import { checkSchema, MAIN, sideby, sidebySpawn } from './cli-test-helpers.ts'

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
      const routed = await sidebySpawn(h, ['resume', 'claude', '--', '--resume', ID], {
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
      const r = await sidebySpawn(h, ['families', 'claude', '--json'])
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

  it('new --api names the short command after the vendor, and never gives an API account a numbered one', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      for (const n of ['001', '002'])
        assert.equal((await sideby(h, ['new', 'claude', n, '--alias', `cc${n}`])).code, 0)

      // --vendor: the Family's prefix and the slug.
      const ds = await sideby(h, ['new', 'claude', '--next', '--api', '--vendor', 'ds', '--json'])
      assert.equal(ds.code, 0, ds.out + ds.err)
      const d = checkSchema('new', ds.out)
      assert.deepEqual(d.suggestion, { name: '003', alias: 'cc-ds' })
      assert.deepEqual(d.alias, { name: 'cc-ds', added: true })
      assert.equal((d.account as { kind: string }).kind, 'api')

      // Without --vendor: no short command, and the hint says how to get one.
      const plain = await sideby(h, ['new', 'claude', '--next', '--api', '--json'])
      assert.equal(plain.code, 0, plain.out)
      const p = checkSchema('new', plain.out)
      const sug = p.suggestion as { name: string; alias?: string; aliasHint?: string }
      assert.equal(sug.name, '004')
      assert.equal(sug.alias, undefined)
      assert.match(
        sug.aliasHint as string,
        /--vendor <slug>.*cc-<slug>.*sideby alias add cc-<slug> claude:004/,
      )
      assert.equal(p.alias, undefined)
      const text = await sideby(h, ['new', 'claude', '--next', '--api'])
      assert.match(
        text.out,
        /no short command yet\. API accounts get a short command named after their vendor/,
      )

      // A taken or invalid slug is reported; the Account is still created, without a short command.
      const taken = checkSchema(
        'new',
        (await sideby(h, ['new', 'claude', '--next', '--api', '--vendor', 'ds', '--json'])).out,
      )
      assert.match((taken.suggestion as { aliasProblem: string }).aliasProblem, /^cc-ds: /)
      assert.equal(taken.alias, undefined)
      const bad = checkSchema(
        'new',
        (await sideby(h, ['new', 'claude', 'kimi', '--api', '--vendor', 'Ki mi', '--json'])).out,
      )
      assert.match((bad.suggestion as { aliasProblem: string }).aliasProblem, /^cc-Ki mi: /)
      assert.ok((await stat(h.path('.claude-kimi'))).isDirectory())

      // An explicit name works with --vendor too.
      const named = checkSchema(
        'new',
        (await sideby(h, ['new', 'claude', 'moon', '--api', '--vendor', 'kimi', '--json'])).out,
      )
      assert.deepEqual(named.suggestion, { name: 'moon', alias: 'cc-kimi' })

      // The subscription path still follows the numbering.
      const sub = checkSchema('new', (await sideby(h, ['new', 'claude', '--next', '--json'])).out)
      assert.equal(
        (sub.suggestion as { alias: string }).alias,
        `cc${(sub.suggestion as { name: string }).name}`,
      )

      // --vendor without --api is a usage error and creates nothing.
      const noApi = await sideby(h, ['new', 'claude', 'x1', '--vendor', 'ds'])
      assert.equal(noApi.code, 2)
      assert.match(noApi.err, /add --api/)
      assert.equal(await stat(h.path('.claude-x1')).catch(() => null), null)
    })
  })

  it('new --api --vendor gives no short command when the Family has no prefix to use', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      const r = checkSchema(
        'new',
        (await sideby(h, ['new', 'claude', '--next', '--api', '--vendor', 'ds', '--json'])).out,
      )
      const sug = r.suggestion as { alias?: string; aliasHint?: string }
      assert.equal(sug.alias, undefined)
      assert.match(sug.aliasHint as string, /no prefix to put before ds/)
      assert.equal(r.alias, undefined)
      const config = await readFile(h.path('.config/sideby/config.json'), 'utf8').catch(() => '{}')
      assert.equal(JSON.parse(config).aliases?.['cc-ds'], undefined)
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

  it('groups the general help by task, generated from the Command List (spec §3.38)', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['--help'])
      assert.equal(r.code, 0)
      assert.match(r.out, /\nAccounts:\n {2}sideby {30}list accounts/)
      assert.match(r.out, /\nAuto Handoff:\n {2}sideby handoff status/)
      assert.match(r.out, /\n {2}sideby commands +list every command by task/)
    })
  })

  it('`sideby commands` with no words lists every command by task, the common ones first (spec §3.38)', async () => {
    await withFakeHome(async (h) => {
      const text = await sideby(h, ['commands'])
      assert.equal(text.code, 0, text.err)
      assert.match(text.out, /^Common\n {2}sideby list {2,}List your accounts/)
      assert.ok(text.out.indexOf('\nAccounts\n') > text.out.indexOf('Common'))
      assert.match(text.out, /sideby run <account> \[-- args\] {2,}Start the AI tool as one account/)

      const r = await sidebySpawn(h, ['commands', '--json'])
      assert.equal(r.code, 0, r.err)
      const data = checkSchema('commands-list', r.out) as {
        common: string[]
        groups: {
          id: string
          commands: {
            id: string
            usage: string
            example: string | null
            featureId: string | null
            panel: string | null
          }[]
        }[]
      }
      assert.equal(data.common[0], 'list')
      assert.equal(data.groups[0]!.id, 'accounts')
      const all = data.groups.flatMap((g) => g.commands)
      const run = all.find((c) => c.id === 'run')!
      assert.equal(run.example, 'sideby run claude:work')
      const enable = all.find((c) => c.id === 'handoff.enable')!
      assert.equal(enable.featureId, 'action.handoff-on')
      assert.equal(enable.panel, 'Auto Handoff page')

      // Words search the Search Catalog instead of listing the commands.
      const found = await sideby(h, ['commands', 'language', '--json'])
      assert.equal(found.code, 0)
      const hits = checkSchema('commands', found.out) as { results: { id: string }[] }
      assert.equal(hits.results[0]!.id, 'setting.language')
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
      const r = await sidebySpawn(h, ['handoff', 'status', '--json'])
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
