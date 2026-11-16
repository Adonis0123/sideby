// `sideby progress …` end to end (spec §3.42), as real child processes against a fake HOME: JSON output against its
// schema, the undo it prints, and errors that say what to do.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

function cli(h: FakeHome, args: string[]) {
  return spawnSync(process.execPath, [MAIN, 'progress', ...args], {
    env: { ...h.env, LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
  })
}

function json(h: FakeHome, args: string[]) {
  const r = cli(h, [...args, '--json'])
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const value = JSON.parse(r.stdout)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS.progress!, JSON.parse(r.stdout)),
    JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS.progress!, value)].slice(0, 3)),
  )
  return value
}

describe('sideby progress', () => {
  it('shows it off, turns it on, changes the interval and turns it off, printing each undo', async () => {
    await withFakeHome(async (h) => {
      const first = json(h, [])
      assert.equal(first.action, 'status')
      assert.equal(first.on, false)
      assert.equal(first.defaultEvery, 30)
      assert.deepEqual(first.families, ['claude'])
      const on = json(h, ['on'])
      assert.equal(on.changed, true)
      assert.equal(on.every, 30)
      assert.equal(on.undo, 'sideby progress off')
      const config = h.path('.config/sideby/config.json')
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).progress, { every: 30 })
      const again = json(h, ['on'])
      assert.equal(again.changed, false)
      assert.equal(again.undo, undefined)
      const other = json(h, ['on', '--every', '15'])
      assert.equal(other.before, 30)
      assert.equal(other.undo, 'sideby progress on --every 30')
      assert.equal(json(h, ['status']).every, 15)
      const off = json(h, ['off'])
      assert.equal(off.on, false)
      assert.equal(off.undo, 'sideby progress on --every 15')
      assert.equal(JSON.parse(await readFile(config, 'utf8')).progress, undefined)
    })
  })

  it('says what it costs and what it covers', async () => {
    await withFakeHome(async (h) => {
      const r = cli(h, ['on', '--every', '5'])
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /every 5 minutes/)
      assert.match(r.stdout, /one model turn/)
      assert.match(r.stdout, /Codex is not covered/)
      assert.match(r.stdout, /Undo: sideby progress off/)
    })
  })

  it('refuses an interval it does not take, and says which it takes', async () => {
    await withFakeHome(async (h) => {
      for (const bad of ['0', '241', '2.5', 'ten']) {
        const r = cli(h, ['on', '--every', bad])
        assert.equal(r.status, 2, bad)
        assert.match(r.stderr, /--every takes whole minutes from 1 to 240/)
      }
      assert.equal(cli(h, ['off', '--every', '5']).status, 2)
      assert.equal(cli(h, ['sometimes']).status, 2)
    })
  })
})
