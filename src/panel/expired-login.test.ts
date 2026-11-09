// Expired Login (ADR-0071) in the Panel: the state field, the recommendation and the row's badge reason.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, handoffByFamily, type PanelAccount, type PanelState } from './handler.ts'
import { MESSAGES } from './i18n.ts'
import { attentionReasons, expiredLogins, rowBadge } from './page-logic.ts'

const EXPIRED_AT = '2026-11-08T10:00:00.000Z'

describe('Expired Login in the Panel', () => {
  it('/api/state carries loginProblem for the expired account only', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.demo-work/rules.md', 'rules\n')
      const def = demoFamily({
        loginState: async () => 'logged-in',
        readLoginEvents: async (a) => (a.name === 'main' ? { expiredAt: EXPIRED_AT } : {}),
      })
      const make = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(def))] })
      let handler: ReturnType<typeof createPanelHandler> | undefined
      const server: Server = createServer((req, res) => void handler!(req, res))
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as AddressInfo).port
      handler = createPanelHandler({ runtime: make, allowedHosts: [`127.0.0.1:${port}`] })
      try {
        const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as PanelState
        const main = state.accounts.find((a) => a.ref === 'demo:main')!
        assert.equal(main.loginProblem?.kind, 'expired')
        assert.equal(main.loginProblem?.since, EXPIRED_AT)
        assert.equal(state.accounts.find((a) => a.ref === 'demo:work')!.loginProblem, undefined)
      } finally {
        await new Promise<void>((r) => {
          server.close(() => r())
          server.closeAllConnections()
        })
      }
    })
  })

  it('never recommends an expired account', async () => {
    await withFakeHome(async (h) => {
      const def = demoFamily({ readQuota: async () => ({ status: 'unavailable', reason: 'no-session' }) })
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(def))] })
      const quota = (used: number) => ({
        status: 'ok' as const,
        observedAt: '2026-11-08T11:00:00.000Z',
        source: 'test',
        windows: [
          { label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: '2026-11-08T14:00:00.000Z' },
        ],
      })
      const row = (name: string, used: number, expired: boolean): PanelAccount => ({
        family: 'demo',
        name,
        ref: `demo:${name}`,
        dir: h.path(`.demo-${name}`),
        isMain: name === 'main',
        kind: 'subscription',
        familyTitle: 'Demo',
        hostInstalled: true,
        login: 'logged-in',
        quota: quota(used),
        ...(expired ? { loginProblem: { kind: 'expired' as const, since: EXPIRED_AT, message: 'x' } } : {}),
      })
      const now = new Date('2026-11-08T12:00:00Z')
      assert.deepEqual(handoffByFamily(rt, [row('main', 5, true), row('work', 40, false)], now), {
        demo: 'demo:work',
      })
      assert.deepEqual(handoffByFamily(rt, [row('main', 5, false), row('work', 40, false)], now), {
        demo: 'demo:main',
      })
    })
  })

  it('gives the row its own reason and a badge before every other, and lists it for the banner', () => {
    const a = { family: 'claude', name: 'work', ref: 'claude:work', kind: 'subscription', login: 'logged-in' }
    const expired = { ...a, loginProblem: { kind: 'expired', since: EXPIRED_AT } }
    assert.deepEqual(attentionReasons(a, null, Date.now(), 60), [])
    assert.deepEqual(attentionReasons(expired, null, Date.now(), 60), ['login-expired'])
    assert.equal(rowBadge(['login-expired'], { next: true }), 'login-expired')
    assert.equal(rowBadge(['health-fail', 'quota-high', 'login-expired'], {}), 'login-expired')
    assert.deepEqual(
      expiredLogins([a, expired, { ...expired, ref: 'claude:api', kind: 'api' }]).map((x) => x.ref),
      ['claude:work'],
    )
  })

  it('has every new word in both languages', () => {
    const keys = Object.keys(MESSAGES.en).filter((k) =>
      /^(acct\.expired|acct\.signInAgain|exp\.|need\.login-expired|why\.login-expired|ai\.ask\.expired)/.test(
        k,
      ),
    )
    assert.ok(keys.length >= 10)
    for (const k of keys) assert.ok((MESSAGES.zh as Record<string, string>)[k], k)
    assert.equal(MESSAGES.zh['acct.expired' as keyof typeof MESSAGES.zh], '登录已过期')
    assert.equal(MESSAGES.zh['acct.signInAgain' as keyof typeof MESSAGES.zh], '重新登录')
  })
})
