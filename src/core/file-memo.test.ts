import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FileMemo, type FileStats, fileSignature } from './file-memo.ts'

const st = (size: number, mtimeMs = 1000, ctimeMs = 1000, ino = 7): FileStats => ({
  size,
  mtimeMs,
  ctimeMs,
  ino,
})

describe('FileMemo', () => {
  it('reuses a parse while the file is unchanged and parses again after it changed', async () => {
    const memo = new FileMemo<string>()
    let parses = 0
    const parse = (v: string) => async () => {
      parses++
      return v
    }
    let p = memo.pass('acct')
    assert.equal(await p.get('/a', st(10), parse('a1')), 'a1')
    p.done()
    p = memo.pass('acct')
    assert.equal(await p.get('/a', st(10), parse('a2')), 'a1')
    p.done()
    assert.equal(parses, 1)
    assert.deepEqual(memo.stats, { hits: 1, misses: 1 })
    // Size, mtime, ctime and inode each count as a change.
    for (const changed of [st(11), st(10, 2000), st(10, 1000, 2000), st(10, 1000, 1000, 8)]) {
      p = memo.pass('acct')
      assert.equal(await p.get('/a', changed, parse('new')), 'new')
      p.done()
    }
    assert.equal(parses, 5)
  })

  it('forgets files a pass did not ask for, keeps scopes apart and skips values `keep` refuses', async () => {
    const memo = new FileMemo<string>()
    let p = memo.pass('one')
    await p.get('/a', st(1), async () => 'a')
    await p.get('/b', st(1), async () => 'b')
    p.done()
    assert.equal(memo.size('one'), 2)
    p = memo.pass('one')
    await p.get('/a', st(1), async () => 'a again')
    p.done()
    assert.equal(memo.size('one'), 1)

    p = memo.pass('two')
    assert.equal(await p.get('/a', st(1), async () => 'two a'), 'two a')
    assert.equal(
      await p.get(
        '/c',
        st(1),
        async () => 'partial',
        (v) => v !== 'partial',
      ),
      'partial',
    )
    p.done()
    assert.equal(memo.size('two'), 1)
    assert.equal(memo.size('one'), 1)
  })

  it('builds the signature from size, mtime, ctime and inode', () => {
    assert.equal(fileSignature(st(3, 4, 5, 6)), '3:4:5:6')
  })
})

describe('FileMemo dump and restore', () => {
  it('dumps what a pass kept, restores it into a fresh memo and marks only real changes dirty', async () => {
    const memo = new FileMemo<string>()
    let p = memo.pass('acct')
    await p.get('/a', st(1), async () => 'a')
    p.done()
    assert.equal(memo.dirty, true)
    const dump = memo.dump()
    assert.deepEqual(dump, { acct: { '/a': ['1:1000:1000:7', 'a'] } })
    assert.equal(memo.dirty, false)
    p = memo.pass('acct')
    await p.get('/a', st(1), async () => 'never')
    p.done()
    assert.equal(memo.dirty, false, 'a pass that reused everything changes nothing')

    const fresh = new FileMemo<string>()
    fresh.restore(dump)
    let parses = 0
    p = fresh.pass('acct')
    assert.equal(
      await p.get('/a', st(1), async () => {
        parses++
        return 'b'
      }),
      'a',
    )
    assert.equal(
      await p.get('/a', st(2), async () => {
        parses++
        return 'b'
      }),
      'b',
      'a changed file is parsed again',
    )
    assert.equal(parses, 1)
  })

  it('does not overwrite a scope this process already read, and skips malformed entries', async () => {
    const memo = new FileMemo<string>()
    const p = memo.pass('acct')
    await p.get('/a', st(1), async () => 'live')
    p.done()
    memo.restore({
      acct: { '/a': ['1:1000:1000:7', 'old'] },
      other: { '/b': [7 as never, 'x'], '/c': ['s', 'c'] },
    })
    assert.equal(memo.dump().acct?.['/a']?.[1], 'live')
    assert.equal(memo.size('other'), 1)
  })
})
