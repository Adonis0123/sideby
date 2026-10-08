import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { FileMemo, type FileStats } from './file-memo.ts'
import { memoCachePath, memoStore, resetMemoStores } from './memo-store.ts'

const st: FileStats = { size: 1, mtimeMs: 1000, ctimeMs: 1000, ino: 7 }
const memo = new FileMemo<{ n: number }>({ name: 'memo-store-test', version: 3 })

async function fill(value: number) {
  memo.clear()
  const p = memo.pass('acct')
  await p.get('/log', st, async () => ({ n: value }))
  p.done()
}

describe('memoStore', () => {
  it('writes the persisted memos with mode 600 and a new process starts from them', async () => {
    await withFakeHome(async (h) => {
      const dir = join(h.home, 'state')
      resetMemoStores()
      await fill(42)
      await memoStore(dir).save()
      assert.equal((await stat(memoCachePath(dir))).mode & 0o777, 0o600)

      // A new process: nothing in memory, the cache file on disk.
      memo.clear()
      resetMemoStores()
      await memoStore(dir).ready()
      const p = memo.pass('acct')
      assert.deepEqual(await p.get('/log', st, async () => ({ n: -1 })), { n: 42 })
    })
  })

  it('ignores a cache of another memo version, another format or broken JSON', async () => {
    await withFakeHome(async (h) => {
      const dir = join(h.home, 'state')
      resetMemoStores()
      await fill(42)
      await memoStore(dir).save()
      const file = memoCachePath(dir)
      const saved = JSON.parse(await readFile(file, 'utf8'))
      const variants = [
        { ...saved, memos: { 'memo-store-test': { ...saved.memos['memo-store-test'], version: 2 } } },
        { ...saved, format: 99 },
        'not json',
      ]
      for (const v of variants) {
        await writeFile(file, typeof v === 'string' ? v : JSON.stringify(v))
        memo.clear()
        resetMemoStores()
        await memoStore(dir).ready()
        assert.equal(memo.size('acct'), 0)
      }
    })
  })

  it('writes once after the reads stop, and not again within the interval', async () => {
    await withFakeHome(async (h) => {
      const dir = join(h.home, 'state')
      resetMemoStores()
      let t = 0
      const store = memoStore(dir, () => t, 5)
      await fill(1)
      store.saveSoon()
      store.saveSoon()
      await new Promise((r) => setTimeout(r, 40))
      assert.deepEqual(JSON.parse(await readFile(memoCachePath(dir), 'utf8')).memos['memo-store-test'].data, {
        acct: { '/log': ['1:1000:1000:7', { n: 1 }] },
      })
      await fill(2)
      t = 1000
      store.saveSoon()
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(
        JSON.parse(await readFile(memoCachePath(dir), 'utf8')).memos['memo-store-test'].data.acct['/log'][1]
          .n,
        1,
        'the second write waits for the 60 s interval',
      )
    })
  })
})
