// Using a Codex Limit Reset (spec §3.40, ADR-0072), against a scripted fake `codex app-server` only: the plan, the
// four outcomes, every way an answer can go missing, and what is kept on disk.
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, withFakeHome } from '../../../testing/index.ts'
import {
  type LimitResetError,
  limitResetDir,
  limitResetFile,
  listLimitResetRecords,
  pruneLimitResetRecords,
  RECORD_KEEP_MS,
  writeLimitResetRecord,
} from '../../core/limit-reset.ts'
import {
  consumes,
  EMAIL,
  failure,
  hostDirs,
  hostState,
  runtime,
  SECRET,
  sent,
  setMode,
  setState,
  setup,
  signIn,
  snapshotText,
  USER,
  USER_2,
  WS_A,
  WS_B,
  WS_C,
} from './limit-reset-test-helpers.ts'
import { codexLoginKey } from './login-key.ts'

describe('Codex Limit Reset', () => {
  it('shows a plan from a fresh read and sends nothing until it is confirmed', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const before = await hostDirs(h)
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:work'))
      assert.equal(plan.account, 'codex:work')
      assert.deepEqual(plan.sameLogin, ['codex:main'])
      assert.equal(plan.canUse, true)
      assert.ok(plan.operationId)
      assert.equal(plan.limitResets?.available, 2)
      assert.equal(plan.expectedAfter, 1)
      assert.ok(plan.limitResets?.nextExpiresAt, 'the next expiry, when the Host tells it')
      assert.equal(plan.quota.status, 'ok')
      if (plan.quota.status === 'ok')
        assert.deepEqual(
          plan.quota.windows.map((w) => [w.label, w.usedPercent, Boolean(w.resetsAt)]),
          [
            ['5h', 72, true],
            ['7d', 61, true],
          ],
        )
      assert.match(plan.message, /cannot be undone/)
      assert.match(plan.message, /does not say beforehand which windows/)
      assert.match(plan.message, /codex:main/, 'names the other accounts of the login')
      // The read asked the Host now, and nothing else was sent.
      assert.deepEqual(await consumes(h), [])
      assert.ok((await sent(h)).some((r) => r.method === 'account/rateLimits/read'))
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec?.state, 'planned')
      assert.deepEqual(rec?.accounts, ['codex:main', 'codex:work'])
      assert.deepEqual(diffSnapshots(before, await hostDirs(h)), [])
      assert.equal((await hostState(h)).spends, 0)
    })
  })

  it('uses one after the confirmation, then shows what the Host reports for every account of the login', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const before = await hostDirs(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.operationId, plan.operationId)
      assert.deepEqual(r.sameLogin, ['codex:work'])
      assert.equal(r.quotaPending, undefined)
      assert.equal(r.quota?.status, 'ok')
      if (r.quota?.status === 'ok') {
        assert.deepEqual(
          r.quota.windows.map((w) => w.usedPercent),
          [0, 0],
        )
        assert.equal(r.quota.limitResets?.available, 0)
      }
      // The other account of the login shows the same read, without another ask.
      const asked = (await sent(h)).length
      const peer = await rt.quota(await rt.resolve('codex:work'), { fetch: 'never' })
      assert.equal(peer.status === 'ok' && peer.windows[0]!.usedPercent, 0)
      assert.equal(peer.status === 'ok' && peer.limitResets?.available, 0)
      assert.equal((await sent(h)).length, asked)
      // One request, with the key on disk and no credit id: the vendor picks the credit.
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      const calls = await consumes(h)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.key, rec!.idempotencyKey)
      assert.deepEqual(calls[0]!.params, ['idempotencyKey'])
      assert.ok((await sent(h)).every((s) => s.method !== 'initialize' || s.experimentalApi === false))
      assert.equal(rec!.state, 'reset')
      assert.ok(rec!.quotaReadAt)
      assert.equal(rec!.attempts.length, 1)
      // Asking again with the same operation says the same and sends nothing.
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.outcome, 'reset')
      assert.equal(again.replayed, true)
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
      assert.deepEqual(diffSnapshots(before, await hostDirs(h)), [], 'nothing written under a Host directory')
    })
  })

  it('keeps the operation as a 600 file in a 700 folder, without a login key, an identity or a credit id', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await rt.limitResetUse(main, plan.operationId!)
      const dir = limitResetDir(rt.paths.stateDir)
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      const files = (await readdir(dir)).filter((n) => n.endsWith('.json'))
      assert.deepEqual(files, [`${plan.operationId}.json`])
      const file = join(dir, files[0]!)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const text = await readFile(file, 'utf8')
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
        'accounts',
        'attempts',
        'createdAt',
        'finishedAt',
        'idempotencyKey',
        'login',
        'operationId',
        'quotaReadAt',
        'state',
        'version',
      ])
      // Of the login only a salted digest: not the Login Key, the ids it is made of, nor the Identity.
      const loginKey = await codexLoginKey(main)
      assert.ok(loginKey)
      assert.deepEqual(Object.keys(JSON.parse(text).login).sort(), ['digest', 'salt'])
      for (const no of [WS_A, USER, EMAIL, SECRET, 'credit-', 'id_token', 'e30.', loginKey])
        assert.equal(text.includes(no), false, `the record holds no ${no}`)
      // Nor does anything else sideby keeps about it.
      for (const [name, body] of await snapshotText(rt.paths.stateDir))
        assert.equal(body.includes(SECRET), false, `${name} holds nothing of the Host's raw answer`)
    })
  })

  it('tells the three other answers apart, and says in each that nothing more was spent', async () => {
    for (const [mode, outcome, words] of [
      ['nothing', 'nothing-to-reset', /Nothing was spent: no limit of codex:main can be reset/],
      ['none', 'none-left', /Nothing was spent: codex:main holds no limit reset/],
      ['already', 'already-done', /already used for codex:main; nothing more was spent/],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const r = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(r.outcome, outcome)
        assert.match(r.message, words)
        assert.equal((await hostState(h)).spends, 0)
        // The bars and the count are what the Host says, never changed by sideby.
        assert.equal(r.quota?.status === 'ok' && r.quota.windows[0]!.usedPercent, 72)
        assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 1)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, outcome)
      })
    }
  })

  it('refuses without a plan: an id nobody made, a plan of another login, a blocked account', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 0 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const none = await rt.limitResetPlan(main)
      assert.equal(none.canUse, false)
      assert.equal(none.operationId, undefined)
      assert.match(none.blocked ?? '', /holds no limit reset/)
      assert.equal((await failure(rt.limitResetUse(main, 'lr-zzzzzzzz-00000000'))).code, 'unknown-operation')
      await setState(h, { credits: 1 })
      const other = await rt.limitResetPlan(await rt.resolve('codex:other'))
      assert.deepEqual(other.sameLogin, [])
      const err = await failure(rt.limitResetUse(main, other.operationId!))
      assert.equal(err.code, 'unknown-operation')
      assert.match(err.message, /Nothing was sent/)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('knows nothing was spent when the request never left, and ends that operation', async () => {
    for (const mode of ['noinit', 'old']) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'not-sent')
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, /Nothing was sent, so nothing was spent/)
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await hostState(h)).spends, 0)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'not-sent')
        // It is not left unresolved: the next step is a new plan.
        await setMode(h, 'reset')
        assert.equal((await failure(rt.limitResetUse(main, plan.operationId!))).code, 'operation-ended')
        const next = await rt.limitResetPlan(main)
        assert.notEqual(next.operationId, plan.operationId)
        assert.equal(next.unresolved, undefined)
        assert.equal((await rt.limitResetUse(main, next.operationId!)).outcome, 'reset')
      })
    }
  })

  it('repeats the same request after a lost answer, from another process, and spends once', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'lost')
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /cannot tell whether a limit reset was used/)
      assert.match(err.message, new RegExp(`--yes --operation ${plan.operationId}`))
      assert.equal((await hostState(h)).spends, 1, 'the spend went through; only its answer was lost')
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'pending')

      // Another sideby process, later, through the other account of the login.
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const work = await rt2.resolve('codex:work')
      const seen = await rt2.limitResetPlan(work)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId, 'the unresolved operation, not a new one')
      assert.equal(seen.canUse, true)
      assert.match(seen.message, /earlier attempt/)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir)).length, 1)
      // Whatever operation the caller names, the unresolved one of the login goes first, with its own key.
      const r = await rt2.limitResetUse(work, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]!.key, calls[1]!.key)
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
      // The numbers are the Host's: one left, not zero.
      assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 1)
      const [rec] = await listLimitResetRecords(rt2.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.equal(rec!.attempts.length, 2)
    })
  })

  it('leaves a request that got no answer in time unresolved, never ages it out, and resolves it on a retry', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h, {}, 300)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'hang')
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /no answer in time|did not answer in time/)
      await pruneLimitResetRecords(rt.paths.stateDir, new Date(Date.now() + 400 * 24 * 3600_000))
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec?.state, 'pending')
      // The Host never ran it: the same key now gets the first real answer.
      await setMode(h, 'reset')
      const r = await (await runtime(h)).limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.resumed, true)
      const calls = await consumes(h)
      assert.deepEqual(
        calls.map((c) => c.key),
        [rec!.idempotencyKey, rec!.idempotencyKey],
      )
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('treats a Host that crashed or refused after the request left as unknown, not as unspent', async () => {
    for (const mode of ['crash', 'error', 'odd']) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'outcome-unknown', mode)
        assert.equal(err.operationId, plan.operationId)
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'pending')
        await setMode(h, 'reset')
        const r = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(r.outcome, 'reset')
        assert.equal((await hostState(h)).spends, 1)
      })
    }
  })

  it('lets two confirmations of one login through one at a time: one spend, whatever they name', async () => {
    // The same plan confirmed twice at once (a double click, two windows).
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const [a, b] = [await runtime(h), await runtime(h)]
      const plan = await a.limitResetPlan(await a.resolve('codex:main'))
      await setMode(h, 'slow')
      const [x, y] = await Promise.all([
        a.limitResetUse(await a.resolve('codex:main'), plan.operationId!),
        b.limitResetUse(await b.resolve('codex:work'), plan.operationId!),
      ])
      assert.deepEqual([x.outcome, y.outcome], ['reset', 'reset'])
      assert.equal(
        [x, y].filter((r) => r.replayed).length,
        1,
        'the second one is told the first one’s answer',
      )
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
    })
    // Two plans of the same login, shown before either was confirmed: the later confirmation is out of date.
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const [a, b] = [await runtime(h), await runtime(h)]
      const p1 = await a.limitResetPlan(await a.resolve('codex:main'))
      const p2 = await b.limitResetPlan(await b.resolve('codex:work'))
      assert.notEqual(p1.operationId, p2.operationId)
      await setMode(h, 'slow')
      const done = await Promise.allSettled([
        a.limitResetUse(await a.resolve('codex:main'), p1.operationId!),
        b.limitResetUse(await b.resolve('codex:work'), p2.operationId!),
      ])
      const ok = done.filter((d) => d.status === 'fulfilled')
      const no = done.filter((d) => d.status === 'rejected')
      assert.equal(ok.length, 1)
      assert.equal(no.length, 1)
      const err = (no[0] as PromiseRejectedResult).reason as LimitResetError
      assert.equal(err.code, 'plan-outdated')
      assert.match(err.message, /nothing was sent/)
      assert.equal((await consumes(h)).length, 1)
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
    })
  })

  it('goes on with the same request, never a new one, after an account of the login signed in elsewhere', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      assert.equal((await hostState(h)).spends, 1, 'used, and the answer was lost')
      const [first] = await consumes(h)
      // codex:work signs in to another workspace: main is alone in its login now, and work is one login with other.
      await signIn(h, '.codex-work', WS_B)
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const [main, work] = [await rt2.resolve('codex:main'), await rt2.resolve('codex:work')]
      assert.deepEqual(await rt2.sameLogin(main), [])
      assert.deepEqual(await rt2.sameLogin(work), ['codex:other'])
      // From the account that left, and from its new login: not sent, no new operation, still unresolved; the
      // message names the account that may still be the original login.
      for (const ref of ['codex:work', 'codex:other']) {
        const a = await rt2.resolve(ref)
        const seen = await rt2.limitResetPlan(a)
        assert.equal(seen.canUse, false, ref)
        assert.equal(seen.operationId, undefined)
        assert.equal(seen.unresolved, true)
        const err = await failure(rt2.limitResetUse(a, plan.operationId!))
        assert.equal(err.code, 'login-changed', ref)
        assert.equal(err.operationId, plan.operationId)
        assert.match(
          err.message,
          new RegExp(
            `If codex:main is still signed in as the original login, run .sideby quota reset codex:main --yes --operation ${plan.operationId}`,
          ),
        )
      }
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir)).length, 1)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'pending')
      // From the account that is still the login: the plan is the unresolved operation, and confirming repeats its
      // request with its own key, which uses nothing more.
      const seen = await rt2.limitResetPlan(main)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal(seen.canUse, true)
      const r = await rt2.limitResetUse(main, seen.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.deepEqual(
        calls.map((c) => c.key),
        [first!.key, first!.key],
        'the Host never saw a second key',
      )
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
      // The outcome is kept for the accounts of the login as they are now, and never as "stopped".
      const [rec] = await listLimitResetRecords(rt2.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.deepEqual(rec!.accounts, ['codex:main'])
      // Only now, with the first one answered, is a new plan made: for main, and for the login work moved to.
      for (const a of [main, work]) {
        const next = await rt2.limitResetPlan(a)
        assert.equal(next.unresolved, undefined)
        assert.equal(next.canUse, true)
        assert.notEqual(next.operationId, plan.operationId)
      }
      assert.equal((await consumes(h)).length, 2)
    })
  })

  it('finds the unresolved operation of a login from an account that signed in as it afterwards', async () => {
    const lostOnce = async (h: FakeHome) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      await setMode(h, 'reset')
      const [first] = await consumes(h)
      // A new account signs in as the same login.
      await signIn(h, '.codex-new', WS_A)
      await h.write('.codex-new/config.toml', '')
      return { plan, key: first!.key }
    }
    const oneKeyOneSpend = async (h: FakeHome, key: string | undefined, requests: number) => {
      const calls = await consumes(h)
      assert.equal(calls.length, requests)
      assert.deepEqual([...new Set(calls.map((c) => c.key))], [key], 'the Host never saw a second key')
      assert.equal((await hostState(h)).spends, 1)
    }
    // It joins the accounts the operation names.
    await withFakeHome(async (h) => {
      const { plan, key } = await lostOnce(h)
      const rt = await runtime(h)
      const fresh = await rt.resolve('codex:new')
      assert.deepEqual((await rt.sameLogin(fresh)).sort(), ['codex:main', 'codex:work'])
      const seen = await rt.limitResetPlan(fresh)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir)).length, 1, 'no new operation beside it')
      // The answer is lost once more: still the same operation, now also under the new account's name.
      await setMode(h, 'hang')
      const slow = await runtime(h, {}, 300)
      const err = await failure(slow.limitResetUse(await slow.resolve('codex:new'), seen.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      const [open] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(open!.state, 'pending')
      assert.deepEqual(open!.accounts, ['codex:main', 'codex:new', 'codex:work'])
      await setMode(h, 'reset')
      const r = await rt.limitResetUse(fresh, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      await oneKeyOneSpend(h, key, 3)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.deepEqual(rec!.accounts, ['codex:main', 'codex:new', 'codex:work'])
    })
    // Every account the operation names left the login; the only account of that login now is one it never named.
    await withFakeHome(async (h) => {
      const { plan, key } = await lostOnce(h)
      await signIn(h, '.codex', WS_C)
      await signIn(h, '.codex-work', WS_C)
      const rt = await runtime(h)
      const fresh = await rt.resolve('codex:new')
      assert.deepEqual(await rt.sameLogin(fresh), [])
      // The accounts that left cannot send it and get no new plan while it is unresolved; they are told who may ask.
      const main = await rt.resolve('codex:main')
      assert.equal((await rt.limitResetPlan(main)).canUse, false)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'login-changed')
      // The account that is the login now finds it through the login, not through its name: no new key is made.
      const seen = await rt.limitResetPlan(fresh)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal(seen.canUse, true)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir)).length, 1, 'no new operation beside it')
      const r = await rt.limitResetUse(fresh, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      await oneKeyOneSpend(h, key, 2)
      assert.equal((await hostState(h)).credits, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.deepEqual(rec!.accounts, ['codex:new'])
    })
  })

  it('keeps a plan that was confirmed while pruning looked at it, with the key its request was sent with', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      await setMode(h, 'lost')
      // Pruning, with a clock a day ahead, has read the plan as one nobody confirmed. Before it removes anything the
      // plan is confirmed: the request is sent, a reset is used and the answer is lost.
      let confirmed = 0
      await pruneLimitResetRecords(rt.paths.stateDir, new Date(Date.now() + RECORD_KEEP_MS + 60_000), {
        afterRead: async (r) => {
          assert.equal(r.operationId, plan.operationId)
          assert.equal(r.state, 'planned')
          const err = await failure(rt.limitResetUse(main, plan.operationId!))
          assert.equal(err.code, 'outcome-unknown')
          confirmed++
        },
      })
      assert.equal(confirmed, 1)
      assert.equal((await hostState(h)).spends, 1)
      const [first] = await consumes(h)
      // The record is still there, unresolved, with that key.
      const kept = JSON.parse(await readFile(file, 'utf8')) as { state: string; idempotencyKey: string }
      assert.equal(kept.state, 'pending')
      assert.equal(kept.idempotencyKey, first!.key)
      // So the retry repeats that request instead of making a new one.
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const seen = await rt2.limitResetPlan(await rt2.resolve('codex:work'))
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      const r = await rt2.limitResetUse(await rt2.resolve('codex:work'), seen.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.deepEqual(
        (await consumes(h)).map((c) => c.key),
        [first!.key, first!.key],
      )
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
    })
  })

  it('refuses a plan shown more than a day ago at the confirmation, and sends nothing', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const [made] = await listLimitResetRecords(rt.paths.stateDir)
      const old = { ...made!, createdAt: new Date(Date.now() - RECORD_KEEP_MS - 1000).toISOString() }
      await writeLimitResetRecord(rt.paths.stateDir, old)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'plan-outdated')
      assert.match(err.message, /shown more than a day ago/)
      assert.match(err.message, /nothing was sent; run `sideby quota reset codex:main`/)
      assert.deepEqual(await consumes(h), [])
      assert.equal((await hostState(h)).spends, 0)
      // It was never made unresolved, so pruning may remove it, and the next plan is a new one that can be used.
      assert.deepEqual(await listLimitResetRecords(rt.paths.stateDir), [old])
      const next = await rt.limitResetPlan(main)
      assert.notEqual(next.operationId, plan.operationId)
      assert.deepEqual(
        (await listLimitResetRecords(rt.paths.stateDir)).map((r) => r.operationId),
        [next.operationId],
      )
      assert.equal((await rt.limitResetUse(main, next.operationId!)).outcome, 'reset')
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('does not send a confirmed plan once the account is signed in as another login under the same name', async () => {
    // codex:other is alone in its login, so its group of accounts is the same before and after: only the login moved.
    for (const [why, again] of [
      ['another workspace', (h: FakeHome) => signIn(h, '.codex-other', WS_C)],
      ['another user', (h: FakeHome) => signIn(h, '.codex-other', WS_B, USER_2)],
      ['a sign-in that cannot be read', (h: FakeHome) => h.write('.codex-other/auth.json', '{}', 0o600)],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const plan = await rt.limitResetPlan(await rt.resolve('codex:other'))
        assert.equal(plan.canUse, true, why)
        await again(h)
        const rt2 = await runtime(h)
        const other = await rt2.resolve('codex:other')
        assert.deepEqual(await rt2.sameLogin(other), [], 'still the same group of accounts')
        const err = await failure(rt2.limitResetUse(other, plan.operationId!))
        assert.equal(err.code, 'plan-outdated', why)
        assert.match(err.message, /nothing was sent/)
        assert.match(err.message, /sideby quota reset codex:other/)
        assert.deepEqual(await consumes(h), [], why)
        assert.equal((await hostState(h)).spends, 0)
        assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'planned')
      })
    }
  })
})
