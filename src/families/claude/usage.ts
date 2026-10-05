// Usage for a Claude Code Account, counted from its own session logs (`<dir>/projects/**/*.jsonl`).
// One assistant message can be logged on several lines; the last line per `message.id` wins. Each file's parse is
// remembered until the file changes (core/file-memo.ts), so a refresh reads only the logs that grew.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { FileMemo } from '../../core/file-memo.ts'
import { USAGE_DAYS } from '../../core/quota-levels.ts'
import { dailyBuckets } from '../../core/usage-days.ts'
import type { Account, ReadContext, UsageResult } from '../../types.ts'

const DAY_MS = 86_400_000

interface Entry {
  timestamp: number
  session: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

async function listJsonl(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    // Dirent types do not follow symlinks, so a linked directory can never loop the walk.
    if (e.isDirectory()) await listJsonl(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

interface Row {
  type?: unknown
  timestamp?: unknown
  sessionId?: unknown
  requestId?: unknown
  message?: { id?: unknown; usage?: Record<string, unknown> | null } | null
}

/** What one session log holds: its usage rows in file order, keyed for the "last line wins" dedupe. */
interface Parsed {
  lines: number
  parsed: number
  rows: [string, Entry][]
  /** The read stopped early; the rows so far still count, but the result is not remembered. */
  failed: boolean
}

async function parseFile(file: string): Promise<Parsed> {
  const out: Parsed = { lines: 0, parsed: 0, rows: [], failed: false }
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of rl) {
      if (!line.trim()) continue
      out.lines++
      let row: Row
      try {
        row = JSON.parse(line) as Row
      } catch {
        continue
      }
      out.parsed++
      if (row?.type !== 'assistant') continue
      const usage = row.message?.usage
      if (typeof usage !== 'object' || usage === null) continue
      const id = row.message?.id
      const key =
        typeof id === 'string'
          ? id
          : typeof row.requestId === 'string'
            ? `request:${row.requestId}`
            : `${file}:${out.lines}`
      out.rows.push([
        key,
        {
          timestamp: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN,
          session: typeof row.sessionId === 'string' ? row.sessionId : file,
          input: count(usage.input_tokens),
          output: count(usage.output_tokens),
          cacheRead: count(usage.cache_read_input_tokens),
          cacheWrite: count(usage.cache_creation_input_tokens),
        },
      ])
    }
  } catch {
    // An unreadable file is skipped; the others still count.
    out.failed = true
  }
  return out
}

/** Parsed session logs per Account directory; a file is parsed again only after it changed. */
export const claudeUsageMemo = new FileMemo<Parsed>()

export async function readClaudeUsage(account: Account, ctx: ReadContext): Promise<UsageResult> {
  const files = await listJsonl(join(account.dir, 'projects'))
  if (!files.length)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: 'no Claude Code sessions recorded for this account yet',
    }
  const now = ctx.now.getTime()
  const since = now - USAGE_DAYS * DAY_MS
  const entries = new Map<string, Entry>()
  let lines = 0
  let parsed = 0
  const memo = claudeUsageMemo.pass(account.dir)

  for (const file of files) {
    const st = await stat(file).catch(() => null)
    if (!st || st.mtimeMs < since) continue
    const p = await memo.get(
      file,
      st,
      () => parseFile(file),
      (v) => !v.failed,
    )
    lines += p.lines
    parsed += p.parsed
    for (const [key, entry] of p.rows) {
      // Re-insert so the last occurrence wins.
      entries.delete(key)
      entries.set(key, entry)
    }
  }
  memo.done()
  if (lines > 0 && parsed === 0)
    return {
      status: 'unavailable',
      reason: 'unrecognized',
      detail: `session logs in the last ${USAGE_DAYS} days could not be parsed as JSON lines`,
    }

  const sessions = new Set<string>()
  const days = dailyBuckets(ctx.now)
  let last = Number.NEGATIVE_INFINITY
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const e of entries.values()) {
    if (!Number.isFinite(e.timestamp) || e.timestamp > now) continue
    if (e.timestamp > last) last = e.timestamp
    if (e.timestamp < since) continue
    sessions.add(e.session)
    inputTokens += e.input
    outputTokens += e.output
    cacheReadTokens += e.cacheRead
    cacheWriteTokens += e.cacheWrite
    days.add(e.timestamp, e.input + e.output + e.cacheRead + e.cacheWrite)
  }
  return {
    status: 'ok',
    days: USAGE_DAYS,
    sessions: sessions.size,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    daily: days.daily,
    ...(Number.isFinite(last) ? { lastActivityAt: new Date(last).toISOString() } : {}),
  }
}
