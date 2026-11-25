import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { runMain } from '../cli/cli-test-helpers.ts'
import { createRuntime } from '../runtime.ts'
import { appDataDir } from './desktop-app.ts'
import { lstatOrNull } from './fs-safe.ts'
import { quotaStoreFile } from './quota-store.ts'
import { RemoveError } from './remove.ts'

describe('account removal (ADR-0087)', () => {
  it('refuses to remove a Main Account and leaves disk untouched', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const rt = await createRuntime({ env: h.env })
      const plan = await rt.removeAccountPlan('claude:main')
      assert.equal(plan.blocked?.code, 'main-account')
      await assert.rejects(
        () => rt.removeAccount('claude:main'),
        (e: unknown) => e instanceof RemoveError && e.code === 'main-account',
      )
      assert.ok(await lstatOrNull(h.path('.claude/settings.json')))
    })
  })

  it('refuses when the account has a live session', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-work/settings.json', '{}')
      const rt = await createRuntime({
        env: h.env,
        picks: { liveSessions: async () => new Map([['claude:work', 1]]) },
      })
      const plan = await rt.removeAccountPlan('claude:work')
      assert.equal(plan.blocked?.code, 'live-sessions')
      await assert.rejects(
        () => rt.removeAccount('claude:work'),
        (e: unknown) => e instanceof RemoveError && e.code === 'live-sessions',
      )
      assert.ok(await lstatOrNull(h.path('.claude-work')))
    })
  })

  it('moves non-main account and app data to trash, keeps main symlink targets, and cleans config', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"main":true}')
      await h.write('.claude/CLAUDE.md', '# main rules\n')
      await mkdir(h.path('.claude-work'), { recursive: true })
      await symlink(h.path('.claude/CLAUDE.md'), h.path('.claude-work/CLAUDE.md'))
      await h.write('.claude-work/local.txt', 'work-only')
      const appData = appDataDir(h.home, { family: 'claude', name: 'work' })
      await mkdir(appData, { recursive: true })
      await writeFile(join(appData, 'Preferences'), '{}')

      const shellFile = h.path('.sideby-init.zsh')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({
          aliases: { ccwork: 'claude:work', ccmain: 'claude:main' },
          shellInitFile: { zsh: shellFile },
          display: {
            accounts: { claude: ['main', 'work'] },
            pinned: { claude: ['work'] },
            hidden: { claude: ['work'] },
          },
          handoff: { families: { claude: { policy: 'order', order: ['claude:main', 'claude:work'] } } },
          accounts: { 'claude:work': { args: ['--model', 'sonnet'] } },
        }),
      )

      const rt = await createRuntime({ env: h.env, picks: { liveSessions: async () => new Map() } })
      const qFile = quotaStoreFile(rt.paths.stateDir, 'claude', 'work')
      await mkdir(join(rt.paths.stateDir, 'quota', 'claude'), { recursive: true })
      await writeFile(qFile, '{}')

      const plan = await rt.removeAccountPlan('claude:work')
      assert.equal(plan.blocked, undefined)
      assert.deepEqual(plan.aliases, ['ccwork'])
      assert.equal(plan.appData, appData)
      assert.ok(plan.configCleanup.includes('display'))
      assert.ok(plan.configCleanup.includes('handoff'))

      const res = await rt.removeAccount('claude:work')
      assert.equal(await lstatOrNull(h.path('.claude-work')), null)
      assert.equal(await lstatOrNull(appData), null)
      assert.ok(await lstatOrNull(res.trashedTo))
      assert.ok(res.appDataTrashedTo && (await lstatOrNull(res.appDataTrashedTo)))
      assert.equal(await readFile(h.path('.claude/CLAUDE.md'), 'utf8'), '# main rules\n')
      assert.equal(await lstatOrNull(qFile), null)
      assert.deepEqual(res.removedAliases, ['ccwork'])

      const cfg = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(cfg.aliases, { ccmain: 'claude:main' })
      assert.deepEqual(cfg.display?.accounts?.claude, ['main'])
      assert.equal(cfg.display?.pinned, undefined)
      assert.equal(cfg.display?.hidden, undefined)
      assert.deepEqual(cfg.handoff?.families?.claude?.order, ['claude:main'])
      assert.equal(cfg.accounts?.['claude:work'], undefined)
      assert.ok(!(await readFile(shellFile, 'utf8')).includes('ccwork'))
    })
  })

  it('CLI remove exits 10 without --yes and moves to trash with --yes --json', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-old/settings.json', '{}')

      const preview = await runMain(['remove', 'claude:old', '--json'], { env: h.env })
      assert.equal(preview.code, 10)
      const planJson = JSON.parse(preview.out)
      assert.equal(planJson.schemaVersion, 1)
      assert.equal(planJson.removed, false)
      assert.ok(await lstatOrNull(h.path('.claude-old')))

      const done = await runMain(['rm', 'claude:old', '--yes', '--json'], { env: h.env })
      assert.equal(done.code, 0)
      const doneJson = JSON.parse(done.out)
      assert.equal(doneJson.schemaVersion, 1)
      assert.equal(doneJson.removed, true)
      assert.equal(await lstatOrNull(h.path('.claude-old')), null)
    })
  })
})
