import assert from 'node:assert/strict'
import { readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { isZombieStat, takeFileLock } from './lock.ts'

const base = { staleMs: 60_000, beatMs: 10_000, alive: () => true }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const age = (file: string, ms: number) => utimes(file, new Date(Date.now() - ms), new Date(Date.now() - ms))

describe('takeFileLock', () => {
  it('takes a missing lock, writes `<pid> <ms>` with mode 600, and release removes it', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const release = await takeFileLock(file, { ...base, now: () => 1234 })
      assert.ok(release)
      assert.equal(await readFile(file, 'utf8'), `${process.pid} 1234`)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      await release()
      await assert.rejects(stat(file))
    }))

  it('is held by a live, freshly touched holder', () =>
    withFakeHome(async (h) => {
      const text = `4242 ${Date.now()}`
      const file = await h.write('a.lock', text)
      assert.equal(await takeFileLock(file, base), null)
      assert.equal(await readFile(file, 'utf8'), text)
    }))

  it('is taken over when the pid is dead', () =>
    withFakeHome(async (h) => {
      const file = await h.write('a.lock', `4242 ${Date.now()}`)
      const release = await takeFileLock(file, { ...base, alive: (pid) => pid !== 4242 })
      assert.ok(release)
      assert.match(await readFile(file, 'utf8'), new RegExp(`^${process.pid} `))
      await release()
    }))

  it('is taken over when nobody touched it for staleMs, although its pid runs', () =>
    withFakeHome(async (h) => {
      const file = await h.write('a.lock', `4242 ${Date.now()}`)
      await age(file, 30_000)
      assert.equal(await takeFileLock(file, base), null)
      await age(file, 61_000)
      const release = await takeFileLock(file, base)
      assert.ok(release)
      await release()
    }))

  it('is taken over when older than maxMs, although touched', () =>
    withFakeHome(async (h) => {
      const now = Date.now()
      const file = await h.write('a.lock', `4242 ${now - 2 * 3_600_000}`)
      assert.equal(await takeFileLock(file, base), null, 'no maxMs: age alone frees nothing')
      const release = await takeFileLock(file, { ...base, maxMs: 3_600_000, now: () => now })
      assert.ok(release)
      await release()
    }))

  it('holds an unparsable lock only within writeGraceMs', () =>
    withFakeHome(async (h) => {
      const file = await h.write('a.lock', '')
      assert.equal(await takeFileLock(file, { ...base, writeGraceMs: 5000 }), null)
      await writeFile(file, '4242')
      await age(file, 6000)
      const release = await takeFileLock(file, { ...base, writeGraceMs: 5000 })
      assert.ok(release)
      await release()
    }))

  it('release leaves a lock that another holder took since', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const release = await takeFileLock(file, base)
      assert.ok(release)
      await writeFile(file, `4242 ${Date.now()}`)
      await release()
      assert.equal(await readFile(file, 'utf8').then((t) => t.startsWith('4242 ')), true)
    }))

  it('the holder touches its lock every beatMs', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const release = await takeFileLock(file, { ...base, beatMs: 20 })
      assert.ok(release)
      await age(file, 50_000)
      await sleep(80)
      assert.ok(Date.now() - (await stat(file)).mtimeMs < 5000)
      await release()
    }))

  it('lets only one of several takers have a lock left behind', () =>
    withFakeHome(async (h) => {
      // One round rarely interleaves; without the guard two holders show up within about 150 rounds.
      const file = h.path('a.lock')
      for (let round = 0; round < 300; round++) {
        await writeFile(file, `4242 ${Date.now()}`)
        await age(file, 120_000)
        const takers = await Promise.all(Array.from({ length: 8 }, () => takeFileLock(file, base)))
        assert.equal(takers.filter(Boolean).length, 1, `round ${round}`)
        await Promise.all(takers.map((r) => r?.()))
      }
    }))

  it('a holder whose lock was taken over never touches the lock that replaced it', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const release = await takeFileLock(file, { ...base, beatMs: 10 })
      assert.ok(release)
      // Another taker removed it and made its own lock, which then stopped being touched.
      const other = await takeFileLock(file, { ...base, alive: () => false, staleMs: 0 })
      assert.ok(other)
      const theirs = `4343 ${Date.now()}`
      await writeFile(file, theirs)
      await age(file, 120_000)
      const before = (await stat(file)).mtimeMs
      await sleep(60)
      assert.equal((await stat(file)).mtimeMs, before)
      await release()
      await other()
      assert.equal(await readFile(file, 'utf8'), theirs)
    }))

  it('waiting: acquires once the holder releases', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const first = await takeFileLock(file, base)
      assert.ok(first)
      setTimeout(() => void first(), 60)
      const second = await takeFileLock(file, { ...base, wait: { timeoutMs: 2000, pollMs: 10 } })
      assert.ok(second)
      await second()
    }))

  it('waiting: gives up at the timeout', () =>
    withFakeHome(async (h) => {
      const file = h.path('a.lock')
      const first = await takeFileLock(file, base)
      assert.ok(first)
      const started = Date.now()
      assert.equal(await takeFileLock(file, { ...base, wait: { timeoutMs: 80, pollMs: 10 } }), null)
      assert.ok(Date.now() - started >= 80)
      await first()
    }))

  it('throws errors other than an existing lock', () =>
    withFakeHome(async (h) => {
      await assert.rejects(takeFileLock(h.path('missing-dir', 'a.lock'), base), { code: 'ENOENT' })
    }))
})

describe('isZombieStat', () => {
  it('reads the state after the command name', () => {
    assert.equal(isZombieStat('1075152 (node) Z 895969 1075152'), true)
    assert.equal(isZombieStat('42 (node) S 1 42'), false)
    assert.equal(isZombieStat('43 (a) Z b) R 1 43'), false)
  })
})
