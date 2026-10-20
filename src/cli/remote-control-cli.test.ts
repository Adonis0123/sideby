// `sideby remote-control off|on|undo` without `--yes` only reads (spec §3.22, ADR-0017): even when a settings file
// changes between the read for the preview and anything later, the preview path writes nothing, and a run with
// nothing to change exits 1.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { describe, it } from 'node:test'
import { diffSnapshots, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime, type Runtime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cmdRemoteControl } from './commands.ts'

/** Runs `fn` while another writer puts `next` into `file` right after its first read. */
async function changedAfterFirstRead<T>(file: string, next: string, fn: () => Promise<T>): Promise<T> {
  const orig = fsp.readFile
  let reads = 0
  fsp.readFile = (async (...args: Parameters<typeof orig>) => {
    const read = await orig(...args)
    if (args[0] === file && ++reads === 1) await fsp.writeFile(file, next)
    return read
  }) as typeof orig
  syncBuiltinESMExports()
  try {
    return await fn()
  } finally {
    fsp.readFile = orig
    syncBuiltinESMExports()
  }
}

async function rc(rt: Runtime, argv: string[]) {
  const out: string[] = []
  const code = await cmdRemoteControl(
    parseArgs(['remote-control', ...argv].slice(1), ['json', 'yes']),
    { out: (s) => out.push(s), err: () => {} },
    rt,
  )
  return { code, out: out.join('\n') }
}

describe('remote-control without --yes', () => {
  for (const [action, now, next] of [
    ['off', 'false', 'true'],
    ['on', 'true', 'false'],
  ] as const)
    it(`${action}: writes nothing when the file changes after the preview read`, async () => {
      await withFakeHome(async (h) => {
        const settings = await h.write('.claude/settings.json', `{"remoteControlAtStartup":${now}}`)
        const rt = await createRuntime({ env: h.env })
        const before = await snapshot(h.home)
        const r = await changedAfterFirstRead(settings, `{"remoteControlAtStartup":${next}}`, () =>
          rc(rt, [action, '--json']),
        )
        assert.equal(r.code, 1, r.out)
        // Only the other writer changed the file; sideby wrote no setting and no undo record.
        assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.claude/settings.json'])
        assert.equal(JSON.parse(await fsp.readFile(settings, 'utf8')).remoteControlAtStartup, next === 'true')
        await assert.rejects(fsp.stat(h.path('.local/state/sideby/remote-control')))
        assert.equal(JSON.parse(r.out).applied, false)
      })
    })

  it('undo: puts nothing back when the file changes after the preview read', async () => {
    await withFakeHome(async (h) => {
      const settings = await h.write('.claude/settings.json', '{"remoteControlAtStartup":true}')
      const rt = await createRuntime({ env: h.env })
      assert.equal((await rc(rt, ['off', '--yes'])).code, 0)
      // The user turned it on again by hand, so there is nothing of sideby's left to undo.
      await fsp.writeFile(settings, '{"remoteControlAtStartup":true}')
      const before = await snapshot(h.home)
      const r = await changedAfterFirstRead(settings, '{"remoteControlAtStartup":false}', () =>
        rc(rt, ['undo']),
      )
      assert.equal(r.code, 1, r.out)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.claude/settings.json'])
      assert.equal(JSON.parse(await fsp.readFile(settings, 'utf8')).remoteControlAtStartup, false)
    })
  })

  for (const [action, value] of [
    ['off', 'false'],
    ['on', 'true'],
  ] as const)
    it(`${action}: exits 1 and says nothing changed when every file already holds it`, async () => {
      await withFakeHome(async (h) => {
        await h.write('.claude/settings.json', `{"remoteControlAtStartup":${value}}`)
        const rt = await createRuntime({ env: h.env })
        const before = await snapshot(h.home)
        for (const flags of [[], ['--yes']]) {
          const r = await rc(rt, [action, ...flags])
          assert.equal(r.code, 1)
          assert.match(r.out, new RegExp(`already ${action}, nothing changed`))
        }
        assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      })
    })
})
