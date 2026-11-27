// WHY: ADR-0088 Antigravity CLI Live Session reader. Strictly read-only (never deletes or modifies files during
// listing). Prefers `<state>/agy-live/<pid>.json` for `sideby run agy`, resolves plain `agy` and local Orca
// `agy acp` via bounded-concurrency `openFiles` + one batched read-only `conversation_summaries.db` query, guards
// ambiguity/collisions with `guessed: true`, and enriches Orca Chat via a short-timeout cached `orca agent list`.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { AGY_ACCOUNT_REF_RE, AGY_LIVE_DIR, type AgyLiveRecord, isPlainAgyId } from '../../agy/statusline.ts'
import { ownedFolder } from '../../core/fs-safe.ts'
import type { LiveSessionStatus } from '../../core/live-sessions.ts'
import {
  hostArgs,
  isInside,
  isoOf,
  mapLimit,
  type ProcessInfo,
  runsHost,
  sameStart,
} from '../../core/live-sessions-procs.ts'
import {
  normalizeOrcaSessionId,
  ORCA_AGENT_LIST_TIMEOUT_MS,
  ORCA_AGENT_SESSION_VAR,
  ORCA_STRUCTURED_VAR,
  type OrcaAgentEntry,
  type OrcaAgentListRunner,
  orcaAgents,
} from '../../core/orca-chat.ts'
import { ORCA_HANDLE_VAR } from '../../panel/orca.ts'
import type { Account, Env } from '../../types.ts'
import type { LiveSessionReader, RawLiveSession } from '../live-sessions.ts'
import { titleFromText } from '../shared/history-text.ts'
import { type AgySummaryRow, readAgySummaries } from './history.ts'
import { AGY_APP_DATA_DIR_FLAGS, AGY_GEMINI_DIR_FLAGS } from './layout.ts'
import { AGY_NON_INTERACTIVE_SUBCOMMANDS, AGY_SKIP_VALUE_FLAGS, classifyAgyArgs } from './mod.ts'

export const AGY_LIVE_FRESH_MS = 120_000
const LIVE_FILE_MAX_BYTES = 16 * 1024
const OPEN_FILES_CONCURRENCY = 4
const MAX_CANDIDATES_PER_PROC = 64
const CONV_DB = /^conversations\/([A-Za-z0-9_-]{1,128})\.db$/
const BRAIN_ENTRY = /^brain\/([A-Za-z0-9_-]{1,128})(?:\/|$)/

/** WHY: deterministic expected transcript path for verified non-guessed agy sessions, even before creation (ADR-0088). */
export const agyTranscriptPath = (accountDir: string, conversationId: string): string =>
  join(accountDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')

function mapAgyAgentState(state: string | undefined): LiveSessionStatus {
  if (state === 'reviewing') return 'needs-you'
  if (state === 'working' || state === 'tool_use') return 'busy'
  if (state === 'idle') return 'idle'
  return 'unknown'
}

function mapOrcaAgentState(state: string | undefined): LiveSessionStatus {
  if (state === 'working') return 'busy'
  if (state === 'done') return 'idle'
  if (state === 'waiting' || state === 'blocked') return 'needs-you'
  return 'unknown'
}

function readFlagValue(
  a: string,
  argv: readonly string[],
  i: number,
  names: readonly string[],
): { value: string; step: number } | undefined {
  for (const name of names) {
    if (a === name && i + 1 < argv.length) return { value: argv[i + 1]!, step: 1 }
    if (a.startsWith(`${name}=`)) return { value: a.slice(name.length + 1), step: 0 }
  }
  return undefined
}

/**
 * WHY: ADR-0090 attribute each running `agy` process strictly to its target `--app_data_dir` / `--gemini_dir`
 * Account (defaulting to Main when absent) so concurrent `agy` Accounts never cross-list each other's PIDs.
 */
export function procMatchesAgyAccount(
  args: readonly string[],
  account: Pick<Account, 'dir' | 'isMain'>,
  home?: string,
): boolean {
  let geminiDir: string | undefined
  let appDataDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    const g = readFlagValue(a, args, i, AGY_GEMINI_DIR_FLAGS)
    if (g) {
      geminiDir = g.value
      i += g.step
      continue
    }
    const d = readFlagValue(a, args, i, AGY_APP_DATA_DIR_FLAGS)
    if (d) {
      appDataDir = d.value
      i += d.step
      continue
    }
    if (AGY_SKIP_VALUE_FLAGS.has(a)) i++
  }
  if (!geminiDir && !appDataDir) return account.isMain
  const accountDir = resolve(account.dir)
  if (appDataDir && isAbsolute(appDataDir)) return resolve(appDataDir) === accountDir
  const baseGemini = geminiDir
    ? isAbsolute(geminiDir)
      ? geminiDir
      : join(home || dirname(dirname(accountDir)), geminiDir)
    : dirname(accountDir)
  return resolve(baseGemini, appDataDir || 'antigravity-cli') === accountDir
}

function isInteractiveOrAcp(argv: readonly string[]): { keep: boolean; isAcp: boolean } {
  const info = classifyAgyArgs(argv)
  if (info.headless || info.helpOrVersion) return { keep: false, isAcp: false }
  if (info.subcommand === 'acp') return { keep: true, isAcp: true }
  if (info.subcommand && AGY_NON_INTERACTIVE_SUBCOMMANDS.has(info.subcommand))
    return { keep: false, isAcp: false }
  return { keep: true, isAcp: false }
}

async function readLiveRecord(liveDir: string, proc: ProcessInfo): Promise<AgyLiveRecord | null> {
  const file = join(liveDir, `${proc.pid}.json`)
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await fh.stat()
    const uid = process.getuid?.()
    if (!st.isFile() || st.size > LIVE_FILE_MAX_BYTES) return null
    if (uid !== undefined && st.uid !== uid) return null
    if ((st.mode & 0o077) !== 0) return null
    const raw = await fh.readFile('utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.version !== 1) return null
    if (parsed.pid !== proc.pid) return null
    if (typeof parsed.procStart !== 'number' || !sameStart(proc, parsed.procStart)) return null
    if (!isPlainAgyId(parsed.conversationId)) return null
    if (typeof parsed.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt))) return null
    return {
      version: 1,
      pid: proc.pid,
      procStart: parsed.procStart,
      conversationId: parsed.conversationId,
      ...(typeof parsed.account === 'string' && AGY_ACCOUNT_REF_RE.test(parsed.account)
        ? { account: parsed.account }
        : {}),
      ...(typeof parsed.title === 'string' && parsed.title ? { title: parsed.title } : {}),
      ...(typeof parsed.agentState === 'string' && parsed.agentState
        ? { agentState: parsed.agentState }
        : {}),
      ...(typeof parsed.cwd === 'string' && isAbsolute(parsed.cwd) ? { cwd: parsed.cwd } : {}),
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

// WHY: active SQLite `conversations/<id>.db` handles identify the running conversation much more reliably than
// `brain/<id>` directory/file references (which stay open for older sessions whose artifacts were read, ADR-0088).
export function extractAgyCandidates(
  accountDir: string,
  files: readonly string[],
): { dbIds: string[]; brainIds: string[] } {
  const dbIds = new Set<string>()
  const brainIds = new Set<string>()
  const base = resolve(accountDir)
  for (const f of files) {
    if (!isInside(base, f)) continue
    const rel = relative(base, resolve(f)).replaceAll('\\', '/')
    const dbId = CONV_DB.exec(rel)?.[1]
    if (dbId && isPlainAgyId(dbId)) {
      dbIds.add(dbId)
      if (dbIds.size + brainIds.size >= MAX_CANDIDATES_PER_PROC) break
      continue
    }
    const brainId = BRAIN_ENTRY.exec(rel)?.[1]
    if (brainId && isPlainAgyId(brainId)) {
      brainIds.add(brainId)
      if (dbIds.size + brainIds.size >= MAX_CANDIDATES_PER_PROC) break
    }
  }
  return { dbIds: [...dbIds], brainIds: [...brainIds] }
}

export function extractAgyCandidateIds(accountDir: string, files: readonly string[]): string[] {
  const { dbIds, brainIds } = extractAgyCandidates(accountDir, files)
  return [...new Set([...dbIds, ...brainIds])]
}

interface DiscoveredProc {
  proc: ProcessInfo
  isAcp: boolean
  live?: AgyLiveRecord
  startedFrom?: 'orca'
  rawOrcaSessionId?: string
  dbCandidates: string[]
  brainCandidates: string[]
}

const ORCA_DEADLINE_MARGIN_MS = 400
const ORCA_MIN_BUDGET_MS = 50

function orcaEnrichBudgetMs(deadlineAtMs: number | undefined): number {
  if (deadlineAtMs === undefined) return ORCA_AGENT_LIST_TIMEOUT_MS
  const remaining = deadlineAtMs - Date.now()
  if (remaining <= ORCA_MIN_BUDGET_MS) return 0
  const margin = Math.min(ORCA_DEADLINE_MARGIN_MS, Math.floor(remaining / 2))
  return Math.min(ORCA_AGENT_LIST_TIMEOUT_MS, Math.max(ORCA_MIN_BUDGET_MS, remaining - margin))
}

async function readOrcaAgentsBounded(
  env: Env,
  opts: { run?: OrcaAgentListRunner; now: () => number },
  budgetMs: number,
): Promise<Map<string, OrcaAgentEntry> | null> {
  if (budgetMs <= 0) return null
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs)
    timer.unref()
  })
  try {
    return await Promise.race([orcaAgents(env, { ...opts, timeoutMs: budgetMs }).catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const agyLiveSessions: LiveSessionReader = {
  family: 'agy',
  async read(account, procs, problems, ctx) {
    const allProcs = await procs.list()
    const stateDir = ctx?.stateDir
    const nowMs = (ctx?.now ?? new Date()).getTime()
    const liveDir = stateDir
      ? await ownedFolder(stateDir, [AGY_LIVE_DIR], { create: false }).catch(() => null)
      : null

    const agyProcs: { proc: ProcessInfo; isAcp: boolean; preLive?: AgyLiveRecord }[] = []
    for (const p of allProcs) {
      if (!runsHost(p.command, 'agy')) continue
      const exact = await procs.argv(p.pid)
      const args = exact ?? hostArgs(p.command)
      const { keep, isAcp } = isInteractiveOrAcp(args)
      if (!keep) continue
      const rawLive = liveDir ? ((await readLiveRecord(liveDir, p)) ?? undefined) : undefined
      // WHY: on ps fallback (`exact` undefined), verified live-record account beats space-split prompt text (ADR-0090).
      if (exact) {
        if (!procMatchesAgyAccount(exact, account, ctx?.env?.HOME)) continue
      } else if (rawLive?.account) {
        if (rawLive.account !== account.ref) continue
      } else if (!procMatchesAgyAccount(args, account, ctx?.env?.HOME)) {
        continue
      }
      agyProcs.push({ proc: p, isAcp, ...(rawLive ? { preLive: rawLive } : {}) })
    }
    if (!agyProcs.length) return []

    const discovered: DiscoveredProc[] = await mapLimit(
      agyProcs,
      OPEN_FILES_CONCURRENCY,
      async ({ proc, isAcp, preLive }) => {
        const live = preLive && (!preLive.account || preLive.account === account.ref) ? preLive : undefined
        const [structured, agentEnv, termHandle] = await Promise.all([
          procs.envVar(proc.pid, ORCA_STRUCTURED_VAR).catch(() => undefined),
          procs.envVar(proc.pid, ORCA_AGENT_SESSION_VAR).catch(() => undefined),
          procs.envVar(proc.pid, ORCA_HANDLE_VAR).catch(() => undefined),
        ])
        const rawOrcaSessionId = isAcp && structured === '1' ? normalizeOrcaSessionId(agentEnv) : undefined
        const startedFrom: 'orca' | undefined =
          rawOrcaSessionId || (structured !== '1' && Boolean(termHandle)) ? 'orca' : undefined
        const { dbIds, brainIds } = live
          ? { dbIds: [live.conversationId], brainIds: [] }
          : extractAgyCandidates(account.dir, await procs.openFiles(proc.pid))
        return {
          proc,
          isAcp,
          ...(live ? { live } : {}),
          ...(startedFrom ? { startedFrom } : {}),
          ...(rawOrcaSessionId ? { rawOrcaSessionId } : {}),
          dbCandidates: dbIds,
          brainCandidates: brainIds,
        }
      },
    )

    const allCandidateIds = [...new Set(discovered.flatMap((d) => [...d.dbCandidates, ...d.brainCandidates]))]
    const needOrca = discovered.some((d) => Boolean(d.rawOrcaSessionId))
    const orcaBudgetMs = needOrca ? orcaEnrichBudgetMs(ctx?.deadlineAtMs) : 0
    const [summaries, confirmedAgents] = await Promise.all([
      allCandidateIds.length
        ? readAgySummaries(account.dir, allCandidateIds).catch((err) => {
            problems.push(
              `${account.ref}: could not read conversation_summaries.db (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
            )
            return new Map<string, AgySummaryRow>()
          })
        : Promise.resolve(new Map<string, AgySummaryRow>()),
      needOrca
        ? readOrcaAgentsBounded(
            ctx?.env ?? process.env,
            {
              ...(ctx?.orcaAgents ? { run: ctx.orcaAgents } : {}),
              now: () => nowMs,
            },
            orcaBudgetMs,
          )
        : Promise.resolve(null),
    ])

    const resolved: {
      sessionId: string
      title?: string
      status: LiveSessionStatus
      cwd?: string
      pid: number
      startedAt?: string
      updatedAt?: string
      guessed: boolean
      startedFrom?: string
      orcaSessionId?: string
    }[] = []

    for (const d of discovered) {
      let sessionId: string | undefined
      let guessed = false
      let dbRow: AgySummaryRow | undefined

      if (d.live) {
        sessionId = d.live.conversationId
        dbRow = summaries.get(sessionId)
      } else {
        const topDbRows = d.dbCandidates
          .map((id) => summaries.get(id))
          .filter((r): r is AgySummaryRow => Boolean(r))
        const topRows = topDbRows.length
          ? topDbRows
          : d.brainCandidates.map((id) => summaries.get(id)).filter((r): r is AgySummaryRow => Boolean(r))
        if (!topRows.length) continue
        if (topRows.length === 1) {
          dbRow = topRows[0]!
          sessionId = dbRow.conversationId
        } else {
          // WHY: multiple open top-level conversation handles without a stronger identity signal must be marked guessed (ADR-0088).
          topRows.sort(
            (a, b) =>
              (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) ||
              a.conversationId.localeCompare(b.conversationId),
          )
          dbRow = topRows[0]!
          sessionId = dbRow.conversationId
          guessed = true
        }
      }

      let status: LiveSessionStatus = 'unknown'
      if (d.live) {
        const ageMs = nowMs - Date.parse(d.live.updatedAt)
        status = ageMs <= AGY_LIVE_FRESH_MS ? mapAgyAgentState(d.live.agentState) : 'unknown'
      }

      const orcaEntry = d.rawOrcaSessionId ? confirmedAgents?.get(d.rawOrcaSessionId) : undefined
      if (status === 'unknown' && orcaEntry?.state) {
        status = mapOrcaAgentState(orcaEntry.state)
      }

      const cwd = d.live?.cwd ?? dbRow?.cwd
      // WHY: prefer Orca's own displayed Chat title when matched so Live Sessions match Orca's sidebar 1-to-1 (ADR-0088).
      const orcaTitle = orcaEntry?.title ? titleFromText(orcaEntry.title) : ''
      const title = d.live?.title || orcaTitle || dbRow?.title || (cwd ? basename(cwd) : undefined)
      const startedAt = isoOf(d.proc.startMs)
      const updatedAt = d.live?.updatedAt ?? dbRow?.updatedAt

      resolved.push({
        sessionId,
        ...(title ? { title } : {}),
        status,
        ...(cwd ? { cwd } : {}),
        pid: d.proc.pid,
        ...(startedAt ? { startedAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        guessed,
        ...(d.startedFrom ? { startedFrom: d.startedFrom } : {}),
        ...(orcaEntry ? { orcaSessionId: orcaEntry.orcaSessionId } : {}),
      })
    }

    // WHY: collision guard — if two running processes resolve to the same conversation_id, mark all affected rows
    // guessed so neither claims an exact match (ADR-0088).
    const counts = new Map<string, number>()
    for (const r of resolved) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1)

    return resolved.map((r): RawLiveSession => {
      const guessed = r.guessed || (counts.get(r.sessionId) ?? 0) > 1
      return {
        sessionId: r.sessionId,
        ...(r.title ? { title: r.title } : {}),
        status: r.status,
        ...(r.cwd ? { cwd: r.cwd } : {}),
        pid: r.pid,
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
        guessed,
        ...(!guessed ? { transcript: agyTranscriptPath(account.dir, r.sessionId) } : {}),
        ...(r.startedFrom ? { startedFrom: r.startedFrom } : {}),
        ...(r.orcaSessionId ? { orcaSessionId: r.orcaSessionId } : {}),
      }
    })
  },
}
