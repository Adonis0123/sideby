// WHY: ADR-0088 Orca Chat CLI adapter. Isolates `orca agent list --json` behind a short timeout and cache so a slow
// or stopped Orca never drops `agy` Live Sessions, and provides shell-free `orca orchestration send` with structured
// outcome mapping (delivered / paste-needed / unknown, ADR-0065).
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { ORCA_APP_CLI, runBounded } from '../panel/orca.ts'
import type { Env } from '../types.ts'
import { which } from './launch.ts'

export const ORCA_STRUCTURED_VAR = 'ORCA_STRUCTURED_SESSION'
export const ORCA_AGENT_SESSION_VAR = 'ORCA_AGENT_SESSION_ID'
export const ORCA_SESSION_PREFIX = 'orca_session_id:'
export const ORCA_AGENT_LIST_TIMEOUT_MS = 1_500
export const ORCA_AGENT_CACHE_MS = 2_000
export const ORCA_SEND_TIMEOUT_MS = 20_000
const KILL_GRACE_MS = 2_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface OrcaAgentEntry {
  orcaSessionId: string
  kind?: string
  state?: string
}

export type OrcaAgentListRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string }>

export type OrcaSendRunner = (
  args: readonly string[],
  env: Env,
  timeoutMs: number,
  killGraceMs?: number,
) => Promise<{ exitCode: number; stdout: string }>

/** WHY: distinguishes a failure before `orca` could start (safe to paste) from a post-start timeout (unknown, ADR-0065). */
export class OrcaPreSendError extends Error {}
export class OrcaSendTimeout extends Error {}

export type OrcaSendOutcome =
  | { kind: 'delivered'; warning?: string }
  | { kind: 'paste-needed'; reason: string }
  | { kind: 'unknown'; reason: string }

/** WHY: strip an optional `orca_session_id:` prefix so stored IDs stay canonical bare IDs (ADR-0088). */
export function normalizeOrcaSessionId(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const bare = trimmed.startsWith(ORCA_SESSION_PREFIX) ? trimmed.slice(ORCA_SESSION_PREFIX.length) : trimmed
  return /^[A-Za-z0-9._-]{1,128}$/.test(bare) ? bare : undefined
}

export async function findOrcaBin(env: Env): Promise<string | null> {
  const onPath = await which('orca', env)
  if (onPath) return onPath
  if (process.platform === 'darwin') {
    try {
      await access(ORCA_APP_CLI, constants.X_OK)
      return ORCA_APP_CLI
    } catch {}
  }
  return null
}

export function parseOrcaAgentList(stdout: string, exitCode: number): Map<string, OrcaAgentEntry> | null {
  if (exitCode !== 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const top = parsed as { ok?: unknown; result?: { agents?: unknown } }
  if (top.ok !== true) return null
  const agents = top.result?.agents
  if (!Array.isArray(agents)) return null
  const out = new Map<string, OrcaAgentEntry>()
  for (const item of agents) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const a = item as Record<string, unknown>
    const id = normalizeOrcaSessionId(
      typeof a.orcaSessionId === 'string' ? a.orcaSessionId : typeof a.id === 'string' ? a.id : undefined,
    )
    if (!id) continue
    const kind = typeof a.kind === 'string' ? a.kind : undefined
    const state = typeof a.state === 'string' ? a.state : typeof a.status === 'string' ? a.status : undefined
    out.set(id, {
      orcaSessionId: id,
      ...(kind ? { kind } : {}),
      ...(state ? { state } : {}),
    })
  }
  return out
}

interface CacheEntry {
  at: number
  value: Map<string, OrcaAgentEntry> | null
}

const agentCache = new Map<string, CacheEntry>()

export function clearOrcaAgentCache(): void {
  agentCache.clear()
}

export async function orcaAgents(
  env: Env,
  opts: { run?: OrcaAgentListRunner; now?: () => number; bypassCache?: boolean; timeoutMs?: number } = {},
): Promise<Map<string, OrcaAgentEntry> | null> {
  const now = opts.now?.() ?? Date.now()
  const timeoutMs = opts.timeoutMs ?? ORCA_AGENT_LIST_TIMEOUT_MS
  const key = opts.run ? '' : `${env.HOME ?? ''}\0${env.PATH ?? ''}`
  if (key && !opts.bypassCache) {
    const cached = agentCache.get(key)
    if (cached && now - cached.at < ORCA_AGENT_CACHE_MS) return cached.value
  }
  const run: OrcaAgentListRunner =
    opts.run ??
    (async (args, limitMs) => {
      const bin = await findOrcaBin(env)
      if (!bin) throw new Error('Orca is not installed')
      return runBounded(bin, [...args], env, { timeoutMs: limitMs, graceMs: Math.min(250, limitMs) })
    })
  let value: Map<string, OrcaAgentEntry> | null = null
  try {
    const ans = await run(['agent', 'list', '--json'], timeoutMs)
    value = parseOrcaAgentList(ans.stdout, ans.exitCode)
  } catch {
    value = null
  }
  if (key) agentCache.set(key, { at: now, value })
  return value
}

/**
 * WHY: confirmed pre-send refusal codes prove the message never entered Orca's runtime and may safely fall back to
 * `paste-needed`; all other failures after send starts map to `unknown` to prevent duplicate delivery (ADR-0088).
 */
const PRE_SEND_CODES = new Set([
  'not_found',
  'recipient_not_found',
  'session_not_found',
  'chat_not_found',
  'terminal_not_found',
  'terminal_handle_stale',
  'no_active_sender_terminal',
  'invalid_sender',
  'invalid_recipient',
  'invalid_argument',
  'invalid_request',
  'permission_denied',
  'refused',
  'self_send_refused',
  'sender_not_found',
])

const UNCERTAIN_CODES = new Set(['runtime_unavailable', 'outcome_unknown', 'timeout', 'disconnected'])

function extractHeldWarning(top: Record<string, unknown>): string | undefined {
  const res =
    top.result && typeof top.result === 'object' && !Array.isArray(top.result)
      ? (top.result as Record<string, unknown>)
      : undefined
  const check = (v: unknown): boolean => {
    if (typeof v === 'string') return v.includes('recipient_delivery_held')
    if (Array.isArray(v)) return v.some(check)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.code === 'recipient_delivery_held' || o.recipient_delivery_held === true) return true
      return Object.values(o).some(check)
    }
    return false
  }
  if (
    check(res?.warning) ||
    check(res?.warnings) ||
    check(res?.delivery) ||
    check(res?.status) ||
    check(top.warning) ||
    check(top.warnings)
  ) {
    return 'Orca accepted the message, but delivery to the recipient is currently held (recipient_delivery_held)'
  }
  return undefined
}

export function classifyOrcaSend(answer: { exitCode: number; stdout: string }): OrcaSendOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(answer.stdout)
  } catch {
    return {
      kind: 'unknown',
      reason: `Orca returned an unreadable answer (exit ${answer.exitCode})`,
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'unknown',
      reason: `Orca returned an unexpected answer (exit ${answer.exitCode})`,
    }
  }
  const top = parsed as Record<string, unknown>
  if (answer.exitCode === 0 && top.ok === true) {
    const warning = extractHeldWarning(top)
    return warning ? { kind: 'delivered', warning } : { kind: 'delivered' }
  }
  const err =
    top.error && typeof top.error === 'object' && !Array.isArray(top.error)
      ? (top.error as Record<string, unknown>)
      : undefined
  const code = typeof err?.code === 'string' ? err.code : undefined
  if (code && UNCERTAIN_CODES.has(code)) {
    return { kind: 'unknown', reason: `Orca reported ${code}` }
  }
  if (code && PRE_SEND_CODES.has(code)) {
    return { kind: 'paste-needed', reason: `Orca refused the delivery (${code})` }
  }
  return {
    kind: 'unknown',
    reason: code ? `Orca did not confirm delivery (${code})` : `Orca exited with ${answer.exitCode}`,
  }
}

function isGroupAlive(pid: number | undefined): boolean {
  if (process.platform === 'win32' || pid === undefined) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (process.platform !== 'win32' && pid !== undefined) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // WHY: fall back to direct child signal if the process group already exited (ADR-0088).
    }
  }
  try {
    child.kill(signal)
  } catch {
    // WHY: child already exited before the signal arrived (ADR-0088).
  }
}

export async function runOrcaSend(
  args: readonly string[],
  env: Env,
  timeoutMs = ORCA_SEND_TIMEOUT_MS,
  killGraceMs = KILL_GRACE_MS,
): Promise<{ exitCode: number; stdout: string }> {
  const bin = await findOrcaBin(env)
  if (!bin) throw new OrcaPreSendError('Orca is not installed')
  return new Promise((resolve, reject) => {
    let settled = false
    let started = false
    let childClosed = false
    let stdout = ''
    let timeoutErr: Error | undefined
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [...args], {
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      reject(new OrcaPreSendError((err as Error).message))
      return
    }
    child.once('spawn', () => {
      started = true
    })
    let killTimer: NodeJS.Timeout | undefined
    let postKillTimer: NodeJS.Timeout | undefined
    let groupPoll: NodeJS.Timeout | undefined
    const finish = (err: Error | null, exitCode?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(postKillTimer)
      clearInterval(groupPoll)
      if (err) reject(err)
      else resolve({ exitCode: exitCode ?? 1, stdout })
    }
    const timer = setTimeout(() => {
      const msg = `Orca did not finish within ${timeoutMs / 1000} s`
      timeoutErr = started ? new OrcaSendTimeout(msg) : new OrcaPreSendError(msg)
      signalChild(child, 'SIGTERM')
      // WHY: keep killTimer armed until the entire process group exits even if the direct process closes
      // while a background descendant ignores SIGTERM, so body-file cleanup waits until transport stops (ADR-0088).
      killTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL')
        // WHY: keep poll and bounded post-kill timers ref'd until finish() clears them so a standalone
        // CLI does not exit 0 early after the outer process closes, skipping receipt and body-file cleanup (ADR-0088).
        groupPoll = setInterval(() => {
          if (!isGroupAlive(child.pid) && childClosed) finish(timeoutErr!)
        }, 20)
        postKillTimer = setTimeout(
          () => {
            child.stdout?.destroy()
            finish(timeoutErr!)
          },
          Math.min(Math.max(killGraceMs, 80), 500),
        )
      }, killGraceMs)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk
    })
    child.once('error', (err: NodeJS.ErrnoException) => {
      finish(
        new OrcaPreSendError(
          err.code === 'ENOENT' ? 'Orca is not on PATH' : `Orca could not start: ${err.message}`,
        ),
      )
    })
    child.once('close', (code) => {
      childClosed = true
      if (timeoutErr && isGroupAlive(child.pid)) return
      finish(timeoutErr ?? null, code)
    })
  })
}
