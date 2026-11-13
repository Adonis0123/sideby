import assert from 'node:assert/strict'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { parseArgs } from '../cli/args.ts'
import { cmdQuotaReset } from '../cli/commands.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import type { ExecResult } from '../core/desktop-app.ts'
import { UserError } from '../core/errors.ts'
import { listLimitResetRecords } from '../core/limit-reset.ts'
import { createRuntime } from '../runtime.ts'
import { accountScript, SCRIPT_NAME } from './account-script.ts'
import { HookBus } from './bus.ts'
import { limitResetProblem, logoProblem } from './loader.ts'

async function runtime(h: FakeHome, extra: Parameters<typeof asBuiltin>[0][] = []) {
  return createRuntime({
    env: h.env,
    builtins: [asBuiltin(demoPlugin()), asBuiltin(accountScript, false), ...extra.map((p) => asBuiltin(p))],
  })
}

describe('loader', () => {
  it('rejects duplicate families and names, relative pluginDirs, and mismatched manifests', async () => {
    await withFakeHome(async (h) => {
      const dup = {
        name: 'dup',
        register: (api: { family: (d: unknown) => void }) => api.family(demoFamily()),
      }
      const rt = await runtime(h, [dup as never])
      assert.match(
        rt.pluginErrors.map((e) => e.message).join('\n'),
        /family demo is already provided by demo-family/,
      )

      const dir = h.path('plugins', 'named')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'named', version: '1.0.0' }))
      await writeFile(join(dir, 'index.ts'), `export default { name: 'other', register() {} }\n`)
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ pluginDirs: ['relative/dir', '~/plugins/named'] }),
      )
      const rt2 = await runtime(h)
      const msgs = rt2.pluginErrors.map((e) => e.message).join('\n')
      assert.match(msgs, /must be absolute or start with ~\//)
      assert.match(msgs, /does not match the exported name other/)
    })
  })

  it('keeps built-ins off unless enabled, and lets the config turn a plugin off', async () => {
    await withFakeHome(async (h) => {
      assert.equal(
        (await runtime(h)).plugins.some((p) => p.name === 'account-script'),
        false,
      )
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({
          plugins: { 'account-script': { enabled: true }, 'demo-family': { enabled: false } },
        }),
      )
      const rt = await runtime(h)
      assert.ok(rt.plugins.some((p) => p.name === 'account-script'))
      assert.equal(rt.families.has('demo'), false)
    })
  })
})

describe('bus', () => {
  it('times out slow hooks and labels errors with the plugin', async () => {
    const bus = new HookBus({ 'launch.before': 20 })
    bus.add('slow', 'launch.before', {}, () => new Promise((r) => setTimeout(r, 200)))
    await assert.rejects(bus.run('launch.before', 'x', {} as never), /\[slow\] launch.before timed out/)
    const iso = new HookBus()
    iso.add('bad', 'doctor.check', {}, () => {
      throw new Error('boom')
    })
    iso.add('good', 'doctor.check', {}, () => [])
    const res = await iso.runIsolated('doctor.check', 'x', {} as never)
    assert.equal(res[0]!.error!.message, '[bad] boom')
    assert.deepEqual(res[1]!.result, [])
  })
})

describe('account-script', () => {
  async function prepared(h: FakeHome, script: string, mode = 0o700) {
    await seedDemoMain(h.write)
    await h.write(
      '.config/sideby/config.json',
      JSON.stringify({ plugins: { 'account-script': { enabled: true } } }),
    )
    const rt = await runtime(h)
    await rt.createAccount('demo', 'work')
    const p = h.path('.demo-work', SCRIPT_NAME)
    await writeFile(p, script)
    await chmod(p, mode)
    return rt
  }

  it('runs the account script in the account directory with the launch environment', async () => {
    await withFakeHome(async (h) => {
      const rt = await prepared(h, '#!/bin/sh\nprintf "%s|%s" "$PWD" "$DEMO_HOME" > ran.txt\n')
      await rt.prepareLaunch('demo:work', [], 'run')
      const { readFile } = await import('node:fs/promises')
      const ran = await readFile(h.path('.demo-work', 'ran.txt'), 'utf8')
      assert.equal(ran, `${h.path('.demo-work')}|${h.path('.demo-work')}`)
    })
  })

  it('stops the launch with the tail of stderr when the script fails', async () => {
    await withFakeHome(async (h) => {
      const lines = Array.from({ length: 30 }, (_, i) => `echo line${i} >&2`).join('\n')
      const rt = await prepared(h, `#!/bin/sh\n${lines}\nexit 7\n`)
      await assert.rejects(rt.prepareLaunch('demo:work', [], 'run'), (e: Error) => {
        assert.match(e.message, /\[account-script\] sideby-before-launch exited with 7/)
        assert.match(e.message, /line29/)
        assert.doesNotMatch(e.message, /line5\n/)
        return true
      })
    })
  })

  it('keeps the tail of stderr while the event loop is saturated', async () => {
    // Guard against going back to a pipe plus a short drain timer, which dropped the tail on a loaded runner. Busy
    // chunks longer than such a timer run while the script writes and exits; in-process load alone does not
    // reliably reproduce the race, so the script also checks that its stderr is a regular file, the contract.
    await withFakeHome(async (h) => {
      const lines = Array.from({ length: 30 }, (_, i) => `echo line${i} >&2`).join('\n')
      const rt = await prepared(
        h,
        `#!/bin/sh\n[ -f /dev/fd/2 ] || { echo stderr-is-not-a-file >&2; exit 3; }\nsleep 0.1\n${lines}\nexit 7\n`,
      )
      const until = Date.now() + 700
      const hog = new Promise<void>((resolve) => {
        const step = () => {
          const end = Date.now() + 250
          while (Date.now() < end) {}
          if (Date.now() < until) setImmediate(step)
          else resolve()
        }
        setImmediate(step)
      })
      await assert.rejects(rt.prepareLaunch('demo:work', [], 'run'), (e: Error) => {
        assert.match(e.message, /exited with 7/)
        assert.match(e.message, /line29/)
        return true
      })
      await hog
    })
  })

  it('does not wait for a background process the script left holding stderr', async () => {
    await withFakeHome(async (h) => {
      const rt = await prepared(h, '#!/bin/sh\nsleep 3 &\necho started >&2\nexit 0\n')
      const t0 = Date.now()
      await rt.prepareLaunch('demo:work', [], 'run')
      assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
    })
  })

  it('refuses a script others can write or that is not executable', async () => {
    await withFakeHome(async (h) => {
      const rt = await prepared(h, '#!/bin/sh\nexit 0\n', 0o722)
      await assert.rejects(rt.prepareLaunch('demo:work', [], 'run'), /writable by group or others/)
    })
    await withFakeHome(async (h) => {
      const rt = await prepared(h, '#!/bin/sh\nexit 0\n', 0o600)
      await assert.rejects(rt.prepareLaunch('demo:work', [], 'run'), /not executable/)
    })
  })
})

describe('account.create.before', () => {
  // Allows one non-main subscription Account, like the Cursor plugin; API Accounts always pass.
  const oneSubscription = demoPlugin(demoFamily(), (api) => {
    api.on('account.create.before', { family: 'demo' }, (ctx) => {
      if (ctx.api) return
      const taken = ctx.accounts.filter((a) => !a.isMain && a.kind === 'subscription')
      if (taken.length)
        throw api.abort(`demo:${ctx.name} would share a login with ${taken[0]!.ref}; use --api`)
    })
  })

  it('a refusing hook stops creation before anything is written', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(oneSubscription)] })
      assert.equal((await rt.createAccount('demo', 'first')).ok, true)
      const before = await snapshot(h.home)
      await assert.rejects(rt.createAccount('demo', 'second'), (e: Error & { code?: string }) => {
        assert.ok(e instanceof UserError)
        assert.equal(e.code, 'create-refused')
        assert.equal(e.message, '[demo-family] demo:second would share a login with demo:first; use --api')
        return true
      })
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const api = await rt.createAccount('demo', 'second', { api: true })
      assert.equal(api.ok, true)
      assert.equal(api.account.kind, 'api')
    })
  })

  it('sees the name, the API flag, the Family accounts and its own settings', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const seen: unknown[] = []
      const spy = demoPlugin(demoFamily(), (api) => {
        api.on('account.create.before', (ctx) => {
          seen.push({
            family: ctx.family.id,
            name: ctx.name,
            api: ctx.api,
            refs: ctx.accounts.map((a) => a.ref),
            config: ctx.config,
          })
        })
      })
      await h.write('.config/sideby/config.json', JSON.stringify({ plugins: { 'demo-family': { v: 1 } } }))
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(spy)] })
      await rt.createAccount('demo', 'work', { api: true })
      assert.deepEqual(seen, [
        { family: 'demo', name: 'work', api: true, refs: ['demo:main'], config: { v: 1 } },
      ])
    })
  })

  it('times out a hook that hangs on a bare Promise even when nothing else keeps the process alive', async () => {
    const { execFileSync } = await import('node:child_process')
    const bus = new URL('./bus.ts', import.meta.url).href
    const script = [
      `const { HookBus } = await import(${JSON.stringify(bus)})`,
      "const b = new HookBus({ 'account.create.before': 50 })",
      "b.add('stuck', 'account.create.before', {}, () => new Promise(() => {}))",
      "try { await b.run('account.create.before', 'demo', {}); console.log('no error') } catch (e) { console.log(String(e.message)) }",
    ].join('\n')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    assert.match(out, /timed out/)
  })

  it('a hook that crashes or hangs also stops creation and names the plugin', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const crash = demoPlugin(demoFamily(), (api) => {
        api.on('account.create.before', () => {
          throw new Error('boom')
        })
      })
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(crash)] })
      await assert.rejects(rt.createAccount('demo', 'work'), /\[demo-family\] boom; nothing was created/)
      await assert.rejects(stat(h.path('.demo-work')), { code: 'ENOENT' })

      const bus = new HookBus({ 'account.create.before': 20 })
      bus.add('slow', 'account.create.before', {}, () => new Promise(() => {}))
      await assert.rejects(
        bus.run('account.create.before', 'demo', {
          family: demoFamily(),
          name: 'x',
          api: false,
          accounts: [],
          config: {},
        }),
        /\[slow\] account.create.before timed out/,
      )
    })
  })
})

describe('logoProblem', () => {
  const path = 'M0 0h24v24H0z'
  it('accepts colour washes made of numbers and hex colours, and the built-in marks', async () => {
    const { BUILTIN_LOGOS } = await import('../families/logos.ts')
    assert.equal(
      logoProblem({ path, color: '#3186FF', gradients: [{ from: [4, 8], to: [10, 15], color: '#00B95C' }] }),
      null,
    )
    for (const logo of Object.values(BUILTIN_LOGOS)) assert.equal(logoProblem(logo), null)
  })

  it('keeps the washes of a mark when the Family registers, and nothing else a plugin put on them', async () => {
    await withFakeHome(async (h) => {
      const fam = demoFamily()
      const wash = { from: [4, 8], to: [10, 15], color: '#00B95C', extra: 'x' }
      const rt = await runtime(h, [
        {
          name: 'washed',
          register: (api) => api.family({ ...fam, id: 'washed', logo: { path, gradients: [wash] } as never }),
        },
      ])
      assert.deepEqual(rt.families.get('washed')?.logo, {
        path,
        gradients: [{ from: [4, 8], to: [10, 15], color: '#00B95C' }],
      })
    })
  })
  it('rejects a wash that could carry anything but numbers and a hex colour, or too many washes', () => {
    const wash = { from: [0, 0], to: [24, 24], color: '#fff' }
    for (const gradients of [
      'red',
      [{ ...wash, color: 'url(#x)' }],
      [{ ...wash, from: ['0', 0] }],
      [{ ...wash, to: [0] }],
      [{ ...wash, from: [0, Number.NaN] }],
      [{ ...wash, from: [0, 1e9] }],
      Array(5).fill(wash),
    ])
      assert.match(logoProblem({ path, gradients }) ?? '', /logo\.gradients/)
  })
})

describe('limitReset (ADR-0072)', () => {
  const only = (h: FakeHome, fam: ReturnType<typeof demoFamily>) =>
    createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(fam))] })
  it('accepts a use function, an https vendor page or both, and nothing else', () => {
    const use = async () => 'reset' as const
    assert.equal(limitResetProblem({ use }), null)
    assert.equal(limitResetProblem({ vendorPage: 'https://example.com/settings/usage' }), null)
    assert.equal(limitResetProblem({ use, vendorPage: 'https://example.com/usage' }), null)
    assert.match(limitResetProblem({}) ?? '', /needs use, vendorPage or both/)
    assert.match(limitResetProblem('https://example.com') ?? '', /must be an object/)
    assert.match(limitResetProblem({ use: 'sideby quota reset' }) ?? '', /use must be a function/)
    for (const vendorPage of [
      'http://example.com/usage',
      'https://example.com/usage?next=1',
      'https://example.com/usage" & calc',
      'file:///etc/passwd',
      7,
    ])
      assert.match(
        limitResetProblem({ vendorPage }) ?? '',
        /vendorPage must be an https address/,
        String(vendorPage),
      )
  })

  it('drops an unusable limitReset with a plugin error and keeps the Family; keeps only its known fields', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const bad = await only(h, demoFamily({ limitReset: { vendorPage: 'http://x.example' } }))
      assert.ok(bad.families.has('demo'))
      assert.equal(bad.families.get('demo')?.limitReset, undefined)
      assert.match(bad.pluginErrors.map((e) => e.message).join('\n'), /family demo: limitReset\.vendorPage/)
      assert.equal(bad.limitResetKind(await bad.resolve('demo:main')), null)
      const ok = await only(
        h,
        demoFamily({ limitReset: { vendorPage: 'https://demo.example.com/usage', extra: 'x' } as never }),
      )
      assert.deepEqual(ok.families.get('demo')?.limitReset, { vendorPage: 'https://demo.example.com/usage' })
      assert.deepEqual(ok.limitResetKind(await ok.resolve('demo:main')), {
        kind: 'page',
        url: 'https://demo.example.com/usage',
      })
    })
  })

  it('runs a plugin Family’s use only after a confirmed plan, with the key sideby kept, and reads `sent: false`', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const calls: string[] = []
      let stock = 1
      let answer: () => Promise<never> | Promise<string> = async () => 'reset'
      let who: string | undefined = 'me@example.com'
      const parts = {
        fetchQuota: {
          everyMinutes: 15,
          summary: 'Ask Demo for quota every 15 minutes',
          fetch: async () => ({
            status: 'ok' as const,
            windows: [{ label: '5h', windowMinutes: 300, usedPercent: 80, resetsAt: '2099-01-01T00:00:00Z' }],
            observedAt: new Date().toISOString(),
            source: 'demo',
            limitResets: { available: stock, observedAt: new Date().toISOString() },
          }),
        },
        limitReset: {
          use: async (_account: unknown, ctx: { idempotencyKey: string }) => {
            calls.push(ctx.idempotencyKey)
            return (await answer()) as never
          },
        },
      }
      // Without `identity` sideby cannot tell which login would be charged, so it never calls `use`.
      const blind = await only(h, demoFamily(parts))
      const noWho = await blind.limitResetPlan(await blind.resolve('demo:main'))
      assert.equal(noWho.canUse, false)
      assert.equal(noWho.operationId, undefined)
      assert.match(noWho.blocked ?? '', /Demo does not tell sideby which login an account is signed in as/)
      assert.deepEqual(await listLimitResetRecords(blind.paths.stateDir), [])
      const fam = demoFamily({ ...parts, identity: async () => (who ? { email: who } : undefined) })
      const rt = await only(h, fam)
      const main = await rt.resolve('demo:main')
      assert.deepEqual(rt.limitResetKind(main), { kind: 'use' })
      const plan = await rt.limitResetPlan(main)
      assert.equal(plan.canUse, true)
      assert.deepEqual(calls, [], 'a plan calls nothing')
      // The account signs in as someone else before the plan is confirmed: `use` is not called for that plan.
      who = 'other@example.com'
      await assert.rejects(rt.limitResetUse(main, plan.operationId!), (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'plan-outdated')
        return true
      })
      assert.deepEqual(calls, [])
      who = 'me@example.com'
      // The request never left: nothing was spent, and the operation ends.
      answer = async () => {
        throw Object.assign(new Error('demo is not installed'), { sent: false })
      }
      await assert.rejects(rt.limitResetUse(main, plan.operationId!), (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'not-sent')
        return true
      })
      // An answer sideby does not know is not an outcome: unresolved, and retried with the same key.
      const second = await rt.limitResetPlan(main)
      answer = async () => 'maybe'
      await assert.rejects(rt.limitResetUse(main, second.operationId!), (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'outcome-unknown')
        return true
      })
      answer = async () => 'reset'
      stock = 0
      const r = await rt.limitResetUse(main, second.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.resumed, true)
      assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 0)
      assert.equal(calls.length, 3)
      assert.equal(calls[1], calls[2], 'the retry carries the same key')
      assert.notEqual(calls[0], calls[1], 'a new plan is a new operation')
    })
  })

  it('`quota reset --open` for a Family with both a use and a vendor page opens the page, schema-valid, and uses nothing', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      let uses = 0
      const opened: string[][] = []
      const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
        opened.push([cmd, ...args])
        return { code: 0, stdout: '', stderr: '' }
      }
      const fam = demoFamily({
        identity: async () => ({ email: 'me@example.com' }),
        limitReset: {
          use: async () => {
            uses++
            return 'reset'
          },
          vendorPage: 'https://demo.example.com/usage',
        },
      })
      const rt = await createRuntime({
        env: h.env,
        builtins: [asBuiltin(demoPlugin(fam))],
        desktop: { platform: 'linux', exec },
      })
      assert.deepEqual(rt.limitResetKind(await rt.resolve('demo:main')), { kind: 'use' })
      const run = async (argv: string[]) => {
        const out: string[] = []
        const code = await cmdQuotaReset(
          parseArgs(['reset', ...argv], ['json', 'yes', 'refresh', 'open'], ['operation']),
          { out: (s) => out.push(s), err: () => {} },
          rt,
        )
        return { code, out: out.join('\n') }
      }
      const j = await run(['demo:main', '--open', '--json'])
      assert.equal(j.code, 0)
      const v = JSON.parse(j.out) as Record<string, unknown>
      assert.ok(
        Value.Check(OUTPUT_SCHEMAS['quota-reset']!, JSON.parse(j.out)),
        JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS['quota-reset']!, v)].slice(0, 3)),
      )
      assert.deepEqual(
        { account: v.account, outcome: v.outcome, url: v.url, opened: v.opened },
        {
          account: 'demo:main',
          outcome: 'open-vendor-page',
          url: 'https://demo.example.com/usage',
          opened: true,
        },
      )
      assert.match(String(v.message), /Opened https:\/\/demo\.example\.com\/usage in your browser/)
      assert.match(String(v.message), /Nothing was used from here/)
      assert.match(String(v.message), /sideby quota reset demo:main/)
      assert.deepEqual(opened, [['xdg-open', 'https://demo.example.com/usage']])
      const text = await run(['demo:main', '--open'])
      assert.equal(text.code, 0)
      assert.match(text.out, /Opened https:\/\/demo\.example\.com\/usage/)
      // Opening a page uses nothing and keeps no operation.
      assert.equal(uses, 0)
      assert.deepEqual(await listLimitResetRecords(rt.paths.stateDir), [])
    })
  })
})
