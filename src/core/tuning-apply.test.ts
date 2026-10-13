import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import type { Account, ReadContext } from '../types.ts'
import { applyTune, planTuneApply, tuneUndoInfo, undoTune } from './tuning-apply.ts'

const MARKER = 'not-a-secret-marker-only-for-this-test'

const acct = (h: FakeHome, name: string): Account => ({
  family: 'claude',
  name,
  ref: `claude:${name}`,
  dir: h.path(name === 'main' ? '.claude' : `.claude-${name}`),
  isMain: name === 'main',
  kind: 'subscription',
})

const ctx = (h: FakeHome): ReadContext => ({
  home: h.home,
  now: new Date(),
  stateDir: h.path('.local/state/sideby'),
  env: h.env,
})

const read = (p: string) => readFile(p, 'utf8')

describe('applying a tuning suggestion', () => {
  it('creates settings.json when there is none, and undo removes it again', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      await mkdir(a.dir, { recursive: true })
      const plan = await planTuneApply(a, 160_000, [a])
      assert.deepEqual([plan.status, plan.creates, plan.current], ['ready', true, null])
      const r = await applyTune(a, 160_000, [a], ctx(h))
      assert.equal(r.ok, true)
      assert.deepEqual(JSON.parse(await read(join(a.dir, 'settings.json'))), { autoCompactWindow: 160_000 })
      assert.equal((await stat(join(a.dir, 'settings.json'))).mode & 0o777, 0o600)
      assert.equal((await tuneUndoInfo(a, ctx(h)))?.applied, 160_000)
      assert.equal((await undoTune(a, ctx(h))).ok, true)
      await assert.rejects(stat(join(a.dir, 'settings.json')))
      assert.equal(await tuneUndoInfo(a, ctx(h)), null)
    })
  })

  it('changes only its key: other keys, indentation, final newline and mode stay as they were', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      const text = `{\n    "env": { "SOME_SETTING": "${MARKER}" },\n    "model": "x"\n}\n`
      await h.write('.claude-work/settings.json', text, 0o644)
      const r = await applyTune(a, 120_000, [a], ctx(h))
      assert.equal(r.ok, true)
      const after = await read(join(a.dir, 'settings.json'))
      const expected = { ...JSON.parse(text), autoCompactWindow: 120_000 }
      assert.equal(after, `${JSON.stringify(expected, null, 4)}\n`)
      assert.equal((await stat(join(a.dir, 'settings.json'))).mode & 0o777, 0o644)
      // Nothing of the other keys reaches the plan, the message or the undo record.
      assert.ok(!JSON.stringify(r).includes(MARKER))
      const dir = h.path('.local/state/sideby/tune')
      for (const f of await readdir(dir)) assert.ok(!(await read(join(dir, f))).includes(MARKER))
    })
  })

  it('undo puts the old value back, and leaves a setting the user changed since', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      await h.write('.claude-work/settings.json', '{"autoCompactWindow":200000}\n')
      await applyTune(a, 100_000, [a], ctx(h))
      assert.equal(JSON.parse(await read(join(a.dir, 'settings.json'))).autoCompactWindow, 100_000)
      assert.equal((await undoTune(a, ctx(h))).ok, true)
      assert.equal(JSON.parse(await read(join(a.dir, 'settings.json'))).autoCompactWindow, 200_000)

      await applyTune(a, 100_000, [a], ctx(h))
      await writeFile(join(a.dir, 'settings.json'), '{"autoCompactWindow":150000}\n')
      const refused = await undoTune(a, ctx(h))
      assert.equal(refused.ok, false)
      assert.match(refused.message, /changed after/)
      assert.equal(JSON.parse(await read(join(a.dir, 'settings.json'))).autoCompactWindow, 150_000)
      assert.equal(await tuneUndoInfo(a, ctx(h)), null)
    })
  })

  it('goes back to the default by removing the key, says so when there is nothing to remove, and undo brings the value back', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      await h.write('.claude-work/settings.json', '{"theme":"dark","autoCompactWindow":200000}\n')
      const plan = await planTuneApply(a, null, [a])
      assert.deepEqual([plan.status, plan.current, plan.next], ['ready', 200_000, null])
      assert.equal((await applyTune(a, null, [a], ctx(h))).ok, true)
      assert.deepEqual(JSON.parse(await read(join(a.dir, 'settings.json'))), { theme: 'dark' })
      assert.equal((await tuneUndoInfo(a, ctx(h)))?.applied, null)
      assert.equal((await planTuneApply(a, null, [a])).status, 'unchanged')
      assert.equal((await undoTune(a, ctx(h))).ok, true)
      assert.deepEqual(JSON.parse(await read(join(a.dir, 'settings.json'))), {
        theme: 'dark',
        autoCompactWindow: 200_000,
      })
      // No file at all: nothing to remove.
      const b = acct(h, 'none')
      await mkdir(b.dir, { recursive: true })
      assert.equal((await planTuneApply(b, null, [b])).status, 'unchanged')
    })
  })

  it('says it is already set, and writes nothing', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      await h.write('.claude-work/settings.json', '{"autoCompactWindow":160000}\n')
      const r = await applyTune(a, 160_000, [a], ctx(h))
      assert.deepEqual([r.ok, r.plan.status], [true, 'unchanged'])
    })
  })

  it('writes a linked settings.json at its real file, names every account that shares it and keeps the link', async () => {
    await withFakeHome(async (h) => {
      const main = acct(h, 'main')
      const a = acct(h, 'work')
      const b = acct(h, 'extra')
      await h.write('.claude/settings.json', '{"theme":"dark"}\n')
      for (const x of [a, b]) {
        await mkdir(x.dir, { recursive: true })
        await symlink(join(main.dir, 'settings.json'), join(x.dir, 'settings.json'))
      }
      const plan = await planTuneApply(a, 90_000, [main, a, b])
      assert.deepEqual([plan.link, plan.affected], [true, ['claude:work', 'claude:main', 'claude:extra']])
      const r = await applyTune(a, 90_000, [main, a, b], ctx(h))
      assert.equal(r.ok, true)
      assert.deepEqual(JSON.parse(await read(join(main.dir, 'settings.json'))), {
        theme: 'dark',
        autoCompactWindow: 90_000,
      })
      assert.equal((await lstat(join(a.dir, 'settings.json'))).isSymbolicLink(), true)
      assert.equal(await readlink(join(a.dir, 'settings.json')), join(main.dir, 'settings.json'))
      assert.equal((await undoTune(a, ctx(h))).ok, true)
      assert.deepEqual(JSON.parse(await read(join(main.dir, 'settings.json'))), { theme: 'dark' })
    })
  })

  it('applying twice keeps the original value, so one undo goes all the way back', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      await h.write('.claude-work/settings.json', '{"autoCompactWindow":200000}\n')
      await applyTune(a, 100_000, [a], ctx(h))
      await applyTune(a, 120_000, [a], ctx(h))
      assert.equal((await undoTune(a, ctx(h))).ok, true)
      assert.equal(JSON.parse(await read(join(a.dir, 'settings.json'))).autoCompactWindow, 200_000)
      // Over a value the user set in between, the record starts again from that value.
      await applyTune(a, 100_000, [a], ctx(h))
      await writeFile(join(a.dir, 'settings.json'), '{"autoCompactWindow":150000}\n')
      await applyTune(a, 90_000, [a], ctx(h))
      await undoTune(a, ctx(h))
      assert.equal(JSON.parse(await read(join(a.dir, 'settings.json'))).autoCompactWindow, 150_000)
    })
  })

  it('finds the shared file and its undo record whatever way the path to it is spelled', async () => {
    await withFakeHome(async (h) => {
      const real = h.path('.claude')
      await mkdir(real, { recursive: true })
      await writeFile(join(real, 'settings.json'), '{}\n')
      await symlink(h.home, h.path('via-link'))
      const main: Account = { ...acct(h, 'main'), dir: h.path('via-link', '.claude') }
      const a = acct(h, 'work')
      await mkdir(a.dir, { recursive: true })
      await symlink(join(real, 'settings.json'), join(a.dir, 'settings.json'))
      const plan = await planTuneApply(a, 90_000, [main, a])
      assert.deepEqual(plan.affected, ['claude:work', 'claude:main'])
      await applyTune(a, 90_000, [main, a], ctx(h))
      assert.equal((await tuneUndoInfo(main, ctx(h)))?.applied, 90_000)
    })
  })

  it('refuses, writing nothing, when settings.json is not usable, without echoing its content', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      for (const bad of ['{ not json', '[1, 2]', `"${MARKER}"`]) {
        await h.write('.claude-work/settings.json', bad)
        const r = await applyTune(a, 100_000, [a], ctx(h))
        assert.equal(r.ok, false, bad)
        assert.equal(r.plan.status, 'blocked')
        assert.ok(!JSON.stringify(r).includes(MARKER))
        assert.equal(await read(join(a.dir, 'settings.json')), bad)
      }
      await symlink(h.path('nowhere.json'), h.path('.claude-work/broken.json'))
      await h.write('.claude-extra/placeholder', '')
      await symlink(h.path('nowhere.json'), h.path('.claude-extra/settings.json'))
      const broken = await planTuneApply(acct(h, 'extra'), 100_000, [])
      assert.equal(broken.status, 'blocked')
    })
  })

  it('rejects a value that is not a whole number of tokens in range', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'work')
      for (const v of [0, -5, 1.5, 9_999, 2_000_001, Number.NaN])
        await assert.rejects(planTuneApply(a, v, [a]), /not a usable size/, String(v))
    })
  })
})
