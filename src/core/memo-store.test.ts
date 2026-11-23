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

  it('keeps the newer parses another process wrote for scopes this one did not read again', async () => {
    await withFakeHome(async (h) => {
      const dir = join(h.home, 'state')
      const at = (n: number): FileStats => ({ ...st, mtimeMs: n })
      const refresh = async (scope: string, n: number) => {
        const p = memo.pass(scope)
        await p.get('/log', at(n), async () => ({ n }))
        p.done()
      }
      const newProcess = async () => {
        memo.clear()
        resetMemoStores()
        await memoStore(dir).ready()
      }
      // The file as process 1 will leave it later: scope x at its newer version 2.
      await newProcess()
      await refresh('x', 2)
      await memoStore(dir).save()
      const newer = await readFile(memoCachePath(dir), 'utf8')
      // Process 2 starts while the file still holds x at version 1.
      await newProcess()
      await refresh('x', 1)
      await memoStore(dir).save()
      await newProcess()
      assert.equal(memo.size('x'), 1)
      // Process 1 writes x = 2 meanwhile; process 2 then reads only y and writes.
      await writeFile(memoCachePath(dir), newer)
      await refresh('y', 5)
      await memoStore(dir).save()

      await newProcess()
      const x = memo.pass('x')
      assert.deepEqual(await x.get('/log', at(2), async () => ({ n: -1 })), { n: 2 }, 'process 1 kept its x')
      const y = memo.pass('y')
      assert.deepEqual(await y.get('/log', at(5), async () => ({ n: -1 })), { n: 5 })
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
      // The write happens 5 ms later, or later still on a busy machine: wait for the file instead of a fixed time.
      for (let i = 0; i < 200 && !(await stat(memoCachePath(dir)).catch(() => null)); i++)
        await new Promise((r) => setTimeout(r, 10))
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
