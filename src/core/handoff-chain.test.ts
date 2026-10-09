// The chain directory's files (spec §3.17): modes, safe names and tolerant reads.
import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { briefPath, chainDir, ensureChainDir, newId, readJsonFile, writeJsonFile } from './handoff-chain.ts'

describe('handoff chain files', () => {
  it('creates the directory mode 700 and writes files mode 600', async () => {
    await withFakeHome(async (h) => {
      const dir = chainDir(h.path('.local/state/sideby'), newId())
      await ensureChainDir(dir)
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      await writeJsonFile(join(dir, 'plan.json'), { decision: 'pick' })
      assert.equal((await stat(join(dir, 'plan.json'))).mode & 0o777, 0o600)
      assert.deepEqual(await readJsonFile(join(dir, 'plan.json')), { decision: 'pick' })
    })
  })

  it('reads a missing, broken or non-object file as null', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('chain')
      await ensureChainDir(dir)
      assert.equal(await readJsonFile(join(dir, 'missing.json')), null)
      await writeFile(join(dir, 'broken.json'), '{"decision":')
      assert.equal(await readJsonFile(join(dir, 'broken.json')), null)
      await writeFile(join(dir, 'list.json'), '[1]')
      assert.equal(await readJsonFile(join(dir, 'list.json')), null)
    })
  })

  it('names a Brief by hop number and a file-safe ref', () => {
    assert.equal(briefPath('/x', 2, 'claude:001'), '/x/2-claude-001.md')
    assert.match(newId(), /^[a-z0-9]+-[0-9a-f]{8}$/)
  })
})
