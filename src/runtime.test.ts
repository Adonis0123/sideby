// The Runtime is the one seam the CLI and the Panel cross: Doctor history and quota setup rules live here.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../testing/demo.ts'
import { withFakeHome } from '../testing/index.ts'
import { UserError } from './core/errors.ts'
import { packageVersion } from './core/version.ts'
import { createRuntime, UnknownFamilyError } from './runtime.ts'
import type { QuotaSetup } from './types.ts'

const fixedNow = () => new Date('2026-10-05T08:00:00Z')

function setupFamily(setup: QuotaSetup) {
  return demoPlugin(demoFamily({ quotaSetup: setup }))
}

describe('Runtime doctor history', () => {
  it('records per Account, replaces only what a run covered, and honours persist: false', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())], now: fixedNow })
      await rt.createAccount('demo', 'work')
      await rt.createAccount('demo', 'side')
      assert.equal(await rt.doctorHistory(), undefined)
      await rt.doctor({ persist: false })
      assert.equal(await rt.doctorHistory(), undefined)

      await rt.doctor()
      const all = await rt.doctorHistory()
      assert.deepEqual(Object.keys(all!.accounts).sort(), ['demo:main', 'demo:side', 'demo:work'])
      assert.equal(all!.accounts['demo:work']!.at, '2026-10-05T08:00:00.000Z')

      // Break one account, then check only that one: the others keep their earlier (healthy) result.
      const { rm: remove } = await import('node:fs/promises')
      await remove(h.path('.demo-work/rules.md'))
      await h.write('.demo-work/rules.md', 'own rules')
      const later = () => new Date('2026-10-05T09:00:00Z')
      const rt2 = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())], now: later })
      await rt2.doctor({ target: 'demo:work' })
      const one = await rt2.doctorHistory()
      assert.equal(one!.accounts['demo:work']!.at, '2026-10-05T09:00:00.000Z')
      assert.ok(one!.accounts['demo:work']!.findings.some((f) => f.code === 'link.real-file'))
      assert.equal(one!.accounts['demo:side']!.at, '2026-10-05T08:00:00.000Z')

      // A whole-family run drops Accounts that no longer exist.
      const { rm } = await import('node:fs/promises')
      await rm(h.path('.demo-side'), { recursive: true })
      await rt2.doctor({ target: 'demo' })
      assert.deepEqual(Object.keys((await rt2.doctorHistory())!.accounts).sort(), ['demo:main', 'demo:work'])
    })
  })

  it('treats an older record format as no history', async () => {
    await withFakeHome(async (h) => {
      await h.write('.local/state/sideby/last-doctor.json', JSON.stringify({ at: 'x', findings: [] }))
      const rt = await createRuntime({ env: h.env, builtins: [] })
      assert.equal(await rt.doctorHistory(), undefined)
    })
  })
})

describe('Runtime quota setup', () => {
  const ok: QuotaSetup = {
    summary: 'demo setup',
    plan: async () => ({ status: 'ready', file: 'f', diff: 'd', message: 'm' }),
    apply: async () => ({ status: 'enabled', file: 'f', diff: '', message: 'on' }),
    teardown: async () => ({ ok: true, message: 'off' }),
  }

  it('binds one family setup and rejects unknown families or families without one', async () => {
    await withFakeHome(async (h) => {
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(setupFamily(ok))] })
      const s = rt.quotaSetup('demo')
      assert.equal(s.summary, 'demo setup')
      assert.equal((await s.apply()).status, 'enabled')
      assert.throws(
        () => rt.quotaSetup('nope'),
        (e: unknown) => e instanceof UnknownFamilyError && e instanceof UserError,
      )
      const plain = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      assert.throws(
        () => plain.quotaSetup('demo'),
        (e: unknown) => e instanceof UserError && /needs no quota setup/.test(String(e)),
      )
    })
  })

  it('lists every setup and shows a plan that throws as blocked', async () => {
    await withFakeHome(async (h) => {
      const broken: QuotaSetup = {
        ...ok,
        plan: async () => {
          throw new Error('settings unreadable')
        },
      }
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(setupFamily(broken))] })
      const [only] = await rt.quotaSetups()
      assert.equal(only?.family, 'demo')
      assert.equal(only?.plan.status, 'blocked')
      assert.match(only?.plan.message ?? '', /settings unreadable/)
    })
  })
})

describe('package version', () => {
  it('reads the version from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    assert.equal(packageVersion(), pkg.version)
  })
})

describe('Runtime quota setup failures (hardening round 2)', () => {
  it('turns a plan or apply that throws, even synchronously, into blocked, and a failing teardown into ok:false', async () => {
    await withFakeHome(async (h) => {
      const sync: QuotaSetup = {
        summary: 's',
        plan: () => {
          throw new Error('sync boom')
        },
        apply: async () => {
          throw new Error('apply boom')
        },
        teardown: async () => {
          throw new Error('teardown boom')
        },
      }
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(setupFamily(sync))] })
      const s = rt.quotaSetup('demo')
      assert.deepEqual(await s.plan(), { status: 'blocked', file: '', diff: '', message: 'sync boom' })
      assert.equal((await s.apply()).message, 'apply boom')
      assert.deepEqual(await s.teardown(), { ok: false, message: 'teardown boom' })
      assert.equal((await rt.quotaSetups())[0]?.plan.message, 'sync boom')
    })
  })
})

describe('quota levels', () => {
  it('CLI and Panel use the same thresholds', async () => {
    const { quotaLevel, QUOTA_FAIL_PERCENT, QUOTA_WARN_PERCENT } = await import('./core/quota-levels.ts')
    const { renderPage } = await import('./panel/page.ts')
    assert.equal(quotaLevel(87), 'fail')
    assert.equal(quotaLevel(QUOTA_WARN_PERCENT), 'warn')
    assert.equal(quotaLevel(QUOTA_WARN_PERCENT - 1), 'ok')
    const html = renderPage({ basePath: '', token: 't' })
    assert.ok(html.includes(`pct >= ${QUOTA_FAIL_PERCENT} ? 'fail' : pct >= ${QUOTA_WARN_PERCENT} ? 'warn'`))
    // The page text comes from USAGE_DAYS; the source must not hard-code a day count.
    const { readFile: read } = await import('node:fs/promises')
    const source = await read(new URL('./panel/page.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /last 7 days|\b7 days\b|pct >= \d/)
  })
})
