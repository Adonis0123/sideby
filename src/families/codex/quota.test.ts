import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { type FakeHome, fakeHost, readHostLog, snapshot, withFakeHome } from '../../../testing/index.ts'
import { quotaStoreFile, readQuotaStore, writeQuotaStore } from '../../core/quota-store.ts'
import { createRuntime } from '../../runtime.ts'
import { codexFamily, codexPlugin } from './index.ts'

const builtins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]
const SECRET = 'private-response-must-not-escape'
const result = (used = 0) => ({
  rateLimits: {
    limitId: 'codex_other',
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1893456000 },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 1893456000 },
      secondary: null,
      planType: 'pro',
      accountId: SECRET,
    },
  },
  accountId: SECRET,
})

async function seed(h: FakeHome) {
  await h.write('.codex/auth.json', '{}', 0o600)
  await h.write('.codex/config.toml', '')
  await h.write('.codex-work/auth.json', '{}', 0o600)
  await h.write('.codex-work/config.toml', '')
}

async function host(h: FakeHome, mode = 'ok', answer: unknown = result()) {
  await writeFile(join(h.bin, 'mode'), mode)
  await fakeHost(h, 'codex', {
    sleep: 3600,
    onStart: `
const mode = fs.readFileSync(path.join(path.dirname(process.argv[1]), 'mode'), 'utf8')
const answers = ${JSON.stringify(answer)}
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
    rec({ method: req.method })
    if (mode === 'hang') continue
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: req.id, result: { userAgent: 'test' } }) + '\\n')
    } else if (req.method === 'account/rateLimits/read') {
      if (mode === 'exit') { process.exit(0) }
      const response = mode === 'error' ? { error: { code: -32603, message: '${SECRET}' } }
        : mode === 'old' ? { error: { code: -32601, message: '${SECRET}' } }
        : { result: answers }
      process.stdout.write(JSON.stringify({ id: req.id, ...response }) + '\\n')
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  })
}

async function methods(h: FakeHome) {
  return (await readFile(join(h.bin, 'codex.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.method)
    .map((r) => r.method)
}

describe('Codex fetched quota', () => {
  it('lets the demo HOME exercise a successful quota query without the real Host', async () => {
    await withFakeHome(async (h) => {
      const demo = h.path('demo')
      await promisify(execFile)(
        process.execPath,
        [new URL('../../../scripts/demo-home.ts', import.meta.url).pathname, demo],
        { env: h.env as NodeJS.ProcessEnv },
      )
      const home = join(demo, 'home')
      const rt = await createRuntime({
        env: {
          ...h.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_STATE_HOME: join(home, '.local/state'),
          PATH: `${join(demo, 'bin')}:/usr/bin:/bin`,
        },
        builtins,
      })
      const q = await rt.quota(await rt.resolve('codex:main'))
      assert.equal(q.status, 'ok')
      if (q.status === 'ok') {
        assert.equal(q.fetched, true)
        assert.equal(q.fetchError, undefined)
        assert.equal(q.windows[1]!.usedPercent, 61)
      }
    })
  })
  it('refreshes from the menu snapshot command even while its cached result is recent', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h, 'ok', result(59))
      const main = new URL('../../cli/main.ts', import.meta.url).pathname
      const run = () =>
        promisify(execFile)(process.execPath, [main, 'menubar', 'snapshot', '--json', '--refresh'], {
          env: h.env as NodeJS.ProcessEnv,
        })
      const first = JSON.parse((await run()).stdout)
      assert.equal(first.sections[0].rows[0].bars[1].percent, 59)
      await host(h, 'ok', result(0))
      const second = JSON.parse((await run()).stdout)
      assert.equal(second.sections[0].rows[0].bars[1].percent, 0)
      assert.equal(second.sections[0].rows[0].stale, false)
      assert.equal((await readHostLog(h, 'codex')).filter((r) => r.argv).length, 4)
    })
  })
  it('labels a local fallback when a query fails before any successful fetch', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h, 'error')
      await h.write(
        '.codex/sessions/rollout-fallback.jsonl',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 59, window_minutes: 10080, resets_at: 1893456000 },
            },
          },
        }),
      )
      const rt = await createRuntime({ env: h.env, builtins })
      const q = await rt.quota(await rt.resolve('codex:main'))
      assert.equal(q.status, 'ok')
      if (q.status === 'ok') {
        assert.equal(q.fetched, undefined)
        assert.equal(q.windows[0]!.usedPercent, 59)
        assert.match(q.fetchError!, /refresh/)
      }
    })
  })
  it('queries without sessions, isolates Accounts and keeps only quota fields', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h)
      const rt = await createRuntime({
        env: { ...h.env, CODEX_HOME: '/wrong', OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: SECRET },
        builtins,
      })
      const before = await Promise.all(['.codex', '.codex-work'].map((d) => snapshot(h.path(d))))
      for (const ref of ['codex:main', 'codex:work']) {
        const q = await rt.quota(await rt.resolve(ref))
        assert.equal(q.status, 'ok')
        if (q.status !== 'ok') return
        assert.equal(q.fetched, true)
        assert.equal(q.plan, 'pro')
        assert.deepEqual(q.windows, [
          { label: '7d', windowMinutes: 10080, usedPercent: 0, resetsAt: '2030-01-01T00:00:00.000Z' },
        ])
        assert.ok(!JSON.stringify(q).includes(SECRET))
      }
      const runs = (await readHostLog(h, 'codex')).filter((r) => r.argv)
      assert.equal(runs.length, 2)
      assert.equal(runs[0]!.env.CODEX_HOME, undefined)
      assert.equal(runs[1]!.env.CODEX_HOME, h.path('.codex-work'))
      assert.ok(runs[1]!.argv.includes('cli_auth_credentials_store="file"'))
      assert.ok(runs.every((r) => !r.env.OPENAI_API_KEY && !r.env.OPENAI_BASE_URL))
      assert.deepEqual(await methods(h), [
        'initialize',
        'initialized',
        'account/rateLimits/read',
        'initialize',
        'initialized',
        'account/rateLimits/read',
      ])
      assert.deepEqual(await Promise.all(['.codex', '.codex-work'].map((d) => snapshot(h.path(d)))), before)
      const stored = await readFile(quotaStoreFile(rt.paths.stateDir, 'codex', 'work'), 'utf8')
      assert.ok(!stored.includes(SECRET))
    })
  })

  it('limits automatic checks but manual refresh discovers a reset without a new session', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h, 'ok', result(59))
      const rt = await createRuntime({ env: h.env, builtins })
      const a = await rt.resolve('codex:main')
      assert.equal((await rt.quota(a)).status, 'ok')
      await rt.quota(a)
      assert.equal((await readHostLog(h, 'codex')).filter((r) => r.argv).length, 1)
      await host(h, 'ok', result(0))
      await rt.refreshQuota([await rt.resolve('codex:main')])
      const q = await rt.quota(a)
      assert.equal(q.status, 'ok')
      if (q.status === 'ok') assert.equal(q.windows[0]!.usedPercent, 0)
      assert.equal((await readHostLog(h, 'codex')).filter((r) => r.argv).length, 2)
    })
  })

  it('does not replace a fetched reset with a newer replay of old rollout quota', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const a = await rt.resolve('codex:main')
      await rt.quota(a)
      const file = quotaStoreFile(rt.paths.stateDir, 'codex', 'main')
      const kept = (await readQuotaStore(file))!
      assert.ok(kept?.quota)
      const observedAt = new Date(Date.now() - 60000).toISOString()
      await writeQuotaStore(file, { ...kept, quota: { ...kept.quota, observedAt } })
      await h.write(
        '.codex/sessions/rollout-replayed.jsonl',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 59, window_minutes: 10080, resets_at: 1893456000 },
            },
          },
        }),
      )
      await host(h, 'error')
      await rt.refreshQuota([await rt.resolve('codex:main')])
      const q = await rt.quota(a)
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.windows[0]!.usedPercent, 0)
      assert.equal(q.observedAt, observedAt)
      assert.match(q.fetchError!, /refresh|again/)
      assert.ok(!JSON.stringify(q).includes(SECRET))
    })
  })

  it('supports legacy answers but never substitutes a different bucket', async () => {
    for (const [answer, ok] of [
      [{ rateLimits: result().rateLimitsByLimitId.codex }, true],
      [{ rateLimits: result().rateLimits }, false],
      [{ ...result(), rateLimitsByLimitId: {} }, false],
      [
        {
          ...result(),
          rateLimitsByLimitId: {
            codex: { ...result().rateLimitsByLimitId.codex, primary: { usedPercent: 'bad' } },
          },
        },
        false,
      ],
    ] as const)
      await withFakeHome(async (h) => {
        await seed(h)
        await host(h, 'ok', answer)
        const rt = await createRuntime({ env: h.env, builtins })
        const q = await rt.quota(await rt.resolve('codex:main'))
        assert.equal(q.status, ok ? 'ok' : 'unavailable')
        if (!ok && q.status === 'unavailable') assert.equal(q.reason, 'fetch-failed')
      })
  })

  it('keeps raw errors private and explains unsupported versions and early exits', async () => {
    for (const [mode, expected] of [
      ['error', /again|refresh/],
      ['old', /update Codex/],
      ['exit', /exited/],
    ] as const)
      await withFakeHome(async (h) => {
        await seed(h)
        await host(h, mode)
        const rt = await createRuntime({ env: h.env, builtins })
        const q = await rt.quota(await rt.resolve('codex:main'))
        assert.equal(q.status, 'unavailable')
        if (q.status === 'unavailable') assert.match(q.detail!, expected)
        assert.ok(!JSON.stringify(q).includes(SECRET))
      })
  })

  it('does not launch the Host when disabled or in CI, even for refresh', async () => {
    for (const ci of [false, true])
      await withFakeHome(async (h) => {
        await seed(h)
        await host(h)
        if (!ci)
          await h.write('.config/sideby/config.json', JSON.stringify({ quota: { check: { codex: false } } }))
        const rt = await createRuntime({ env: { ...h.env, ...(ci ? { CI: '1' } : {}) }, builtins })
        await rt.refreshQuota([await rt.resolve('codex:main')])
        const q = await rt.quota(await rt.resolve('codex:main'))
        assert.equal(q.status, 'unavailable')
        if (q.status === 'unavailable') assert.equal(q.reason, 'not-enabled')
        assert.deepEqual(await readHostLog(h, 'codex'), [])
      })
  })

  it('stops a hanging query when its deadline aborts', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await host(h, 'hang')
      const rt = await createRuntime({ env: h.env, builtins })
      const a = await rt.resolve('codex:work')
      assert.ok(codexFamily.fetchQuota)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 150)
      try {
        const q = await codexFamily.fetchQuota.fetch(a, {
          ...rt.readContext(),
          hostEnv: { ...h.env, CODEX_HOME: a.dir },
          signal: ac.signal,
        })
        assert.equal(q.status, 'unavailable')
        if (q.status === 'unavailable') assert.match(q.detail!, /stopped/)
      } finally {
        clearTimeout(timer)
      }
    })
  })
})
