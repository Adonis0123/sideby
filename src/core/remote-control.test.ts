import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import type { Account, ReadContext } from '../types.ts'
import {
  remoteControlGroups,
  turnRemoteControlOff,
  turnRemoteControlOn,
  undoRemoteControlOff,
} from './remote-control.ts'

const MARKER = 'not-a-secret-marker-only-for-this-test'

const acct = (h: FakeHome, name: string, family = 'claude'): Account => ({
  family,
  name,
  ref: `${family}:${name}`,
  dir: h.path(name === 'main' ? `.${family}` : `.${family}-${name}`),
  isMain: name === 'main',
  kind: 'subscription',
})

const ctx = (h: FakeHome): ReadContext => ({
  home: h.home,
  now: new Date(),
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})

const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'))

/** main is on, 001 links to it, 002 has a file of its own without the key, 003 has no settings.json. */
async function setUp(h: FakeHome) {
  const main = acct(h, 'main')
  const linked = acct(h, '001')
  const own = acct(h, '002')
  const none = acct(h, '003')
  await h.write(
    '.claude/settings.json',
    `{\n    "env": { "X": "${MARKER}" },\n    "remoteControlAtStartup": true\n}\n`,
    0o644,
  )
  await mkdir(linked.dir, { recursive: true })
  await symlink(join(main.dir, 'settings.json'), join(linked.dir, 'settings.json'))
  await h.write('.claude-002/settings.json', '{"model":"x"}')
  await mkdir(none.dir, { recursive: true })
  return { main, linked, own, none, all: [main, linked, own, none, acct(h, 'main', 'codex')] }
}

describe('Remote Control off by default', () => {
  it('groups Accounts by the file they share and reads only the one key', async () => {
    await withFakeHome(async (h) => {
      const { all } = await setUp(h)
      const groups = await remoteControlGroups(all, ctx(h))
      assert.deepEqual(
        groups.map((g) => [g.accounts, g.state, g.undo]),
        [
          [['claude:main', 'claude:001'], 'on', false],
          [['claude:002'], 'default', false],
          [['claude:003'], 'missing', false],
        ],
      )
      assert.match(groups[2]?.reason ?? '', /doctor --fix/)
      assert.ok(!JSON.stringify(groups).includes(MARKER))
    })
  })

  it('off writes false where it was on or missing the key, keeps the rest, and creates no file or link', async () => {
    await withFakeHome(async (h) => {
      const { main, linked, own, none, all } = await setUp(h)
      const r = await turnRemoteControlOff(all, ctx(h))
      assert.equal(r.ok, true)
      assert.equal(r.results.length, 2)
      const mainText = await readFile(join(main.dir, 'settings.json'), 'utf8')
      assert.equal(
        mainText,
        `${JSON.stringify({ env: { X: MARKER }, remoteControlAtStartup: false }, null, 4)}\n`,
      )
      assert.equal((await stat(join(main.dir, 'settings.json'))).mode & 0o777, 0o644)
      assert.deepEqual(await json(join(own.dir, 'settings.json')), {
        model: 'x',
        remoteControlAtStartup: false,
      })
      assert.ok((await lstat(join(linked.dir, 'settings.json'))).isSymbolicLink())
      assert.equal(await readlink(join(linked.dir, 'settings.json')), join(main.dir, 'settings.json'))
      await assert.rejects(stat(join(none.dir, 'settings.json')))
      assert.ok(!JSON.stringify(r).includes(MARKER))
      const dir = h.path('.local/state/sideby/remote-control')
      for (const f of await readdir(dir)) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes(MARKER))
      const after = await remoteControlGroups(all, ctx(h))
      assert.deepEqual(
        after.map((g) => [g.state, g.undo]),
        [
          ['off', true],
          ['off', true],
          ['missing', false],
        ],
      )
      const again = await turnRemoteControlOff(all, ctx(h))
      assert.deepEqual([again.ok, again.results.length], [true, 0])
    })
  })

  it('undo puts back true and removes a key that was not there', async () => {
    await withFakeHome(async (h) => {
      const { main, own, all } = await setUp(h)
      await turnRemoteControlOff(all, ctx(h))
      const r = await undoRemoteControlOff(all, ctx(h))
      assert.equal(r.ok, true)
      assert.equal((await json(join(main.dir, 'settings.json'))).remoteControlAtStartup, true)
      assert.deepEqual(await json(join(own.dir, 'settings.json')), { model: 'x' })
      assert.equal((await undoRemoteControlOff(all, ctx(h))).ok, false)
    })
  })

  it('undo leaves a setting the user changed since', async () => {
    await withFakeHome(async (h) => {
      const { main, all } = await setUp(h)
      await turnRemoteControlOff(all, ctx(h))
      await writeFile(join(main.dir, 'settings.json'), '{"remoteControlAtStartup":true}\n')
      const groups = await remoteControlGroups(all, ctx(h))
      assert.deepEqual([groups[0]?.state, groups[0]?.undo], ['on', false])
      await undoRemoteControlOff(all, ctx(h))
      assert.equal(
        await readFile(join(main.dir, 'settings.json'), 'utf8'),
        '{"remoteControlAtStartup":true}\n',
      )
    })
  })

  it('on writes true where it was off or missing the key, and undo puts each file back', async () => {
    await withFakeHome(async (h) => {
      const { main, own, none, all } = await setUp(h)
      await writeFile(
        join(main.dir, 'settings.json'),
        `{"env":{"X":"${MARKER}"},"remoteControlAtStartup":false}\n`,
      )
      const r = await turnRemoteControlOn(all, ctx(h))
      assert.deepEqual([r.ok, r.results.length], [true, 2])
      assert.deepEqual(await json(join(main.dir, 'settings.json')), {
        env: { X: MARKER },
        remoteControlAtStartup: true,
      })
      assert.deepEqual(await json(join(own.dir, 'settings.json')), {
        model: 'x',
        remoteControlAtStartup: true,
      })
      await assert.rejects(stat(join(none.dir, 'settings.json')))
      assert.ok(!JSON.stringify(r).includes(MARKER))
      const after = await remoteControlGroups(all, ctx(h))
      assert.deepEqual(
        after.map((g) => [g.state, g.undo]),
        [
          ['on', true],
          ['on', true],
          ['missing', false],
        ],
      )
      assert.deepEqual((await turnRemoteControlOn(all, ctx(h))).results.length, 0)
      assert.equal((await undoRemoteControlOff(all, ctx(h))).ok, true)
      assert.equal((await json(join(main.dir, 'settings.json'))).remoteControlAtStartup, false)
      assert.deepEqual(await json(join(own.dir, 'settings.json')), { model: 'x' })
    })
  })

  it('undo after on leaves a setting the user turned off since', async () => {
    await withFakeHome(async (h) => {
      const { main, all } = await setUp(h)
      await writeFile(join(main.dir, 'settings.json'), '{"remoteControlAtStartup":false}\n')
      await turnRemoteControlOn(all, ctx(h))
      await writeFile(join(main.dir, 'settings.json'), '{"remoteControlAtStartup":false}\n')
      const groups = await remoteControlGroups(all, ctx(h))
      assert.deepEqual([groups[0]?.state, groups[0]?.undo], ['off', false])
    })
  })

  it('reads a record written before on existed as one that wrote false', async () => {
    await withFakeHome(async (h) => {
      const { all } = await setUp(h)
      await turnRemoteControlOff(all, ctx(h))
      const dir = h.path('.local/state/sideby/remote-control')
      for (const f of await readdir(dir)) {
        const r = await json(join(dir, f))
        delete r.wrote
        await writeFile(join(dir, f), JSON.stringify(r))
      }
      assert.deepEqual(
        (await remoteControlGroups(all, ctx(h))).map((g) => g.undo),
        [true, true, false],
      )
    })
  })

  it('reports a file it cannot change safely and leaves it alone', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      await h.write('.claude/settings.json', '[1,2]')
      const [g] = await remoteControlGroups([a], ctx(h))
      assert.equal(g?.state, 'blocked')
      const r = await turnRemoteControlOff([a], ctx(h))
      assert.deepEqual([r.ok, r.results.length], [false, 0])
      assert.match(r.message, /not a JSON object/)
      assert.equal(await readFile(join(a.dir, 'settings.json'), 'utf8'), '[1,2]')
    })
  })
})
