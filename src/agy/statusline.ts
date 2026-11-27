// WHY: ADR-0088 internal entry for `sideby agy-statusline` and `sideby agy-title`. Imports only Node built-ins and
// leaf modules so agy refreshes stay fast and never pull in runtime.ts or Family indexes.
import { spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { lstatOrNull, ownedFolder, readSmallFile, writeFileAtomic } from '../core/fs-safe.ts'
import { resolvePaths } from '../core/paths.ts'
import type { Env } from '../types.ts'

export const AGY_LIVE_DIR = 'agy-live'
export const AGY_ORIG_FLAG = '--orig-b64'
export const AGY_HELPER_ACTIVE_VAR = 'SIDEBY_AGY_HELPER_ACTIVE'
export const AGY_LAUNCH_PID_VAR = 'SIDEBY_AGY_LAUNCH_PID'
export const AGY_PID_VAR = 'SIDEBY_AGY_PID'

const MAX_STDIN_BYTES = 256 * 1024
const ORIG_TIMEOUT_MS = 2_000
const ORIG_KILL_GRACE_MS = 500
const PS_TIMEOUT_MS = 2_000
const MAX_TITLE_LEN = 200
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/
const PID_FILE = /^(\d+)\.json$/
const KNOWN_STATES = new Set(['idle', 'working', 'tool_use', 'reviewing', 'error'])
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

export interface HelperProc {
  pid: number
  ppid: number
  startMs: number
  command: string
}

export const AGY_ACCOUNT_REF_RE = /^agy:[a-z0-9][a-z0-9-]{0,31}$/

export interface AgyLiveRecord {
  version: 1
  pid: number
  procStart: number
  conversationId: string
  /** WHY: ADR-0090 per-Account Live Session disambiguation across concurrent `agy` processes. */
  account?: string
  title?: string
  agentState?: string
  cwd?: string
  updatedAt: string
}

export interface AgyHelperDeps {
  selfPid?: number
  now?: () => Date
  origTimeoutMs?: number
  origKillGraceMs?: number
  listProcs?: () => Promise<HelperProc[]>
  runOrig?: (
    cmd: string,
    input: Buffer,
    env: Env,
    timeoutMs: number,
    killGraceMs?: number,
  ) => Promise<{ code: number; stdout: string }>
}

export const isPlainAgyId = (v: unknown): v is string => typeof v === 'string' && PLAIN_ID.test(v)

const stripControls = (s: string): string => [...s].filter((ch) => ch >= ' ' && ch !== '\x7f').join('')

function parseLstart(s: string): number {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s)
  if (!m) return Number.NaN
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return Number.NaN
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

export function parseHelperPs(out: string): HelperProc[] {
  const procs: HelperProc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const startMs = parseLstart(m[3]!)
    if (Number.isNaN(startMs)) continue
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), startMs, command: m[4]!.trim() })
  }
  return procs
}

function isAgyCommand(command: string): boolean {
  const [prog, script] = command.split(/\s+/)
  const name = (s: string | undefined) => (s ? basename(s).replace(/\.(c|m)?js$/, '') : '')
  if (name(prog) === 'agy') return true
  return /^(node|bun|deno)$/.test(name(prog)) && name(script) === 'agy'
}

/**
 * WHY: agy runs statusLine/title scripts via `sh -c` (`cmd /c` on Windows), so `process.ppid` may be a shell rather
 * than `agy`. Walk ancestors (or honor explicit `SIDEBY_AGY_PID` binding) to find the owning `agy` process (ADR-0088).
 */
export function resolveOwningAgyProc(
  selfPid: number,
  procs: readonly HelperProc[],
  env: Env,
): HelperProc | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const launchPid = Number(env[AGY_LAUNCH_PID_VAR])
  const hasLaunchPid = Number.isInteger(launchPid) && launchPid > 1
  const seen = new Set<number>()
  let cur = byPid.get(selfPid)?.ppid
  let fallback: HelperProc | undefined
  while (cur !== undefined && cur > 1 && !seen.has(cur) && seen.size < 32) {
    seen.add(cur)
    const p = byPid.get(cur)
    if (!p) break
    if (isAgyCommand(p.command)) {
      if (hasLaunchPid && p.ppid === launchPid) return p
      fallback ??= p
    }
    cur = p.ppid
  }
  if (fallback) return fallback
  const bound = Number(env[AGY_PID_VAR])
  if (Number.isInteger(bound) && bound > 1) {
    const p = byPid.get(bound)
    if (p && isAgyCommand(p.command)) return p
  }
  return undefined
}

function listUserProcs(env: Env): Promise<HelperProc[]> {
  return new Promise((resolve) => {
    const uid = process.getuid?.()
    const args = [...(uid === undefined ? ['-A'] : ['-U', String(uid)]), '-o', 'pid=,ppid=,lstart=,command=']
    let settled = false
    let out = ''
    const finish = (procs: HelperProc[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(procs)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('ps', args, {
        env: { ...env, TZ: 'UTC', LC_ALL: 'C' } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve([])
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish([])
    }, PS_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < 4 * 1024 * 1024) out += chunk
    })
    child.once('error', () => finish([]))
    child.once('close', (code) => finish(code === 0 ? parseHelperPs(out) : []))
  })
}

function originalCommand(argv: readonly string[]): string | null {
  let b64: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === AGY_ORIG_FLAG) b64 = argv[i + 1]
    else if (a.startsWith(`${AGY_ORIG_FLAG}=`)) b64 = a.slice(AGY_ORIG_FLAG.length + 1)
  }
  if (!b64) return null
  const cmd = Buffer.from(b64, 'base64').toString('utf8')
  return cmd.trim() ? cmd : null
}

async function readBounded(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const c of stream) {
      const buf = typeof c === 'string' ? Buffer.from(c) : Buffer.from(c)
      const room = MAX_STDIN_BYTES - size
      if (room <= 0) break
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf)
      size += buf.length
    }
  } catch {
    // WHY: keep whatever arrived; broken stdin must not break status line rendering (ADR-0088).
  }
  return Buffer.concat(chunks)
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

export function runOriginalCommand(
  cmd: string,
  input: Buffer,
  env: Env,
  timeoutMs: number,
  killGraceMs = ORIG_KILL_GRACE_MS,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, shellArgs, {
        env: { ...env, [AGY_HELPER_ACTIVE_VAR]: '1' } as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      })
    } catch {
      resolve({ code: 127, stdout: '' })
      return
    }
    let settled = false
    let timedOut = false
    let childClosed = false
    let stdout = ''
    let killTimer: NodeJS.Timeout | undefined
    let postKillTimer: NodeJS.Timeout | undefined
    let groupPoll: NodeJS.Timeout | undefined
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(postKillTimer)
      clearInterval(groupPoll)
      resolve({ code, stdout })
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalChild(child, 'SIGTERM')
      // WHY: keep killTimer armed until the entire process group exits, even if the direct shell exits early
      // while a pipe-closing background descendant ignores SIGTERM (ADR-0088).
      killTimer = setTimeout(() => {
        signalChild(child, 'SIGKILL')
        // WHY: keep poll and bounded post-kill timers ref'd until finish() clears them so a standalone
        // CLI does not exit 0 early after the outer shell closes before settling the timeout (ADR-0088).
        groupPoll = setInterval(() => {
          if (!isGroupAlive(child.pid) && childClosed) finish(124)
        }, 20)
        postKillTimer = setTimeout(
          () => {
            child.stdout?.destroy()
            finish(124)
          },
          Math.min(Math.max(killGraceMs, 80), 500),
        )
      }, killGraceMs)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    child.once('error', () => finish(127))
    child.once('close', (code) => {
      childClosed = true
      if (timedOut && isGroupAlive(child.pid)) return
      finish(timedOut ? 124 : (code ?? 1))
    })
  })
}

interface ParsedPayload {
  conversationId?: string
  title?: string
  agentState?: string
  cwd?: string
}

function parseAgyPayload(raw: string): ParsedPayload {
  if (!raw.trim()) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const r = obj as Record<string, unknown>
  const conversationId = isPlainAgyId(r.conversation_id) ? r.conversation_id : undefined
  const rawTitle = typeof r.conversation_title === 'string' ? stripControls(r.conversation_title).trim() : ''
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_LEN) : undefined
  const rawState = typeof r.agent_state === 'string' ? r.agent_state.trim().toLowerCase() : ''
  const agentState = KNOWN_STATES.has(rawState) ? rawState : undefined
  const rawCwd = typeof r.cwd === 'string' ? r.cwd.trim() : ''
  const cwd = rawCwd && isAbsolute(rawCwd) ? rawCwd : undefined
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(title ? { title } : {}),
    ...(agentState ? { agentState } : {}),
    ...(cwd ? { cwd } : {}),
  }
}

export function formatAgyLabel(
  accountLabel: string,
  title: string | undefined,
  cwd: string | undefined,
  conversationId: string | undefined,
): string {
  const cleanAccount = stripControls(accountLabel).trim() || 'agy:main'
  const cleanTitle = title ? stripControls(title).trim() : cwd ? stripControls(basename(cwd)).trim() : ''
  const short = conversationId ? conversationId.slice(0, 8) : ''
  return [cleanAccount, cleanTitle, short].filter(Boolean).join(' · ')
}

/**
 * WHY: dead-PID cleanup runs only in write paths (`agy-statusline` and launch/exit), never during read-only
 * `sideby sessions` or Panel `/api/sessions` (ADR-0088). Re-verify mtime/inode before unlinking to avoid racing a
 * concurrent agy launch (ADR-0090).
 */
export async function pruneDeadAgyLive(
  stateDir: string,
  procs: readonly HelperProc[],
  snapshotMs?: number,
): Promise<void> {
  if (!procs.length) return
  let dir: string | null
  try {
    dir = await ownedFolder(stateDir, [AGY_LIVE_DIR], { create: false })
  } catch {
    return
  }
  if (!dir) return
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const m = PID_FILE.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    const file = join(dir, name)
    const st = await lstatOrNull(file)
    if (!st || st.isSymbolicLink() || !st.isFile()) continue
    const proc = byPid.get(pid)
    const raw = await readSmallFile(file, 16 * 1024)
    let parsed: { procStart?: unknown; updatedAt?: unknown } | null = null
    let badJson = false
    if (raw !== undefined) {
      try {
        parsed = JSON.parse(raw) as { procStart?: unknown; updatedAt?: unknown }
      } catch {
        badJson = true
      }
    }
    let stale = !proc
    if (proc) {
      stale =
        badJson || (typeof parsed?.procStart === 'number' && Math.abs(proc.startMs - parsed.procStart) > 2000)
    } else if (snapshotMs !== undefined) {
      const updated = typeof parsed?.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : Number.NaN
      if (st.mtimeMs > snapshotMs || (Number.isFinite(updated) && updated > snapshotMs)) stale = false
    }
    if (!stale) continue
    const st2 = await lstatOrNull(file)
    if (st2 && !st2.isSymbolicLink() && st2.isFile() && st2.ino === st.ino && st2.mtimeMs === st.mtimeMs) {
      await rm(file, { force: true }).catch(() => {})
    }
  }
}

async function writeLiveCache(
  stateDir: string,
  payload: ParsedPayload,
  env: Env,
  deps: AgyHelperDeps,
): Promise<void> {
  if (!payload.conversationId) return
  // WHY: add 1ms ceiling over Date.now() truncation so files written just before snapshot (sub-ms mtime) still prune cleanly (ADR-0090).
  const snapshotMs = Date.now() + 1
  const procs = await (deps.listProcs ?? (() => listUserProcs(env)))().catch(() => [] as HelperProc[])
  if (!procs.length) return
  const owner = resolveOwningAgyProc(deps.selfPid ?? process.pid, procs, env)
  if (!owner) return
  const dir = await ownedFolder(stateDir, [AGY_LIVE_DIR], { create: true, private: true })
  if (!dir) return
  const account =
    typeof env.SIDEBY_ACCOUNT === 'string' && AGY_ACCOUNT_REF_RE.test(env.SIDEBY_ACCOUNT)
      ? env.SIDEBY_ACCOUNT
      : undefined
  // WHY: keep only non-credential fields; never store email, plan_tier or tokens (ADR-0088).
  const record: AgyLiveRecord = {
    version: 1,
    pid: owner.pid,
    procStart: owner.startMs,
    conversationId: payload.conversationId,
    ...(account ? { account } : {}),
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.agentState ? { agentState: payload.agentState } : {}),
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  }
  await writeFileAtomic(join(dir, `${owner.pid}.json`), `${JSON.stringify(record)}\n`, 0o600)
  await pruneDeadAgyLive(stateDir, procs, snapshotMs)
}

export async function runAgyHelper(
  mode: 'statusline' | 'title',
  argv: readonly string[],
  env: Env,
  stdin: AsyncIterable<Uint8Array | string>,
  stdout: NodeJS.WritableStream,
  _stderr: NodeJS.WritableStream = process.stderr,
  deps: AgyHelperDeps = {},
): Promise<number> {
  const input = await readBounded(stdin)
  const payload = parseAgyPayload(input.toString('utf8'))
  const accountLabel = env.SIDEBY_LABEL || env.SIDEBY_ACCOUNT || 'agy:main'
  const label = formatAgyLabel(accountLabel, payload.title, payload.cwd, payload.conversationId)
  const stateDir = resolvePaths(env).stateDir

  const origCmd = env[AGY_HELPER_ACTIVE_VAR] === '1' ? null : originalCommand(argv)
  const recordPromise = writeLiveCache(stateDir, payload, env, deps).catch(() => {})
  const origPromise = origCmd
    ? (deps.runOrig ?? runOriginalCommand)(
        origCmd,
        input,
        env,
        deps.origTimeoutMs ?? ORIG_TIMEOUT_MS,
        deps.origKillGraceMs ?? ORIG_KILL_GRACE_MS,
      ).catch(() => ({ code: 1, stdout: '' }))
    : Promise.resolve(null)

  const [, origResult] = await Promise.all([recordPromise, origPromise])
  const origText = origResult?.stdout ? origResult.stdout.trimEnd() : ''

  if (mode === 'title') {
    const cleanOrig = stripControls(origText.replace(/[\r\n]+/g, ' ')).trim()
    const line = cleanOrig ? `${cleanOrig} · ${label}` : `[${label}]`
    stdout.write(`${line}\n`)
    return 0
  }

  const line = origText ? `${origText} · ${label}` : label
  stdout.write(`${line}\n`)
  return 0
}
