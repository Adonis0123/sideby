import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { checkSchema, codexMain, sideby, sidebySpawn } from './cli-test-helpers.ts'

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
      assert.match(r.out, /Next: claude:lab \(the most room per running session, 7d 20% of 95%\)/)
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
      const dry = await sidebySpawn(h, ['next', 'claude', '--dry-run'])
      assert.equal(dry.code, 0, dry.err)
      assert.match(dry.out, /Next: claude:work/)
      assert.match(dry.out, /sideby run claude:work/)
      const j = await sidebySpawn(h, ['next', 'claude', '--json'])
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

  it('past the Takeover Limit starts the least used account under 100%, and says so (a Last Resort)', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await cache(h, 'main', 92, 40, 3)
      await cache(h, 'work', 86, 40, 1)
      await cache(h, 'lab', 99, 20, 5)
      const j = await sideby(h, ['next', 'claude', '--json'])
      assert.equal(j.code, 0, j.err)
      const plan = checkSchema('next', j.out) as {
        pick: string
        tight?: { limit: number; longLimit: number }
        accounts: { ref: string; state: string }[]
        earliestReset?: unknown
      }
      assert.equal(plan.pick, 'claude:work')
      assert.deepEqual(plan.tight, { limit: 85, longLimit: 95 })
      assert.equal(plan.earliestReset, undefined)
      // Still `full` in JSON: past the limit; the least used one comes first.
      assert.deepEqual(
        plan.accounts.map((a) => `${a.ref} ${a.state}`),
        ['claude:work full', 'claude:main full', 'claude:lab full'],
      )
      const r = await sideby(h, ['next', 'claude', '--', '--print', 'hi'])
      assert.equal(r.code, 0, r.err)
      assert.match(
        r.out,
        /Next: claude:work \(every claude account is past its limit \(85% of a 5-hour window, 95% of a weekly one\); this one has the most left, 5h 86% of 85%\)/,
      )
      assert.match(r.out, /claude:main\s+low\s+past its limit: 5h 92% of 85% .*; resets /)
      const [rec] = await readHostLog(h, 'claude')
      assert.equal(rec?.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
    })
  })

  it('starts nothing when every account has a window used up, and says which comes back first', async () => {
    await withFakeHome(async (h) => {
      await claudeAccounts(h)
      await cache(h, 'main', 100, 40, 3)
      await cache(h, 'work', 100, 90, 1)
      await cache(h, 'lab', 100, 20, 5)
      const r = await sideby(h, ['next', 'claude'])
      assert.equal(r.code, 1)
      assert.match(r.err, /every signed-in claude account has used up its quota; claude:work is back /)
      assert.match(r.out, /claude:work\s+full\s+used up; back /)
      const j = await sideby(h, ['next', 'claude', '--json'])
      assert.equal(j.code, 1)
      const plan = checkSchema('next', j.out) as {
        pick: null
        tight?: unknown
        earliestReset: { ref: string; at: string }
      }
      assert.equal(plan.pick, null)
      assert.equal(plan.tight, undefined)
      // Back when its used-up 5-hour window resets, not when its 90% weekly one does.
      assert.equal(plan.earliestReset.ref, 'claude:work')
      assert.ok(Date.parse(plan.earliestReset.at) - Date.now() < 2 * 3600_000)
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
      for (const n of ['main', 'work', 'lab']) await cache(h, n, 100, 50)
      await h.write('.claude-key/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
      const r = await sideby(h, ['next', 'claude', '--dry-run'])
      assert.equal(r.code, 1)
      assert.match(r.err, /add --include-api/)
      const api = await sideby(h, ['next', 'claude', '--dry-run', '--include-api'])
      assert.equal(api.code, 0, api.err)
      assert.match(api.out, /Next: claude:key \(API account, pay per use\)/)
      // A subscription past the Takeover Limit but under 100% comes before an API account.
      await cache(h, 'lab', 95, 50)
      const tight = await sideby(h, ['next', 'claude', '--dry-run', '--include-api'])
      assert.equal(tight.code, 0, tight.err)
      assert.match(
        tight.out,
        /Next: claude:lab \(every claude account is past its limit \(85% of a 5-hour window/,
      )
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
      const ask = await sidebySpawn(h, ['alias', 'add', 'cc', '--pick', 'claude', '--json'])
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
      assert.match(second.err, /cc → claude:lab \(7d 20% used, the most room\)/)
      const [one, two] = await readHostLog(h, 'claude')
      assert.equal(one?.env.CLAUDE_CONFIG_DIR, undefined)
      assert.deepEqual(one?.argv.slice(-2), ['--print', 'hi'])
      assert.equal(two?.env.CLAUDE_CONFIG_DIR, h.path('.claude-lab'))
      // A by-id resume starts the account that holds the session, whatever the quota (spec §3.13).
      const sid = '43ad416d-f46d-4bcb-a1de-45103986a005'
      await h.write(`.claude-work/projects/-repo/${sid}.jsonl`, '{}\n')
      const resumed = await sideby(h, ['run', 'cc', '--', '--resume', sid])
      assert.equal(resumed.code, 0, resumed.err)
      assert.match(resumed.err, new RegExp(`session ${sid} is in claude:work; starting it there`))
      assert.doesNotMatch(resumed.err, /the most room/)
      // A session only started (never saved) opens a new one where it started, without the resume.
      const unsaved = '11111111-2222-4333-8444-555555555555'
      await mkdir(h.path(`.claude/session-env/${unsaved}`), { recursive: true })
      const fresh = await sideby(h, ['run', 'cc', '--', '-r', unsaved, '--print', 'hi'])
      assert.equal(fresh.code, 0, fresh.err)
      assert.match(
        fresh.err,
        new RegExp(`session ${unsaved} was never saved; starting a new session in claude:main`),
      )
      const [, , three, four] = await readHostLog(h, 'claude')
      assert.equal(three?.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.deepEqual(three?.argv.slice(-2), ['--resume', sid])
      assert.equal(four?.env.CLAUDE_CONFIG_DIR, undefined)
      assert.deepEqual(four?.argv.slice(-2), ['--print', 'hi'])
      assert.ok(!four?.argv.includes(unsaved))
      // Every account past the Takeover Limit: the least used one under 100%, and the line says so.
      await cache(h, 'work', 86, 40, 1)
      await cache(h, 'lab', 99, 20, 5)
      const tight = await sideby(h, ['run', 'cc'])
      assert.equal(tight.code, 0, tight.err)
      assert.match(
        tight.err,
        /cc → claude:work \(every claude account is past its limit, 85% of a 5-hour window or 95% of a weekly one; this one has the most left, 5h 86% used\)/,
      )
      assert.equal((await readHostLog(h, 'claude'))[4]?.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      // Every account with a window used up: nothing starts, and it says which comes back first.
      await cache(h, 'main', 100, 40, 3)
      await cache(h, 'work', 100, 50, 1)
      await cache(h, 'lab', 100, 20, 5)
      const full = await sideby(h, ['run', 'cc'])
      assert.equal(full.code, 1)
      assert.match(full.err, /cc: every signed-in claude account has used up its quota; claude:work is back /)
      assert.equal((await readHostLog(h, 'claude')).length, 5)

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
      const preview = await sidebySpawn(h, ['shell-init', 'setup', '--json'], env)
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
})
