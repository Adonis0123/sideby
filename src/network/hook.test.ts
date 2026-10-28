// `sideby network-hook` (spec §3.35): blocks with exit 2 and a reason, lets the Host go on with exit 0, and imports
// only leaf modules. Requests go through a fake fetcher.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withFakeHome } from '../../testing/index.ts'
import { NETWORK_ENV } from '../core/egress.ts'
import { runNetworkHook } from './hook.ts'

const trace = (loc: string) => async () => `ip=203.0.113.7\nloc=${loc}\n`
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
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

  it('blocks when it cannot tell', async () => {
    await withFakeHome(async (h) => {
      const err = sink()
      const fetcher = async () => {
        throw new Error('timeout')
      }
      const env = { ...sessionEnv(h.path('net')), LANG: 'en_US.UTF-8' }
      assert.equal(await runNetworkHook(['claude', 'UserPromptSubmit'], env, err, { fetcher, print: 'p' }), 2)
      assert.match(err.lines.join(''), /could not tell/)
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
