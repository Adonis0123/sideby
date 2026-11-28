// WHY: ADR-0093 read-only Antigravity CLI local usage reader from `<account.dir>/conversations/*.db`.
// Opens each conversation SQLite database with the same WAL/immutable guard as history.ts (ADR-0082) so no
// `-wal`/`-shm` files are created in the Host directory, decodes only token/model/timestamp metadata from
// `gen_metadata` and `steps` (never conversation text or credentials), and caches per-file parses via FileMemo.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileMemo, type FileStats } from '../../core/file-memo.ts'
import { lstatOrNull } from '../../core/fs-safe.ts'
import { loadSqlite } from '../../core/history-index.ts'
import { USAGE_DAYS } from '../../core/quota-levels.ts'
import { dailyBuckets } from '../../core/usage-days.ts'
import type { Account, ReadContext, UsageResult } from '../../types.ts'

const DAY_MS = 86_400_000
const GENERATION_STEP_TYPE = 15
const MAX_STEP_METADATA_BYTES = 65_536
const MAX_GEN_BLOB_BYTES = 64 * 1024 * 1024
const KNOWN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface AgyGenerationTurn {
  timestamp: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model?: string
  effort?: string
}

export interface ParsedConversationDb {
  rows: number
  parsed: number
  turns: AgyGenerationTurn[]
  failed: boolean
}

type ProtoField =
  | { num: number; kind: 'varint'; value: number }
  | { num: number; kind: 'bytes'; value: Uint8Array }

function decodeVarint(buf: Uint8Array, start: number): [number, number] | undefined {
  let result = 0n
  let shift = 0n
  for (let i = 0; i < 10; i++) {
    const pos = start + i
    if (pos >= buf.length) return undefined
    const byte = buf[pos]!
    if (i === 9 && (byte & 0x7f) > 1) return undefined
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      const n = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : Number.NaN
      return [n, pos + 1]
    }
    shift += 7n
  }
  return undefined
}

function readProtoFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < buf.length) {
    const tagRes = decodeVarint(buf, offset)
    if (!tagRes) break
    const [tag, afterTag] = tagRes
    if (!Number.isSafeInteger(tag) || tag <= 0) break
    const num = Math.floor(tag / 8)
    const wire = tag % 8
    if (num <= 0) break
    if (wire === 0) {
      const valRes = decodeVarint(buf, afterTag)
      if (!valRes) break
      const [value, next] = valRes
      fields.push({ num, kind: 'varint', value })
      offset = next
    } else if (wire === 1) {
      if (afterTag + 8 > buf.length) break
      offset = afterTag + 8
    } else if (wire === 2) {
      const lenRes = decodeVarint(buf, afterTag)
      if (!lenRes) break
      const [len, dataStart] = lenRes
      if (!Number.isSafeInteger(len) || len < 0 || dataStart + len > buf.length) break
      fields.push({ num, kind: 'bytes', value: buf.subarray(dataStart, dataStart + len) })
      offset = dataStart + len
    } else if (wire === 5) {
      if (afterTag + 4 > buf.length) break
      offset = afterTag + 4
    } else {
      break
    }
  }
  return fields
}

function lastBytes(fields: readonly ProtoField[], num: number): Uint8Array | undefined {
  let found: Uint8Array | undefined
  for (const f of fields) if (f.num === num && f.kind === 'bytes') found = f.value
  return found
}

function lastVarint(fields: readonly ProtoField[], num: number): number | undefined {
  let found: number | undefined
  for (const f of fields)
    if (f.num === num && f.kind === 'varint' && Number.isSafeInteger(f.value) && f.value >= 0) found = f.value
  return found
}

const utf8 = new TextDecoder('utf-8', { fatal: false })

function lastString(fields: readonly ProtoField[], num: number): string | undefined {
  const bytes = lastBytes(fields, num)
  if (!bytes?.length) return undefined
  const s = utf8.decode(bytes).trim()
  return s || undefined
}

export function extractAgyEffort(label: string | undefined): string | undefined {
  if (!label) return undefined
  const m = /\(([^()]+)\)\s*$/.exec(label.trim())
  if (!m) return undefined
  const candidate = m[1]!.trim().toLowerCase()
  return KNOWN_EFFORTS.has(candidate) ? candidate : undefined
}

export function decodeAgyStepTimestampMs(metadata: Uint8Array): number | undefined {
  const tsBytes = lastBytes(readProtoFields(metadata), 1)
  if (!tsBytes) return undefined
  const seconds = lastVarint(readProtoFields(tsBytes), 1)
  if (seconds === undefined || seconds <= 0) return undefined
  return seconds * 1000
}

export interface DecodedGeneration {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model?: string
  effort?: string
}

export function decodeAgyGeneration(blob: Uint8Array): DecodedGeneration | undefined {
  const wrapped = lastBytes(readProtoFields(blob), 1)
  if (!wrapped) return undefined
  const wf = readProtoFields(wrapped)
  const usageBytes = lastBytes(wf, 4)
  if (!usageBytes) return undefined
  const uf = readProtoFields(usageBytes)
  const input = lastVarint(uf, 2) ?? 0
  const output = lastVarint(uf, 3) ?? 0
  const cacheWrite = lastVarint(uf, 4) ?? 0
  const cacheRead = lastVarint(uf, 5) ?? 0
  if (input + output + cacheRead + cacheWrite <= 0) return undefined
  const modelId = lastString(wf, 19)
  const label = lastString(wf, 21)
  const model = modelId ?? label
  const effort = extractAgyEffort(label)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

export async function readAgyConversationDb(file: string, live: boolean): Promise<ParsedConversationDb> {
  const out: ParsedConversationDb = { rows: 0, parsed: 0, turns: [], failed: false }
  const sqlite = await loadSqlite()
  if (!sqlite) {
    out.failed = true
    return out
  }
  let target: string | URL = file
  if (!live) {
    target = pathToFileURL(file)
    target.searchParams.set('immutable', '1')
  }
  let db: InstanceType<typeof sqlite.DatabaseSync> | undefined
  try {
    db = new sqlite.DatabaseSync(target, { readOnly: true })
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
          name?: unknown
        }[]
      )
        .map((r) => r.name)
        .filter((n): n is string => typeof n === 'string'),
    )
    if (!tables.has('gen_metadata')) return out

    const stepTimestamps: (number | undefined)[] = []
    if (tables.has('steps')) {
      const stepCols = new Set(
        (db.prepare("SELECT name FROM pragma_table_info('steps')").all() as unknown as { name?: unknown }[])
          .map((r) => r.name)
          .filter((n): n is string => typeof n === 'string'),
      )
      if (stepCols.has('step_type') && stepCols.has('metadata') && stepCols.has('idx')) {
        const sRows = db
          .prepare(
            `SELECT CASE WHEN length(metadata) <= ${MAX_STEP_METADATA_BYTES} THEN metadata ELSE NULL END AS metadata
             FROM steps WHERE step_type = ? ORDER BY idx`,
          )
          .all(GENERATION_STEP_TYPE) as unknown as { metadata?: Uint8Array | null }[]
        for (const r of sRows) {
          stepTimestamps.push(
            r.metadata instanceof Uint8Array ? decodeAgyStepTimestampMs(r.metadata) : undefined,
          )
        }
      }
    }

    let lastStepTs: number | undefined
    for (let i = stepTimestamps.length - 1; i >= 0; i--) {
      if (stepTimestamps[i] !== undefined) {
        lastStepTs = stepTimestamps[i]
        break
      }
    }

    const gRows = db
      .prepare(
        `SELECT CASE WHEN length(data) <= ${MAX_GEN_BLOB_BYTES} THEN data ELSE NULL END AS data
         FROM gen_metadata ORDER BY idx`,
      )
      .all() as unknown as { data?: Uint8Array | null }[]

    for (let i = 0; i < gRows.length; i++) {
      const blob = gRows[i]!.data
      out.rows++
      if (!(blob instanceof Uint8Array)) continue
      const gen = decodeAgyGeneration(blob)
      if (!gen) continue
      out.parsed++
      // WHY: ADR-0093 gen_metadata rows map ordinally to step_type=15 steps; occasional trailing auxiliary rows fall back to the final step timestamp.
      const ts = stepTimestamps[i] ?? lastStepTs
      if (ts === undefined) continue
      out.turns.push({ timestamp: ts, ...gen })
    }
  } catch {
    out.failed = true
  } finally {
    db?.close()
  }
  return out
}

interface ConversationFile {
  path: string
  stats: FileStats
  live: boolean
}

async function listConversationDbs(accountDir: string): Promise<ConversationFile[]> {
  const dir = join(accountDir, 'conversations')
  const dirSt = await lstatOrNull(dir)
  if (!dirSt?.isDirectory() || dirSt.isSymbolicLink()) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ConversationFile[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.db')) continue
    const file = join(dir, e.name)
    const [dbSt, walSt, shmSt] = await Promise.all([
      lstatOrNull(file),
      lstatOrNull(`${file}-wal`),
      lstatOrNull(`${file}-shm`),
    ])
    if (!dbSt?.isFile() || dbSt.isSymbolicLink()) continue
    const walFile = walSt?.isFile() && !walSt.isSymbolicLink() ? walSt : null
    const shmFile = shmSt?.isFile() && !shmSt.isSymbolicLink() ? shmSt : null
    // WHY: ADR-0093 active SQLite WAL writes grow `-wal` before checkpointing `.db`, so combine both stats into the memo key and mtime filter.
    const stats: FileStats = walFile
      ? {
          size: dbSt.size + walFile.size,
          mtimeMs: Math.max(dbSt.mtimeMs, walFile.mtimeMs),
          ctimeMs: Math.max(dbSt.ctimeMs, walFile.ctimeMs),
          ino: dbSt.ino,
        }
      : dbSt
    out.push({ path: file, stats, live: Boolean(walFile && shmFile) })
  }
  return out
}

export const agyUsageMemo = new FileMemo<ParsedConversationDb>({ name: 'agy-usage', version: 1 })

export async function readAgyUsage(account: Account, ctx: ReadContext): Promise<UsageResult> {
  const files = await listConversationDbs(account.dir)
  if (!files.length)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: 'no Antigravity CLI sessions recorded for this account yet',
    }
  const now = ctx.now.getTime()
  const since = now - USAGE_DAYS * DAY_MS
  const memo = agyUsageMemo.pass(account.dir)
  const days = dailyBuckets(ctx.now)

  let sessions = 0
  let totalRows = 0
  let totalParsed = 0
  let failedFiles = 0
  let scannedFiles = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let last = Number.NEGATIVE_INFINITY
  let lastTurn: AgyGenerationTurn | undefined

  for (const f of files) {
    if (f.stats.mtimeMs < since) continue
    scannedFiles++
    const parsed = await memo.get(
      f.path,
      f.stats,
      () => readAgyConversationDb(f.path, f.live),
      (v) => !v.failed,
    )
    if (parsed.failed) failedFiles++
    totalRows += parsed.rows
    totalParsed += parsed.parsed
    let inWindow = false
    for (const t of parsed.turns) {
      if (!Number.isFinite(t.timestamp) || t.timestamp > now) continue
      if (t.timestamp > last) last = t.timestamp
      if (t.model && (!lastTurn || t.timestamp >= lastTurn.timestamp)) lastTurn = t
      if (t.timestamp < since) continue
      inWindow = true
      inputTokens += t.input
      outputTokens += t.output
      cacheReadTokens += t.cacheRead
      cacheWriteTokens += t.cacheWrite
      days.add(t.timestamp, t.input + t.output + t.cacheRead + t.cacheWrite)
    }
    if (inWindow) sessions++
  }
  memo.done()

  if (sessions === 0) {
    if ((totalRows > 0 && totalParsed === 0) || (scannedFiles > 0 && failedFiles === scannedFiles))
      return {
        status: 'unavailable',
        reason: 'unrecognized',
        detail: `Antigravity CLI conversation databases in the last ${USAGE_DAYS} days could not be read`,
      }
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Antigravity CLI turns in the last ${USAGE_DAYS} days`,
    }
  }

  return {
    status: 'ok',
    days: USAGE_DAYS,
    sessions,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    daily: days.daily,
    ...(Number.isFinite(last) ? { lastActivityAt: new Date(last).toISOString() } : {}),
    ...(lastTurn?.model ? { lastModel: lastTurn.model } : {}),
    ...(lastTurn?.effort ? { lastEffort: lastTurn.effort } : {}),
  }
}
