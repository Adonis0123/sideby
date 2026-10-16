// The chain directory's files (spec §3.17): modes, safe names and tolerant reads.
import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  briefPath,
  chainDir,
  ensureChainDir,
  FILES,
  newId,
  readJsonFile,
  requestHandoff,
  writeJsonFile,
} from './handoff-chain.ts'

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

  it('`handoff ready` asks after the turn, but hands over at once while the session waits for its quota', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('chain')
      await ensureChainDir(dir)
      const env = { SIDEBY_HANDOFF_RUN: 'r1', SIDEBY_HANDOFF_DIR: dir }
      const now = new Date('2026-10-16T00:30:00Z')
      assert.equal((await requestHandoff(env, undefined, undefined, now))?.now, false)
      assert.equal((await readJsonFile<{ trigger: string }>(join(dir, FILES.request)))?.trigger, 'manual')
      await writeJsonFile(join(dir, FILES.run('r1')), { sessionId: 's1', transcriptPath: '/t.jsonl' })
      await writeJsonFile(join(dir, FILES.waiting), { runId: 'r1', until: '2026-10-16T00:50:00Z', at: now })
      const r = await requestHandoff(env, undefined, 'claude:003', now)
      assert.equal(r?.now, true)
      assert.deepEqual(await readJsonFile(join(dir, FILES.ready)), {
        runId: 'r1',
        at: now.toISOString(),
        trigger: 'manual',
        to: 'claude:003',
        sessionId: 's1',
        transcriptPath: '/t.jsonl',
      })
      // Past the reset the session has gone on by itself: back to asking after the turn.
      assert.equal(
        (await requestHandoff(env, undefined, undefined, new Date('2026-10-16T00:51:00Z')))?.now,
        false,
      )
      // Another run's waiting file does not count.
      await writeJsonFile(join(dir, FILES.waiting), { runId: 'r0', until: '2026-10-16T00:50:00Z', at: now })
      assert.equal((await requestHandoff(env, undefined, undefined, now))?.now, false)
    })
  })

  it('names a Brief by hop number and a file-safe ref', () => {
    assert.equal(briefPath('/x', 2, 'claude:001'), '/x/2-claude-001.md')
    assert.match(newId(), /^[a-z0-9]+-[0-9a-f]{8}$/)
  })
})
