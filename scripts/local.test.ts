import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../testing/index.ts'
import {
  copiedFiles,
  dirs,
  keptVersion,
  type LocalDirs,
  linkGlobal,
  offPlan,
  switchBack,
  switchIn,
  unlinkGlobal,
} from './local.ts'

const dirsOf = (h: FakeHome): LocalDirs => ({
  dev: h.path('.local/share/sideby-dev'),
  prefix: h.path('.nvm/node'),
})

async function stage(d: LocalDirs, id: string): Promise<string> {
  const dir = join(d.dev, `.stage-${id}`)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'build.json'), JSON.stringify({ id, local: true }))
  return dir
}
const runningId = async (d: LocalDirs) =>
  (JSON.parse(await readFile(join(d.dev, 'pkg', 'dist', 'build.json'), 'utf8')) as { id: string }).id

describe('pnpm local', () => {
  it('copies package.json and every package.json `files` entry but dist into the build', async () => {
    const files = await copiedFiles()
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      files: string[]
    }
    assert.deepEqual(files, ['package.json', ...pkg.files.filter((f) => f !== 'dist')])
    assert.ok(files.includes('ai-tasks.json'), 'a Portal reads ai-tasks.json from the package root')
  })

  it('switches a build into the same pkg folder and keeps the three newest old ones', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      for (const id of [
        '20261016T100000-a',
        '20261016T110000-b',
        '20261016T120000-c',
        '20261016T130000-d',
        '20261016T140000-e',
      ])
        await switchIn(d, await stage(d, id))
      assert.equal(await runningId(d), '20261016T140000-e')
      assert.deepEqual((await readdir(join(d.dev, 'old'))).sort(), [
        '20261016T110000-b',
        '20261016T120000-c',
        '20261016T130000-d',
      ])
      assert.equal(await switchBack(d), true)
      assert.equal(await runningId(d), '20261016T130000-d')
      assert.ok((await readdir(join(d.dev, 'old'))).includes('20261016T140000-e'))
    })
  })

  it('has nothing to go back to before a second build', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      await switchIn(d, await stage(d, '20261016T100000-a'))
      assert.equal(await switchBack(d), false)
      assert.equal(await runningId(d), '20261016T100000-a')
    })
  })

  it('puts the npm package aside, links the global one to pkg, and --off puts it back', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      const global = join(d.prefix, 'lib/node_modules/sideby')
      await mkdir(join(global, 'dist'), { recursive: true })
      await writeFile(join(global, 'package.json'), '{"name":"sideby","version":"0.12.1"}')
      await switchIn(d, await stage(d, '20261016T100000-a'))
      assert.match(await linkGlobal(d), /npm package moved/)
      assert.equal(await readlink(global), join(d.dev, 'pkg'))
      assert.equal(
        await readlink(join(d.prefix, 'bin/sideby')),
        '../lib/node_modules/sideby/dist/src/cli/main.js',
      )
      assert.match(await linkGlobal(d), /already runs/)
      assert.equal(await unlinkGlobal(d), true)
      assert.ok((await lstat(global)).isDirectory())
      assert.match(await readFile(join(global, 'package.json'), 'utf8'), /0\.12\.1/)
    })
  })

  it('says --off has nothing to restore when no npm package was kept', async () => {
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      await switchIn(d, await stage(d, '20261016T100000-a'))
      await linkGlobal(d)
      assert.equal(await unlinkGlobal(d), false)
    })
  })

  it('--off installs the published version when the kept copy is older, and restores it otherwise', async () => {
    assert.equal(offPlan('0.13.1', '0.14.0'), 'install', 'after a release the kept copy is the old version')
    assert.equal(offPlan('0.14.0', '0.14.0'), 'restore')
    assert.equal(offPlan('0.13.1', null), 'restore', 'offline: the kept copy beats nothing')
    assert.equal(offPlan(null, '0.14.0'), 'install')
    await withFakeHome(async (h) => {
      const d = dirsOf(h)
      assert.equal(await keptVersion(d), null)
      await mkdir(join(d.dev, 'npm'), { recursive: true })
      await writeFile(join(d.dev, 'npm', 'package.json'), '{"name":"sideby","version":"0.13.1"}')
      assert.equal(await keptVersion(d), '0.13.1')
    })
  })

  it('asks npm for the real global prefix when pnpm runs it with -C (pnpm sets npm_config_prefix to that dir)', async () => {
    await withFakeHome(async (h) => {
      const checkout = h.path('src/sideby')
      const seen: Record<string, string | undefined>[] = []
      // A stand-in for `npm prefix -g`: npm answers with npm_config_prefix when it is set.
      const npmPrefix = (env: NodeJS.ProcessEnv) => {
        seen.push({ prefix: env.npm_config_prefix, dir: env.npm_config_dir })
        return env.npm_config_prefix ?? h.path('.nvm/node')
      }
      const env = {
        HOME: h.home,
        npm_config_user_agent: 'pnpm/10.15.0 npm/? node/v22.18.0 darwin arm64',
        npm_config_prefix: checkout,
        npm_config_dir: checkout,
      }
      const d = dirs(env, checkout, npmPrefix)
      assert.equal(d.prefix, h.path('.nvm/node'))
      assert.deepEqual(seen, [{ prefix: undefined, dir: undefined }])
    })
  })

  it('refuses a global prefix inside the checkout and says how to fix it', async () => {
    await withFakeHome(async (h) => {
      const checkout = h.path('src/sideby')
      for (const answer of [checkout, join(checkout, 'node_modules', '.npm')])
        assert.throws(
          () => dirs({ HOME: h.home }, checkout, () => answer),
          (e: Error) => /inside this checkout/.test(e.message) && /npm prefix -g/.test(e.message),
        )
      assert.equal(dirs({ HOME: h.home }, checkout, () => `${checkout}-other`).prefix, `${checkout}-other`)
    })
  })
})
