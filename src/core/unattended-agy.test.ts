// WHY: ADR-0089 write-path and safety-invariant tests for `~/.gemini/config/hooks.json` setup/teardown.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from '../core/paths.ts'
import { AGY_UNATTENDED_KEY, agyHooksFile, agyUnattendedSetup } from './unattended-agy.ts'

describe('agy unattended setup', () => {
  it('creates ~/.gemini/config/hooks.json (0600), preserves other keys, and tears down cleanly', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'sideby')
      const paths = resolvePaths(h.env)
      const setup = agyUnattendedSetup({ home: paths.home, stateDir: paths.stateDir, env: h.env })

      const before = await snapshot(h.home)
      const planned = await setup.plan()
      assert.equal(planned.status, 'ready')
      assert.match(planned.diff, /sideby-unattended/)
      assert.match(planned.diff, /ask_question/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])

      const applied = await setup.apply()
      assert.equal(applied.status, 'enabled')
      const file = agyHooksFile(paths.home)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      assert.ok(parsed[AGY_UNATTENDED_KEY])
      assert.equal((await setup.plan()).status, 'enabled')

      const removed = await setup.teardown()
      assert.equal(removed.ok, true)
      await assert.rejects(() => stat(file))
      assert.equal((await setup.teardown()).ok, true)
    })
  })

  it('preserves sibling hooks, indentation and mode on apply and teardown', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'sideby')
      const paths = resolvePaths(h.env)
      const file = agyHooksFile(paths.home)
      await mkdir(join(paths.home, '.gemini', 'config'), { recursive: true })
      const original =
        '{\n    "__proto__": {\n        "Stop": []\n    },\n    "other-hook": {\n        "Stop": []\n    }\n}\n'
      await writeFile(file, original, { mode: 0o644 })
      await chmod(file, 0o644)

      const setup = agyUnattendedSetup({ home: paths.home, stateDir: paths.stateDir, env: h.env })
      assert.equal((await setup.apply()).status, 'enabled')
      const afterApply = await readFile(file, 'utf8')
      assert.match(afterApply, /\n {4}"other-hook":/)
      assert.match(afterApply, /\n {4}"sideby-unattended":/)
      assert.equal((await stat(file)).mode & 0o777, 0o644)

      const torn = await setup.teardown()
      assert.equal(torn.ok, true)
      assert.equal(await readFile(file, 'utf8'), original)
      assert.equal((await stat(file)).mode & 0o777, 0o644)
    })
  })

  it('refuses symlinks, non-sideby entries, invalid JSON, and missing sideby on PATH', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'sideby')
      const paths = resolvePaths(h.env)
      const dir = join(paths.home, '.gemini', 'config')
      await mkdir(dir, { recursive: true })
      const file = agyHooksFile(paths.home)
      const setup = agyUnattendedSetup({ home: paths.home, stateDir: paths.stateDir, env: h.env })

      const target = h.path('real-hooks.json')
      await writeFile(target, '{}\n')
      await symlink(target, file)
      const linkPlan = await setup.plan()
      assert.equal(linkPlan.status, 'blocked')
      assert.match(linkPlan.message, /symbolic link/)
      assert.equal((await setup.teardown()).ok, false)

      await rm(file)
      await writeFile(file, '{"sideby-unattended":{"Stop":[]}}\n')
      assert.equal((await setup.plan()).status, 'blocked')
      assert.equal((await setup.teardown()).ok, false)

      await writeFile(file, '{not-json')
      assert.equal((await setup.plan()).status, 'blocked')

      await rm(file)
      const noBinEnv = { ...h.env, PATH: '/nonexistent' }
      const noBin = agyUnattendedSetup({ home: paths.home, stateDir: paths.stateDir, env: noBinEnv })
      assert.equal((await noBin.plan()).status, 'blocked')

      assert.equal((await setup.apply()).status, 'enabled')
      assert.equal((await noBin.plan()).status, 'blocked')
      assert.equal((await noBin.teardown()).ok, true)

      await rm(dir, { recursive: true, force: true })
      const outsideDir = h.path('outside-config')
      await mkdir(outsideDir, { recursive: true })
      await symlink(outsideDir, dir)
      const parentLinkPlan = await setup.plan()
      assert.equal(parentLinkPlan.status, 'blocked')
      assert.match(parentLinkPlan.message, /symbolic link/)
    })
  })
})
