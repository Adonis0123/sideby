// Context tuning for a Claude Code Account (spec §3.18): replays its recent session logs against candidate
// Compaction Thresholds. Read-only and local. The one Host config value read is `autoCompactWindow` from the
// Account's `settings.json`; no other key of that file is returned, logged or cached.
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { FileMemo } from '../../core/file-memo.ts'
import { USAGE_DAYS } from '../../core/quota-levels.ts'
import {
  type Compaction,
  getOrCreate,
  type ModelRecords,
  type Turn,
  tuningResult,
} from '../../core/tuning.ts'
import type { Account, ReadContext, TuningResult } from '../../types.ts'
import { listJsonl } from './usage.ts'

const DAY_MS = 86_400_000
const SETTINGS_MAX_BYTES = 1_000_000

/** Context window of a model, from the table or the records: a context that grew past 200K is a 1M window. */
export const isKnownClaudeModel = (id: string) => id.startsWith('claude-')
const windowOf = (maxCtx: number) => (maxCtx > 200_000 ? 1_000_000 : 200_000)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** `[key, ts, session, model, ctx, out, write5m, write1h]` */
type TurnRow = [string, number, string, string, number, number, number, number]
/** `[ts, session, model, trigger, pre, post]` */
type CompactionRow = [number, string, string, string, number, number]

/** What one session log contributes: only what the replay needs, never message text. */
interface Summary {
  lines: number
  parsed: number
  turns: TurnRow[]
  compactions: CompactionRow[]
  failed: boolean
}

interface Row {
  type?: unknown
  subtype?: unknown
  timestamp?: unknown
  sessionId?: unknown
  requestId?: unknown
  isSidechain?: unknown
  compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown } | null
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> | null } | null
}

async function parseFile(file: string, since: number): Promise<Summary> {
  const out: Summary = { lines: 0, parsed: 0, turns: [], compactions: [], failed: false }
  const byKey = new Map<string, TurnRow>()
  const lastModel = new Map<string, string>()
  // Compactions logged before the first assistant row of their session in this file: they take that row's model.
  const orphans = new Map<string, CompactionRow[]>()
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
      const ts = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      const session = typeof row?.sessionId === 'string' ? row.sessionId : file
      if (row?.type === 'system' && row.subtype === 'compact_boundary') {
        const m = row.compactMetadata
        const pre = num(m?.preTokens)
        const post = num(m?.postTokens)
        if (!Number.isFinite(ts) || ts < since || !pre || !post) continue
        const t = m?.trigger
        const entry: CompactionRow = [
          ts,
          session,
          lastModel.get(session) ?? '',
          t === 'auto' || t === 'manual' ? t : 'unknown',
          pre,
          post,
        ]
        out.compactions.push(entry)
        if (!entry[2]) orphans.set(session, [...(orphans.get(session) ?? []), entry])
        continue
      }
      if (row?.type !== 'assistant' || row.isSidechain === true) continue
      const usage = row.message?.usage
      const model = row.message?.model
      if (
        typeof usage !== 'object' ||
        usage === null ||
        typeof model !== 'string' ||
        !model ||
        model === '<synthetic>'
      )
        continue
      lastModel.set(session, model)
      for (const o of orphans.get(session) ?? []) o[2] = model
      orphans.delete(session)
      if (!Number.isFinite(ts) || ts < since) continue
      const id = row.message?.id
      const key =
        typeof id === 'string'
          ? id
          : typeof row.requestId === 'string'
            ? `request:${row.requestId}`
            : `${file}:${out.lines}`
      const cc = usage.cache_creation as
        | { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
        | undefined
      const cacheWrite = num(usage.cache_creation_input_tokens)
      const w1h = Math.min(num(cc?.ephemeral_1h_input_tokens), cacheWrite)
      const ctx = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + cacheWrite
      // Re-insert so the last line of a message wins, as in the usage reader.
      byKey.delete(key)
      byKey.set(key, [key, ts, session, model, ctx, num(usage.output_tokens), cacheWrite - w1h, w1h])
    }
  } catch {
    out.failed = true
  }
  out.turns = [...byKey.values()]
  return out
}

/** Per-file summaries per Account directory; a file is parsed again only after it changed. */
export const claudeTuningMemo = new FileMemo<Summary>({ name: 'claude-tuning', version: 2 })

/** The Account's configured Compaction Threshold, or null for the Host default. Reads exactly one key. */
export async function readAutoCompactWindow(dir: string): Promise<number | null> {
  try {
    const file = join(dir, 'settings.json')
    const st = await stat(file)
    if (!st.isFile() || st.size > SETTINGS_MAX_BYTES) return null
    const json = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> | null
    const v = json && typeof json === 'object' ? json.autoCompactWindow : undefined
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null
  } catch {
    return null
  }
}

export async function readClaudeTuning(account: Account, ctx: ReadContext): Promise<TuningResult> {
  const files = await listJsonl(join(account.dir, 'projects'))
  if (!files.length)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: 'no Claude Code sessions recorded for this account yet',
    }
  const now = ctx.now.getTime()
  const since = now - USAGE_DAYS * DAY_MS
  const turns = new Map<string, TurnRow>()
  const compactions: CompactionRow[] = []
  const compactionKeys = new Set<string>()
  let lines = 0
  let parsed = 0
  const memo = claudeTuningMemo.pass(account.dir)
  for (const file of files) {
    const st = await stat(file).catch(() => null)
    if (!st || st.mtimeMs < since) continue
    const s = await memo.get(
      file,
      st,
      () => parseFile(file, since),
      (v) => !v.failed,
    )
    lines += s.lines
    parsed += s.parsed
    for (const t of s.turns) {
      turns.delete(t[0])
      turns.set(t[0], t)
    }
    // A resumed session can repeat its history in a new file; one compaction counts once.
    for (const c of s.compactions)
      if (!compactionKeys.has(`${c[1]}:${c[0]}:${c[4]}`)) {
        compactionKeys.add(`${c[1]}:${c[0]}:${c[4]}`)
        compactions.push(c)
      }
  }
  memo.done()
  if (lines > 0 && parsed === 0)
    return {
      status: 'unavailable',
      reason: 'unrecognized',
      detail: `session logs in the last ${USAGE_DAYS} days could not be parsed as JSON lines`,
    }

  // A compaction whose own file never named a model takes the model its session used in another file. The rows
  // belong to the cache, so a resolved copy is made instead of editing them.
  const sessionModel = new Map<string, string>()
  for (const t of [...turns.values()].sort((x, y) => x[1] - y[1])) sessionModel.set(t[2], t[3])
  const resolved = compactions.map(
    (c): CompactionRow => (c[2] ? c : [c[0], c[1], sessionModel.get(c[1]) ?? '', c[3], c[4], c[5]]),
  )

  // Group per model, then per session; a session that switched models is replayed once per model.
  const byModel = new Map<string, Map<string, Turn[]>>()
  for (const [, ts, session, model, c, out, w5, w1] of turns.values()) {
    if (ts > now || ts < since) continue
    const sessions = getOrCreate(byModel, model, () => new Map<string, Turn[]>())
    const list = getOrCreate(sessions, session, () => [] as Turn[])
    list.push({ ts, ctx: c, out, write5m: w5, write1h: w1 })
  }
  if (!byModel.size)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Claude Code turns in the last ${USAGE_DAYS} days`,
    }

  const configured = await readAutoCompactWindow(account.dir)
  const records = [...byModel].map(([model, sessions]): ModelRecords => {
    const list = [...sessions.values()].map((t) => t.sort((a, b) => a.ts - b.ts))
    const maxCtx = Math.max(0, ...list.flat().map((t) => t.ctx))
    const comps: Compaction[] = resolved
      .filter((c) => c[2] === model && c[0] >= since && c[0] <= now)
      .map((c) => ({ ts: c[0], trigger: c[3] as Compaction['trigger'], pre: c[4], post: c[5] }))
    const window = Math.max(windowOf(maxCtx), windowOf(Math.max(0, ...comps.map((c) => c.pre))))
    return { model, sessions: list, compactions: comps, contextWindow: window }
  })
  return tuningResult(USAGE_DAYS, records, { configured, known: isKnownClaudeModel, mayRecommend: true })
}
