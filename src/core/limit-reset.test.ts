// The operation records of a Limit Reset (spec §3.40, ADR-0072): what is kept, for how long, and the spend lock.
import assert from 'node:assert/strict'
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withFakeHome } from '../../testing/index.ts'
import {
  confirmedSpends,
  isOperationId,
  LimitResetError,
  limitResetDir,
  limitResetFile,
  listLimitResetRecords,
  loginUnchanged,
  newLimitResetRecord,
  pruneLimitResetRecords,
  RECORD_KEEP_MS,
  readLimitResetRecord,
  sameAccounts,
  scanLimitResetRecords,
  takeLimitResetLock,
  unreadableRecordsMessage,
  unresolvedFor,
  writeLimitResetRecord,
} from './limit-reset.ts'
import { loginComparisonKey } from './same-login.ts'

const NOW = new Date('2026-11-12T12:00:00Z')
// A login's comparison key (core/same-login.ts), with fake values only.
const KEY = loginComparisonKey({
  family: 'codex',
  kind: 'subscription',
  identity: { email: 'me@example.com' },
  loginKey: '0123456789abcdef',
})!
// chmod 000 does not stop root from reading.
const root = process.getuid?.() === 0
const later = (ms: number) => new Date(NOW.getTime() + ms)

describe('Limit Reset operation records', () => {
  it('keeps a record in a 700 folder as a 600 file, with nothing but the operation in it', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const rec = newLimitResetRecord(['codex:work', 'codex:main'], NOW, KEY)
      assert.ok(isOperationId(rec.operationId))
      assert.deepEqual(rec.accounts, ['codex:main', 'codex:work'], 'sorted')
      assert.equal(rec.state, 'planned')
      await writeLimitResetRecord(state, rec)
      const dir = limitResetDir(state)
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      const file = join(dir, `${rec.operationId}.json`)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), [
        'accounts',
        'attempts',
        'createdAt',
        'idempotencyKey',
        'login',
        'operationId',
        'state',
        'version',
      ])
      assert.deepEqual(await readLimitResetRecord(state, rec.operationId), rec)
      // No temp file is left beside it.
      assert.deepEqual(await readdir(dir), [`${rec.operationId}.json`])
    })
  })

  it('reads only records it wrote: an id that is not one, a broken file and an unknown state are nothing', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const rec = newLimitResetRecord(['codex:main'], NOW, KEY)
      await writeLimitResetRecord(state, rec)
      const dir = limitResetDir(state)
      assert.equal(await readLimitResetRecord(state, '../../etc/passwd'), null)
      assert.equal(isOperationId('lr-abc'), false)
      await writeFile(join(dir, 'lr-zzzzzzzz-00000000.json'), '{ not json')
      await writeFile(
        join(dir, 'lr-yyyyyyyy-00000000.json'),
        JSON.stringify({ ...rec, operationId: 'lr-yyyyyyyy-00000000', state: 'spent-twice' }),
      )
      await writeFile(join(dir, 'notes.txt'), 'x')
      assert.deepEqual(
        (await listLimitResetRecords(state)).map((r) => r.operationId),
        [rec.operationId],
      )
      // They are not "nothing there" either: an operation file that is no record may hide an unresolved spend.
      const scan = await scanLimitResetRecords(state)
      assert.deepEqual(
        scan.records.map((r) => r.operationId),
        [rec.operationId],
      )
      assert.deepEqual(scan.unreadable, [
        join(dir, 'lr-yyyyyyyy-00000000.json'),
        join(dir, 'lr-zzzzzzzz-00000000.json'),
      ])
    })
  })

  it('tells an operation file that is not there from one that cannot be read, and never removes the latter', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const dir = limitResetDir(state)
      // No folder yet: nothing was ever kept.
      assert.deepEqual(await scanLimitResetRecords(state), { records: [], unreadable: [] })
      assert.equal(await readLimitResetRecord(state, 'lr-aaaaaaaa-00000000'), null)
      const open = { ...newLimitResetRecord(['codex:main'], NOW, KEY), state: 'pending' as const }
      const done = {
        ...newLimitResetRecord(['codex:work'], NOW, KEY),
        state: 'reset' as const,
        finishedAt: NOW.toISOString(),
      }
      for (const r of [open, done]) await writeLimitResetRecord(state, r)
      const file = limitResetFile(state, open.operationId)
      const good = await readFile(file, 'utf8')
      const unreadable = async (id: string) => {
        await assert.rejects(readLimitResetRecord(state, id), (err: unknown) => {
          assert.ok(err instanceof LimitResetError)
          assert.equal(err.code, 'records-unreadable')
          assert.ok(err.message.includes(limitResetFile(state, id)), 'names the path')
          assert.equal(err.message.includes(open.idempotencyKey), false, 'and nothing of its contents')
          assert.match(err.message, /Nothing was sent/)
          return true
        })
      }
      // Damaged: the file is there, so it is not "no such operation".
      await writeFile(file, good.slice(0, 40))
      assert.deepEqual((await scanLimitResetRecords(state)).unreadable, [file])
      await unreadable(open.operationId)
      // A record kept under another operation's name is not that operation's record.
      await writeFile(file, await readFile(limitResetFile(state, done.operationId), 'utf8'))
      assert.deepEqual((await scanLimitResetRecords(state)).unreadable, [file])
      await writeFile(file, good)
      if (!root) {
        try {
          await chmod(file, 0o000)
          const scan = await scanLimitResetRecords(state)
          assert.deepEqual(scan.unreadable, [file])
          assert.deepEqual(
            scan.records.map((r) => r.operationId),
            [done.operationId],
          )
          await unreadable(open.operationId)
          // Pruning long after never removes what it could not read.
          await pruneLimitResetRecords(state, later(400 * 24 * 3600_000))
          assert.deepEqual(
            (await readdir(dir)).filter((n) => n.endsWith('.json')),
            [`${open.operationId}.json`],
          )
          await chmod(file, 0o600)
          // The folder itself cannot be listed: that is not an empty folder.
          await chmod(dir, 0o000)
          assert.deepEqual(await scanLimitResetRecords(state), { records: [], unreadable: [dir] })
          assert.deepEqual(await listLimitResetRecords(state), [])
        } finally {
          await chmod(dir, 0o700)
          await chmod(file, 0o600)
        }
      }
      assert.deepEqual(await readLimitResetRecord(state, open.operationId), open)
      // What the user is told: the path and what to do, for a file and for the folder.
      assert.match(unreadableRecordsMessage(state, [file, join(dir, 'x')]), /and 1 more beside it/)
      assert.match(
        unreadableRecordsMessage(state, [file]),
        /chmod 600 .*vendor's own usage page.*move the file away/,
      )
      assert.match(unreadableRecordsMessage(state, [dir]), /chmod 700/)
    })
  })

  it('keeps a salted digest of the login, which tells only that the login of this operation is unchanged', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const other = loginComparisonKey({
        family: 'codex',
        kind: 'subscription',
        identity: { email: 'me@example.com' },
        loginKey: 'fedcba9876543210',
      })!
      const a = newLimitResetRecord(['codex:main'], NOW, KEY)
      const b = newLimitResetRecord(['codex:main'], NOW, KEY)
      assert.equal(loginUnchanged(a, KEY), true)
      assert.equal(loginUnchanged(a, other), false, 'the same account name under another login')
      assert.equal(loginUnchanged(a, undefined), false, 'a login that cannot be read now')
      // Two operations of one login share nothing: the digest cannot be used to group or to look a login up.
      assert.notEqual(a.login!.salt, b.login!.salt)
      assert.notEqual(a.login!.digest, b.login!.digest)
      await writeLimitResetRecord(state, a)
      const text = await readFile(limitResetFile(state, a.operationId), 'utf8')
      for (const no of [KEY, '0123456789abcdef', 'me@example.com'])
        assert.equal(text.includes(no), false, `the record holds no ${no}`)
      assert.equal(loginUnchanged((await readLimitResetRecord(state, a.operationId))!, KEY), true)
      // A record from before the digest was kept, or one whose digest is not one: never shown to be any login.
      const { login: _login, ...old } = a
      assert.equal(loginUnchanged(old, KEY), false)
      await writeFile(
        limitResetFile(state, a.operationId),
        JSON.stringify({ ...a, login: { salt: 'x', digest: KEY } }),
      )
      const odd = await readLimitResetRecord(state, a.operationId)
      assert.equal(odd?.login, undefined)
      assert.equal(loginUnchanged(odd!, KEY), false)
    })
  })

  it('has a comparison key only for a login that can be told, equal exactly when two accounts are one login', () => {
    const m = (loginKey: string | undefined, email = 'me@example.com', org?: string, family = 'codex') => ({
      family,
      kind: 'subscription' as const,
      identity: { email, ...(org ? { org } : {}) },
      ...(loginKey ? { loginKey } : {}),
    })
    assert.equal(loginComparisonKey(m('k1')), loginComparisonKey(m('k1', ' ME@example.com ')))
    assert.notEqual(loginComparisonKey(m('k1')), loginComparisonKey(m('k2')), 'another workspace or user')
    assert.notEqual(loginComparisonKey(m('k1')), loginComparisonKey(m('k1', 'me@example.com', 'Acme')))
    assert.notEqual(
      loginComparisonKey(m('k1')),
      loginComparisonKey(m('k1', 'me@example.com', undefined, 'grok')),
    )
    // A Family that needs a Login Key has no key without one; a Family that does not goes by its Identity.
    assert.equal(loginComparisonKey(m(undefined)), undefined)
    assert.ok(loginComparisonKey(m(undefined, 'me@example.com', undefined, 'claude')))
    assert.ok(loginComparisonKey(m(undefined, 'me@example.com', undefined, 'demo')), 'a plugin Family too')
    // Signed out, or an API Account: nothing to compare.
    assert.equal(loginComparisonKey({ family: 'claude', kind: 'subscription' }), undefined)
    assert.equal(loginComparisonKey({ ...m('k1'), kind: 'api' }), undefined)
  })

  it('removes a finished record and an unconfirmed plan after a day, and never an unresolved one', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const plan = newLimitResetRecord(['codex:main'], NOW, KEY)
      const done = {
        ...newLimitResetRecord(['codex:work'], NOW, KEY),
        state: 'reset' as const,
        finishedAt: later(3600_000).toISOString(),
      }
      const open = { ...newLimitResetRecord(['codex:lab'], NOW, KEY), state: 'pending' as const }
      for (const r of [plan, done, open]) await writeLimitResetRecord(state, r)
      const ids = async () => (await listLimitResetRecords(state)).map((r) => r.operationId).sort()
      await pruneLimitResetRecords(state, later(RECORD_KEEP_MS - 1))
      assert.equal((await ids()).length, 3)
      // The plan's day is over; the finished one counts from when it finished.
      await pruneLimitResetRecords(state, later(RECORD_KEEP_MS))
      assert.deepEqual(await ids(), [done.operationId, open.operationId].sort())
      await pruneLimitResetRecords(state, later(400 * 24 * 3600_000))
      assert.deepEqual(await ids(), [open.operationId])
    })
  })

  it('removes a record only under the spend lock of its accounts, after reading it again there', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const plan = newLimitResetRecord(['codex:main', 'codex:work'], NOW, KEY)
      const done = {
        ...newLimitResetRecord(['codex:lab'], NOW, KEY),
        state: 'reset' as const,
        finishedAt: NOW.toISOString(),
      }
      for (const r of [plan, done]) await writeLimitResetRecord(state, r)
      const ids = async () => (await listLimitResetRecords(state)).map((r) => r.operationId)
      const far = later(400 * 24 * 3600_000)
      // A confirmation holds the lock of that login, through either account: its plan is left for the next pruning,
      // without waiting. The record of another login goes.
      const held = await takeLimitResetLock(state, ['codex:work'], 500)
      assert.ok(held)
      const began = Date.now()
      await pruneLimitResetRecords(state, far)
      assert.ok(Date.now() - began < 2000, 'a held lock is not waited for')
      assert.deepEqual(await ids(), [plan.operationId])
      await held()
      // The plan was confirmed between the look and the lock: what is on disk now is unresolved, and it stays, with
      // its key.
      const seen: string[] = []
      await pruneLimitResetRecords(state, far, {
        afterRead: async (r) => {
          seen.push(r.state)
          await writeLimitResetRecord(state, { ...r, state: 'pending', attempts: [NOW.toISOString()] })
        },
      })
      assert.deepEqual(seen, ['planned'])
      const [kept] = await listLimitResetRecords(state)
      assert.equal(kept?.state, 'pending')
      assert.equal(kept?.idempotencyKey, plan.idempotencyKey)
      // Confirmed and answered between the look and the lock: not removed on the age its plan had.
      const next = newLimitResetRecord(['codex:lab'], later(1000), KEY)
      await writeLimitResetRecord(state, next)
      await pruneLimitResetRecords(state, far, {
        afterRead: (r) =>
          writeLimitResetRecord(state, { ...r, state: 'reset', finishedAt: far.toISOString() }),
      })
      assert.deepEqual(await ids(), [plan.operationId, next.operationId])
      // Nothing changed in between: the finished one goes a day later, the unresolved one never, and the lock is
      // free again afterwards.
      await pruneLimitResetRecords(state, new Date(far.getTime() + RECORD_KEEP_MS))
      assert.deepEqual(await ids(), [plan.operationId])
      const free = await takeLimitResetLock(state, ['codex:main', 'codex:work', 'codex:lab'], 0)
      assert.ok(free)
      await free()
    })
  })

  it('finds the unresolved operation of a login through any of its accounts, and tells a changed group', () => {
    const open = { ...newLimitResetRecord(['codex:main', 'codex:work'], NOW, KEY), state: 'pending' as const }
    const plan = newLimitResetRecord(['codex:main', 'codex:work'], NOW, KEY)
    assert.equal(unresolvedFor([plan, open], ['codex:work'])?.operationId, open.operationId)
    assert.equal(unresolvedFor([plan], ['codex:work']), undefined)
    assert.equal(unresolvedFor([open], ['codex:lab']), undefined)
    // An account that signed in as the operation's login since is not named in it: the login's key finds it.
    assert.equal(unresolvedFor([plan, open], ['codex:lab'], KEY)?.operationId, open.operationId)
    const OTHER = loginComparisonKey({
      family: 'codex',
      kind: 'subscription',
      identity: { email: 'me@example.com' },
      loginKey: 'fedcba9876543210',
    })!
    assert.equal(unresolvedFor([open], ['codex:lab'], OTHER), undefined)
    assert.equal(unresolvedFor([plan], ['codex:lab'], KEY), undefined, 'a plan is not unresolved')
    // The operation of the login that asks goes before one that only names the account.
    const theirs = { ...newLimitResetRecord(['codex:lab'], later(-1000), OTHER), state: 'pending' as const }
    assert.equal(unresolvedFor([theirs, open], ['codex:lab'], KEY)?.operationId, open.operationId)
    assert.equal(unresolvedFor([theirs, open], ['codex:lab'], OTHER)?.operationId, theirs.operationId)
    assert.equal(unresolvedFor([theirs, open], ['codex:lab'])?.operationId, theirs.operationId)
    assert.equal(sameAccounts(open, ['codex:work', 'codex:main']), true)
    assert.equal(sameAccounts(open, ['codex:main']), false)
    assert.equal(sameAccounts(open, ['codex:main', 'codex:work', 'codex:lab']), false)
  })

  it('counts a spend as confirmed only once the Quota read after it is kept', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const base = newLimitResetRecord(['codex:main'], NOW, KEY)
      await writeLimitResetRecord(state, { ...base, state: 'reset', finishedAt: NOW.toISOString() })
      assert.deepEqual(await confirmedSpends(state), [])
      const read = later(2000).toISOString()
      await writeLimitResetRecord(state, {
        ...base,
        state: 'reset',
        finishedAt: NOW.toISOString(),
        quotaReadAt: read,
      })
      assert.deepEqual(await confirmedSpends(state), [{ accounts: ['codex:main'], quotaReadAt: read }])
      // An outcome that spent nothing never counts.
      await writeLimitResetRecord(state, {
        ...newLimitResetRecord(['codex:work'], NOW, KEY),
        state: 'nothing-to-reset',
        finishedAt: NOW.toISOString(),
        quotaReadAt: read,
      })
      assert.equal((await confirmedSpends(state)).length, 1)
    })
  })

  it('gives the spend lock of a login to one holder at a time, whichever account names it', async () => {
    await withFakeHome(async (h) => {
      const state = h.path('.local/state/sideby')
      const first = await takeLimitResetLock(state, ['codex:main', 'codex:work'], 500)
      assert.ok(first)
      // Another account of the same login meets the same lock; another login does not.
      assert.equal(await takeLimitResetLock(state, ['codex:work'], 200), null)
      const other = await takeLimitResetLock(state, ['codex:lab'], 200)
      assert.ok(other)
      await other()
      await first()
      const again = await takeLimitResetLock(state, ['codex:work', 'codex:main'], 500)
      assert.ok(again)
      await again()
    })
  })

  it("is reached from two places only: the confirmed command and the Panel's confirmed request", async () => {
    // A spend cannot be undone, so nothing that runs by itself may lead to it (ADR-0072): not Auto Handoff, `sideby
    // next`, a hook, the status line or the menu. Only `limitResetUse` calls a Family's `use`, and only the
    // `quota reset --yes` command and the Panel's `confirm` request call `limitResetUse`.
    const src = fileURLToPath(new URL('..', import.meta.url))
    const files: string[] = []
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p)
      }
    }
    await walk(src)
    const where = async (re: RegExp) => {
      const hits: string[] = []
      for (const f of files) if (re.test(await readFile(f, 'utf8'))) hits.push(relative(src, f))
      return hits.sort()
    }
    assert.deepEqual(await where(/\.limitResetUse\(/), ['cli/commands.ts', 'panel/handler.ts'])
    assert.deepEqual(await where(/limitReset!?\??\.use!?\(/), ['runtime.ts'])
    assert.deepEqual(await where(/rateLimitResetCredit\/consume/), ['families/codex/quota.ts'])
    // In the command it sits behind --yes; in the Panel behind `confirm`.
    const cli = await readFile(join(src, 'cli/commands.ts'), 'utf8')
    const use = cli.indexOf('.limitResetUse(')
    const yes = cli.lastIndexOf("a.flags.has('yes')", use)
    assert.ok(yes > 0 && use - yes < 4000, 'the command checks --yes before it uses one')
    const panel = await readFile(join(src, 'panel/handler.ts'), 'utf8')
    const at = panel.indexOf('.limitResetUse(')
    assert.match(panel.slice(at - 1500, at), /confirm/)
  })
})
