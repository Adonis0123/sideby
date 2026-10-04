import assert from 'node:assert/strict'
import { lstat, readFile, rm, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { createRuntime, type Runtime } from '../../runtime.ts'
import type { Finding } from '../../types.ts'
import { grokPlugin } from './index.ts'

const builtins = [{ plugin: grokPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

async function seedMain(h: FakeHome) {
  await h.mkdir('.grok/skills/one')
  await h.mkdir('.grok/installed-plugins')
  await h.write('.grok/hooks/pre.sh', '#!/bin/sh\necho hi\n', 0o755)
  await h.write('.grok/hooks-paths', '[]\n')
  await h.write('.grok/trusted_folders.toml', 'folders = []\n')
  await h.write('.grok/config.toml', 'model = "grok-main"\n')
  await h.write('.grok/auth.json', '{}', 0o600)
}

async function findings(rt: Runtime, ref: string): Promise<Finding[]> {
  const report = await rt.doctor({ target: ref })
  return report.accounts.find((a) => a.ref === ref)!.findings
}

const at = (list: Finding[], item: string) => list.filter((f) => f.item === item)

describe('grok family', () => {
  it('creates an account that passes doctor, with copies where Grok forbids links', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const res = await rt.createAccount('grok', 'work')
      assert.equal(res.ok, true)
      assert.equal((await lstat(h.path('.grok-work/skills'))).isSymbolicLink(), true)
      for (const p of ['hooks', 'hooks-paths', 'trusted_folders.toml', 'config.toml'])
        assert.equal((await lstat(h.path('.grok-work', p))).isSymbolicLink(), false, p)
      assert.deepEqual(await findings(rt, 'grok:work'), [])
    })
  })

  it('replaces a hooks symlink with a real copy without touching the main account', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      await rt.createAccount('grok', 'work')
      const hooks = h.path('.grok-work/hooks')
      await rm(hooks, { recursive: true })
      await symlink(h.path('.grok/hooks'), hooks)

      const before = await findings(rt, 'grok:work')
      const f = at(before, 'hooks')
      assert.equal(f.length, 1)
      assert.equal(f[0]!.level, 'fail')
      assert.equal(f[0]!.fixable, true)
      assert.match(f[0]!.message, /Grok hooks directory has wrong type/)

      const mainBefore = await snapshot(h.path('.grok'))
      const report = await rt.doctor({ fix: true })
      assert.deepEqual(diffSnapshots(mainBefore, await snapshot(h.path('.grok'))), [])
      assert.ok(report.fixes.some((x) => x.item === 'hooks' && x.ok))
      const st = await lstat(hooks)
      assert.equal(st.isDirectory() && !st.isSymbolicLink(), true)
      assert.equal(await readFile(h.path('.grok-work/hooks/pre.sh'), 'utf8'), '#!/bin/sh\necho hi\n')
      assert.equal((await lstat(h.path('.grok-work/hooks/pre.sh'))).mode & 0o777, 0o755)
      assert.deepEqual(await findings(rt, 'grok:work'), [])
    })
  })

  it('repairs a subscription config.toml link but only reports an API account one', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      await rt.createAccount('grok', 'work')
      await rt.createAccount('grok', 'api1', { api: true })
      for (const name of ['work', 'api1']) {
        const p = h.path(`.grok-${name}/config.toml`)
        await rm(p)
        await symlink(h.path('.grok/config.toml'), p)
      }
      const sub = at(await findings(rt, 'grok:work'), 'config.toml')
      assert.equal(sub[0]?.level, 'fail')
      assert.equal(sub[0]?.fixable, true)
      const api = at(await findings(rt, 'grok:api1'), 'config.toml')
      assert.equal(api[0]?.level, 'fail')
      assert.equal(api[0]?.fixable, false)

      const mainBefore = await snapshot(h.path('.grok'))
      await rt.doctor({ fix: true })
      assert.deepEqual(diffSnapshots(mainBefore, await snapshot(h.path('.grok'))), [])
      assert.equal((await lstat(h.path('.grok-work/config.toml'))).isFile(), true)
      assert.equal(await readFile(h.path('.grok-work/config.toml'), 'utf8'), 'model = "grok-main"\n')
      assert.equal((await lstat(h.path('.grok-api1/config.toml'))).isSymbolicLink(), true)
    })
  })

  it('fails on an auth.json symlink and never repairs it', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      await rt.createAccount('grok', 'work')
      await symlink(h.path('.grok/auth.json'), h.path('.grok-work/auth.json'))
      const f = at(await findings(rt, 'grok:work'), 'auth.json')
      assert.equal(f[0]?.level, 'fail')
      assert.equal(f[0]?.fixable, false)
      assert.match(f[0]!.message, /policy lock file/)
      await rt.doctor({ fix: true })
      assert.equal((await lstat(h.path('.grok-work/auth.json'))).isSymbolicLink(), true)
      const status = await rt.status(await rt.resolve('grok:work'))
      assert.equal(status.login, 'unknown')
    })
  })

  it('reports login state, model and launch environment', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({
        env: { ...h.env, XAI_API_KEY: 'k', GROK_MODELS_BASE_URL: 'u' },
        builtins,
      })
      await rt.createAccount('grok', 'work')
      const main = await rt.status(await rt.resolve('grok:main'))
      assert.equal(main.login, 'logged-in')
      assert.equal(main.model, 'grok-main')
      assert.equal((await rt.status(await rt.resolve('grok:work'))).login, 'logged-out')

      const launch = await rt.prepareLaunch('grok:work', ['-p', 'hi'], 'run')
      assert.deepEqual(launch.args, ['-p', 'hi'])
      assert.equal(launch.env.GROK_HOME, h.path('.grok-work'))
      assert.equal(launch.env.XAI_API_KEY, undefined)
      assert.equal(launch.env.GROK_MODELS_BASE_URL, undefined)
      const q = await rt.quota(await rt.resolve('grok:work'))
      assert.equal(q.status === 'unavailable' && q.reason, 'no-source')
    })
  })
})
