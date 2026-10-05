// PATH as the user's login shell sets it. An app started from Finder, a dock or launchd gets a minimal PATH, so
// Hosts installed under ~/.local/bin, ~/.grok/bin or a version manager would look "not installed".
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { delimiter, isAbsolute } from 'node:path'
import type { Env } from '../types.ts'

const BEGIN = '__SIDEBY_PATH_BEGIN__'
const END = '__SIDEBY_PATH_END__'
export const LOGIN_PATH_TIMEOUT_MS = 5000

export interface LoginPathOptions {
  /** Shell to ask; defaults to `$SHELL`, then the account's shell, then `/bin/sh`. */
  shell?: string
  timeoutMs?: number
}

export interface LoginPathResult {
  path: string
  /** `login-shell` when the shell answered, `fallback` when its answer was unusable and `path` is the current one. */
  source: 'login-shell' | 'fallback'
  /** Why the fallback was used. */
  reason?: string
}

/** Joins PATH lists, first occurrence wins, dropping empty and relative entries. */
export function mergePaths(...lists: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const list of lists)
    for (const dir of (list ?? '').split(delimiter))
      if (dir && isAbsolute(dir) && !seen.has(dir)) seen.add(dir)
  return [...seen].join(delimiter)
}

/** Reads the PATH between the markers; rc files may print anything before or after them. */
export function parseMarkedPath(stdout: string): string | undefined {
  const end = stdout.lastIndexOf(END)
  if (end === -1) return undefined
  const begin = stdout.lastIndexOf(BEGIN, end)
  if (begin === -1) return undefined
  const value = stdout.slice(begin + BEGIN.length, end).trim()
  if (!value || /[\r\n]/.test(value)) return undefined
  const dirs = value.split(delimiter).filter((d) => d && isAbsolute(d))
  return dirs.length ? dirs.join(delimiter) : undefined
}

function defaultShell(env: Env): string {
  if (env.SHELL && isAbsolute(env.SHELL)) return env.SHELL
  try {
    const s = userInfo().shell
    if (s && isAbsolute(s)) return s
  } catch {}
  return '/bin/sh'
}

/**
 * Asks the login shell (`$SHELL -ilc`) for its PATH and merges it in front of `env.PATH`.
 * Never throws: on a timeout, a missing shell or unreadable output it returns the current PATH.
 */
export function loginShellPath(env: Env, opts: LoginPathOptions = {}): Promise<LoginPathResult> {
  const current = env.PATH ?? ''
  const shell = opts.shell ?? defaultShell(env)
  const timeoutMs = opts.timeoutMs ?? LOGIN_PATH_TIMEOUT_MS
  // `printenv` prints the exported PATH the same way in sh, bash, zsh and fish (where $PATH is a list).
  const script = `echo ${BEGIN}; printenv PATH; echo ${END}`
  return new Promise((resolve) => {
    let done = false
    let out = ''
    const finish = (reason?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // A shell that printed its PATH but hangs on exit (an rc file started something) still counts.
      const found = parseMarkedPath(out)
      if (found) resolve({ path: mergePaths(found, current), source: 'login-shell' })
      else resolve({ path: current, source: 'fallback', reason: reason ?? 'no PATH in the shell output' })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ilc', script], {
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Own process group, so a timeout also stops whatever the rc files started.
        detached: true,
      })
    } catch (err) {
      resolve({ path: current, source: 'fallback', reason: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
      finish(`${shell} did not answer within ${timeoutMs} ms`)
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 1_000_000) out += d
    })
    child.once('error', (err) => finish(err.message))
    child.once('close', () => finish())
  })
}
