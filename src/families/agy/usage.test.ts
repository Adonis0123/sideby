import assert from 'node:assert/strict'
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { loadSqlite } from '../../core/history-index.ts'
import type { Account, ReadContext } from '../../types.ts'
import {
  agyUsageMemo,
  decodeAgyGeneration,
  decodeAgyStepTimestampMs,
  extractAgyEffort,
  readAgyUsage,
} from './usage.ts'

const NOW = new Date('2026-11-28T12:00:00.000Z')

function account(dir: string): Account {
  return { family: 'agy', name: 'main', ref: 'agy:main', dir, isMain: true, kind: 'subscription' }
}

function ctx(h: FakeHome, now = NOW): ReadContext {
  return { home: h.home, now, stateDir: h.path('.local/state/sideby'), env: h.env }
}

function encodeVarint(n: number | bigint): Uint8Array {
  let v = BigInt(n)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Uint8Array.from(out)
}

function pbVarint(num: number, value: number | bigint): Uint8Array {
  return Buffer.concat([encodeVarint((num << 3) | 0), encodeVarint(value)])
}

function pbBytes(num: number, data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return Buffer.concat([encodeVarint((num << 3) | 2), encodeVarint(bytes.length), bytes])
}

function stepMeta(tsSeconds: number): Uint8Array {
  return pbBytes(1, pbVarint(1, tsSeconds))
}

function genBlob(opts: {
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  modelId?: string
  label?: string
}): Uint8Array {
  const usageParts: Uint8Array[] = [pbVarint(1, 1532)]
  if (opts.input) usageParts.push(pbVarint(2, opts.input))
  if (opts.output) usageParts.push(pbVarint(3, opts.output))
  if (opts.cacheWrite) usageParts.push(pbVarint(4, opts.cacheWrite))
  if (opts.cacheRead) usageParts.push(pbVarint(5, opts.cacheRead))
  const wrappedParts: Uint8Array[] = [pbBytes(4, Buffer.concat(usageParts))]
  if (opts.modelId) wrappedParts.push(pbBytes(19, opts.modelId))
  if (opts.label) wrappedParts.push(pbBytes(21, opts.label))
  return pbBytes(1, Buffer.concat(wrappedParts))
}

async function writeConvDb(
  file: string,
  turns: {
    tsSeconds?: number
    input?: number
    output?: number
    cacheWrite?: number
    cacheRead?: number
    modelId?: string
    label?: string
    rawBlob?: Uint8Array
    skipStep?: boolean
  }[],
  opts?: { wal?: boolean },
): Promise<void> {
  const sqlite = await loadSqlite()
  assert.ok(sqlite, 'node:sqlite must be available')
  const db = new sqlite.DatabaseSync(file)
  try {
    if (opts?.wal) db.exec('PRAGMA journal_mode = WAL')
    db.exec(`
      DROP TABLE IF EXISTS steps;
      DROP TABLE IF EXISTS gen_metadata;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `)
    const insStep = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)')
    const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      if (!t.skipStep && t.tsSeconds !== undefined) insStep.run(i * 2 + 1, 15, stepMeta(t.tsSeconds))
      insGen.run(i, t.rawBlob ?? genBlob(t))
    }
  } finally {
    db.close()
  }
}

describe('agy usage (ADR-0093)', () => {
  it('decodes protobuf generation tokens, effort labels and step timestamps, ignoring zero rows', () => {
    const g = decodeAgyGeneration(
      genBlob({
        input: 1200,
        output: 340,
        cacheWrite: 80,
        cacheRead: 9500,
        modelId: 'gemini-4-neon',
        label: 'Gemini 4 Neon (High)',
      }),
    )
    assert.deepEqual(g, {
      input: 1200,
      output: 340,
      cacheRead: 9500,
      cacheWrite: 80,
      model: 'gemini-4-neon',
      effort: 'high',
    })
    assert.equal(decodeAgyGeneration(genBlob({})), undefined)
    assert.equal(decodeAgyStepTimestampMs(stepMeta(1_795_875_856)), 1_795_875_856_000)
    assert.equal(extractAgyEffort('Gemini 4 Neon (Medium)'), 'medium')
    assert.equal(extractAgyEffort('Orchestrator (Carbon)'), undefined)
  })

  it('aggregates 7-day tokens, daily buckets, model/effort and trailing rows without writing to the Host folder', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.gemini/antigravity-cli')
      const convDir = join(dir, 'conversations')
      await mkdir(convDir, { recursive: true })
      const nowSec = Math.floor(NOW.getTime() / 1000)
      const db1 = join(convDir, 'sess-1.db')
      await writeConvDb(db1, [
        {
          tsSeconds: nowSec - 8 * 86_400,
          input: 9999,
          output: 1,
          modelId: 'old-model',
        },
        {
          tsSeconds: nowSec + 3600,
          input: 8888,
          output: 1,
          modelId: 'future-model',
        },
        {
          tsSeconds: nowSec - 3600,
          input: 100,
          output: 40,
          cacheRead: 500,
          cacheWrite: 10,
          modelId: 'gemini-4-neon',
          label: 'Gemini 4 Neon (Medium)',
        },
        // WHY: ADR-0093 trailing gen_metadata row with no matching step_type=15 falls back to the last step timestamp.
        {
          skipStep: true,
          input: 20,
          output: 5,
          modelId: 'gemini-4-neon',
          label: 'Gemini 4 Neon (High)',
        },
      ])
      await utimes(db1, NOW, NOW)

      const stale = join(convDir, 'stale.db')
      await writeConvDb(stale, [{ tsSeconds: nowSec - 60, input: 5000, output: 500 }])
      const oldTime = new Date(NOW.getTime() - 10 * 86_400_000)
      await utimes(stale, oldTime, oldTime)

      const outside = join(h.home, 'outside.db')
      await writeConvDb(outside, [{ tsSeconds: nowSec - 60, input: 7777, output: 1 }])
      await symlink(outside, join(convDir, 'linked.db'))

      const before = await snapshot(dir)
      const r = await readAgyUsage(account(dir), ctx(h))
      assert.deepEqual(diffSnapshots(before, await snapshot(dir)), [])

      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.days, 7)
      assert.equal(r.sessions, 1)
      assert.equal(r.inputTokens, 120)
      assert.equal(r.outputTokens, 45)
      assert.equal(r.cacheReadTokens, 500)
      assert.equal(r.cacheWriteTokens, 10)
      assert.equal(r.totalTokens, 675)
      assert.equal(r.lastModel, 'gemini-4-neon')
      assert.equal(r.lastEffort, 'high')
      assert.equal(r.lastActivityAt, new Date((nowSec - 3600) * 1000).toISOString())
      assert.equal(r.daily?.length, 7)
      assert.equal(
        r.daily?.reduce((sum, d) => sum + d.totalTokens, 0),
        675,
      )
    })
  })

  it('reuses memoized parses for unchanged databases and re-reads when the database grows', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.gemini/antigravity-cli')
      const convDir = join(dir, 'conversations')
      await mkdir(convDir, { recursive: true })
      const nowSec = Math.floor(NOW.getTime() / 1000)
      const dbFile = join(convDir, 'grow.db')
      await writeConvDb(dbFile, [{ tsSeconds: nowSec - 120, input: 50, output: 10 }])
      await utimes(dbFile, NOW, NOW)

      const before = { ...agyUsageMemo.stats }
      const r1 = await readAgyUsage(account(dir), ctx(h))
      const r2 = await readAgyUsage(account(dir), ctx(h))
      assert.equal(r1.status === 'ok' ? r1.totalTokens : -1, 60)
      assert.equal(r2.status === 'ok' ? r2.totalTokens : -1, 60)
      assert.equal(agyUsageMemo.stats.misses - before.misses, 1)
      assert.equal(agyUsageMemo.stats.hits - before.hits, 1)

      await writeConvDb(dbFile, [
        { tsSeconds: nowSec - 120, input: 50, output: 10 },
        { tsSeconds: nowSec - 60, input: 30, output: 10 },
      ])
      await utimes(dbFile, new Date(NOW.getTime() + 1000), new Date(NOW.getTime() + 1000))
      const r3 = await readAgyUsage(account(dir), ctx(h))
      assert.equal(r3.status === 'ok' ? r3.totalTokens : -1, 100)
      assert.equal(agyUsageMemo.stats.misses - before.misses, 2)
    })
  })

  it('reports no-session when empty and unrecognized when recent databases are corrupt', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.gemini/antigravity-cli')
      const empty = await readAgyUsage(account(dir), ctx(h))
      assert.equal(empty.status === 'unavailable' && empty.reason, 'no-session')

      const convDir = join(dir, 'conversations')
      await mkdir(convDir, { recursive: true })
      const corrupt = join(convDir, 'bad.db')
      await writeFile(corrupt, 'not a sqlite file')
      await utimes(corrupt, NOW, NOW)
      const bad = await readAgyUsage(account(dir), ctx(h))
      assert.equal(bad.status === 'unavailable' && bad.reason, 'unrecognized')
    })
  })
})
