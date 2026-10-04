import assert from 'node:assert/strict'
import { lstat, readlink, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import { createRuntime } from '../../runtime.ts'
import { piPlugin } from './index.ts'

const builtins = [{ plugin: piPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

describe('pi family', () => {
  it('uses the extra agent/ level for discovery, creation, doctor and login state', async () => {
    await withFakeHome(async (h) => {
      await h.write('.pi/agent/AGENTS.md', '# shared rules\n')
      await h.write('.pi/agent/auth.json', '{"fake":true}', 0o600)
      await h.write(
        '.pi/agent/settings.json',
        JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'fake-model' }),
      )
      await h.mkdir('.pi-work/agent')
      await symlink(h.path('.pi/agent/AGENTS.md'), h.path('.pi-work/agent/AGENTS.md'))
      await h.write('.pi-work/agent/auth.json', '{}', 0o644)
      await h.mkdir('.pi-nodir')

      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(
        (await rt.accounts()).map((a) => `${a.ref}=${a.dir.slice(h.home.length)}`),
        ['pi:main=/.pi/agent', 'pi:work=/.pi-work/agent'],
      )
      const report = await rt.doctor()
      const work = report.accounts.find((a) => a.ref === 'pi:work')!
      assert.deepEqual(
        work.findings.map((f) => `${f.item}:${f.code}`),
        ['auth.json:credential.mode'],
      )
      assert.deepEqual(work.shared, { ok: 1, total: 1 })

      const res = await rt.createAccount('pi', 'work2')
      assert.equal(res.ok, true)
      const link = h.path('.pi-work2/agent/AGENTS.md')
      assert.ok((await lstat(link)).isSymbolicLink())
      assert.equal(await readlink(link), h.path('.pi/agent/AGENTS.md'))
      await assert.rejects(lstat(h.path('.pi-work2/agent/auth.json')))

      const [main, w] = await rt.accounts()
      const ms = await rt.status(main!)
      assert.equal(ms.login, 'logged-in')
      assert.equal(ms.model, 'anthropic/fake-model')
      assert.equal((await rt.status(w!)).login, 'logged-in')
      const fresh = await rt.status(await rt.resolve('pi:work2'))
      assert.equal(fresh.login, 'logged-out')

      const launch = await rt.prepareLaunch('pi:work2', [], 'login')
      assert.deepEqual(launch.args, [])
      assert.match(launch.notice ?? '', /\/login/)
      assert.equal(launch.env.PI_CODING_AGENT_DIR, h.path('.pi-work2/agent'))
      assert.equal((await rt.quota(main!)).status === 'unavailable', true)
      const usage = await rt.usage(main!)
      assert.equal(usage.status === 'unavailable' && usage.reason, 'no-source')
    })
  })
  it('keeps an Account with proxy.env a subscription Account but still loads its keys', async () => {
    await withFakeHome(async (h) => {
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.write('.pi/agent/auth.json', '{}', 0o600)
      await h.write('.pi/agent/proxy.env', 'GLM_API_KEY=fake-glm\n', 0o600)
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: piPlugin, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      const main = await rt.resolve('pi:main')
      assert.equal(main.kind, 'subscription')
      assert.equal((await rt.status(main)).login, 'logged-in')
      const launch = await rt.prepareLaunch('pi:main', [], 'run')
      assert.equal(launch.env.GLM_API_KEY, 'fake-glm')
    })
  })
})
