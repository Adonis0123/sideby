// "Go to its Orca tab" on the Sessions page (spec §3.32, ADR-0039). Orca sets `ORCA_TERMINAL_HANDLE` in every
// terminal it runs, and `orca terminal list --json` lists the handles of its live terminals: a Live Session whose Host
// process carries a listed handle runs in that tab. A handle that is not listed (Orca restarted, the tab closed) offers
// nothing. Tried with Orca 1.4.230 on macOS on 2026-10-20. Every Orca call goes through OrcaDeps, without a shell.
// What the page gets back is one of three fixed sentences: never the command, the handle or anything Orca printed.
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { UserError } from '../core/errors.ts'
import { which } from '../core/launch.ts'
import { systemDeps } from '../core/live-sessions-procs.ts'
import type { Env } from '../types.ts'

export const ORCA_HANDLE_VAR = 'ORCA_TERMINAL_HANDLE'
/** Where the Orca app keeps its CLI on macOS, for a user who never added `orca` to PATH. */
export const ORCA_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'

export interface OrcaDeps {
  /**
   * Runs the Orca CLI with these arguments: its exit code and output. Throws only when Orca cannot be run or does not
   * finish in time.
   */
  run(args: string[]): Promise<{ exitCode: number; stdout: string }>
  /** The value of one environment variable of a running process. */
  envVar(pid: number, name: string): Promise<string | undefined>
}

/** The only texts a failed switch shows, so nothing of the command, the handle or Orca's output reaches the page. */
export const ORCA_MESSAGES = {
  notRunning: 'Orca is not running or did not answer. Open Orca and try again.',
  gone: 'That Orca tab no longer exists. Refresh the list and try again.',
  unconfirmed: 'Orca did not confirm the switch. Look in Orca, then try again.',
} as const
/** Orca error codes that mean the terminal is gone (Orca 1.4.230 answers `terminal_handle_stale`). */
const GONE_CODES = new Set(['terminal_handle_stale', 'terminal_not_found'])
const MAX_OUTPUT = 8 * 1024 * 1024

/**
 * Runs a program without a shell and always settles: after `timeoutMs` it gets SIGTERM, and SIGKILL `graceMs` later if
 * it is still there. Gives the exit code and stdout; stderr is dropped. Rejects when the program cannot start, does
 * not finish, or prints more than 8 MB.
 */
export function runBounded(
  file: string,
  args: string[],
  env: Env,
  opts: { timeoutMs?: number; graceMs?: number } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const graceMs = opts.graceMs ?? 1000
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let failure: Error | undefined
    const child = spawn(file, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
    let killTimer: NodeJS.Timeout | undefined
    const stop = (why: Error) => {
      failure ??= why
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), graceMs)
      // The last word: a child that survives even SIGKILL (or never reports its exit) still ends the call.
      setTimeout(() => finish(), graceMs + 500).unref()
    }
    const finish = (exitCode?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (failure || typeof exitCode !== 'number') reject(failure ?? new Error('the program did not finish'))
      else resolve({ exitCode, stdout })
    }
    const timer = setTimeout(() => stop(new Error('the program did not finish in time')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT) stop(new Error('the program printed too much'))
    })
    child.on('error', (err) => {
      failure ??= err
      finish()
    })
    child.on('close', (code) => finish(code))
  })
}

/** The real Orca CLI (`orca` on PATH, else the macOS app's copy) and the real process environment reader. */
export function systemOrca(env: Env): OrcaDeps {
  const bin = async (): Promise<string> => {
    const onPath = await which('orca', env)
    if (onPath) return onPath
    if (process.platform === 'darwin') {
      try {
        await access(ORCA_APP_CLI, constants.X_OK)
        return ORCA_APP_CLI
      } catch {}
    }
    throw new Error('Orca is not installed')
  }
  const procs = systemDeps(env)
  return {
    run: async (args) => runBounded(await bin(), args, env),
    envVar: (pid, name) => procs.envVar(pid, name),
  }
}

/** Orca's JSON answer when it is an object that says `ok: true` and the CLI exited 0; else undefined. */
function confirmed(answer: { exitCode: number; stdout: string }): Record<string, unknown> | undefined {
  try {
    const out: unknown = JSON.parse(answer.stdout)
    if (answer.exitCode !== 0 || !out || typeof out !== 'object' || Array.isArray(out)) return undefined
    return (out as { ok?: unknown }).ok === true ? (out as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The handles of the terminals Orca runs now; empty when Orca is missing, not running or answers something else. */
export async function orcaHandles(deps: OrcaDeps): Promise<Set<string>> {
  try {
    const out = confirmed(await deps.run(['terminal', 'list', '--json', '--limit', '1000']))
    const terminals = (out?.result as { terminals?: unknown } | undefined)?.terminals
    if (!Array.isArray(terminals)) return new Set()
    return new Set(
      terminals
        .filter(
          (t): t is { handle: string } =>
            !!t && typeof t.handle === 'string' && t.handle !== '' && t.connected !== false,
        )
        .map((t) => t.handle),
    )
  } catch {
    return new Set()
  }
}

/**
 * The Orca terminal of each Session that runs in one, by Session id. Asks Orca only when some Session has a process
 * id; a Session whose process has no listed handle is left out.
 */
export async function orcaTabs(
  deps: OrcaDeps,
  sessions: readonly { sessionId: string; pid?: number }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const withPid = sessions.filter((s) => typeof s.pid === 'number' && s.pid > 0)
  if (!withPid.length) return out
  const live = await orcaHandles(deps)
  if (!live.size) return out
  await Promise.all(
    withPid.map(async (s) => {
      const handle = await deps.envVar(s.pid!, ORCA_HANDLE_VAR).catch(() => undefined)
      if (handle && live.has(handle)) out.set(s.sessionId, handle)
    }),
  )
  return out
}

/** Brings one Orca terminal tab to the front; a refusal throws one of ORCA_MESSAGES and nothing else. */
export async function switchOrcaTab(deps: OrcaDeps, handle: string): Promise<void> {
  let answer: { exitCode: number; stdout: string }
  try {
    answer = await deps.run(['terminal', 'switch', '--terminal', handle, '--json'])
  } catch {
    throw new UserError(ORCA_MESSAGES.notRunning)
  }
  if (confirmed(answer)) return
  let code: unknown
  try {
    code = (JSON.parse(answer.stdout) as { error?: { code?: unknown } } | null)?.error?.code
  } catch {}
  throw new UserError(
    typeof code === 'string' && GONE_CODES.has(code) ? ORCA_MESSAGES.gone : ORCA_MESSAGES.unconfirmed,
  )
}
