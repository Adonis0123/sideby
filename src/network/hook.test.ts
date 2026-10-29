// `sideby network-hook` (spec §3.35): blocks with exit 2 and a reason, lets the Host go on with exit 0, and imports
// only leaf modules. Requests go through a fake fetcher.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withFakeHome } from '../../testing/index.ts'
import { NETWORK_ENV, RETRY_BUDGET_MS, TIMEOUT_MS } from '../core/egress.ts'
import { runNetworkHook } from './hook.ts'

const trace = (loc: string) => async () => `ip=203.0.113.7\nloc=${loc}\n`
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}

/** A clock that moves only when the fake fetcher or the fake sleep says so: nothing really waits. */
const fakeTime = (start = Date.parse('2026-10-29T00:00:00Z')) => {
  let t = start
  const waits: number[] = []
  return {
    waits,
    elapsed: () => t - start,
    now: () => new Date(t),
    sleep: async (ms: number) => {
      waits.push(ms)
      t += ms
    },
    /** A request that runs out of time, as `fetchTrace` would after `TIMEOUT_MS` (or a little later). */
    timeout: (late = 0) => {
      t += TIMEOUT_MS + late
      throw new Error('timeout')
    },
  }
}

const sessionEnv = (dir: string, allow = 'US,JP') => ({
  [NETWORK_ENV.url]: 'https://api.anthropic.com/cdn-cgi/trace',
  [NETWORK_ENV.allow]: allow,
  [NETWORK_ENV.dir]: dir,
  SIDEBY_LABEL: 'cc008',
  LANG: 'zh_CN.UTF-8',
})

describe('network hook', () => {
  it('does nothing outside a session sideby started with Network Guard', async () => {
    const err = sink()
    assert.equal(await runNetworkHook(['claude', 'UserPromptSubmit'], {}, err, { fetcher: trace('HK') }), 0)
    assert.deepEqual(err.lines, [])
  })

  it('lets an allowed country through and blocks another with the reason', async () => {
    await withFakeHome(async (h) => {
      const ok = sink()
      const env = sessionEnv(h.path('net'))
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], env, ok, { fetcher: trace('JP'), print: 'p' }),
        0,
      )
      assert.deepEqual(ok.lines, [])
      const bad = sink()
      const env2 = sessionEnv(h.path('net2'))
      assert.equal(
        await runNetworkHook(['codex', 'PreToolUse'], env2, bad, { fetcher: trace('HK'), print: 'p' }),
        2,
      )
      assert.match(bad.lines.join(''), /香港（HK）/)
      assert.match(bad.lines.join(''), /sideby run cc008 --ignore-network/)
    })
  })

  it('blocks when it cannot tell after asking again within the budget', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => {
        calls++
        return time.timeout()
      }
      const env = { ...sessionEnv(h.path('net')), LANG: 'en_US.UTF-8' }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, deps), 2)
      assert.equal(calls, 5)
      assert.deepEqual(time.waits, [1000, 2000, 4000, 8000])
      assert.ok(time.elapsed() <= RETRY_BUDGET_MS, `${time.elapsed()} ms is over the budget`)
      assert.match(err.lines.join(''), /could not tell this network's exit after 5 tries in about 30 s/)
      assert.match(err.lines.join(''), /no answer within 3 seconds/)
    })
  })

  it('says how long it tried in Chinese too', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      const deps = { fetcher: async () => time.timeout(), print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['claude', 'PreToolUse'], sessionEnv(h.path('net')), err, deps), 2)
      assert.match(err.lines.join(''), /试了 5 次（约 30 秒）仍没能确认网络出口（3 秒内没有回应）/)
    })
  })

  it('goes on when a later try answers with an allowed country', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => (++calls === 1 ? time.timeout() : trace('JP')())
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), err, deps),
        0,
      )
      assert.equal(calls, 2)
      assert.deepEqual(time.waits, [1000])
      assert.deepEqual(err.lines, [])
    })
  })

  it('asks again when the answer names no country', async () => {
    await withFakeHome(async (h) => {
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => (++calls === 1 ? 'ip=203.0.113.7\n' : trace('US')())
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(await runNetworkHook(['codex', 'PreToolUse'], sessionEnv(h.path('net')), sink(), deps), 0)
      assert.equal(calls, 2)
    })
  })

  it('blocks a country outside the list at once, without asking again', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const time = fakeTime()
      let calls = 0
      const fetcher = async () => {
        calls++
        return trace('HK')()
      }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), err, deps),
        2,
      )
      assert.equal(calls, 1)
      assert.deepEqual(time.waits, [])
      assert.match(err.lines.join(''), /香港（HK）/)
    })
  })

  it('stops asking when the next try would not fit the budget', async () => {
    await withFakeHome(async (h) => {
      const time = fakeTime()
      let calls = 0
      // Each timeout fires half a second late: a fifth try after the 8-second wait would end past the budget.
      const fetcher = async () => {
        calls++
        return time.timeout(500)
      }
      const deps = { fetcher, print: 'p', now: time.now, sleep: time.sleep }
      assert.equal(
        await runNetworkHook(['claude', 'UserPromptSubmit'], sessionEnv(h.path('net')), sink(), deps),
        2,
      )
      assert.equal(calls, 4)
      assert.deepEqual(time.waits, [1000, 2000, 4000])
      assert.ok(time.elapsed() <= RETRY_BUDGET_MS, `${time.elapsed()} ms`)
    })
  })

  it('a tool call in the middle tier goes on and starts a refresh; Refresh asks and keeps the answer', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'))
      const t0 = Date.parse('2026-10-27T00:00:00Z')
      await runNetworkHook(['claude', 'Refresh'], env, sink(), {
        fetcher: trace('US'),
        print: 'p',
        now: () => new Date(t0),
      })
      let started = 0
      const code = await runNetworkHook(['claude', 'PreToolUse'], env, sink(), {
        fetcher: async () => assert.fail('no request in this tier'),
        print: 'p',
        now: () => new Date(t0 + 90_000),
        background: () => started++,
      })
      assert.equal(code, 0)
      assert.equal(started, 1)
    })
  })

  it('ignores events it does not guard', async () => {
    await withFakeHome(async (h) => {
      const env = sessionEnv(h.path('net'))
      assert.equal(await runNetworkHook(['claude', 'Stop'], env, sink(), { fetcher: trace('HK') }), 0)
    })
  })
})

describe('network hook imports', () => {
  it('reaches only leaf modules: never the Runtime, a Family index or core/accounts.ts', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const seen = new Set<string>()
    const walk = async (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/^import (?!type )[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm))
        await walk(resolve(dirname(file), m[1]!))
    }
    await walk(join(root, 'network/hook.ts'))
    assert.ok(seen.has(join(root, 'core/egress.ts')), 'the walk follows imports')
    const allowed = new Set(['network/hook.ts', 'core/egress.ts', 'core/fs-safe.ts'])
    assert.deepEqual(
      [...seen].map((f) => relative(root, f)).filter((f) => !allowed.has(f)),
      [],
    )
  })
})
