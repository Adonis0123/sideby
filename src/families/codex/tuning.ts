// Context tuning for a Codex Account (spec §3.18): observation only. The default Compaction Threshold and its
// scope have no first-hand source, so this shows how large the context was when Codex compacted, never a
// suggestion. The one Host config value read is `model_auto_compact_token_limit` from the Account's `config.toml`.
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
import { listRollouts } from './rollout.ts'

const DAY_MS = 86_400_000
const CONFIG_MAX_BYTES = 1_000_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** What one rollout contributes: per `token_count` the context size, and each compaction's before and after. */
interface Summary {
  /** `[ts, model, ctx, window]` */
  turns: [number, string, number, number][]
  /** `[ts, model, pre, post]` */
  compactions: [number, string, number, number][]
  failed: boolean
}

async function parseFile(file: string, since: number): Promise<Summary> {
  const out: Summary = { turns: [], compactions: [], failed: false }
  let model = ''
  let last = 0
  let pending: { ts: number; model: string; pre: number } | null = null
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of rl) {
      if (!line.includes('token_count') && !line.includes('"compacted"') && !line.includes('turn_context'))
        continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObj(row)) continue
      const payload = isObj(row.payload) ? row.payload : {}
      const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      if (row.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model) model = payload.model
      } else if (row.type === 'compacted') {
        if (Number.isFinite(ts) && last > 0) pending = { ts, model, pre: last }
      } else if (row.type === 'event_msg' && payload.type === 'token_count') {
        const info = isObj(payload.info) ? payload.info : null
        const usage = info && isObj(info.last_token_usage) ? info.last_token_usage : null
        const ctx = usage ? num(usage.input_tokens) : 0
        if (!ctx || !Number.isFinite(ts)) continue
        last = ctx
        if (pending) {
          if (pending.ts >= since && pending.model)
            out.compactions.push([pending.ts, pending.model, pending.pre, ctx])
          pending = null
        }
        if (ts >= since && model) out.turns.push([ts, model, ctx, num(info?.model_context_window)])
      }
    }
  } catch {
    out.failed = true
  }
  return out
}

/** Per-rollout summaries per Account directory; a rollout is parsed again only after it changed. */
export const codexTuningMemo = new FileMemo<Summary>({ name: 'codex-tuning', version: 1 })

/** The Account's configured threshold, or null for the Host default. Takes one top-level key; nothing else is kept. */
export async function readCompactLimit(dir: string): Promise<number | null> {
  try {
    const file = join(dir, 'config.toml')
    const st = await stat(file)
    if (!st.isFile() || st.size > CONFIG_MAX_BYTES) return null
    for (const raw of (await readFile(file, 'utf8')).split('\n')) {
      const line = raw.trim()
      if (line.startsWith('[')) return null // a table starts: no top-level key is left
      const m = /^model_auto_compact_token_limit\s*=\s*([0-9_]+)\s*(#.*)?$/.exec(line)
      if (m) {
        const n = Number((m[1] ?? '').replaceAll('_', ''))
        return Number.isFinite(n) && n > 0 ? n : null
      }
    }
  } catch {
    // unreadable config: the Host default
  }
  return null
}

export async function readCodexTuning(account: Account, ctx: ReadContext): Promise<TuningResult> {
  const now = ctx.now.getTime()
  const since = now - USAGE_DAYS * DAY_MS
  const files = (await listRollouts(account.dir)).filter((f) => f.mtimeMs >= since)
  if (!files.length)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Codex session in the last ${USAGE_DAYS} days`,
    }
  const memo = codexTuningMemo.pass(account.dir)
  const byModel = new Map<
    string,
    { sessions: Turn[][]; compactions: Compaction[]; window: number; maxCtx: number }
  >()
  const entry = (model: string) =>
    getOrCreate(byModel, model, () => ({
      sessions: [] as Turn[][],
      compactions: [] as Compaction[],
      window: 0,
      maxCtx: 0,
    }))
  for (const f of files) {
    const s = await memo.get(
      f.path,
      f.stats,
      () => parseFile(f.path, since),
      (v) => !v.failed,
    )
    const perModel = new Map<string, Turn[]>()
    for (const [ts, model, c, window] of s.turns) {
      if (ts > now || ts < since) continue
      const e = entry(model)
      e.window = Math.max(e.window, window)
      e.maxCtx = Math.max(e.maxCtx, c)
      const list = getOrCreate(perModel, model, () => [] as Turn[])
      list.push({ ts, ctx: c, out: 0, write5m: 0, write1h: 0 })
    }
    for (const [model, turns] of perModel) entry(model).sessions.push(turns)
    for (const [ts, model, pre, post] of s.compactions) {
      if (ts > now || ts < since) continue
      entry(model).compactions.push({ ts, trigger: 'unknown', pre, post })
    }
  }
  memo.done()
  if (!byModel.size)
    return {
      status: 'unavailable',
      reason: 'no-session',
      detail: `no Codex token counts in the last ${USAGE_DAYS} days`,
    }
  const configured = await readCompactLimit(account.dir)
  const records = [...byModel].map(
    ([model, e]): ModelRecords => ({
      model,
      sessions: e.sessions,
      compactions: e.compactions,
      contextWindow: e.window || e.maxCtx,
    }),
  )
  return tuningResult(USAGE_DAYS, records, { configured, known: () => false, mayRecommend: false })
}
