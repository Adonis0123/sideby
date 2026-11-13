import assert from 'node:assert/strict'
import { mkdir, rename, rm, symlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import type { Account, QuotaFetch, QuotaResult, QuotaWindow } from '../types.ts'
import { takeFileLock } from './lock.ts'
import {
  fetchedQuota,
  localCovers,
  loginProblemOf,
  passedResets,
  quotaAsking,
  shownQuota,
} from './quota-fetch.ts'
import { type QuotaStoreEntry, quotaStoreFile, readQuotaStore, writeQuotaStore } from './quota-store.ts'

const win = (label: string, usedPercent: number, name?: string): QuotaWindow => ({
  label,
  ...(name ? { name } : {}),
  windowMinutes: label === '5h' ? 300 : 10080,
  usedPercent,
  resetsAt: '2026-11-05T09:00:00.000Z',
})
const kept = (observedAt: string, windows: QuotaWindow[]): QuotaStoreEntry => ({
  version: 1,
  attemptedAt: observedAt,
  quota: { status: 'ok', windows, observedAt, source: 'claude /usage' },
})
const local = (observedAt: string, windows: QuotaWindow[]) =>
  ({ status: 'ok', windows, observedAt, source: 'claude statusline' }) as const

test('a newer local reading keeps the fetched model-group windows it cannot see', () => {
  const q = shownQuota(
    local('2026-10-31T13:20:00Z', [win('5h', 5), win('7d', 23)]),
    kept('2026-10-31T13:00:00Z', [win('5h', 1), win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(q.status, 'ok')
  if (q.status !== 'ok') return
  assert.equal(q.source, 'claude statusline')
  assert.deepEqual(
    q.windows.map((w) => [w.name ?? '', w.label, w.usedPercent]),
    [
      ['', '5h', 5],
      ['', '7d', 23],
      ['Fable', '7d', 0],
    ],
  )
})

test('a local reading that reports a group itself keeps its own numbers for it', () => {
  const q = shownQuota(
    local('2026-10-31T13:20:00Z', [win('7d', 30), win('7d', 4, 'Fable')]),
    kept('2026-10-31T13:00:00Z', [win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(
    q.status === 'ok' &&
      q.windows
        .filter((w) => w.name === 'Fable')
        .map((w) => w.usedPercent)
        .join(),
    '4',
  )
})

test('an older local reading still loses to the fetched answer whole', () => {
  const q = shownQuota(
    local('2026-10-31T12:00:00Z', [win('5h', 5), win('7d', 23)]),
    kept('2026-10-31T13:00:00Z', [win('7d', 22), win('7d', 0, 'Fable')]),
    null,
  )
  assert.equal(q.status === 'ok' && q.source, 'claude /usage')
  assert.equal(q.status === 'ok' && q.windows.length, 2)
})

// Expired Login (ADR-0071): the newest sign that the login expired against the newest sign that it works.
test('an expiry with nothing working since is an Expired Login, with sideby’s own sentence', () => {
  const p = loginProblemOf(
    'claude:work',
    { expiredAt: '2026-11-08T10:00:00.000Z', workingAt: '2026-11-08T09:00:00.000Z' },
    null,
  )
  assert.equal(p?.kind, 'expired')
  assert.equal(p?.since, '2026-11-08T10:00:00.000Z')
  assert.match(p?.message ?? '', /sideby login claude:work/)
  assert.equal(p?.signedInAt, undefined)
})

test('a later turn or a later good quota answer clears it; a generic failure does not', () => {
  const expiredAt = '2026-11-08T10:00:00.000Z'
  assert.equal(
    loginProblemOf('claude:work', { expiredAt, workingAt: '2026-11-08T11:00:00.000Z' }, null),
    undefined,
  )
  assert.equal(
    loginProblemOf('claude:work', { expiredAt }, kept('2026-11-08T11:00:00.000Z', [win('5h', 3)])),
    undefined,
  )
  const failedLater: QuotaStoreEntry = {
    ...kept('2026-11-08T09:00:00.000Z', [win('5h', 3)]),
    attemptedAt: '2026-11-08T11:00:00.000Z',
    error: 'Claude Code exited without answering; sideby asks again later',
  }
  assert.equal(loginProblemOf('claude:work', { expiredAt }, failedLater)?.kind, 'expired')
})

test('a quota answer that asked for a new sign-in counts, until something works after it', () => {
  const asked: QuotaStoreEntry = {
    ...kept('2026-11-08T08:00:00.000Z', [win('5h', 3)]),
    attemptedAt: '2026-11-08T10:00:00.000Z',
    loginExpiredAt: '2026-11-08T10:00:00.000Z',
  }
  assert.equal(
    loginProblemOf('claude:work', { workingAt: '2026-11-08T09:00:00.000Z' }, asked)?.kind,
    'expired',
  )
  assert.equal(loginProblemOf('claude:work', { workingAt: '2026-11-08T10:30:00.000Z' }, asked), undefined)
})

test('a sign-in sideby started after the expiry is shown as waiting for confirmation', () => {
  const events = { expiredAt: '2026-11-08T10:00:00.000Z' }
  assert.equal(
    loginProblemOf('claude:work', events, null, '2026-11-08T10:05:00.000Z')?.signedInAt,
    '2026-11-08T10:05:00.000Z',
  )
  assert.equal(loginProblemOf('claude:work', events, null, '2026-11-08T09:00:00.000Z')?.signedInAt, undefined)
})

test('a fetch that asks for a new sign-in keeps the time; a good one clears it; a generic failure keeps it', async () => {
  await withFakeHome(async (h) => {
    const account: Account = {
      family: 'claude',
      name: 'work',
      ref: 'claude:work',
      dir: h.path('.claude-work'),
      isMain: false,
      kind: 'subscription',
    }
    const ctx = {
      home: h.home,
      now: new Date('2026-11-08T10:00:00Z'),
      stateDir: h.path('.local/state/sideby'),
      env: h.env,
    }
    const answers: QuotaResult[] = [
      { status: 'unavailable', reason: 'fetch-failed', detail: 'asks for a new sign-in', loginExpired: true },
      { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' },
      {
        status: 'ok',
        windows: [win('5h', 3)],
        observedAt: '2026-11-08T10:10:00.000Z',
        source: 'claude /usage',
      },
    ]
    const fq: QuotaFetch = { everyMinutes: 15, summary: 'test', fetch: async () => answers.shift()! }
    const first = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.ok(first?.loginExpiredAt)
    const second = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.equal(second?.loginExpiredAt, first?.loginExpiredAt)
    const third = await fetchedQuota(fq, account, ctx, {}, 'force')
    assert.equal(third?.loginExpiredAt, undefined)
  })
})

// Per-window read time and the Limit Resets through a merge (ADR-0072, ADR-0073).
test('a newer local reading stamps the kept model-group windows with their own time and source', () => {
  const answer = kept('2026-10-31T13:00:00Z', [win('5h', 1), win('7d', 22), win('7d', 9, 'Fable')])
  const at = (observedAt: string) => {
    const q = shownQuota(local(observedAt, [win('5h', 5), win('7d', 23)]), answer, null)
    assert.equal(q.status, 'ok')
    return q.status === 'ok' ? q : null
  }
  const first = at('2026-10-31T13:20:00Z')!
  const group = first.windows.find((w) => w.name === 'Fable')!
  assert.equal(group.observedAt, '2026-10-31T13:00:00Z')
  assert.equal(group.source, 'claude /usage')
  // The windows the local reading covers take its time: they carry none of their own.
  for (const w of first.windows.filter((x) => !x.name)) {
    assert.equal(w.observedAt, undefined)
    assert.equal(w.source, undefined)
  }
  // A later local reading moves the Quota's time, never the time of the window it did not read.
  const later = at('2026-10-31T14:45:00Z')!
  assert.equal(later.observedAt, '2026-10-31T14:45:00Z')
  assert.equal(later.windows.find((w) => w.name === 'Fable')!.observedAt, '2026-10-31T13:00:00Z')
})

test('the Limit Resets of the kept answer stay under a newer local reading, with their own read time', () => {
  const answer = kept('2026-10-31T13:00:00Z', [win('5h', 1)])
  answer.quota!.limitResets = { available: 2, observedAt: '2026-10-31T13:00:00Z' }
  const q = shownQuota(local('2026-10-31T13:20:00Z', [win('5h', 5)]), answer, null)
  assert.deepEqual(q.status === 'ok' && q.limitResets, { available: 2, observedAt: '2026-10-31T13:00:00Z' })
  // The kept answer shown whole carries them too, and a reading without any has no such field.
  const whole = shownQuota(null, answer, null)
  assert.equal(whole.status === 'ok' && whole.limitResets?.available, 2)
  const none = shownQuota(
    local('2026-10-31T13:20:00Z', [win('5h', 5)]),
    kept('2026-10-31T13:00:00Z', []),
    null,
  )
  assert.equal(none.status === 'ok' && 'limitResets' in none, false)
})

// One more ask once a published reset time has passed (ADR-0073).
const acct = (h: { path(p: string): string }, name: string): Account => ({
  family: 'claude',
  name,
  ref: `claude:${name}`,
  dir: h.path(`.claude-${name}`),
  isMain: false,
  kind: 'subscription',
})
const T0 = Date.parse('2026-11-08T10:00:00Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const ctxAt = (h: FakeHome, minutes: number) => ({
  home: h.home,
  now: new Date(T0 + minutes * 60_000),
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})
const resetting = (label: string, minutes: number, name?: string): QuotaWindow => ({
  ...win(label, 40, name),
  resetsAt: iso(minutes),
})

test('asks once more when a window passed its published reset time, once per reset instant', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    // Taken at 10:00; the 5-hour window and a model group reset together at 10:05, the week at 10:09.
    await writeQuotaStore(file, {
      version: 1,
      attemptedAt: iso(0),
      quota: {
        status: 'ok',
        windows: [resetting('5h', 5), resetting('7d', 5, 'Fable'), resetting('7d', 9)],
        observedAt: iso(0),
        source: 'claude /usage',
      },
    })
    let asks = 0
    let markedBeforeAsking: string[] | undefined
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        markedBeforeAsking = (await readQuotaStore(file))?.resetAsked
        throw new Error('no answer')
      },
    }
    // Inside `everyMinutes` and before any reset: the kept answer, no ask.
    await fetchedQuota(fq, a, ctxAt(h, 3), {}, 'wait')
    assert.equal(asks, 0)
    // 10:06: two windows reset at the same instant, so one ask; the attempt is on disk before the Host is asked.
    const failed = await fetchedQuota(fq, a, ctxAt(h, 6), {}, 'wait')
    assert.equal(asks, 1)
    assert.deepEqual(markedBeforeAsking, [iso(5)])
    assert.equal(failed?.quota?.windows.length, 3, 'a failed ask keeps the kept answer')
    assert.match(failed?.error ?? '', /no answer/)
  })
})

test('a failed extra ask is not repeated for the same instant, and a later instant is asked once more', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const stateDir = ctxAt(h, 0).stateDir
    const file = quotaStoreFile(stateDir, 'claude', 'work')
    const seed = (attemptedAt: string, resetAsked?: string[]) =>
      writeQuotaStore(file, {
        version: 1,
        attemptedAt,
        quota: {
          status: 'ok',
          windows: [resetting('5h', 5), resetting('7d', 9)],
          observedAt: iso(0),
          source: 'claude /usage',
        },
        ...(resetAsked ? { resetAsked } : {}),
      })
    let asks = 0
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        return { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' }
      },
    }
    // The 10:05 reset was asked for and failed (the mark stays): reading again at 10:07 asks nobody.
    await seed(iso(6), [iso(5)])
    await fetchedQuota(fq, a, ctxAt(h, 7), {}, 'wait')
    await fetchedQuota(fq, a, ctxAt(h, 8), {}, 'background')
    assert.equal(asks, 0)
    // 10:10: the week's reset (10:09) is another instant, asked once; both marks are kept while the answer stands.
    await seed(iso(6), [iso(5)])
    await fetchedQuota(fq, a, ctxAt(h, 10), {}, 'wait')
    assert.equal(asks, 1)
    assert.deepEqual((await readQuotaStore(file))?.resetAsked, [iso(5), iso(9)])
    // (The attempt is stamped with the real clock; put it on this test's clock to read on.)
    await seed(iso(10), [iso(5), iso(9)])
    await fetchedQuota(fq, a, ctxAt(h, 11), {}, 'wait')
    assert.equal(asks, 1)
    // `never` (a hook's read, a check turned off, CI, an API or signed-out Account) reads what is kept.
    await seed(iso(0))
    await fetchedQuota(fq, a, ctxAt(h, 12), {}, 'never')
    assert.equal(asks, 1)
  })
})

test('a good answer after a reset drops the marks of instants it no longer has', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    await writeQuotaStore(file, {
      version: 1,
      attemptedAt: iso(0),
      quota: { status: 'ok', windows: [resetting('5h', 5)], observedAt: iso(0), source: 'claude /usage' },
    })
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => ({
        status: 'ok',
        windows: [resetting('5h', 305)],
        observedAt: iso(6),
        source: 'claude /usage',
      }),
    }
    const entry = await fetchedQuota(fq, a, ctxAt(h, 6), {}, 'wait')
    assert.equal(entry?.quota?.windows[0]?.resetsAt, iso(305))
    assert.equal(entry?.resetAsked, undefined)
    assert.deepEqual(passedResets(entry, new Date(T0 + 7 * 60_000)), [])
  })
})

test('a window read before its reset counts; one whose reset had passed when it was read does not', () => {
  const entry: QuotaStoreEntry = {
    version: 1,
    attemptedAt: iso(0),
    quota: {
      status: 'ok',
      // The second window was already past its reset when the answer was taken: nothing new was published since.
      windows: [
        resetting('5h', 5),
        resetting('7d', -30),
        { ...resetting('7d', 5, 'Fable'), resetsAt: 'soon' },
      ],
      observedAt: iso(0),
      source: 'claude /usage',
    },
  }
  assert.deepEqual(passedResets(entry, new Date(T0 + 4 * 60_000)), [])
  assert.deepEqual(passedResets(entry, new Date(T0 + 6 * 60_000)), [iso(5)])
  assert.deepEqual(passedResets({ ...entry, resetAsked: [iso(5)] }, new Date(T0 + 6 * 60_000)), [])
  assert.deepEqual(passedResets(null, new Date(T0)), [])
})

// Fewer Hosts at once (spec §3.26): one ask per Account, four on the machine, the tight and pinned first.
test('readers of one Account share one ask, and an ask another process finished is taken instead of asking', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const ctx = ctxAt(h, 0)
    const file = quotaStoreFile(ctx.stateDir, 'claude', 'work')
    let asks = 0
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        await gate
        return { status: 'ok', windows: [win('5h', 7)], observedAt: iso(0), source: 'claude /usage' }
      },
    }
    const both = Promise.all([
      fetchedQuota(fq, a, ctx, {}, 'force'),
      fetchedQuota(fq, a, ctx, {}, 'wait'),
      fetchedQuota(fq, a, ctx, {}, 'force'),
    ])
    release()
    const entries = await both
    assert.equal(asks, 1)
    assert.ok(entries.every((e) => e?.quota?.windows[0]?.usedPercent === 7))

    // Another process holds the Account's lock and keeps its answer while this one waits: no second ask.
    await mkdir(dirname(file), { recursive: true })
    const held = await takeFileLock(`${file}.lock`, { staleMs: 30_000, beatMs: 5_000 })
    assert.ok(held)
    const waiting = fetchedQuota(fq, a, ctx, {}, 'force')
    await new Promise((r) => setTimeout(r, 150))
    await writeQuotaStore(file, {
      version: 1,
      attemptedAt: iso(1),
      quota: { status: 'ok', windows: [win('5h', 55)], observedAt: iso(1), source: 'claude /usage' },
    })
    await held!()
    assert.equal((await waiting)?.quota?.windows[0]?.usedPercent, 55)
    assert.equal(asks, 1)
  })
})

test('at most four Hosts are asked at once, the pinned and the tight Accounts first, Hidden ones last', async () => {
  await withFakeHome(async (h) => {
    const ctx = ctxAt(h, 0)
    const names = ['hidden', 'idle', 'recent', 'tight', 'pinned', 'older']
    // A kept answer over its warning level makes `tight` tight; every answer is old, so each Account is due.
    for (const n of names)
      await writeQuotaStore(quotaStoreFile(ctx.stateDir, 'claude', n), {
        version: 1,
        attemptedAt: iso(-60),
        quota: {
          status: 'ok',
          windows: [resetting('5h', 200), { ...resetting('7d', 900), usedPercent: n === 'tight' ? 90 : 10 }],
          observedAt: iso(-60),
          source: 'claude /usage',
        },
      })
    const started: string[] = []
    let running = 0
    let most = 0
    const gates = new Map<string, () => void>()
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async (account) => {
        started.push(account.name)
        most = Math.max(most, ++running)
        await new Promise<void>((r) => gates.set(account.name, r))
        running--
        return { status: 'ok', windows: [win('5h', 1)], observedAt: iso(0), source: 'claude /usage' }
      },
    }
    const hints: Record<string, { pinned?: boolean; hidden?: boolean; usedAt?: number }> = {
      hidden: { hidden: true, usedAt: T0 },
      idle: {},
      recent: { usedAt: T0 - 1000 },
      tight: {},
      pinned: { pinned: true },
      older: { usedAt: T0 - 9000 },
    }
    const all = names.map((n) => fetchedQuota(fq, acct(h, n), ctx, {}, 'background', hints[n]))
    // Every read shows its kept answer at once; the asks run behind it.
    assert.ok((await Promise.all(all)).every((e) => e?.quota?.windows[1]?.resetsAt === iso(900)))
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
      assert.ok(ok(), `waited for the asks; started: ${started.join()}`)
    }
    await until(() => started.length === 4)
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual([...started].sort(), ['older', 'pinned', 'recent', 'tight'])
    assert.equal(quotaAsking(ctx.stateDir, 'claude', 'idle'), true)
    for (const n of [...started]) gates.get(n)!()
    await until(() => started.length === 6)
    assert.deepEqual(started.slice(4).sort(), ['hidden', 'idle'])
    for (const n of started.slice(4)) gates.get(n)!()
    await until(() => !names.some((n) => quotaAsking(ctx.stateDir, 'claude', n)))
    assert.equal(most, 4)
  })
})

// A local reading that spares a due ask (spec §3.26).
test('a local reading newer than the Family asks, showing every kept window, stands in for a due ask', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    const far = (label: string, name?: string): QuotaWindow => resetting(label, 600, name)
    const write = (windows: QuotaWindow[]) =>
      writeQuotaStore(file, {
        version: 1,
        attemptedAt: iso(0),
        quota: { status: 'ok', windows, observedAt: iso(0), source: 'claude /usage' },
      })
    let asks = 0
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        throw new Error('no answer')
      },
    }
    const reading = (minutes: number, windows: QuotaWindow[]) =>
      ({ status: 'ok', windows, observedAt: iso(minutes), source: 'claude statusline' }) as const
    const plan = [far('5h'), far('7d')]
    // 10:20, the kept answer is 20 minutes old: due. A status-line reading from 10:18 shows both windows.
    await write(plan)
    await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', { local: reading(18, plan) })
    assert.equal(asks, 0, 'the local reading is enough')
    // The same reading no longer is once it is older than the Family asks.
    await fetchedQuota(fq, a, ctxAt(h, 34), {}, 'wait', { local: reading(18, plan) })
    assert.equal(asks, 1)
    // A kept model-group window the status line cannot see still needs the Host.
    await write([...plan, far('7d', 'Fable')])
    await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', { local: reading(18, plan) })
    assert.equal(asks, 2)
    // A manual refresh always asks.
    await write(plan)
    await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'force', { local: reading(18, plan) })
    assert.equal(asks, 3)
  })
})

test('a local reading never replaces an ask for a Family whose records can replay old numbers, nor a first answer', () => {
  const at = (minutes: number) => new Date(T0 + minutes * 60_000)
  const windows = [resetting('5h', 600), resetting('7d', 600)]
  const store: QuotaStoreEntry = {
    version: 1,
    attemptedAt: iso(0),
    quota: { status: 'ok', windows, observedAt: iso(0), source: 'host' },
  }
  const read = (minutes: number, w = windows) =>
    ({ status: 'ok', windows: w, observedAt: iso(minutes), source: 'local' }) as const
  const fq = { everyMinutes: 15 }
  assert.equal(localCovers(fq, read(18), store, at(20)), true)
  // Codex: its rollout files can hold numbers from before a reset.
  assert.equal(localCovers({ ...fq, localFallbackOnly: true }, read(18), store, at(20)), false)
  assert.equal(localCovers(fq, read(18), null, at(20)), false, 'nothing kept yet')
  assert.equal(localCovers(fq, null, store, at(20)), false)
  assert.equal(localCovers(fq, { status: 'unavailable', reason: 'no-session' }, store, at(20)), false)
  assert.equal(localCovers(fq, read(18, [windows[0]!]), store, at(20)), false, 'a window is missing')
  // A count of Limit Resets comes only from the Host.
  const withStock = {
    ...store,
    quota: { ...store.quota!, limitResets: { available: 1, observedAt: iso(0) } },
  }
  assert.equal(localCovers(fq, read(18), withStock, at(20)), false)
  // A window that reset after the local reading was taken: the reading shows the old window.
  const resetAt19 = { ...store, quota: { ...store.quota!, windows: [resetting('5h', 19), windows[1]!] } }
  assert.equal(localCovers(fq, read(18, resetAt19.quota.windows), resetAt19, at(20)), false)
  assert.equal(localCovers(fq, read(19.5, resetAt19.quota.windows), resetAt19, at(20)), true)
  // A reading dated ahead of the clock is not trusted.
  assert.equal(localCovers(fq, read(25), store, at(20)), false)
  // Each window counts by its own time: a new reading that carries an old window does not cover that window.
  const oldWindow = (minutes: number) => [windows[0]!, { ...windows[1]!, observedAt: iso(minutes) }]
  assert.equal(localCovers(fq, read(18, oldWindow(-120)), store, at(20)), false, 'a window read long ago')
  assert.equal(localCovers(fq, read(18, oldWindow(17)), store, at(20)), true)
  assert.equal(
    localCovers(fq, read(18, [windows[0]!, { ...windows[1]!, observedAt: 'nope' }]), store, at(20)),
    false,
  )
  // Read before the kept window was, or before that window's reset time that has passed.
  const keptLater = {
    ...store,
    quota: { ...store.quota!, windows: [windows[0]!, { ...windows[1]!, observedAt: iso(12) }] },
  }
  assert.equal(localCovers(fq, read(18, oldWindow(10)), keptLater, at(20)), false)
  assert.equal(
    localCovers(
      fq,
      read(19.5, [{ ...resetAt19.quota.windows[0]!, observedAt: iso(18) }, windows[1]!]),
      resetAt19,
      at(20),
    ),
    false,
  )
})

// A read that must come after a change (ADR-0072: the Quota right after a Limit Reset was used).
test('a read that must come after a change does not take an answer whose ask began before it', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const ctx = ctxAt(h, 0)
    const file = quotaStoreFile(ctx.stateDir, 'claude', 'work')
    const tick = () => new Promise((r) => setTimeout(r, 15))
    let asks = 0
    let used = 72
    let release = () => {}
    let gate = new Promise<void>((r) => {
      release = r
    })
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        // The Host takes its numbers when it is asked, and answers when the gate opens.
        const seen = used
        await gate
        return { status: 'ok', windows: [win('5h', seen)], observedAt: iso(0), source: 'claude /usage' }
      },
    }
    // In this process: a reader is asking; the change happens; its answer lands afterwards.
    const early = fetchedQuota(fq, a, ctx, {}, 'force')
    for (let i = 0; i < 200 && asks < 1; i++) await tick()
    assert.equal(asks, 1)
    await tick()
    used = 0
    const changedAt = Date.now()
    const after = fetchedQuota(fq, a, ctx, {}, 'force', { notBefore: changedAt })
    await tick()
    release()
    assert.equal((await early)?.quota?.windows[0]?.usedPercent, 72)
    const fresh = await after
    assert.equal(asks, 2, 'the answer that began before the change is not taken: the Host is asked anew')
    assert.equal(fresh?.quota?.windows[0]?.usedPercent, 0)
    assert.ok(Date.parse(fresh?.startedAt ?? '') >= changedAt)
    assert.ok(Date.parse(fresh!.startedAt!) <= Date.parse(fresh!.attemptedAt))
    assert.equal((await readQuotaStore(file))?.quota?.windows[0]?.usedPercent, 0)

    // Another process holds the Account's lock and keeps, after the change, an answer whose ask began before it.
    gate = Promise.resolve()
    const other = async (startedAt: string | undefined, percent: number) => {
      const held = await takeFileLock(`${file}.lock`, { staleMs: 30_000, beatMs: 5_000 })
      assert.ok(held)
      const at = Date.now()
      await tick()
      const waiting = fetchedQuota(fq, a, ctx, {}, 'force', { notBefore: at })
      await new Promise((r) => setTimeout(r, 150))
      await writeQuotaStore(file, {
        version: 1,
        attemptedAt: new Date().toISOString(),
        ...(startedAt === undefined
          ? {}
          : {
              startedAt: startedAt === 'before' ? new Date(at - 500).toISOString() : new Date().toISOString(),
            }),
        quota: { status: 'ok', windows: [win('5h', percent)], observedAt: iso(1), source: 'claude /usage' },
      })
      await held!()
      return waiting
    }
    used = 5
    assert.equal((await other('before', 72))?.quota?.windows[0]?.usedPercent, 5)
    assert.equal(asks, 3, 'kept after the change, begun before it: asked anew')
    // An answer from a sideby that did not write when it began cannot be shown to have begun after.
    used = 6
    assert.equal((await other(undefined, 72))?.quota?.windows[0]?.usedPercent, 6)
    assert.equal(asks, 4)
    // One that began after the change is the answer this read wanted: no second ask.
    assert.equal((await other('after', 9))?.quota?.windows[0]?.usedPercent, 9)
    assert.equal(asks, 4)
  })
})

// "Once per reset instant" needs the mark on disk before the ask (ADR-0073).
test('the extra ask after a passed reset is not sent while its mark cannot be saved', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    const entry = (attemptedAt: string, resetAsked?: string[]): QuotaStoreEntry => ({
      version: 1,
      attemptedAt,
      quota: {
        status: 'ok',
        windows: [resetting('5h', 5), resetting('7d', 900)],
        observedAt: iso(0),
        source: 'claude /usage',
      },
      ...(resetAsked ? { resetAsked } : {}),
    })
    let asks = 0
    let markedBeforeAsking: string[] | undefined
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        markedBeforeAsking = (await readQuotaStore(file))?.resetAsked
        return { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' }
      },
    }
    // The kept answer can be read but not written: sideby's writer refuses to write through a link.
    const real = h.path('kept-elsewhere.json')
    await writeQuotaStore(real, entry(iso(0)))
    await mkdir(dirname(file), { recursive: true })
    await symlink(real, file)
    // 10:06, inside `everyMinutes`, the 5-hour window passed its reset at 10:05: the mark cannot be saved.
    const first = await fetchedQuota(fq, a, ctxAt(h, 6), {}, 'wait')
    assert.equal(asks, 0, 'no mark on disk, no ask')
    assert.equal(first?.quota?.windows.length, 2, 'the kept answer goes on showing')
    assert.match(first?.error ?? '', /could not write .*work\.fetched\.json.*so it did not ask/)
    // What the CLI and the Panel show with the numbers.
    const shown = shownQuota(null, first, null)
    assert.match((shown.status === 'ok' && shown.fetchError) || '', /did not ask/)
    // Read after read, the Host is still not asked, and the Panel's read carries the reason too.
    assert.match((await fetchedQuota(fq, a, ctxAt(h, 7), {}, 'wait'))?.error ?? '', /did not ask/)
    const panel = await fetchedQuota(fq, a, ctxAt(h, 7), {}, 'background')
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(asks, 0)
    assert.equal((await readQuotaStore(file))?.resetAsked, undefined)
    assert.match((await fetchedQuota(fq, a, ctxAt(h, 8), {}, 'background'))?.error ?? '', /did not ask/)
    assert.equal(panel?.quota?.windows.length, 2)
    // Writes work again: the instant is marked, then asked, once.
    await rm(file)
    await writeQuotaStore(file, entry(iso(0)))
    const asked = await fetchedQuota(fq, a, ctxAt(h, 9), {}, 'wait')
    assert.equal(asks, 1)
    assert.deepEqual(markedBeforeAsking, [iso(5)], 'the mark was on disk before the Host was asked')
    assert.match(asked?.error ?? '', /no answer/)
    // The Host's ask failed: it is not sent again for that instant, and the waiting note is gone.
    // (The attempt is stamped with the real clock; put it on this test's clock to read on.)
    await writeQuotaStore(file, entry(iso(9), [iso(5)]))
    const again = await fetchedQuota(fq, a, ctxAt(h, 10), {}, 'wait')
    await fetchedQuota(fq, a, ctxAt(h, 11), {}, 'background')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(asks, 1)
    assert.equal(again?.error, undefined)
  })
})

test('an ask that is due by age goes on when a reset mark cannot be saved: only the extra ask waits for it', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    let asks = 0
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        return { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' }
      },
    }
    const real = h.path('kept-elsewhere.json')
    await writeQuotaStore(real, {
      version: 1,
      attemptedAt: iso(0),
      quota: { status: 'ok', windows: [resetting('5h', 5)], observedAt: iso(0), source: 'claude /usage' },
    })
    await mkdir(dirname(file), { recursive: true })
    await symlink(real, file)
    // 10:20: the kept answer is older than `everyMinutes`, so this is the regular ask; a refresh always asks.
    await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait')
    assert.equal(asks, 1)
    await fetchedQuota(fq, a, ctxAt(h, 6), {}, 'force')
    assert.equal(asks, 2)
  })
})

// "At most once per distinct reset instant" across processes (ADR-0073): the mark another process wrote counts, also
// when that process could not keep what its ask brought.
test('two processes due for the same reset instant ask once, also when the first could not keep its answer', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const stateDir = ctxAt(h, 0).stateDir
    const file = quotaStoreFile(stateDir, 'claude', 'work')
    const entry = (resetAsked?: string[]): QuotaStoreEntry => ({
      version: 1,
      attemptedAt: iso(0),
      quota: {
        status: 'ok',
        windows: [resetting('5h', 5), resetting('7d', 900)],
        observedAt: iso(0),
        source: 'claude /usage',
      },
      ...(resetAsked ? { resetAsked } : {}),
    })
    await writeQuotaStore(file, entry())
    // The same state folder under a second path: a reader through it shares the lock files and the kept answer, but
    // not this process's table of running asks, as another sideby process would.
    const alias = h.path('state-of-another-process')
    await symlink(stateDir, alias)
    const elsewhere = h.path('kept-elsewhere.json')
    let asks = 0
    let markedBeforeAsking: string[] | undefined
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        markedBeforeAsking = (await readQuotaStore(file))?.resetAsked
        // From here on the kept answer can be read but not written (sideby's writer never writes through a link):
        // the mark is on disk, what this ask brings cannot be kept, so `attemptedAt` stays as it was.
        if (asks === 1) {
          await rename(file, elsewhere)
          await symlink(elsewhere, file)
        }
        return { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' }
      },
    }
    // 10:06, inside `everyMinutes`: the 5-hour window passed its reset at 10:05, and both judge the extra ask due.
    const both = await Promise.all([
      fetchedQuota(fq, a, ctxAt(h, 6), {}, 'wait'),
      fetchedQuota(fq, a, { ...ctxAt(h, 6), stateDir: alias }, {}, 'wait'),
    ])
    assert.deepEqual(markedBeforeAsking, [iso(5)], 'the mark was on disk before the Host was asked')
    const onDisk = await readQuotaStore(file)
    assert.equal(onDisk?.attemptedAt, iso(0), 'what the first ask brought could not be kept')
    assert.deepEqual(onDisk?.resetAsked, [iso(5)])
    assert.equal(
      asks,
      1,
      'one ask for the instant: the second reader finds it marked and shows the kept answer',
    )
    assert.ok(both.every((e) => e?.quota?.windows.length === 2))
    // Reading on inside the interval asks nobody, from either side.
    await fetchedQuota(fq, a, ctxAt(h, 7), {}, 'wait')
    await fetchedQuota(fq, a, { ...ctxAt(h, 8), stateDir: alias }, {}, 'wait')
    assert.equal(asks, 1)
    // 10:16: the regular ask of `everyMinutes` is due, and is sent as always.
    await rm(file)
    await writeQuotaStore(file, entry([iso(5)]))
    await fetchedQuota(fq, a, ctxAt(h, 16), {}, 'wait')
    assert.equal(asks, 2)
  })
})

test('a reset instant handled for another Account of the Same Login is not asked for again', async () => {
  await withFakeHome(async (h) => {
    const stateDir = ctxAt(h, 0).stateDir
    const work = quotaStoreFile(stateDir, 'claude', 'work')
    const alt = quotaStoreFile(stateDir, 'claude', 'alt')
    const seed = (file: string, extra: Partial<QuotaStoreEntry> = {}) =>
      writeQuotaStore(file, {
        version: 1,
        attemptedAt: iso(0),
        quota: { status: 'ok', windows: [resetting('5h', 5)], observedAt: iso(0), source: 'claude /usage' },
        ...extra,
      })
    await seed(work)
    await seed(alt)
    let asks = 0
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => {
        asks++
        return { status: 'unavailable', reason: 'fetch-failed', detail: 'no answer' }
      },
    }
    const peers = (file: string) => ({ peers: async () => [await readQuotaStore(file)] })
    // 10:06: `work` asks for the login once the 10:05 reset has passed; the ask fails and its mark stays.
    await fetchedQuota(fq, acct(h, 'work'), ctxAt(h, 6), {}, 'wait', peers(alt))
    assert.equal(asks, 1)
    assert.deepEqual((await readQuotaStore(work))?.resetAsked, [iso(5)])
    // The other Account asks for the login from now on (the order changed, or `work` signed out): same instant, no ask.
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 7), {}, 'wait', peers(work))
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 8), {}, 'background', peers(work))
    assert.equal(asks, 1)
    assert.deepEqual(
      passedResets(await readQuotaStore(alt), ctxAt(h, 7).now),
      [iso(5)],
      'by itself it would ask',
    )
    // An answer `work` took after the instant counts the same, though a good answer drops the mark.
    await seed(work, { attemptedAt: iso(6), startedAt: iso(6) })
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 9), {}, 'wait', peers(work))
    assert.equal(asks, 1)
    // One taken before the instant, or a failed one, does not.
    assert.deepEqual(
      passedResets(await readQuotaStore(alt), ctxAt(h, 9).now, [
        { ...(await readQuotaStore(work))!, startedAt: iso(4) },
        { ...(await readQuotaStore(work))!, error: 'no answer' },
        null,
      ]),
      [iso(5)],
    )
    // A later ask of `work` that failed does not undo its good answer from after the instant (taken at 10:06).
    await seed(work, {
      attemptedAt: iso(7),
      startedAt: iso(7),
      error: 'no answer',
      quota: { status: 'ok', windows: [resetting('5h', 305)], observedAt: iso(6), source: 'claude /usage' },
    })
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 9), {}, 'wait', peers(work))
    assert.equal(asks, 1)
    // The regular ask and a refresh are not held back.
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 20), {}, 'wait', peers(work))
    assert.equal(asks, 2)
    await seed(alt)
    await fetchedQuota(fq, acct(h, 'alt'), ctxAt(h, 7), {}, 'force', peers(work))
    assert.equal(asks, 3)
  })
})

test('an answer asked for before a Limit Reset was used is not kept after it, and the Account stays due', async () => {
  await withFakeHome(async (h) => {
    const a = acct(h, 'work')
    const file = quotaStoreFile(ctxAt(h, 0).stateDir, 'claude', 'work')
    const before = kept(iso(0), [win('5h', 72)])
    await writeQuotaStore(file, before)
    const fq: QuotaFetch = {
      everyMinutes: 15,
      summary: 'test',
      fetch: async () => ({
        status: 'ok',
        windows: [win('5h', 71)],
        observedAt: new Date().toISOString(),
        source: 'claude /usage',
      }),
    }
    // The reset was used while the Host was answering: what arrives may be from before it.
    const late = await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', {
      changedAt: async () => Date.now() + 60_000,
    })
    assert.equal(late?.quota?.windows[0]?.usedPercent, 72)
    assert.deepEqual(await readQuotaStore(file), before, 'nothing was written, so the next read asks again')
    // An ask that began after it is kept as usual; so is one when the time cannot be read.
    const after = await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', {
      changedAt: async () => Date.now() - 60_000,
    })
    assert.equal(after?.quota?.windows[0]?.usedPercent, 71)
    // A first ask, with nothing kept yet, is held to the same rule: nothing is written.
    await rm(file)
    const first = await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', {
      changedAt: async () => Date.now() + 60_000,
    })
    assert.equal(first, null)
    assert.equal(await readQuotaStore(file), null)
    await writeQuotaStore(file, before)
    const unknown = await fetchedQuota(fq, a, ctxAt(h, 20), {}, 'wait', {
      changedAt: async () => {
        throw new Error('unreadable')
      },
    })
    assert.equal(unknown?.quota?.windows[0]?.usedPercent, 71)
  })
})
