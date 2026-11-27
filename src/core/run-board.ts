// WHY: Read-only live Run Board model for sideby Panel, CLI (`sideby runs`), and post-compaction pointer hook.
// Reuses `dispatchStateDir` from `run-link.ts` and enforces strict O_NOFOLLOW, ownership, and byte bounds.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WatchDir } from '../panel/changes.ts'
import type { Env } from '../types.ts'
import type { LiveSession } from './live-sessions.ts'
import { dispatchStateDir } from './run-link.ts'

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
export const RUNS_MAX_BYTES = 512 * 1024
export const RUN_JSON_MAX_BYTES = 2 * 1024 * 1024
export const STREAM_TAIL_BYTES = 64 * 1024
export const WAIT_LOG_TAIL_BYTES = 8 * 1024
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024
export const OUTWARD_META_MAX_CHARS = 4 * 1024
export const OUTWARD_DRAFT_MAX_CHARS = 64 * 1024
const MAX_CLOSED_RUNS = 50
const MAX_TEXT = 240
const MAX_ACTIVITY = 120
const MAX_CLAUDE_ACCOUNT_DIRS = 20
const MAX_CLAUDE_PROJECT_DIRS = 120
const ENDED_LANE_STATES = new Set(['done', 'failed', 'stopped'])
const ENDED_WAIT_STATES = new Set(['done', 'failed', 'stopped'])

// biome-ignore lint/complexity/useRegexLiterals: control characters in regex literal trigger noControlCharactersInRegex
const CONTROL = new RegExp(String.raw`[\x00-\x1f\x7f-\x9f]+`, 'g')

export const isValidRunId = (id: string): boolean => RUN_ID_RE.test(id)

export type StepState = 'queued' | 'working' | 'done' | 'blocked'
export type LiveLaneState =
  | 'done'
  | 'failed'
  | 'stopped'
  | 'needs-you'
  | 'attention'
  | 'finished'
  | 'queued'
  | 'working'

export interface RunSummary {
  id: string
  objective: string
  state: 'active' | 'closed'
  createdAt?: string
  updatedAt?: string
  activeLanes: number
  totalLanes: number
  openAsks: number
  runningWaits: number
  stepsDone: number
  stepsTotal: number
  coordinator?: string
  coordinatorSession?: string
  dir: string
}

export interface LiveStep {
  title: string
  state: StepState
  note?: string
}

export interface AutoStepItem {
  title: string
  state: StepState
}

export interface AutoSteps {
  source: 'agy' | 'claude'
  updatedAt?: string
  items: AutoStepItem[]
}

export interface LiveLane {
  id: string
  title: string
  role?: string
  account?: string
  branch?: string
  worktree?: string
  round: number
  ledgerState: string
  liveState: LiveLaneState
  activity?: string
  note?: string
  summary?: string
  evidence?: string
  streamEnded: boolean
  streamFailed: boolean
  streamMtimeMs?: number
  tokens?: { input: number; output: number }
  costUsd?: number
  sessionId?: string
  sessionStatus?: 'busy' | 'idle' | 'needs-you' | 'unknown'
  sessionLabel?: string
  startedAt?: string
  updatedAt?: string
  endedAt?: string
  elapsedMs?: number
  waitingOn: string[]
  openAsks: string[]
}

export interface LiveAsk {
  id: string
  state: 'open' | 'answered'
  question: string
  recommend?: string
  evidence?: string
  blocks?: string
  lane?: string
  outward?: boolean
  recipient?: string
  recipientTruncated?: boolean
  channel?: string
  channelTruncated?: boolean
  draft?: string
  draftTruncated?: boolean
  answer?: string
  createdAt?: string
  answeredAt?: string
}

export interface LiveWait {
  id: string
  title: string
  state: string
  stage?: string
  note?: string
  log?: string
  lastLine?: string
  logMtimeMs?: number
  startedAt?: string
  updatedAt?: string
}

export interface LiveOutput {
  kind: 'lane' | 'artifact' | 'commit'
  title: string
  summary?: string
  evidence?: string
  path?: string
  meta?: string
}

export interface LiveDecision {
  what: string
  choice: string
  why?: string
  options?: string
}

export interface LiveGrant {
  scope: string
  words?: string
  outward?: boolean
}

export interface LiveRunView {
  id: string
  objective: string
  state: 'active' | 'closed'
  paused: boolean
  dir: string
  createdAt?: string
  updatedAt?: string
  coordinator?: string
  coordinatorSession?: string
  steps: LiveStep[]
  autoSteps: AutoSteps | null
  asks: LiveAsk[]
  lanes: LiveLane[]
  waits: LiveWait[]
  outputs: LiveOutput[]
  decisions: LiveDecision[]
  grants: LiveGrant[]
  fingerprint: string
}

export interface CompactPointerRun {
  id: string
  objective: string
  dir: string
  panelUrl: string
  stepsDone: number
  stepsTotal: number
  currentStep?: string
  activeLanes: { id: string; title: string; liveState: LiveLaneState }[]
  openAsks: { id: string; question: string }[]
}

export interface RunCompactPointerResult {
  runs: CompactPointerRun[]
  text: string
}

interface RegistryRow {
  id: string
  dir: string
  objective: string
  state: 'active' | 'closed'
}

function cleanText(value: unknown, limit = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const one = value.replace(CONTROL, ' ').trim()
  if (!one) return undefined
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one
}

function cleanMultiline(value: unknown, limit = 2000): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return undefined
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : undefined
}

function shortPath(value: unknown, limit = 50): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return ''
  if (s.length <= limit) return s
  const parts = s.split(/[\\/]/).filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    return tail.length <= limit ? `…/${tail}` : tail.slice(-limit)
  }
  return `…${s.slice(-(limit - 1))}`
}

async function readSmallFile(path: string, maxBytes: number, uid?: number): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile() || st.size > maxBytes) return undefined
    if (uid !== undefined && st.uid !== uid) return undefined
    const buf = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (bytesRead > maxBytes) return undefined
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

async function readFileTail(
  path: string,
  maxBytes: number,
  uid?: number,
): Promise<{ text: string; mtimeMs: number } | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile()) return undefined
    if (uid !== undefined && st.uid !== uid) return undefined
    const size = st.size
    const start = Math.max(0, size - maxBytes)
    const toRead = Math.min(size, maxBytes)
    const buf = Buffer.alloc(toRead)
    let offset = 0
    while (offset < toRead) {
      const { bytesRead } = await fh.read(buf, offset, toRead - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    let text = buf.subarray(0, offset).toString('utf8')
    // WHY: When reading from the middle of a JSONL file, drop the leading partial line so JSON.parse only sees complete records.
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    return { text, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

async function ownedRealDir(dir: string, uid?: number): Promise<string | undefined> {
  if (!isAbsolute(dir)) return undefined
  try {
    const st = await lstat(dir)
    if (!st.isDirectory()) return undefined
    if (uid !== undefined && st.uid !== uid) return undefined
    return await realpath(dir)
  } catch {
    return undefined
  }
}

function isInsideDir(candidate: string, base: string): boolean {
  const rel = relative(base, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function noSymlinkUnder(rootReal: string, relPath: string): Promise<boolean> {
  const parts = relPath.split(sep).filter(Boolean)
  if (!parts.length) return false
  let cur = rootReal
  for (const part of parts) {
    if (part === '.' || part === '..') return false
    cur = join(cur, part)
    try {
      const st = await lstat(cur)
      if (st.isSymbolicLink()) return false
    } catch {
      return false
    }
  }
  return true
}

// WHY: Shared path boundary for both reading (`readLiveRun`) and watching (`runWatchTargets`) lane streams and wait logs.
// Strictly confines every path (relative or absolute) to regular, user-owned files strictly inside `runRealDir` with no symlinks.
export async function resolveRunArtifactPath(
  runRealDir: string,
  rawPath: unknown,
  uid?: number,
): Promise<string | undefined> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined
  const isRel = !isAbsolute(rawPath)
  const target = isRel ? resolve(runRealDir, rawPath) : resolve(rawPath)
  if (!isInsideDir(target, runRealDir)) return undefined
  try {
    const st = await lstat(target)
    if (!st.isFile()) return undefined
    if (uid !== undefined && st.uid !== uid) return undefined
    const real = await realpath(target)
    if (!isInsideDir(real, runRealDir)) return undefined
    const rel = relative(runRealDir, target)
    if (!(await noSymlinkUnder(runRealDir, rel))) return undefined
    return real
  } catch {
    return undefined
  }
}

async function readRegistry(env: Env, home: string, uid?: number): Promise<RegistryRow[]> {
  const path = join(dispatchStateDir(env, home), 'runs.json')
  const raw = await readSmallFile(path, RUNS_MAX_BYTES, uid)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const byId = new Map<string, RegistryRow>()
  for (const item of parsed) {
    const o = asObj(item)
    if (!o) continue
    const id = typeof o.id === 'string' ? o.id : ''
    const dir = typeof o.dir === 'string' ? o.dir : ''
    if (!RUN_ID_RE.test(id) || !isAbsolute(dir)) continue
    const objective = cleanText(o.objective, MAX_TEXT) ?? id
    const state = o.state === 'closed' ? 'closed' : 'active'
    byId.set(id, { id, dir, objective, state })
  }
  return [...byId.values()]
}

async function readRunJson(
  runDir: string,
  uid?: number,
): Promise<{ data: Record<string, unknown>; realDir: string } | undefined> {
  const realDir = await ownedRealDir(runDir, uid)
  if (!realDir) return undefined
  const file = join(realDir, 'run.json')
  const raw = await readSmallFile(file, RUN_JSON_MAX_BYTES, uid)
  if (!raw) return undefined
  try {
    const data = asObj(JSON.parse(raw))
    return data ? { data, realDir } : undefined
  } catch {
    return undefined
  }
}

function mapStepState(raw: unknown): StepState {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  if (s === 'done' || s === 'completed' || s === 'skipped') return 'done'
  if (s === 'working' || s === 'in_progress' || s === 'in-progress') return 'working'
  if (s === 'blocked' || s === 'failed') return 'blocked'
  return 'queued'
}

export interface StreamSummary {
  activity?: string
  streamEnded: boolean
  streamFailed: boolean
  tokens?: { input: number; output: number }
  costUsd?: number
  sessionId?: string
}

function saidActivity(text: unknown): string {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return ''
  const first = raw.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return cleanText(first, MAX_ACTIVITY) ?? ''
}

export function parseLaneStream(tailText: string): StreamSummary {
  const info: StreamSummary = { streamEnded: false, streamFailed: false }
  let grokText = ''
  const working = (activity: string) => {
    const a = cleanText(activity, MAX_ACTIVITY)
    if (a) info.activity = a
    info.streamEnded = false
    info.streamFailed = false
  }
  for (const line of tailText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed[0] !== '{') continue
    let ev: Record<string, unknown> | undefined
    try {
      ev = asObj(JSON.parse(trimmed))
    } catch {
      continue
    }
    if (!ev) continue
    const etype = typeof ev.type === 'string' ? ev.type : ''
    if (etype === 'system' && typeof ev.session_id === 'string' && SESSION_ID_RE.test(ev.session_id)) {
      info.sessionId = ev.session_id
    } else if (etype === 'assistant') {
      const msg = asObj(ev.message)
      const usage = asObj(msg?.usage)
      if (usage) {
        const input =
          Number(usage.input_tokens || 0) +
          Number(usage.cache_read_input_tokens || 0) +
          Number(usage.cache_creation_input_tokens || 0)
        const output = Number(usage.output_tokens || 0)
        if (input > 0 || output > 0) info.tokens = { input, output }
      }
      const content = Array.isArray(msg?.content) ? msg.content : []
      for (const rawPart of content) {
        const part = asObj(rawPart)
        if (!part) continue
        if (part.type === 'tool_use') {
          const name = cleanText(part.name, 40) ?? 'tool'
          const inp = asObj(part.input)
          const desc = cleanText(inp?.description ?? inp?.command ?? inp?.pattern, 70)
          const fp = !desc && inp?.file_path ? shortPath(inp.file_path) : ''
          const detail = desc || fp
          working(detail ? `${name}: ${detail}` : name)
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          working(saidActivity(part.text))
        }
      }
    } else if (etype === 'result' && ('subtype' in ev || 'is_error' in ev || 'session_id' in ev)) {
      info.streamEnded = true
      if (typeof ev.session_id === 'string' && SESSION_ID_RE.test(ev.session_id))
        info.sessionId = ev.session_id
      info.streamFailed = Boolean(ev.is_error) || (ev.subtype !== undefined && ev.subtype !== 'success')
      if (typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd))
        info.costUsd = ev.total_cost_usd
    } else if (etype === 'thread.started' || etype === 'turn.started') {
      if (etype === 'thread.started' && typeof ev.thread_id === 'string' && SESSION_ID_RE.test(ev.thread_id))
        info.sessionId = ev.thread_id
      info.streamEnded = false
      info.streamFailed = false
    } else if (etype === 'item.started' || etype === 'item.completed' || etype === 'item.updated') {
      const item = asObj(ev.item)
      const itype =
        typeof item?.type === 'string' ? item.type : typeof item?.item_type === 'string' ? item.item_type : ''
      if (itype === 'command_execution') {
        const cmd = cleanText(item?.command, 80)
        working(cmd ? `Run: ${cmd}` : 'Run command')
      } else if (itype === 'agent_message' || itype === 'assistant_message') {
        working(saidActivity(item?.text))
      } else if (itype === 'file_change') {
        const changes = Array.isArray(item?.changes) ? item.changes : []
        const paths = changes
          .map((c) => shortPath(asObj(c)?.path, 36))
          .filter(Boolean)
          .slice(0, 3)
        working(paths.length ? `Edit: ${paths.join(', ')}` : 'Edit files')
      } else if (itype === 'mcp_tool_call' || itype === 'web_search') {
        const detail = cleanText(item?.tool ?? item?.query, 70)
        working(detail ? `${itype}: ${detail}` : itype)
      }
    } else if (etype === 'turn.completed') {
      info.streamEnded = true
      const usage = asObj(ev.usage)
      if (usage) {
        const prev = info.tokens ?? { input: 0, output: 0 }
        info.tokens = {
          input: prev.input + Number(usage.input_tokens || 0),
          output: prev.output + Number(usage.output_tokens || 0),
        }
      }
    } else if (etype === 'turn.failed') {
      info.streamEnded = true
      info.streamFailed = true
    } else if (etype === 'tool_call') {
      const name = cleanText(ev.toolName ?? ev.title, 40) ?? 'tool'
      const raw = asObj(ev.rawInput)
      const detail = cleanText(raw?.command ?? raw?.path ?? raw?.pattern, 70)
      working(detail ? `${name}: ${detail}` : name)
      grokText = ''
    } else if (etype === 'text' && typeof ev.data === 'string') {
      if (grokText.length < 1000) {
        grokText += ev.data
        working(saidActivity(grokText))
      }
    } else if (etype === 'end') {
      info.streamEnded = true
      info.streamFailed = ev.stopReason !== undefined && ev.stopReason !== 'end_turn'
      grokText = ''
    }
  }
  return info
}

export function parseAutoStepsAgy(tailText: string): AutoSteps | null {
  let latest: AutoStepItem[] | null = null
  let updatedAt: string | undefined
  for (const line of tailText.split('\n')) {
    if (!line.includes('update_steps')) continue
    let ev: Record<string, unknown> | undefined
    try {
      ev = asObj(JSON.parse(line))
    } catch {
      continue
    }
    if (!ev) continue
    const calls = Array.isArray(ev.tool_calls) ? ev.tool_calls : []
    for (const rawCall of calls) {
      const call = asObj(rawCall)
      if (call?.name !== 'update_steps') continue
      const args = asObj(call.args)
      let rawSteps: unknown = args?.steps
      // WHY: Antigravity CLI transcripts serialize `update_steps.args.steps` as a JSON string in some builds.
      if (typeof rawSteps === 'string') {
        try {
          rawSteps = JSON.parse(rawSteps)
        } catch {
          rawSteps = undefined
        }
      }
      if (!Array.isArray(rawSteps)) continue
      const items: AutoStepItem[] = []
      for (const s of rawSteps) {
        const so = asObj(s)
        const title = cleanText(so?.title, MAX_TEXT)
        if (!title) continue
        items.push({ title, state: mapStepState(so?.status) })
      }
      if (items.length) {
        latest = items
        updatedAt = typeof ev.created_at === 'string' ? ev.created_at : updatedAt
      }
    }
  }
  return latest ? { source: 'agy', ...(updatedAt ? { updatedAt } : {}), items: latest } : null
}

function extractTaskIdFromToolResult(content: unknown): string | undefined {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((item) => {
        if (typeof item === 'string') return item
        const o = asObj(item)
        return typeof o?.text === 'string' ? o.text : ''
      })
      .filter(Boolean)
      .join('\n')
  } else {
    const o = asObj(content)
    const direct = o?.taskId ?? o?.id ?? asObj(o?.task)?.id
    if (typeof direct === 'string' || typeof direct === 'number') {
      const s = String(direct).trim()
      if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s
    }
  }
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed[0] === '{') {
    try {
      const o = asObj(JSON.parse(trimmed))
      const direct = o?.taskId ?? o?.id ?? asObj(o?.task)?.id
      if (typeof direct === 'string' || typeof direct === 'number') {
        const s = String(direct).trim()
        if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s
      }
    } catch {}
  }
  const hashMatch = /\bTask\s*#([A-Za-z0-9_-]{1,64})\b/i.exec(trimmed)
  if (hashMatch?.[1]) return hashMatch[1]
  const jsonFieldMatch = /"(?:taskId|task_id|id)"\s*:\s*"?([A-Za-z0-9_-]{1,64})"?/i.exec(trimmed)
  if (jsonFieldMatch?.[1]) return jsonFieldMatch[1]
  const kvMatch = /\b(?:task\s*id|id)\s*[:=]\s*#?([A-Za-z0-9_-]{1,64})\b/i.exec(trimmed)
  if (kvMatch?.[1]) return kvMatch[1]
  return undefined
}

export function parseAutoStepsClaude(tailText: string): AutoSteps | null {
  let mode: 'todo' | 'task' | null = null
  let todos: AutoStepItem[] = []
  const tasks = new Map<string, AutoStepItem>()
  // WHY: Correlate both `TaskCreate` and `TaskUpdate` with their matching `tool_result` by `tool_use.id`, so failed
  // updates (`is_error: true`) never mark tasks done and 256 KiB tail windows never guess task ids 1..N.
  const pendingCreates = new Map<string, string>()
  const pendingUpdates = new Map<string, { id: string; statusRaw: string; explicitTitle?: string }>()
  let updatedAt: string | undefined

  for (const line of tailText.split('\n')) {
    if (
      !line.includes('TodoWrite') &&
      !line.includes('TaskCreate') &&
      !line.includes('TaskUpdate') &&
      !line.includes('tool_result')
    )
      continue
    let ev: Record<string, unknown> | undefined
    try {
      ev = asObj(JSON.parse(line))
    } catch {
      continue
    }
    if (!ev) continue
    const msg = asObj(ev.message)
    const content = Array.isArray(msg?.content) ? msg.content : []
    const ts = typeof ev.timestamp === 'string' ? ev.timestamp : undefined

    if (ev.type === 'assistant') {
      for (const rawPart of content) {
        const part = asObj(rawPart)
        if (part?.type !== 'tool_use') continue
        const name = typeof part.name === 'string' ? part.name : ''
        const inp = asObj(part.input)
        if (!inp) continue
        if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
          const next: AutoStepItem[] = []
          for (const t of inp.todos) {
            const to = asObj(t)
            const title = cleanText(to?.content ?? to?.title, MAX_TEXT)
            if (!title) continue
            next.push({ title, state: mapStepState(to?.status) })
          }
          todos = next
          mode = 'todo'
          if (ts) updatedAt = ts
        } else if (name === 'TaskCreate') {
          const title = cleanText(inp.subject ?? inp.title, MAX_TEXT)
          const toolUseId = typeof part.id === 'string' && part.id ? part.id : ''
          if (!title || !toolUseId) continue
          pendingCreates.set(toolUseId, title)
          if (ts) updatedAt = ts
        } else if (name === 'TaskUpdate') {
          const toolUseId = typeof part.id === 'string' && part.id ? part.id : ''
          const id =
            typeof inp.taskId === 'string' || typeof inp.taskId === 'number' ? String(inp.taskId).trim() : ''
          if (!toolUseId || !id) continue
          const statusRaw = typeof inp.status === 'string' ? inp.status.toLowerCase().trim() : ''
          const explicitTitle = cleanText(inp.subject ?? inp.title, MAX_TEXT)
          pendingUpdates.set(toolUseId, { id, statusRaw, ...(explicitTitle ? { explicitTitle } : {}) })
          if (ts) updatedAt = ts
        }
      }
    } else if (ev.type === 'user' && (pendingCreates.size > 0 || pendingUpdates.size > 0)) {
      for (const rawPart of content) {
        const part = asObj(rawPart)
        if (part?.type !== 'tool_result') continue
        const toolUseId = typeof part.tool_use_id === 'string' ? part.tool_use_id : ''
        if (!toolUseId) continue
        if (pendingCreates.has(toolUseId)) {
          const title = pendingCreates.get(toolUseId)!
          pendingCreates.delete(toolUseId)
          if (part.is_error === true) continue
          const realId = extractTaskIdFromToolResult(part.content)
          if (!realId) continue
          const existing = tasks.get(realId)
          tasks.set(realId, { title, state: existing?.state ?? 'queued' })
          mode = 'task'
          if (ts) updatedAt = ts
        } else if (pendingUpdates.has(toolUseId)) {
          const upd = pendingUpdates.get(toolUseId)!
          pendingUpdates.delete(toolUseId)
          if (part.is_error === true) continue
          if (upd.statusRaw === 'deleted') {
            tasks.delete(upd.id)
            mode = 'task'
            if (ts) updatedAt = ts
          } else {
            const existing = tasks.get(upd.id)
            const title = upd.explicitTitle ?? existing?.title
            if (title) {
              tasks.set(upd.id, {
                title,
                state: upd.statusRaw ? mapStepState(upd.statusRaw) : (existing?.state ?? 'queued'),
              })
              mode = 'task'
              if (ts) updatedAt = ts
            }
          }
        }
      }
    }
  }
  const items = mode === 'todo' ? todos : mode === 'task' ? [...tasks.values()] : []
  if (!items.length) return null
  return { source: 'claude', ...(updatedAt ? { updatedAt } : {}), items }
}

async function locateClaudeTranscript(
  home: string,
  sessionId: string,
  sessions?: readonly LiveSession[],
  uid?: number,
): Promise<string | undefined> {
  const hint = sessions?.find((s) => s.sessionId === sessionId && s.transcript)?.transcript
  if (hint && isAbsolute(hint)) {
    try {
      const st = await lstat(hint)
      if (st.isFile() && (uid === undefined || st.uid === uid)) return await realpath(hint)
    } catch {}
  }
  const fileName = `${sessionId}.jsonl`
  let entries: string[]
  try {
    entries = (await readdir(home))
      .filter((n) => n === '.claude' || n.startsWith('.claude-'))
      .slice(0, MAX_CLAUDE_ACCOUNT_DIRS)
  } catch {
    return undefined
  }
  for (const acc of entries) {
    const projRoot = join(home, acc, 'projects')
    let projects: string[]
    try {
      projects = (await readdir(projRoot)).slice(0, MAX_CLAUDE_PROJECT_DIRS)
    } catch {
      continue
    }
    for (const proj of projects) {
      const candidate = join(projRoot, proj, fileName)
      try {
        const st = await lstat(candidate)
        if (st.isFile() && (uid === undefined || st.uid === uid)) return await realpath(candidate)
      } catch {}
    }
  }
  return undefined
}

async function findCoordinatorTranscript(
  home: string,
  sessionId: string | undefined,
  sessions?: readonly LiveSession[],
  uid?: number,
): Promise<{ source: 'agy' | 'claude'; path: string } | undefined> {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return undefined
  const agyPath = join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  )
  try {
    const st = await lstat(agyPath)
    if (st.isFile() && (uid === undefined || st.uid === uid)) {
      return { source: 'agy', path: await realpath(agyPath) }
    }
  } catch {}
  const claudePath = await locateClaudeTranscript(home, sessionId, sessions, uid)
  if (claudePath) return { source: 'claude', path: claudePath }
  return undefined
}

async function readAutoSteps(
  home: string,
  sessionId: string | undefined,
  sessions?: readonly LiveSession[],
  uid?: number,
): Promise<{ autoSteps: AutoSteps | null; transcriptPath?: string }> {
  const found = await findCoordinatorTranscript(home, sessionId, sessions, uid)
  if (!found) return { autoSteps: null }
  const tail = await readFileTail(found.path, TRANSCRIPT_TAIL_BYTES, uid)
  if (!tail) return { autoSteps: null, transcriptPath: found.path }
  const autoSteps = found.source === 'agy' ? parseAutoStepsAgy(tail.text) : parseAutoStepsClaude(tail.text)
  return { autoSteps, transcriptPath: found.path }
}

function deriveLaneState(opts: {
  ledgerState: string
  openAsks: readonly string[]
  sessionStatus?: LiveLane['sessionStatus']
  streamEnded: boolean
  streamFailed: boolean
  waitingOn: readonly string[]
}): LiveLaneState {
  if (ENDED_LANE_STATES.has(opts.ledgerState)) return opts.ledgerState as LiveLaneState
  if (opts.openAsks.length > 0 || opts.ledgerState === 'needs-you' || opts.sessionStatus === 'needs-you')
    return 'needs-you'
  const busy = opts.sessionStatus === 'busy'
  if (!busy && opts.streamEnded && opts.streamFailed) return 'attention'
  if (!busy && opts.streamEnded) return 'finished'
  if (opts.ledgerState === 'queued' || opts.waitingOn.length > 0) return 'queued'
  return 'working'
}

function summarizeRunRow(row: RegistryRow, data?: Record<string, unknown>): RunSummary {
  const state = data?.state === 'closed' || row.state === 'closed' ? 'closed' : 'active'
  const objective = cleanText(data?.objective, MAX_TEXT) ?? row.objective
  const rawLanes = Array.isArray(data?.lanes) ? data.lanes : []
  const rawAsks = Array.isArray(data?.asks) ? data.asks : []
  const rawWaits = Array.isArray(data?.waits) ? data.waits : []
  const rawSteps = Array.isArray(data?.steps) ? data.steps : []
  const activeLanes = rawLanes.filter((l) => {
    const s = asObj(l)?.state
    return typeof s === 'string' ? !ENDED_LANE_STATES.has(s) : true
  }).length
  const openAsks = rawAsks.filter((a) => asObj(a)?.state === 'open').length
  const runningWaits = rawWaits.filter((w) => {
    const s = asObj(w)?.state
    return typeof s === 'string' ? !ENDED_WAIT_STATES.has(s) : true
  }).length
  const stepsDone = rawSteps.filter((s) => mapStepState(asObj(s)?.state) === 'done').length
  const createdAt = typeof data?.created_at === 'string' ? data.created_at : undefined
  const updatedAt = typeof data?.updated_at === 'string' ? data.updated_at : undefined
  const coordinator = cleanText(data?.coordinator, 80)
  const coordinatorSession =
    typeof data?.coordinator_session === 'string' && SESSION_ID_RE.test(data.coordinator_session)
      ? data.coordinator_session
      : undefined
  return {
    id: row.id,
    objective,
    state,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    activeLanes,
    totalLanes: rawLanes.length,
    openAsks,
    runningWaits,
    stepsDone,
    stepsTotal: rawSteps.length,
    ...(coordinator ? { coordinator } : {}),
    ...(coordinatorSession ? { coordinatorSession } : {}),
    dir: row.dir,
  }
}

export async function findRunSummary(
  env: Env,
  home: string,
  runId: string,
  uid = process.getuid?.(),
): Promise<RunSummary | undefined> {
  if (!RUN_ID_RE.test(runId)) return undefined
  const rows = await readRegistry(env, home, uid)
  const row = rows.find((r) => r.id === runId)
  if (!row) return undefined
  const loaded = await readRunJson(row.dir, uid)
  if (!loaded) return undefined
  return summarizeRunRow(row, loaded.data)
}

export async function listRuns(env: Env, home: string, uid = process.getuid?.()): Promise<RunSummary[]> {
  const rows = await readRegistry(env, home, uid)
  if (!rows.length) return []
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const loaded = await readRunJson(row.dir, uid)
      return summarizeRunRow(row, loaded?.data)
    }),
  )
  const timeOf = (r: RunSummary) => parseIsoMs(r.updatedAt) ?? parseIsoMs(r.createdAt) ?? 0
  const active = summaries.filter((r) => r.state === 'active').sort((a, b) => timeOf(b) - timeOf(a))
  const closed = summaries
    .filter((r) => r.state === 'closed')
    .sort((a, b) => timeOf(b) - timeOf(a))
    .slice(0, MAX_CLOSED_RUNS)
  return [...active, ...closed]
}

function firstSentence(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('OUTCOME:')) ?? ''
  return cleanText(firstLine, MAX_TEXT) ?? ''
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanText(lines[i], MAX_TEXT)
    if (line) return line
  }
  return undefined
}

function computeFingerprint(view: Omit<LiveRunView, 'fingerprint'>): string {
  const canonical = {
    id: view.id,
    objective: view.objective,
    state: view.state,
    paused: view.paused,
    updatedAt: view.updatedAt,
    steps: view.steps,
    autoSteps: view.autoSteps,
    asks: view.asks,
    lanes: view.lanes.map((l) => ({
      id: l.id,
      title: l.title,
      round: l.round,
      ledgerState: l.ledgerState,
      liveState: l.liveState,
      activity: l.activity,
      note: l.note,
      summary: l.summary,
      evidence: l.evidence,
      streamEnded: l.streamEnded,
      streamFailed: l.streamFailed,
      streamMtimeMs: l.streamMtimeMs,
      tokens: l.tokens,
      costUsd: l.costUsd,
      sessionId: l.sessionId,
      sessionStatus: l.sessionStatus,
      sessionLabel: l.sessionLabel,
      waitingOn: l.waitingOn,
      openAsks: l.openAsks,
    })),
    waits: view.waits,
    outputs: view.outputs,
    decisions: view.decisions,
    grants: view.grants,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

export async function readLiveRun(
  env: Env,
  home: string,
  runId: string,
  opts: { sessions?: readonly LiveSession[]; uid?: number; nowMs?: number } = {},
): Promise<LiveRunView | undefined> {
  if (!RUN_ID_RE.test(runId)) return undefined
  const uid = opts.uid ?? process.getuid?.()
  const nowMs = opts.nowMs ?? Date.now()
  const rows = await readRegistry(env, home, uid)
  const row = rows.find((r) => r.id === runId)
  if (!row) return undefined
  const loaded = await readRunJson(row.dir, uid)
  if (!loaded) return undefined
  const { data, realDir } = loaded

  const paused = await lstat(join(realDir, 'STOP')).then(
    (s) => s.isFile() && (uid === undefined || s.uid === uid),
    () => false,
  )

  const rawSteps = Array.isArray(data.steps) ? data.steps : []
  const steps: LiveStep[] = []
  for (const s of rawSteps) {
    const so = asObj(s)
    const title = cleanText(so?.title, MAX_TEXT)
    if (!title) continue
    const note = cleanText(so?.note, MAX_TEXT)
    steps.push({ title, state: mapStepState(so?.state), ...(note ? { note } : {}) })
  }

  const rawAsks = Array.isArray(data.asks) ? data.asks : []
  const asks: LiveAsk[] = []
  for (const a of rawAsks) {
    const ao = asObj(a)
    const id = cleanText(ao?.id, 40)
    const question = cleanText(ao?.question, 500)
    if (!id || !question) continue
    const rawRecipient = typeof ao?.recipient === 'string' ? ao.recipient.replace(CONTROL, ' ').trim() : ''
    const recipientTruncated = rawRecipient.length > OUTWARD_META_MAX_CHARS
    const recipient = rawRecipient
      ? recipientTruncated
        ? rawRecipient.slice(0, OUTWARD_META_MAX_CHARS)
        : rawRecipient
      : undefined
    const rawChannel = typeof ao?.channel === 'string' ? ao.channel.replace(CONTROL, ' ').trim() : ''
    const channelTruncated = rawChannel.length > OUTWARD_META_MAX_CHARS
    const channel = rawChannel
      ? channelTruncated
        ? rawChannel.slice(0, OUTWARD_META_MAX_CHARS)
        : rawChannel
      : undefined
    const rawDraft = typeof ao?.draft === 'string' ? ao.draft.trim() : ''
    const draftTruncated = rawDraft.length > OUTWARD_DRAFT_MAX_CHARS
    const draft = rawDraft
      ? draftTruncated
        ? rawDraft.slice(0, OUTWARD_DRAFT_MAX_CHARS)
        : rawDraft
      : undefined
    asks.push({
      id,
      state: ao?.state === 'answered' ? 'answered' : 'open',
      question,
      ...(cleanText(ao?.recommend, 500) ? { recommend: cleanText(ao?.recommend, 500) } : {}),
      ...(cleanMultiline(ao?.evidence, 1500) ? { evidence: cleanMultiline(ao?.evidence, 1500) } : {}),
      ...(cleanText(ao?.blocks, 300) ? { blocks: cleanText(ao?.blocks, 300) } : {}),
      ...(cleanText(ao?.lane, 64) ? { lane: cleanText(ao?.lane, 64) } : {}),
      ...(ao?.outward === true ? { outward: true } : {}),
      ...(recipient ? { recipient } : {}),
      ...(recipientTruncated ? { recipientTruncated: true } : {}),
      ...(channel ? { channel } : {}),
      ...(channelTruncated ? { channelTruncated: true } : {}),
      ...(draft ? { draft } : {}),
      ...(draftTruncated ? { draftTruncated: true } : {}),
      ...(cleanText(ao?.answer, 500) ? { answer: cleanText(ao?.answer, 500) } : {}),
      ...(typeof ao?.created_at === 'string' ? { createdAt: ao.created_at } : {}),
      ...(typeof ao?.answered_at === 'string' ? { answeredAt: ao.answered_at } : {}),
    })
  }
  const openAsks = asks.filter((a) => a.state === 'open')

  const rawLanes = Array.isArray(data.lanes) ? data.lanes : []
  const rawWaits = Array.isArray(data.waits) ? data.waits : []
  const doneIds = new Set<string>()
  const titleById = new Map<string, string>()
  for (const item of [...rawLanes, ...rawWaits]) {
    const o = asObj(item)
    const id = typeof o?.id === 'string' ? o.id : ''
    if (!id) continue
    titleById.set(id, cleanText(o?.title, MAX_TEXT) ?? id)
    if (o?.state === 'done') doneIds.add(id)
  }

  const sessionById = new Map<string, LiveSession>()
  for (const s of opts.sessions ?? []) sessionById.set(s.sessionId, s)

  const lanes: LiveLane[] = await Promise.all(
    rawLanes.map(async (rawLane) => {
      const lo = asObj(rawLane) ?? {}
      const id = cleanText(lo.id, 64) ?? 'lane'
      const title = cleanText(lo.title, MAX_TEXT) ?? id
      const ledgerState = cleanText(lo.state, 32) ?? 'working'
      const outPath = await resolveRunArtifactPath(realDir, lo.output, uid)
      const tail = outPath ? await readFileTail(outPath, STREAM_TAIL_BYTES, uid) : undefined
      const stream = tail ? parseLaneStream(tail.text) : { streamEnded: false, streamFailed: false }
      const ledgerSession =
        typeof lo.session === 'string' && SESSION_ID_RE.test(lo.session) ? lo.session : undefined
      const sessionId = ledgerSession ?? stream.sessionId
      const matched = sessionId ? sessionById.get(sessionId) : undefined
      const sessionStatus = matched?.status
      const sessionLabel = matched?.label
      const afterRaw = Array.isArray(lo.after) ? lo.after : []
      const waitingOn = afterRaw
        .filter((x): x is string => typeof x === 'string' && !doneIds.has(x))
        .map((x) => titleById.get(x) ?? x)
      const laneOpenAsks = openAsks.filter((a) => a.lane === id).map((a) => a.id)
      const liveState = deriveLaneState({
        ledgerState,
        openAsks: laneOpenAsks,
        sessionStatus,
        streamEnded: stream.streamEnded,
        streamFailed: stream.streamFailed,
        waitingOn,
      })
      const startedMs = parseIsoMs(lo.started_at)
      const endedMs = parseIsoMs(lo.ended_at) ?? parseIsoMs(lo.updated_at)
      const endRef = ENDED_LANE_STATES.has(liveState)
        ? endedMs
        : liveState === 'finished' || liveState === 'attention'
          ? (tail?.mtimeMs ?? endedMs ?? nowMs)
          : nowMs
      const elapsedMs =
        startedMs !== undefined && endRef !== undefined ? Math.max(0, endRef - startedMs) : undefined
      const manualCost = typeof lo.cost === 'number' && Number.isFinite(lo.cost) ? lo.cost : undefined
      const costUsd = manualCost ?? stream.costUsd
      const roundNum = Number(lo.round)
      const round = Number.isInteger(roundNum) && roundNum > 0 ? roundNum : 1
      const role = cleanText(lo.role, 40)
      const account = cleanText(lo.account, 80)
      const branch = cleanText(lo.branch, 120)
      const worktree = cleanText(lo.worktree, 260)
      const note = cleanText(lo.note, MAX_TEXT)
      const summary = cleanMultiline(lo.summary, 1000)
      const evidence = cleanMultiline(lo.evidence, 600)
      const activity = stream.activity ?? (ENDED_LANE_STATES.has(liveState) ? note : undefined)
      return {
        id,
        title,
        ...(role ? { role } : {}),
        ...(account ? { account } : {}),
        ...(branch ? { branch } : {}),
        ...(worktree ? { worktree } : {}),
        round,
        ledgerState,
        liveState,
        ...(activity ? { activity } : {}),
        ...(note ? { note } : {}),
        ...(summary ? { summary } : {}),
        ...(evidence ? { evidence } : {}),
        streamEnded: stream.streamEnded,
        streamFailed: stream.streamFailed,
        ...(tail ? { streamMtimeMs: Math.floor(tail.mtimeMs) } : {}),
        ...(stream.tokens ? { tokens: stream.tokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionStatus ? { sessionStatus } : {}),
        ...(sessionLabel ? { sessionLabel } : {}),
        ...(typeof lo.started_at === 'string' ? { startedAt: lo.started_at } : {}),
        ...(typeof lo.updated_at === 'string' ? { updatedAt: lo.updated_at } : {}),
        ...(typeof lo.ended_at === 'string' ? { endedAt: lo.ended_at } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        waitingOn,
        openAsks: laneOpenAsks,
      }
    }),
  )

  const waits: LiveWait[] = await Promise.all(
    rawWaits.map(async (rawWait) => {
      const wo = asObj(rawWait) ?? {}
      const id = cleanText(wo.id, 64) ?? 'wait'
      const title = cleanText(wo.title, MAX_TEXT) ?? id
      const state = cleanText(wo.state, 32) ?? 'running'
      const running = !ENDED_WAIT_STATES.has(state)
      const logPath = running ? await resolveRunArtifactPath(realDir, wo.log, uid) : undefined
      const tail = logPath ? await readFileTail(logPath, WAIT_LOG_TAIL_BYTES, uid) : undefined
      const lastLine = tail ? lastNonEmptyLine(tail.text) : undefined
      return {
        id,
        title,
        state,
        ...(cleanText(wo.stage, MAX_TEXT) ? { stage: cleanText(wo.stage, MAX_TEXT) } : {}),
        ...(cleanText(wo.note, MAX_TEXT) ? { note: cleanText(wo.note, MAX_TEXT) } : {}),
        ...(cleanText(wo.log, 260) ? { log: cleanText(wo.log, 260) } : {}),
        ...(lastLine ? { lastLine } : {}),
        ...(tail ? { logMtimeMs: Math.floor(tail.mtimeMs) } : {}),
        ...(typeof wo.started_at === 'string' ? { startedAt: wo.started_at } : {}),
        ...(typeof wo.updated_at === 'string' ? { updatedAt: wo.updated_at } : {}),
      }
    }),
  )

  const outputs: LiveOutput[] = []
  for (const l of lanes) {
    if (ENDED_LANE_STATES.has(l.liveState) && l.summary) {
      outputs.push({
        kind: 'lane',
        title: l.title,
        summary: firstSentence(l.summary) || l.summary,
        ...(l.evidence ? { evidence: l.evidence.split(/\r?\n/)[0] } : {}),
      })
    }
  }
  for (const rawArt of Array.isArray(data.artifacts) ? data.artifacts : []) {
    const ao = asObj(rawArt)
    const p = cleanText(ao?.path, 260)
    if (!p) continue
    outputs.push({
      kind: 'artifact',
      title: cleanText(ao?.label, MAX_TEXT) ?? basename(p),
      path: p,
    })
  }
  for (const rawCommit of Array.isArray(data.commits) ? data.commits : []) {
    const co = asObj(rawCommit)
    const subject = cleanText(co?.subject, MAX_TEXT)
    const hash = cleanText(co?.hash, 40)
    const repo = cleanText(co?.repo, 200)
    const repoName = repo ? basename(repo.replace(/[\\/]+$/, '')) : ''
    const meta = [repoName, hash].filter(Boolean).join(' · ')
    if (subject || meta) {
      outputs.push({
        kind: 'commit',
        title: subject ?? meta,
        ...(meta ? { meta } : {}),
      })
    }
  }

  const decisions: LiveDecision[] = []
  for (const rawDec of Array.isArray(data.decisions) ? data.decisions : []) {
    const d = asObj(rawDec)
    const what = cleanText(d?.what, MAX_TEXT)
    const choice = cleanText(d?.choice, MAX_TEXT)
    if (!what && !choice) continue
    decisions.push({
      what: what ?? 'Decision',
      choice: choice ?? '',
      ...(cleanText(d?.why, 400) ? { why: cleanText(d?.why, 400) } : {}),
      ...(cleanMultiline(d?.options, 1000) ? { options: cleanMultiline(d?.options, 1000) } : {}),
    })
  }

  const rawGrants = Array.isArray(data.grants)
    ? data.grants
    : Array.isArray(data.standing_grants)
      ? data.standing_grants
      : []
  const grants: LiveGrant[] = []
  for (const rawGrant of rawGrants) {
    const g = asObj(rawGrant)
    const scope = cleanText(g?.scope, MAX_TEXT)
    if (!scope) continue
    grants.push({
      scope,
      ...(cleanText(g?.words, 300) ? { words: cleanText(g?.words, 300) } : {}),
      ...(g?.outward === true ? { outward: true } : {}),
    })
  }

  const coordinator = cleanText(data.coordinator, 80)
  const coordinatorSession =
    typeof data.coordinator_session === 'string' && SESSION_ID_RE.test(data.coordinator_session)
      ? data.coordinator_session
      : undefined
  const { autoSteps } = await readAutoSteps(home, coordinatorSession, opts.sessions, uid)

  const base: Omit<LiveRunView, 'fingerprint'> = {
    id: row.id,
    objective: cleanText(data.objective, MAX_TEXT) ?? row.objective,
    state: data.state === 'closed' || row.state === 'closed' ? 'closed' : 'active',
    paused,
    dir: row.dir,
    ...(typeof data.created_at === 'string' ? { createdAt: data.created_at } : {}),
    ...(typeof data.updated_at === 'string' ? { updatedAt: data.updated_at } : {}),
    ...(coordinator ? { coordinator } : {}),
    ...(coordinatorSession ? { coordinatorSession } : {}),
    steps,
    autoSteps,
    asks,
    lanes,
    waits,
    outputs,
    decisions,
    grants,
  }
  return { ...base, fingerprint: computeFingerprint(base) }
}

async function normalizeDir(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return resolve(p)
  }
}

export async function runCompactPointer(
  env: Env,
  home: string,
  opts: { sessionId?: string; cwd?: string; uid?: number; panelPort?: number } = {},
): Promise<RunCompactPointerResult> {
  const uid = opts.uid ?? process.getuid?.()
  const port = opts.panelPort ?? 17420
  const summaries = (await listRuns(env, home, uid)).filter((r) => r.state === 'active')
  if (!summaries.length) return { runs: [], text: '' }

  const sid = opts.sessionId && SESSION_ID_RE.test(opts.sessionId) ? opts.sessionId : undefined
  const cwdReal = opts.cwd ? await normalizeDir(opts.cwd) : undefined
  const cwdRunsPrefix = cwdReal ? join(cwdReal, '.agent-dispatch', 'runs') : undefined

  const matched: CompactPointerRun[] = []
  for (const s of summaries) {
    const view = await readLiveRun(env, home, s.id, { uid })
    if (view?.state !== 'active') continue
    let matches = !sid && !cwdRunsPrefix
    if (sid) {
      if (view.coordinatorSession === sid || view.lanes.some((l) => l.sessionId === sid)) matches = true
    }
    if (!matches && cwdRunsPrefix) {
      const dirReal = await normalizeDir(view.dir)
      if (
        dirReal === cwdRunsPrefix ||
        dirReal.startsWith(`${cwdRunsPrefix}/`) ||
        dirReal.startsWith(`${cwdRunsPrefix}\\`)
      )
        matches = true
    }
    if (!matches) continue
    const effectiveSteps = view.steps.length > 0 ? view.steps : (view.autoSteps?.items ?? [])
    const stepsDone = effectiveSteps.filter((st) => st.state === 'done').length
    const currentStep =
      effectiveSteps.find((st) => st.state === 'working')?.title ??
      effectiveSteps.find((st) => st.state === 'queued')?.title
    const activeLanes = view.lanes
      .filter((l) => !ENDED_LANE_STATES.has(l.liveState))
      .map((l) => ({ id: l.id, title: l.title, liveState: l.liveState }))
    const openAsks = view.asks
      .filter((a) => a.state === 'open')
      .map((a) => ({ id: a.id, question: a.question }))
    matched.push({
      id: view.id,
      objective: view.objective,
      dir: view.dir,
      panelUrl: `http://127.0.0.1:${port}/runs/${view.id}`,
      stepsDone,
      stepsTotal: effectiveSteps.length,
      ...(currentStep ? { currentStep } : {}),
      activeLanes,
      openAsks,
    })
  }
  if (!matched.length) return { runs: [], text: '' }

  const blocks = matched.map((r) => {
    const lines = [`Run ${r.id} | dir: ${r.dir} | panel: ${r.panelUrl}`]
    const stepPart = r.stepsTotal
      ? `Steps: ${r.stepsDone}/${r.stepsTotal}${r.currentStep ? ` (${cleanText(r.currentStep, 50)})` : ''}`
      : 'Steps: 0'
    lines.push(`${stepPart} | Active lanes: ${r.activeLanes.length} | Open asks: ${r.openAsks.length}`)
    const details: string[] = []
    if (r.activeLanes.length)
      details.push(
        `Lanes: ${r.activeLanes
          .slice(0, 4)
          .map((l) => `${l.id}(${l.liveState})`)
          .join(', ')}`,
      )
    if (r.openAsks.length)
      details.push(
        `Asks: ${r.openAsks
          .slice(0, 3)
          .map((a) => a.id)
          .join(', ')}`,
      )
    if (details.length) lines.push(details.join(' | '))
    return lines.join('\n')
  })
  return { runs: matched, text: blocks.join('\n') }
}

export async function runWatchTargets(
  env: Env,
  home: string,
  runId: string,
  uid = process.getuid?.(),
): Promise<WatchDir[]> {
  if (!RUN_ID_RE.test(runId)) return []
  const targets: WatchDir[] = []
  const stateDir = await ownedRealDir(dispatchStateDir(env, home), uid)
  if (stateDir) {
    targets.push({
      dir: stateDir,
      recursive: false,
      match: /^runs\.json$/,
      gapMs: 1000,
    })
  }
  const rows = await readRegistry(env, home, uid)
  const row = rows.find((r) => r.id === runId)
  if (!row) return targets
  const loaded = await readRunJson(row.dir, uid)
  const runDir = loaded?.realDir ?? (await ownedRealDir(row.dir, uid))
  if (runDir) {
    targets.push({
      dir: runDir,
      recursive: false,
      match: /^(run\.json|STOP|.*\.(jsonl|log))$/,
      gapMs: 1000,
    })
    // WHY: Lane output streams or wait logs may live in a subfolder under the Run dir (such as `logs/`).
    const extraDirs = new Set<string>()
    const rawLanes = Array.isArray(loaded?.data.lanes) ? loaded.data.lanes : []
    const rawWaits = Array.isArray(loaded?.data.waits) ? loaded.data.waits : []
    for (const item of [...rawLanes, ...rawWaits]) {
      const o = asObj(item)
      const p = await resolveRunArtifactPath(runDir, o?.output ?? o?.log, uid)
      if (p) {
        const d = dirname(p)
        if (d !== runDir) extraDirs.add(d)
      }
    }
    for (const dir of extraDirs) {
      targets.push({
        dir,
        recursive: false,
        match: /\.(jsonl|log)$/,
        gapMs: 1000,
      })
    }
  }
  const coordSession =
    typeof loaded?.data.coordinator_session === 'string' &&
    SESSION_ID_RE.test(loaded.data.coordinator_session)
      ? loaded.data.coordinator_session
      : undefined
  const transcript = await findCoordinatorTranscript(home, coordSession, undefined, uid)
  if (transcript) {
    const file = basename(transcript.path)
    targets.push({
      dir: dirname(transcript.path),
      recursive: false,
      match: { test: (name: string) => name === file },
      gapMs: 1000,
    })
  }
  return targets
}
