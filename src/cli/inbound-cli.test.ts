// `sideby messages inbound accept|undo` without `--yes` only reads (spec §3.32 step 2, ADR-0040): even when a settings
// file changes between the read for the preview and anything later, the preview path writes nothing.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { describe, it } from 'node:test'
import { diffSnapshots, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cmdMessages } from './commands.ts'

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

describe('messages inbound without --yes', () => {
  for (const action of ['accept', 'undo'] as const)
    it(`${action}: writes nothing when the file changes after the preview read`, async () => {
      await withFakeHome(async (h) => {
        const settings = await h.write('.claude/settings.json', '{"crossSessionInbound":"accept"}')
        const rt = await createRuntime({ env: h.env })
        const before = await snapshot(h.home)
        const out: string[] = []
        const code = await changedAfterFirstRead(settings, '{"crossSessionInbound":"hold"}', () =>
          cmdMessages(
            parseArgs(['inbound', action, '--json'], ['json', 'yes']),
            { out: (s) => out.push(s), err: () => {} },
            rt,
          ),
        )
        assert.equal(code, 1, out.join(''))
        // Only the other writer changed the file; sideby wrote no setting and no undo record.
        assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.claude/settings.json'])
        assert.equal(JSON.parse(await fsp.readFile(settings, 'utf8')).crossSessionInbound, 'hold')
        await assert.rejects(fsp.stat(h.path('.local/state/sideby/cross-session-inbound')))
        assert.equal(JSON.parse(out.join('')).applied, false)
      })
    })

  it('accept: exits 1 and says nothing changed when every file already accepts', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"crossSessionInbound":"accept"}')
      const rt = await createRuntime({ env: h.env })
      const before = await snapshot(h.home)
      for (const flags of [[], ['--yes']]) {
        const out: string[] = []
        const code = await cmdMessages(
          parseArgs(['inbound', 'accept', ...flags], ['json', 'yes']),
          { out: (s) => out.push(s), err: () => {} },
          rt,
        )
        assert.equal(code, 1)
        assert.match(out.join('\n'), /already accept, nothing changed/)
      }
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })
})
