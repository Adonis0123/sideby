import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { quotaStoreFile, readQuotaStore, writeQuotaStore } from '../../core/quota-store.ts'
import { createRuntime } from '../../runtime.ts'
import type { QuotaResult } from '../../types.ts'
import { grokAccountFromEnv, grokHookReader } from './handoff-hook.ts'
import { grokPlugin } from './index.ts'
import { fetchGrokQuota } from './quota.ts'
import { GROK_BILLING_MSG, grokQuota, lastGrokBilling, readGrokLogQuota } from './quota-log.ts'

/** The fullest window's used percent, as the hook reads it; null when unknown. */
const top = (w: { usedPercent: number }[] | null) => (w ? Math.max(0, ...w.map((x) => x.usedPercent)) : null)

const builtins = [{ plugin: grokPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()
const START = iso(-24)
const END = iso(24 * 6)
/** Values that must never leave the answer or the log: an id and a token's tail. */
const SECRETS = ['u-secret-7781', 'tok-tail-9f3c', 'team-secret-55']

const billing = (pct: number, end = END) => ({
  config: {
    creditUsagePercent: pct,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: START, end },
    billingPeriodStart: START,
    billingPeriodEnd: end,
    teamId: SECRETS[2],
  },
  subscription_tier: 'SuperGrok Heavy',
  user_id: SECRETS[0],
})

/**
 * A fake `grok` that records how it was started and the request it read, then answers as `<bin>/grok.mode` says:
 * `ok`, `notfound`, `auth`, `apikey`, `garbage`, `exit` or `hang`.
 */
async function fakeGrok(h: FakeHome, mode = 'ok', pct = 6): Promise<void> {
  await writeFile(join(h.bin, 'grok.mode'), mode)
  const answers = {
    ok: { result: billing(pct) },
    notfound: { error: { code: -32601, message: 'Method not found' } },
    auth: {
      error: {
        code: -32000,
        message: 'Authentication required',
        data: 'Authentication required to fetch billing data',
      },
    },
    apikey: {
      error: {
        code: -32000,
        message: 'Authentication required',
        data: 'Billing data requires auth with grok.com. Run `grok login` to authenticate.',
      },
    },
    garbage: { result: { nothing: SECRETS[0] } },
    internal: {
      error: { code: -32603, message: 'Internal error', data: `Billing service error: ${SECRETS[1]}` },
    },
  }
  const script = `#!${process.execPath}
const fs = require('node:fs')
const log = ${JSON.stringify(join(h.bin, 'grok.log'))}
const rec = (o) => fs.appendFileSync(log, JSON.stringify(o) + '\\n')
process.on('SIGTERM', () => { rec({ signal: 'SIGTERM' }); process.exit(143) })
rec({ argv: process.argv.slice(2), grokHome: process.env.GROK_HOME ?? null, noUpdate: process.env.GROK_DISABLE_AUTOUPDATER ?? null, xai: process.env.XAI_API_KEY ?? null })
const mode = fs.readFileSync(${JSON.stringify(join(h.bin, 'grok.mode'))}, 'utf8').trim()
const answers = ${JSON.stringify(answers)}
if (mode === 'exit') process.exit(0)
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    rec({ req })
    if (mode === 'hang') continue
    // expired: the first ask fails as with an expired token, the next one answers.
    const answer = mode === 'expired' ? (req.id === 1 ? answers.internal : answers.ok) : answers[mode]
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...answer }) + '\\n')
  }
})
// A Grok that hangs ignores its closed stdin too, so only sideby's SIGTERM ends it.
process.stdin.on('end', () => { if (mode !== 'hang') process.exit(0) })
if (mode === 'hang') setInterval(() => {}, 1000)
`
  await writeFile(join(h.bin, 'grok'), script, { mode: 0o755 })
}

async function grokLog(h: FakeHome): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(join(h.bin, 'grok.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const starts = async (h: FakeHome) => (await grokLog(h)).filter((r) => r.argv).length

async function seed(h: FakeHome, ...names: string[]) {
  await h.write('.grok/auth.json', '{}', 0o600)
  await h.write('.grok/config.toml', 'model = "grok-main"\n')
  for (const n of names) {
    await h.write(`.grok-${n}/auth.json`, '{}', 0o600)
    await h.write(`.grok-${n}/config.toml`, '')
  }
}

const logLine = (ts: string, msg: string, ctx: unknown) =>
  JSON.stringify({ ts, src: 'x', lvl: 'info', msg, ctx })

const assertNoSecrets = (text: string) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked ${s}`)
}

describe('Grok quota (spec §3.26)', () => {
  it('asks the Grok CLI of each account, with its own GROK_HOME and nothing else of sideby', async () => {
    await withFakeHome(async (h) => {
      await seed(h, 'work')
      await fakeGrok(h)
      const rt = await createRuntime({ env: { ...h.env, XAI_API_KEY: 'leak-me' }, builtins })
      const before = await snapshot(h.home)
      const main = await rt.quota(await rt.resolve('grok:main'))
      const work = await rt.quota(await rt.resolve('grok:work'))
      for (const q of [main, work]) {
        assert.equal(q.status, 'ok')
        if (q.status !== 'ok') return
        assert.equal(q.fetched, true)
        assert.equal(q.plan, 'SuperGrok Heavy')
        assert.deepEqual(q.windows, [
          { label: '7d', windowMinutes: 10080, usedPercent: 6, resetsAt: new Date(END).toISOString() },
        ])
        assertNoSecrets(JSON.stringify(q))
      }
      const log = await grokLog(h)
      const runs = log.filter((r) => r.argv)
      assert.deepEqual(
        runs.map((r) => r.argv),
        [
          ['agent', '--no-leader', 'stdio'],
          ['agent', '--no-leader', 'stdio'],
        ],
      )
      assert.deepEqual(runs.map((r) => r.grokHome).sort(), [h.path('.grok-work'), null].sort())
      assert.ok(runs.every((r) => r.noUpdate === '1' && r.xai === null))
      // One request each, the billing method, no `initialize` and no session.
      assert.deepEqual(
        log.filter((r) => r.req).map((r) => (r.req as { method: string }).method),
        ['_x.ai/billing', '_x.ai/billing'],
      )
      // Only sideby's state changed: nothing in any account directory.
      const changed = diffSnapshots(before, await snapshot(h.home))
      assert.ok(changed.length > 0)
      assert.deepEqual(
        changed.filter(
          (p) => !['.local', '.local/state'].includes(p) && !p.startsWith('.local/state/sideby'),
        ),
        [],
      )
      const kept = await readFile(quotaStoreFile(rt.paths.stateDir, 'grok', 'main'), 'utf8')
      assertNoSecrets(kept)
    })
  })

  it('asks again only after 15 minutes, or when the user refreshes', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeGrok(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const main = await rt.resolve('grok:main')
      await rt.quota(main)
      await rt.quota(main)
      assert.equal(await starts(h), 1)
      await rt.refreshQuota()
      assert.equal(await starts(h), 2)
      const file = quotaStoreFile(rt.paths.stateDir, 'grok', 'main')
      const entry = (await readQuotaStore(file))!
      await writeQuotaStore(file, { ...entry, attemptedAt: iso(-0.3) })
      await rt.quota(main)
      assert.equal(await starts(h), 3)
      // `never` (the hook's way) only reads what is kept.
      await writeQuotaStore(file, { ...entry, attemptedAt: iso(-1) })
      await rt.quota(main, { fetch: 'never' })
      assert.equal(await starts(h), 3)
    })
  })

  it('says why there is no quota, and what to do, without repeating what Grok said', async () => {
    const cases: [string, RegExp][] = [
      ['notfound', /cannot report the quota; update Grok/],
      ['auth', /run `sideby login grok:main`/],
      ['apikey', /API key, which has no subscription quota/],
      ['garbage', /does not recognise/],
      ['exit', /exited without answering/],
      ['internal', /could not get the quota from xAI \(error -32603\)/],
    ]
    for (const [mode, want] of cases)
      await withFakeHome(async (h) => {
        await seed(h)
        await fakeGrok(h, mode)
        const rt = await createRuntime({ env: h.env, builtins })
        const q = await rt.quota(await rt.resolve('grok:main'))
        assert.equal(q.status, 'unavailable', mode)
        if (q.status !== 'unavailable') return
        assert.equal(q.reason, 'fetch-failed', mode)
        assert.match(q.detail ?? '', want, mode)
        assert.ok(!(q.detail ?? '').includes('Billing data requires'), mode)
        assertNoSecrets(JSON.stringify(q))
      })
  })

  it('asks once more in the same Grok when the first answer fails, as after an expired token', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeGrok(h, 'expired')
      const rt = await createRuntime({ env: h.env, builtins })
      const q = await rt.quota(await rt.resolve('grok:main'))
      assert.equal(q.status === 'ok' && q.windows[0]?.usedPercent, 6)
      assert.equal(await starts(h), 1)
      assert.deepEqual(
        (await grokLog(h)).filter((r) => r.req).map((r) => (r.req as { id: number }).id),
        [1, 2],
      )
    })
  })

  it('keeps the last good answer on show when a later check fails', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeGrok(h, 'ok', 40)
      const rt = await createRuntime({ env: h.env, builtins })
      const main = await rt.resolve('grok:main')
      await rt.quota(main)
      await fakeGrok(h, 'notfound')
      await rt.refreshQuota([main])
      const q = await rt.quota(main)
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.windows[0]!.usedPercent, 40)
      assert.match(q.fetchError ?? '', /update Grok/)
    })
  })

  it('does not ask when turned off, in CI, for a signed-out account or an API account', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.mkdir('.grok-out')
      await h.write('.grok-out/config.toml', '')
      await h.write('.grok-key/proxy.env', 'XAI_API_KEY=x\n', 0o600)
      await fakeGrok(h)
      const off = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(await off.setQuotaCheck('grok', false), { changed: true })
      const q = await off.quota(await off.resolve('grok:main'))
      assert.equal(q.status === 'unavailable' && q.reason, 'not-enabled')
      assert.deepEqual(JSON.parse(await readFile(off.paths.configFile, 'utf8')).quota, {
        check: { grok: false },
      })
      assert.equal(off.quotaChecks()[0]!.on, false)
      assert.equal(await starts(h), 0)
      await off.setQuotaCheck('grok', true)
      assert.equal(JSON.parse(await readFile(off.paths.configFile, 'utf8')).quota, undefined)

      const ci = await createRuntime({ env: { ...h.env, CI: 'true' }, builtins })
      assert.equal((await ci.quota(await ci.resolve('grok:main'))).status, 'unavailable')
      assert.match(ci.quotaChecks()[0]!.blocked ?? '', /CI/)
      const rt = await createRuntime({ env: h.env, builtins })
      await rt.quota(await rt.resolve('grok:out'))
      assert.equal((await rt.quota(await rt.resolve('grok:key'))).status, 'unavailable')
      assert.equal(await starts(h), 0)
    })
  })

  it('stops a Grok that does not answer and ends it', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeGrok(h, 'hang')
      const ac = new AbortController()
      // Stop only once Grok has the request (and its signal handler): a fixed delay loses that race on a slow machine.
      void (async () => {
        for (let i = 0; i < 200 && !(await grokLog(h)).some((r) => r.req); i++)
          await new Promise((r) => setTimeout(r, 25))
        ac.abort()
      })()
      const rt = await createRuntime({ env: h.env, builtins })
      const q = await fetchGrokQuota(await rt.resolve('grok:main'), {
        ...rt.readContext(),
        signal: ac.signal,
        hostEnv: h.env,
      })
      assert.equal(q.status === 'unavailable' && q.reason, 'fetch-failed')
      for (let i = 0; i < 200 && !(await grokLog(h)).some((r) => r.signal); i++)
        await new Promise((r) => setTimeout(r, 50))
      const log = await grokLog(h)
      assert.ok(
        log.some((r) => r.signal === 'SIGTERM'),
        `no SIGTERM in the fake Grok's log: ${JSON.stringify(log.map((r) => ({ ...r, env: undefined })))}; answer: ${JSON.stringify(q)}`,
      )
    })
  })
})

describe('Grok quota from its log (spec §3.26)', () => {
  it('reads only the billing lines, the newest first, and keeps nothing else of the file', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const lines = [
        logLine(iso(-3), GROK_BILLING_MSG, { config: billing(20).config, subscriptionTier: 'SuperGrok' }),
        logLine(iso(-2), 'auth init user_info check', { userId: SECRETS[0], token: `…${SECRETS[1]}` }),
        logLine(iso(-1), GROK_BILLING_MSG, { config: billing(35).config, subscriptionTier: 'SuperGrok' }),
        // The message inside another field is not a billing line.
        logLine(iso(-0.5), 'something else', { note: GROK_BILLING_MSG, config: billing(99).config }),
        '{not json',
      ]
      await h.write('.grok/logs/unified.jsonl', `${lines.join('\n')}\n`)
      const q = await readGrokLogQuota(h.path('.grok'))
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.windows[0]!.usedPercent, 35)
      assert.equal(q.plan, 'SuperGrok')
      assert.equal(q.source, 'logs/unified.jsonl')
      assertNoSecrets(JSON.stringify(q))
      // Read backwards across chunks: a billing line far from the end is still found.
      const filler = logLine(iso(-0.2), 'noise', { pad: 'x'.repeat(2000) })
      await h.write(
        '.grok-far/logs/unified.jsonl',
        `${lines[2]}\n${Array.from({ length: 200 }, () => filler).join('\n')}\n`,
      )
      const far = await lastGrokBilling(h.path('.grok-far/logs/unified.jsonl'), 8 * 1024 * 1024)
      assert.equal(far?.windows[0]?.usedPercent, 35)
      assert.equal(await lastGrokBilling(h.path('.grok-far/logs/unified.jsonl'), 64 * 1024), null)
    })
  })

  it('shows the newer of the log and the kept answer', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeGrok(h, 'ok', 10)
      const rt = await createRuntime({ env: h.env, builtins })
      const main = await rt.resolve('grok:main')
      const old = await rt.quota(main)
      assert.equal(old.status === 'ok' && old.fetched, true)
      // Grok wrote a newer line after a turn.
      await h.write(
        '.grok/logs/unified.jsonl',
        `${logLine(iso(0.01), GROK_BILLING_MSG, { config: billing(50).config })}\n`,
      )
      const q: QuotaResult = await rt.quota(main)
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.windows[0]!.usedPercent, 50)
      assert.equal(q.fetched, undefined)
    })
  })

  it('maps a monthly answer and a weekly one without a percent', () => {
    const monthly = grokQuota(
      {
        config: {
          used: { val: '25' },
          monthlyLimit: { val: 100 },
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_MONTHLY',
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-31T00:00:00Z',
          },
        },
      },
      'now',
      'x',
    )
    assert.deepEqual(monthly?.windows, [
      { label: '30d', windowMinutes: 43200, usedPercent: 25, resetsAt: '2026-10-31T00:00:00.000Z' },
    ])
    const weekly = grokQuota(
      { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: END } } },
      'now',
      'x',
    )
    assert.equal(weekly?.windows[0]?.usedPercent, 0)
    assert.equal(weekly?.windows[0]?.label, '7d')
    assert.equal(grokQuota({ config: {} }, 'now', 'x'), null)
  })
})

describe('Grok handoff hook pressure (spec §3.26)', () => {
  it('finds the account from GROK_HOME and takes the newer of the kept answer and the log', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(grokAccountFromEnv(h.env), { name: 'main', dir: h.path('.grok') })
      assert.deepEqual(grokAccountFromEnv({ ...h.env, GROK_HOME: h.path('.grok-work') }), {
        name: 'work',
        dir: h.path('.grok-work'),
      })
      assert.equal(grokAccountFromEnv({ ...h.env, GROK_HOME: '/tmp/other' }), null)
      const env = { ...h.env, GROK_HOME: h.path('.grok-work') }
      const now = new Date()
      assert.equal(top(await grokHookReader.windows!({}, env, now)), null)
      const stateDir = h.path('.local/state/sideby')
      await writeQuotaStore(quotaStoreFile(stateDir, 'grok', 'work'), {
        version: 1,
        attemptedAt: iso(-0.1),
        quota: grokQuota(billing(70), iso(-0.1), 'grok agent')!,
      })
      assert.equal(top(await grokHookReader.windows!({}, env, now)), 70)
      await h.write(
        '.grok-work/logs/unified.jsonl',
        `${logLine(iso(-0.01), GROK_BILLING_MSG, billing(96))}\n`,
      )
      assert.equal(top(await grokHookReader.windows!({}, env, now)), 96)
    })
  })
})
