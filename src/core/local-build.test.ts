// Switching between a Local Build and the npm package (ADR-0024). npm and the registry are replaced through
// bindUpdateDeps; nothing here installs anything or reaches the network.
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { globalPkg, type LocalDirs, linkGlobal, localStatus, pkgDir, switchLocal } from './local-build.ts'
import { resolvePaths } from './paths.ts'
import { bindUpdateDeps } from './update.ts'

const dirsOf = (h: FakeHome): LocalDirs => ({
  dev: h.path('.local/share/sideby-dev'),
  prefix: h.path('.npm-global'),
})

async function pkgAt(dir: string, version: string, build: object = { id: 'b1' }): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sideby', version }))
  await writeFile(join(dir, 'dist', 'build.json'), JSON.stringify(build))
}
const localBuild = {
  id: 'l1',
  local: true,
  commit: 'abc1234',
  dirty: true,
  builtAt: '2026-10-17T12:00:00.000Z',
}
const versionAt = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version: string }).version

let unbind: (() => void) | null = null
afterEach(() => {
  unbind?.()
  unbind = null
})
function machine(latest: string, installCode = 0) {
  const ran: string[] = []
  unbind = bindUpdateDeps({
    fetch: async () => new Response(JSON.stringify({ latest }), { status: 200 }),
    exec: async (file, args) => {
      ran.push([file, ...args].join(' '))
      return { code: installCode, output: '' }
    },
    restartPanel: async () => true,
    startDetached: async (file, args) => {
      ran.push(`detached: ${[file, ...args].join(' ')}`)
      return true
    },
  })
  return ran
}

describe('Local Build switch', () => {
  it('tells which side the global sideby runs and what is kept', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      await pkgAt(globalPkg(d), '0.15.0')
      assert.deepEqual(await localStatus(d), { running: 'npm', local: null, kept: null })
      await pkgAt(pkgDir(d), '0.15.0', localBuild)
      await linkGlobal(d)
      const s = await localStatus(d)
      assert.equal(s.running, 'local')
      assert.equal(s.kept, '0.15.0')
      assert.deepEqual(s.local, {
        commit: 'abc1234',
        dirty: true,
        builtAt: localBuild.builtAt,
        version: '0.15.0',
      })
    })
  })

  it('switches to the newest Local Build and back to the kept npm package when it is the latest', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      const ran = machine('0.15.0')
      await pkgAt(globalPkg(d), '0.15.0')
      await pkgAt(pkgDir(d), '0.15.0', localBuild)
      const paths = resolvePaths(h.env)
      const on = await switchLocal(paths, d, 'local', h.env, { panelPort: async () => 17420 })
      assert.equal(on.ok, true)
      assert.equal(on.running, 'local')
      assert.equal(on.restartedPanel, true)
      assert.equal(await readlink(globalPkg(d)), pkgDir(d))
      const off = await switchLocal(paths, d, 'npm', h.env)
      assert.equal(off.ok, true)
      assert.equal(off.running, 'npm')
      assert.ok((await lstat(globalPkg(d))).isDirectory())
      assert.equal(await versionAt(globalPkg(d)), '0.15.0')
      assert.deepEqual(
        ran,
        ['sideby update --yes'],
        'restoring installs nothing; the npm code brings the skill along',
      )
    })
  })

  it('points an existing login item at the sideby switched to, and never creates one (spec §3.29)', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      machine('0.15.0')
      await pkgAt(globalPkg(d), '0.15.0')
      await pkgAt(pkgDir(d), '0.15.0', localBuild)
      for (const dir of [globalPkg(d), pkgDir(d)]) {
        await mkdir(join(dir, 'dist', 'src', 'cli'), { recursive: true })
        await writeFile(join(dir, 'dist', 'src', 'cli', 'main.js'), '')
      }
      const paths = resolvePaths(h.env)
      const plist = h.path('Library/LaunchAgents/dev.sideby.panel.plist')
      const calls: string[][] = []
      const ctx = {
        platform: 'darwin' as const,
        uid: 501,
        loginHome: h.home,
        exec: async (file: string, args: readonly string[]) => {
          calls.push([file, ...args])
          return { code: 0, output: '' }
        },
      }
      // No login item: none is created, and the result says nothing about one.
      const none = await switchLocal(paths, d, 'local', h.env, { autostart: ctx })
      assert.equal(none.refreshedAutostart, undefined)
      assert.equal(await readFile(plist).catch(() => null), null)
      // One that starts another sideby is rewritten to start the one now in use.
      const { applyAutostart, planAutostart, parseProgramArguments } = await import('./autostart.ts')
      const old = { ...ctx, home: h.home, launcher: { node: '/bin/sh', entry: '/bin/ls' } }
      await applyAutostart(old, await planAutostart(old, 'on'))
      const launcher = { node: '/bin/sh', entry: '/usr/bin/env' }
      const back = await switchLocal(paths, d, 'npm', h.env, { autostart: { ...ctx, launcher } })
      assert.equal(back.refreshedAutostart, true)
      assert.deepEqual(parseProgramArguments(await readFile(plist, 'utf8'))?.slice(0, 2), [
        '/bin/sh',
        '/usr/bin/env',
      ])
      // The real entry here sits in a temporary folder, which a login item may not start: it is left as it was.
      const kept = await switchLocal(paths, d, 'local', h.env, { autostart: ctx })
      assert.equal(kept.refreshedAutostart, false)
      assert.deepEqual(parseProgramArguments(await readFile(plist, 'utf8'))?.slice(0, 2), [
        '/bin/sh',
        '/usr/bin/env',
      ])
    })
  })

  it('starts the skill on its own for the Panel, so the answer does not wait for the network', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      const ran = machine('0.15.0')
      await pkgAt(globalPkg(d), '0.15.0')
      await pkgAt(pkgDir(d), '0.15.0', localBuild)
      await linkGlobal(d)
      const r = await switchLocal(resolvePaths(h.env), d, 'npm', h.env, { skillSync: 'background' })
      assert.deepEqual([r.ok, r.skillSyncStarted, r.skillSynced], [true, true, undefined])
      assert.deepEqual(ran, ['detached: sideby update --yes'])
    })
  })

  it('installs the latest npm package when the kept one is older', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      const ran = machine('0.16.0')
      await pkgAt(globalPkg(d), '0.15.0')
      await pkgAt(pkgDir(d), '0.16.0', localBuild)
      await linkGlobal(d)
      const r = await switchLocal(resolvePaths(h.env), d, 'npm', h.env)
      assert.equal(r.ok, true)
      assert.deepEqual(ran, ['npm install -g sideby@0.16.0', 'sideby update --yes'])
    })
  })

  it('links the Local Build back when the install fails, so sideby never goes missing', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      machine('0.16.0', 1)
      await pkgAt(globalPkg(d), '0.15.0')
      await pkgAt(pkgDir(d), '0.16.0', localBuild)
      await linkGlobal(d)
      const r = await switchLocal(resolvePaths(h.env), d, 'npm', h.env)
      assert.equal(r.ok, false)
      assert.match(r.message, /npm install -g sideby@0\.16\.0/)
      assert.equal(await readlink(globalPkg(d)), pkgDir(d))
      assert.equal((await localStatus(d)).kept, '0.15.0')
    })
  })

  it('refuses the Local Build when there is none, and changes nothing when already there', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      machine('0.15.0')
      await pkgAt(globalPkg(d), '0.15.0')
      const paths = resolvePaths(h.env)
      const none = await switchLocal(paths, d, 'local', h.env)
      assert.equal(none.ok, false)
      assert.match(none.message, /pnpm local/)
      const same = await switchLocal(paths, d, 'npm', h.env)
      assert.equal(same.ok, true)
      assert.equal(same.unchanged, true)
    })
  })
})
