// Using a Codex Limit Reset (spec §3.40, ADR-0072), against a scripted fake `codex app-server` only: the plan, the
// four outcomes, every way an answer can go missing, and what is kept on disk.
import assert from 'node:assert/strict'
import { chmod, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import {
  limitResetDir,
  limitResetFile,
  listLimitResetRecords,
  writeLimitResetRecord,
} from '../../core/limit-reset.ts'
import { createPanelHandler } from '../../panel/handler.ts'
import {
  CONSUME,
  checked,
  cli,
  consumes,
  EMAIL,
  failSavesFrom,
  failure,
  hostState,
  root,
  runtime,
  SECRET,
  sent,
  setMode,
  setup,
  signIn,
  USER,
  USER_2,
  WS_B,
  WS_C,
} from './limit-reset-test-helpers.ts'

describe('Codex Limit Reset', () => {
  it('keeps an unresolved operation for its own login: another login under the same account name cannot retry it', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:other'))
      await setMode(h, 'lost')
      assert.equal(
        (await failure(rt.limitResetUse(await rt.resolve('codex:other'), plan.operationId!))).code,
        'outcome-unknown',
      )
      const [first] = await consumes(h)
      await setMode(h, 'reset')
      const dir = limitResetDir(rt.paths.stateDir)
      const refused = async (how: RegExp) => {
        const rt2 = await runtime(h)
        const other = await rt2.resolve('codex:other')
        // A retry by its id, and a bare retry, which looks at the plan first.
        const err = await failure(rt2.limitResetUse(other, plan.operationId!))
        assert.equal(err.code, 'login-changed')
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, how)
        assert.match(err.message, /will not retry that operation from this account/)
        assert.match(err.message, /Nothing was sent/)
        assert.match(
          err.message,
          new RegExp(`sideby quota reset codex:other --yes --operation ${plan.operationId}`),
        )
        for (const no of [WS_B, WS_C, USER, USER_2, EMAIL]) assert.equal(err.message.includes(no), false)
        const seen = await rt2.limitResetPlan(other)
        assert.equal(seen.canUse, false)
        assert.equal(seen.operationId, undefined)
        assert.equal(seen.unresolved, true)
        assert.ok(seen.blocked)
        // Nothing reached the Host, the operation is still unresolved, and no new one was made beside it.
        assert.equal((await consumes(h)).length, 1)
        assert.deepEqual(
          (await readdir(dir)).filter((n) => n.endsWith('.json')),
          [`${plan.operationId}.json`],
        )
        assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'pending')
      }
      await signIn(h, '.codex-other', WS_C)
      await refused(/now signed in as a different login/)
      await signIn(h, '.codex-other', WS_B, USER_2)
      await refused(/now signed in as a different login/)
      // Signed out: the plan says to sign in; a retry cannot tell the login and sends nothing either.
      await rm(h.path('.codex-other/auth.json'))
      const out = await runtime(h)
      const err = await failure(out.limitResetUse(await out.resolve('codex:other'), plan.operationId!))
      assert.equal(err.code, 'login-changed')
      assert.match(err.message, /cannot read which login codex:other is signed in as now/)
      assert.equal((await consumes(h)).length, 1)
      // A record from before the digest was kept cannot be shown to be this login's: the same refusal.
      await signIn(h, '.codex-other', WS_B)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      const kept = await readFile(file, 'utf8')
      const { login: _login, ...old } = JSON.parse(kept)
      await writeFile(file, JSON.stringify(old))
      const legacy = await runtime(h)
      assert.equal(
        (await failure(legacy.limitResetUse(await legacy.resolve('codex:other'), plan.operationId!))).code,
        'login-changed',
      )
      assert.equal((await consumes(h)).length, 1)
      await writeFile(file, kept)
      // Back as the original login: the same operation goes on, with the same key, and spends nothing more.
      const back = await runtime(h)
      const r = await back.limitResetUse(await back.resolve('codex:other'), plan.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[1]!.key, first!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('sends nothing when every account of a Same Login moved to another login together', async () => {
    const moveBoth = async (h: FakeHome) => {
      await signIn(h, '.codex', WS_C)
      await signIn(h, '.codex-work', WS_C)
    }
    // A plan that was shown, then confirmed after the move.
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await moveBoth(h)
      const rt2 = await runtime(h)
      const work = await rt2.resolve('codex:work')
      assert.deepEqual(await rt2.sameLogin(work), ['codex:main'], 'the same accounts, still one login')
      assert.equal((await failure(rt2.limitResetUse(work, plan.operationId!))).code, 'plan-outdated')
      assert.deepEqual(await consumes(h), [])
      // A plan made now is for the new login, and can be used.
      const next = await rt2.limitResetPlan(work)
      assert.notEqual(next.operationId, plan.operationId)
      assert.equal((await rt2.limitResetUse(work, next.operationId!)).outcome, 'reset')
      assert.equal((await consumes(h)).length, 1)
    })
    // An attempt that got no answer, then retried after the move.
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      await setMode(h, 'reset')
      await moveBoth(h)
      for (const ref of ['codex:main', 'codex:work']) {
        const rt2 = await runtime(h)
        const err = await failure(rt2.limitResetUse(await rt2.resolve(ref), plan.operationId!))
        assert.equal(err.code, 'login-changed', ref)
        assert.equal(err.operationId, plan.operationId)
      }
      assert.equal((await consumes(h)).length, 1, 'no second request')
      assert.equal((await hostState(h)).spends, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'pending', 'still unresolved, not stopped')
      assert.equal(rec!.attempts.length, 1)
    })
  })

  it('makes no new operation and sends nothing while an operation file is there but cannot be read', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(main, plan.operationId!))
      await setMode(h, 'reset')
      const [first] = await consumes(h)
      const state = rt.paths.stateDir
      const dir = limitResetDir(state)
      const file = limitResetFile(state, plan.operationId!)
      const good = await readFile(file, 'utf8')
      const blocked = async (path: string) => {
        // A preview, a retry by id, and a bare `--yes` (which is a preview, then its operation).
        const rt2 = await runtime(h)
        const work = await rt2.resolve('codex:work')
        const seen = await rt2.limitResetPlan(work)
        assert.equal(seen.canUse, false)
        assert.equal(seen.operationId, undefined)
        assert.ok(seen.blocked?.includes(path), 'the plan names what cannot be read')
        assert.match(seen.blocked ?? '', /will not use a limit reset/)
        assert.equal(seen.quota.status, 'ok', 'the plan still shows the numbers')
        for (const id of [plan.operationId!, 'lr-zzzzzzzz-00000000']) {
          const err = await failure(rt2.limitResetUse(work, id))
          assert.equal(err.code, 'records-unreadable')
          assert.ok(err.message.includes(path))
          assert.match(err.message, /Nothing was sent/)
          assert.equal(err.message.includes(first!.key!), false, 'never the contents')
        }
        const cli1 = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
        assert.equal(cli1.status, 1)
        const e = checked(cli1.stdout, 'error')
        assert.equal(e.code, 'cannot-use')
        assert.ok(e.error.includes(path))
        assert.equal((await consumes(h)).length, 1, 'nothing reached the Host')
      }
      try {
        // Damaged.
        await writeFile(file, good.slice(0, 30))
        await blocked(file)
        await writeFile(file, good)
        if (!root) {
          // No permission to read the file.
          await chmod(file, 0o000)
          await blocked(file)
          await chmod(file, 0o600)
          // The folder cannot be listed.
          await chmod(dir, 0o000)
          await blocked(dir)
          await chmod(dir, 0o700)
        }
      } finally {
        await chmod(dir, 0o700)
        await chmod(file, 0o600)
      }
      // No new operation was made beside the unresolved one, and that one was never removed or changed.
      assert.deepEqual(
        (await readdir(dir)).filter((n) => n.endsWith('.json')),
        [`${plan.operationId}.json`],
      )
      assert.equal(await readFile(file, 'utf8'), good)
      // Readable again: the unresolved operation goes on with its own key.
      const rt3 = await runtime(h)
      const r = await rt3.limitResetUse(await rt3.resolve('codex:work'), 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[1]!.key, first!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('reads the quota anew after a spend when a read that began before it is kept after it', async () => {
    const reads = async (h: FakeHome) =>
      (await sent(h)).filter((r) => r.method === 'account/rateLimits/read').length
    const until = async (ok: () => Promise<boolean>) => {
      for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20))
      assert.ok(await ok(), 'waited for the slow read to reach the Host')
    }
    for (const where of ['this process', 'another process'] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        const before = await reads(h)
        // A read takes the numbers of before the spend (72%) and answers late.
        await setMode(h, 'slowread')
        const slow =
          where === 'this process'
            ? (await runtime(h)).quota(main, { fetch: 'force' })
            : cli(h, ['quota', 'codex:main', '--refresh', '--json'])
        await until(async () => (await reads(h)) > before)
        await setMode(h, 'reset')
        const r = await rt.limitResetUse(main, plan.operationId!)
        await slow
        assert.equal(r.outcome, 'reset', where)
        // What is shown is a read that began after the spend: the Host's new numbers, not the late old ones.
        assert.equal(r.quotaPending, undefined)
        assert.deepEqual(r.quota?.status === 'ok' && r.quota.windows.map((w) => w.usedPercent), [0, 0], where)
        assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 0)
        const log = await sent(h)
        const spendAt = log.findIndex((x) => x.method === CONSUME)
        assert.ok(
          log.slice(spendAt + 1).some((x) => x.method === 'account/rateLimits/read'),
          `${where}: a read was sent after the spend`,
        )
        const kept = await rt.quota(main, { fetch: 'never' })
        assert.equal(kept.status === 'ok' && kept.windows[0]!.usedPercent, 0)
        const [rec] = await listLimitResetRecords(rt.paths.stateDir)
        assert.ok(rec!.quotaReadAt, 'stamped by the read that came after the spend')
      })
    }
  })

  it('says "used; quota pending update" when the read after a spend fails, and changes no number itself', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.quotaPending, true)
      assert.equal(r.quota, undefined)
      assert.match(r.message, /could not be read yet/)
      // What is on show is still the last real read: 72% and one reset, not zeros of sideby's own.
      const shown = await rt.quota(main, { fetch: 'never' })
      assert.equal(shown.status === 'ok' && shown.windows[0]!.usedPercent, 72)
      assert.equal(shown.status === 'ok' && shown.limitResets?.available, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'reset')
      assert.equal(rec!.quotaReadAt, undefined)
    })
  })

  it('never shows the numbers from before a spend as current when the same operation is asked again', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      const first = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(first.outcome, 'reset')
      assert.equal(first.quotaPending, true)
      // Asked again while the Host still cannot be read: the same answer, and still no numbers of sideby's choosing.
      const still = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(still.outcome, 'reset')
      assert.equal(still.replayed, true)
      assert.equal(still.quotaPending, true, 'the kept 72% is from before the spend: not shown as current')
      assert.equal(still.quota, undefined)
      assert.match(still.message, /A limit reset was used for codex:main/)
      assert.match(still.message, /could not be read yet/)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt, undefined)
      // The Host can be read again: asking again reads the Quota (a read, never a second spend) and shows it.
      await setMode(h, 'reset')
      const now = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(now.replayed, true)
      assert.equal(now.quotaPending, undefined)
      assert.deepEqual(now.quota?.status === 'ok' && now.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal(now.quota?.status === 'ok' && now.quota.limitResets?.available, 0)
      assert.ok(
        (await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt,
        'the read after the spend is noted once it is kept',
      )
      // From then on the kept answer is known to be from after the spend: nobody is asked for it again.
      const asked = (await sent(h)).length
      const later = await (await runtime(h)).limitResetUse(main, plan.operationId!)
      assert.deepEqual(later.quota?.status === 'ok' && later.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal((await sent(h)).length, asked)
      assert.equal((await consumes(h)).length, 1, 'one spend request in all')
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('does not take a noted read as proof for the Account asked now: its own kept numbers must be from after the spend', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      assert.equal((await rt.limitResetUse(main, plan.operationId!)).quotaPending, true)
      // The record says a read after the spend was kept (for an Account that has left the login since, say), while
      // what is kept for this Account is still from before.
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      await writeLimitResetRecord(rt.paths.stateDir, { ...rec!, quotaReadAt: new Date().toISOString() })
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.replayed, true)
      assert.equal(again.quotaPending, true, 'the kept 72% is from before the spend: not shown as current')
      assert.equal(again.quota, undefined)
      assert.equal((await consumes(h)).length, 1, 'never a second spend')
    })
  })

  it('says what the Host answered when that answer cannot be recorded, and a retry repeats the same request', async () => {
    for (const [mode, words, spends] of [
      ['reset', /A limit reset was used for codex:main/, 1],
      ['nothing', /Nothing was spent: no limit of codex:main can be reset/, 0],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        await setMode(h, mode)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
        const writable = await failSavesFrom(h, file, 'the spend request')
        const retry = `sideby quota reset codex:main --yes --operation ${plan.operationId}`
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'outcome-not-saved', mode)
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, words, 'what the Host answered, in plain words')
        assert.ok(err.message.includes(file), 'names the file that could not be written')
        assert.ok(err.message.includes(retry), 'and the retry that repeats the same request')
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await hostState(h)).spends, spends)
        // On disk the operation is still unresolved, with its key, so nothing new is made beside it.
        const [open] = await listLimitResetRecords(rt.paths.stateDir)
        assert.equal(open!.state, 'pending')
        if (mode === 'reset') {
          // The spend went through, so the Quota was read all the same: the numbers on show are the Host's new ones.
          const shown = await rt.quota(main, { fetch: 'never' })
          assert.equal(shown.status === 'ok' && shown.windows[0]!.usedPercent, 0)
          // Another process retries while the file still cannot be written: nothing is sent before the request is
          // on disk, and the failure names the same operation and how to go on.
          const cmd = await cli(h, [
            'quota',
            'reset',
            'codex:main',
            '--yes',
            '--operation',
            plan.operationId!,
            '--json',
          ])
          assert.equal(cmd.status, 1)
          const e = checked(cmd.stdout, 'error')
          assert.equal(e.code, 'outcome-unknown')
          assert.equal(e.operationId, plan.operationId)
          assert.match(e.error, /Nothing was sent now/)
          assert.ok(e.error.includes(file) && e.error.includes(retry))
          assert.equal((await consumes(h)).length, 1)
        }
        // The file can be written again: the retry sends the request with the key it had, and spends nothing more.
        await writable()
        const again = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(again.outcome, mode === 'reset' ? 'already-done' : 'nothing-to-reset')
        assert.equal(again.resumed, true)
        assert.equal(again.operationId, plan.operationId)
        const calls = await consumes(h)
        assert.equal(calls.length, 2)
        assert.deepEqual([...new Set(calls.map((c) => c.key))], [open!.idempotencyKey], 'one key throughout')
        assert.equal((await hostState(h)).spends, spends)
        const [done] = await listLimitResetRecords(rt.paths.stateDir)
        assert.equal(done!.state, again.outcome)
      })
    }
  })

  it('sends nothing, and says so, when a confirmed plan cannot be put on disk before the request', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The plan can be read but not written: sideby's writer never writes through a link.
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      await rename(file, join(h.bin, 'record.moved'))
      await symlink(join(h.bin, 'record.moved'), file)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'not-sent')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /Nothing was sent, so nothing was spent/)
      assert.ok(err.message.includes(file), 'names the file that could not be written')
      assert.deepEqual(await consumes(h), [])
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'planned')
    })
  })

  it('reports a used reset as used when only the note of the quota read after it cannot be saved', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      const writable = await failSavesFrom(h, file, 'the read after the spend')
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.operationId, plan.operationId)
      assert.equal(r.quotaPending, undefined)
      assert.deepEqual(r.quota?.status === 'ok' && r.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.match(r.message, /A limit reset was used for codex:main/)
      assert.match(r.message, /could not note/)
      assert.ok(r.message.includes(file), 'names the file that could not be written')
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'reset')
      assert.equal(rec!.quotaReadAt, undefined)
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
      // Once the file can be written, asking for the same operation notes the read already kept: nobody is asked.
      await writable()
      const asked = (await sent(h)).length
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.replayed, true)
      assert.deepEqual(again.quota?.status === 'ok' && again.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal((await sent(h)).length, asked)
      assert.ok((await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt)
    })
  })

  it('is off in CI and inside a session under Unattended Mode, before anything is read or sent', async () => {
    for (const [env, code] of [
      [{ CI: 'true' }, 'ci'],
      [{ SIDEBY_ACCOUNT: 'codex:main', SIDEBY_UNATTENDED: '1' }, 'unattended'],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        // A plan made by the user beforehand does not open the door.
        const user = await runtime(h)
        const made = await user.limitResetPlan(await user.resolve('codex:main'))
        const rt = await runtime(h, env)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        assert.equal(plan.canUse, false)
        assert.equal(plan.operationId, undefined)
        assert.ok(plan.blocked)
        const err = await failure(rt.limitResetUse(main, made.operationId!))
        assert.equal(err.code, code)
        assert.match(err.message, /Nothing was sent/)
        assert.deepEqual(await consumes(h), [])
        assert.equal((await hostState(h)).spends, 0)
      })
    }
  })

  it('is never sent by a quota read, a refresh, the Handoff ranking or an Auto Handoff decision', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { pct: [99, 99] })
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      await rt.refreshQuota()
      await rt.quota(main, { fetch: 'wait' })
      await rt.handoff('codex')
      await rt.handoffDecision(main, [])
      assert.ok((await sent(h)).some((r) => r.method === 'account/rateLimits/read'))
      assert.deepEqual(await consumes(h), [])
      assert.deepEqual(await listLimitResetRecords(rt.paths.stateDir), [])
    })
  })

  it('lets Auto Handoff take an account back after a confirmed spend, once its Quota shows room', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { pct: [99, 40] })
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const rt = await runtime(h)
      const [main, other] = [await rt.resolve('codex:main'), await rt.resolve('codex:other')]
      await rt.refreshQuota()
      // The chain left codex:main because its 5-hour window was full; that window resets in two hours.
      const hop = {
        ref: 'codex:main',
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        window: { resetsAt: new Date(Date.now() + 7200_000).toISOString() },
      }
      const before = await rt.handoffDecision(other, [hop], { manual: true })
      assert.notEqual(before.kind === 'pick' && before.ref, 'codex:main')
      const plan = await rt.limitResetPlan(main)
      await rt.limitResetUse(main, plan.operationId!)
      const after = await rt.handoffDecision(other, [hop], { manual: true })
      assert.deepEqual([after.kind, after.kind === 'pick' && after.ref], ['pick', 'codex:main'])
    })
  })
})

describe('Panel: using a Limit Reset', () => {
  const request = (
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let text = ''
          res.on('data', (d: Buffer) => (text += d))
          res.on('end', () => {
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(text) as Record<string, unknown>
            } catch {}
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  async function serve(h: FakeHome, readOnly = false) {
    let handler: ReturnType<typeof createPanelHandler> | undefined
    const server = createServer((req, res) => void handler!(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    handler = createPanelHandler({
      runtime: () => runtime(h),
      allowedHosts: [`127.0.0.1:${port}`],
      ...(readOnly ? { readOnly } : {}),
    })
    const good = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'x-sideby-token': handler.token,
    }
    const close = () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
    return { port, good, close }
  }

  it('refuses a request with a bad Host, Origin or token, and a read-only Panel, before anything is read', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const { port, good, close } = await serve(h)
      const ro = await serve(h, true)
      try {
        const body = { account: 'codex:main', confirm: true, operationId: 'lr-zzzzzzzz-00000000' }
        for (const path of ['/api/quota/reset', '/api/quota/reset/open']) {
          const bad: Record<string, string>[] = [
            { ...good, host: 'evil.example:80' },
            { ...good, origin: 'http://evil.example' },
            { host: good.host, 'x-sideby-token': good['x-sideby-token'] },
            { ...good, 'x-sideby-token': 'nope' },
            { host: good.host, origin: good.origin },
          ]
          for (const headers of bad)
            assert.equal((await request(port, path, body, headers)).status, 403, path)
          assert.equal((await request(ro.port, path, body, ro.good)).status, 403, `${path} read-only`)
        }
        assert.deepEqual(await sent(h), [], 'the Host was never started')
        assert.deepEqual(await listLimitResetRecords(h.path('.local/state/sideby')), [])
      } finally {
        await close()
        await ro.close()
      }
    })
  })

  it('gives the plan first, uses one only with confirm and its operation, and reports a lost answer to retry', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const { port, good, close } = await serve(h)
      try {
        const post = (body: unknown) => request(port, '/api/quota/reset', body, good)
        assert.equal((await post({})).status, 400)
        const planned = await post({ account: 'codex:main' })
        assert.equal(planned.status, 200)
        const plan = planned.body.plan as { operationId: string; canUse: boolean; sameLogin: string[] }
        assert.equal(plan.canUse, true)
        assert.deepEqual(plan.sameLogin, ['codex:work'])
        assert.deepEqual(await consumes(h), [])
        // `confirm` without the operation it confirms is a malformed request, not a spend.
        assert.equal((await post({ account: 'codex:main', confirm: true })).status, 400)
        assert.deepEqual(await consumes(h), [])
        await setMode(h, 'lost')
        const lost = await post({ account: 'codex:main', confirm: true, operationId: plan.operationId })
        assert.equal(lost.status, 400)
        assert.equal(lost.body.code, 'outcome-unknown')
        assert.equal(lost.body.operationId, plan.operationId)
        assert.equal(String(lost.body.error).includes(SECRET), false)
        // "Check again": the same operation, the same key, no second spend.
        await setMode(h, 'reset')
        const again = await post({ account: 'codex:main', confirm: true, operationId: plan.operationId })
        assert.equal(again.status, 200)
        const result = again.body.result as { outcome: string; resumed?: boolean; quota?: { status: string } }
        assert.equal(result.outcome, 'already-done')
        assert.equal(result.resumed, true)
        assert.equal(result.quota?.status, 'ok')
        const calls = await consumes(h)
        assert.equal(calls.length, 2)
        assert.equal(calls[0]!.key, calls[1]!.key)
        assert.equal((await hostState(h)).spends, 1)
      } finally {
        await close()
      }
    })
  })
})
