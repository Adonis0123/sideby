// Cross-session inbound (spec §3.32 step 2, ADR-0040): only the top-level `crossSessionInbound` of each Claude
// settings file changes, a shared file is written once at its real target, `refuse` is never touched, and undo puts
// back only what sideby wrote.
import assert from 'node:assert/strict'
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import type { Account, ReadContext } from '../types.ts'
import { acceptInbound, groupsToAccept, inboundGroups, undoInbound, waitingFiles } from './inbound.ts'

const MARKER = 'not-a-secret-marker-only-for-this-test'

const acct = (h: FakeHome, name: string, family = 'claude'): Account => ({
  family,
  name,
  ref: `${family}:${name}`,
  dir: h.path(name === 'main' ? `.${family}` : `.${family}-${name}`),
  isMain: name === 'main',
  kind: 'subscription',
})

const ctx = (h: FakeHome): ReadContext => ({
  home: h.home,
  now: new Date(),
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})

const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'))

/** main has no key and 001 links to it; 002 holds; 003 refuses; 004 has no settings.json. */
async function setUp(h: FakeHome) {
  await h.write('.claude/settings.json', `{\n    "env": { "X": "${MARKER}" }\n}\n`)
  await mkdir(h.path('.claude-001'), { recursive: true })
  await symlink(h.path('.claude/settings.json'), h.path('.claude-001/settings.json'))
  await h.write('.claude-002/settings.json', '{"model":"x","crossSessionInbound":"hold"}')
  await h.write('.claude-003/settings.json', '{"crossSessionInbound":"refuse"}')
  await mkdir(h.path('.claude-004'), { recursive: true })
  return ['main', '001', '002', '003', '004'].map((n) => acct(h, n)).concat(acct(h, 'main', 'codex'))
}

describe('sideby messages inbound', () => {
  it('shows each file once, reading only the one key', async () => {
    await withFakeHome(async (h) => {
      const all = await setUp(h)
      const groups = await inboundGroups(all, ctx(h))
      assert.deepEqual(
        groups.map((g) => [g.accounts, g.state]),
        [
          [['claude:main', 'claude:001'], 'default'],
          [['claude:002'], 'hold'],
          [['claude:003'], 'refuse'],
          [['claude:004'], 'missing'],
        ],
      )
      assert.ok(!JSON.stringify(groups).includes(MARKER))
      assert.match(groups[2]!.reason!, /you set it to refuse, so sideby leaves it alone/)
      assert.deepEqual(
        groupsToAccept(groups).map((g) => g.accounts[0]),
        ['claude:main', 'claude:002'],
      )
    })
  })

  it('tells which files hold Messages for approval: hold, or not set where an Account starts in bypass', async () => {
    await withFakeHome(async (h) => {
      const all = await setUp(h)
      const groups = await inboundGroups(all, ctx(h))
      const files = (s: Set<string>) => groups.filter((g) => s.has(g.file)).map((g) => g.accounts[0])
      assert.deepEqual(files(await waitingFiles(groups, all, () => [])), ['claude:002'])
      const bypass = (a: Account) => (a.ref === 'claude:001' ? [['--dangerously-skip-permissions']] : [])
      assert.deepEqual(files(await waitingFiles(groups, all, bypass)), ['claude:main', 'claude:002'])
    })
  })

  it('writes only crossSessionInbound where it is not set or holds, keeps links, and undoes only its own value', async () => {
    await withFakeHome(async (h) => {
      const all = await setUp(h)
      const before = await snapshot(h.home)
      const r = await acceptInbound(all, ctx(h))
      assert.equal(r.ok, true, r.message)
      assert.deepEqual(
        r.results.map((x) => x.accounts),
        [['claude:main', 'claude:001'], ['claude:002']],
      )
      const changed = diffSnapshots(before, await snapshot(h.home)).filter((p) => !p.startsWith('.local'))
      assert.deepEqual(changed.sort(), ['.claude-002/settings.json', '.claude/settings.json'])
      assert.deepEqual(await json(h.path('.claude/settings.json')), {
        env: { X: MARKER },
        crossSessionInbound: 'accept',
      })
      // The file keeps its own indentation, and the link still points where it did.
      assert.match(await readFile(h.path('.claude/settings.json'), 'utf8'), /^\{\n {4}"env"/)
      assert.equal(await readlink(h.path('.claude-001/settings.json')), h.path('.claude/settings.json'))
      assert.deepEqual(await json(h.path('.claude-002/settings.json')), {
        model: 'x',
        crossSessionInbound: 'accept',
      })
      assert.deepEqual(await json(h.path('.claude-003/settings.json')), { crossSessionInbound: 'refuse' })
      assert.equal(
        await readFile(h.path('.claude-004/settings.json'), 'utf8').catch(() => null),
        null,
        'no settings.json is created',
      )
      // A second run has nothing to do.
      assert.equal((await acceptInbound(all, ctx(h))).results.length, 0)

      // Someone changes 002 afterwards: undo leaves it alone and puts back only the main file.
      await writeFile(h.path('.claude-002/settings.json'), '{"crossSessionInbound":"hold"}')
      const u = await undoInbound(all, ctx(h))
      assert.deepEqual(
        u.results.map((x) => [x.accounts[0], x.ok]),
        [['claude:main', true]],
      )
      assert.deepEqual(await json(h.path('.claude/settings.json')), { env: { X: MARKER } })
      assert.equal((await undoInbound(all, ctx(h))).message, 'There is nothing from sideby to undo.')
      const records = join(h.path('.local/state/sideby'), 'cross-session-inbound')
      assert.ok(!(await readFile(join(records, 'x'), 'utf8').catch(() => '')).includes(MARKER))
    })
  })

  it('changes nothing when every file already accepts or refuses, and says why when one cannot be written', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"crossSessionInbound":"accept"}')
      const r = await acceptInbound([acct(h, 'main')], ctx(h))
      assert.equal(r.ok, false)
      assert.match(
        r.message,
        /already show Messages from other sessions at once \(already accept, nothing changed\)/,
      )
      await h.write('.claude/settings.json', '[1]')
      const bad = await acceptInbound([acct(h, 'main')], ctx(h))
      assert.equal(bad.ok, false)
      assert.match(bad.message, /settings\.json cannot be changed safely: it is not a JSON object/)
    })
  })
})

describe('doctor and held messages', () => {
  it('warns for an account that starts in bypass mode while it holds messages, and points at the command', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-001/settings.json', '{}')
      await h.write('.claude-002/settings.json', '{"permissions":{"defaultMode":"bypassPermissions"}}')
      await h.write('.claude-003/settings.json', '{"crossSessionInbound":"accept"}')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({
          aliases: {
            cc001: { account: 'claude:001', args: ['--dangerously-skip-permissions'] },
            cc003: { account: 'claude:003', args: ['--dangerously-skip-permissions'] },
          },
        }),
      )
      const { createRuntime } = await import('../runtime.ts')
      const rt = await createRuntime({ env: h.env })
      const before = await snapshot(h.home)
      const report = await rt.doctor({ persist: false })
      const held = report.accounts
        .flatMap((a) => a.findings)
        .filter((f) => f.code === 'messages.inbound-held')
      assert.deepEqual(
        held.map((f) => [f.account, f.level, f.fixable]),
        [
          ['claude:001', 'warn', false],
          ['claude:002', 'warn', false],
        ],
      )
      assert.match(held[0]!.hint!, /sideby messages inbound accept/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })
})

describe('values sideby leaves alone', () => {
  it('changes only an unset key or "hold", says why it leaves the rest, and undoes to the exact old value', async () => {
    await withFakeHome(async (h) => {
      const odd = [false, 5, { a: 1 }, null, 'later']
      for (const [i, v] of odd.entries())
        await h.write(`.claude-${i + 1}/settings.json`, JSON.stringify({ crossSessionInbound: v }))
      const accounts = odd.map((_, i) => acct(h, String(i + 1)))
      const before = await snapshot(h.home)
      const groups = await inboundGroups(accounts, ctx(h))
      assert.deepEqual(new Set(groups.map((g) => g.state)), new Set(['other']))
      assert.deepEqual(groupsToAccept(groups), [])
      const r = await acceptInbound(accounts, ctx(h))
      assert.equal(r.ok, false)
      assert.match(
        r.message,
        /^Nothing was changed\. claude:1: it holds a value sideby does not know, so sideby leaves it alone/,
      )
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])

      // "hold" goes back to "hold"; a key that was not there goes away again.
      await h.write('.claude-hold/settings.json', '{"crossSessionInbound":"hold","x":1}')
      await h.write('.claude-none/settings.json', '{"x":1}')
      const two = [acct(h, 'hold'), acct(h, 'none')]
      const done = await acceptInbound([...two, ...accounts], ctx(h))
      assert.equal(done.ok, true)
      assert.match(done.message, /Left alone: claude:1: it holds a value sideby does not know/)
      assert.equal((await undoInbound(two, ctx(h))).ok, true)
      assert.deepEqual(await json(h.path('.claude-hold/settings.json')), {
        crossSessionInbound: 'hold',
        x: 1,
      })
      assert.deepEqual(await json(h.path('.claude-none/settings.json')), { x: 1 })
    })
  })

  it('reports nothing changed, not success, when every account refuses or there is none', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"crossSessionInbound":"refuse"}')
      const r = await acceptInbound([acct(h, 'main')], ctx(h))
      assert.equal(r.ok, false)
      assert.match(
        r.message,
        /^Nothing was changed\. claude:main: you set it to refuse, so sideby leaves it alone/,
      )
      const none = await acceptInbound([acct(h, 'main', 'codex')], ctx(h))
      assert.deepEqual([none.ok, none.message], [false, 'No Claude accounts found, so nothing was changed.'])
    })
  })
})
