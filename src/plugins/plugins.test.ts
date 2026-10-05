import assert from 'node:assert/strict'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { UserError } from '../core/errors.ts'
import { createRuntime } from '../runtime.ts'
import { accountScript, SCRIPT_NAME } from './account-script.ts'
import { HookBus } from './bus.ts'

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
