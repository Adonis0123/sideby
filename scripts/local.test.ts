import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../testing/index.ts'
import { type LocalDirs, linkGlobal, switchBack, switchIn, unlinkGlobal } from './local.ts'

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
})
