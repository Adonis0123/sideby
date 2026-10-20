// The running processes Live Sessions are checked against (spec §3.32). Every program sideby runs here (`ps`,
// `lsof`) goes through LiveSessionDeps, so tests replace it and never look at the machine's real processes.
import { spawn } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Env } from '../types.ts'
import { which } from './launch.ts'

export interface ProcessInfo {
  pid: number
  ppid: number
  /** When the process started, epoch milliseconds (whole seconds, as `ps` gives it). */
  startMs: number
  /** The command line as `ps` shows it. */
  command: string
}

export interface LiveSessionDeps {
  /** Every process of the current user, or throws when `ps` cannot run. */
  processes(signal?: AbortSignal): Promise<ProcessInfo[]>
  /**
   * The value of one environment variable of a running process (never any other variable); undefined when the
   * process does not set it. Throws when the process's environment cannot be read, so a caller never takes "could
   * not read" for "not set".
   */
  envVar(pid: number, name: string, signal?: AbortSignal): Promise<string | undefined>
  /** Paths of the files a process holds open (`lsof`); empty when they cannot be read. */
  openFiles(pid: number, signal?: AbortSignal): Promise<string[]>
  /**
   * The exact arguments of a process (after the program), where the system gives them word by word (Linux
   * `/proc/<pid>/cmdline`); undefined where only the flattened `ps` line exists (macOS).
   */
  argv?(pid: number, signal?: AbortSignal): Promise<string[] | undefined>
}

/**
 * Runs a program and returns its stdout. It always settles: on a non-zero exit, on `signal`, or after `timeoutMs`
 * (it rejects at once, sends SIGTERM, and SIGKILL after `graceMs` for a program that ignores SIGTERM).
 */
export function runProgram(
  bin: string,
  args: string[],
  env: Env,
  signal?: AbortSignal,
  o: { timeoutMs?: number; graceMs?: number; maxBytes?: number } = {},
): Promise<string> {
  const timeoutMs = o.timeoutMs ?? 5_000
  const graceMs = o.graceMs ?? 1_000
  const maxBytes = o.maxBytes ?? 32 * 1024 * 1024
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(`${basename(bin)} was stopped`))
    const child = spawn(bin, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const end = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          }, graceMs).unref()
        }
        reject(err)
      } else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onAbort = () => end(new Error(`${basename(bin)} was stopped`))
    const timer = setTimeout(
      () => end(new Error(`${basename(bin)} did not answer within ${timeoutMs / 1000} s`)),
      timeoutMs,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > maxBytes) end(new Error(`${basename(bin)} printed more than sideby reads`))
      else chunks.push(d)
    })
    child.once('error', (err) => end(err))
    child.once('close', (code, sig) =>
      end(code === 0 ? null : new Error(`${basename(bin)} exited with ${sig ?? code}`)),
    )
  })
}

const run = (bin: string, args: string[], env: Env, signal?: AbortSignal): Promise<string> =>
  runProgram(bin, args, env, signal)

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

/** `Tue Oct 20 02:14:43 2026` read as UTC (`ps -o lstart` under `TZ=UTC`, Claude Code's `procStart`); NaN otherwise. */
export function parseLstart(s: string): number {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s)
  if (!m) return Number.NaN
  const month = MONTHS.indexOf(m[1]!)
  if (month < 0) return Number.NaN
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

/** Parses `ps -Ao pid=,ppid=,lstart=,command=` output; lines it cannot read are skipped. */
export function parsePs(out: string): ProcessInfo[] {
  const procs: ProcessInfo[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const startMs = parseLstart(m[3]!)
    if (Number.isNaN(startMs)) continue
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), startMs, command: m[4]!.trim() })
  }
  return procs
}

const ENV_NAME = /\s[A-Za-z_][A-Za-z0-9_]*=/g

/**
 * One environment variable of a process on macOS, from two `ps` outputs of it: `argvOut` (`ps -ww -o command=`, the
 * arguments only) and `ewwOut` (`ps eww -o command=`, the same arguments followed by the environment). Only what
 * follows the exact arguments is read, so an argument such as `CODEX_HOME=/x` is never taken for the environment.
 * A value runs to the next ` NAME=`, so a path with spaces stays whole. Throws when the environment cannot be read:
 * the outputs do not match (the process changed, or one was cut off) or no environment is shown.
 */
export function envFromPs(argvOut: string, ewwOut: string, name: string): string | undefined {
  const argv = argvOut.replace(/\n+$/, '')
  const eww = ewwOut.replace(/\n+$/, '')
  if (!argv || !eww.startsWith(argv)) throw new Error('the environment of this process cannot be read')
  const env = eww.slice(argv.length)
  if (!/^\s/.test(env) || !/\sPATH=/.test(env))
    throw new Error('the environment of this process cannot be read')
  const key = ` ${name}=`
  const at = env.indexOf(key)
  if (at < 0) return undefined
  const from = at + key.length
  ENV_NAME.lastIndex = from
  const next = ENV_NAME.exec(env)
  return env.slice(from, next ? next.index : undefined)
}

/** The real `ps` and `lsof`, found on `env.PATH`. */
export function systemDeps(env: Env): LiveSessionDeps {
  const tool = async (name: string): Promise<string> => {
    const bin = await which(name, env)
    if (!bin) throw new Error(`\`${name}\` is not on PATH`)
    return bin
  }
  return {
    async processes(signal) {
      // Only this user's processes; UTC and the C locale make `lstart` one fixed format to read.
      const uid = process.getuid?.()
      const who = uid === undefined ? ['-A'] : ['-U', String(uid)]
      const out = await run(
        await tool('ps'),
        [...who, '-o', 'pid=,ppid=,lstart=,command='],
        { ...env, TZ: 'UTC', LC_ALL: 'C' },
        signal,
      )
      return parsePs(out)
    },
    async envVar(pid, name, signal) {
      if (process.platform === 'linux') {
        let raw: string
        try {
          raw = await readFile(`/proc/${pid}/environ`, 'utf8')
        } catch (err) {
          throw new Error(
            `the environment of process ${pid} cannot be read (${(err as NodeJS.ErrnoException).code})`,
          )
        }
        const hit = raw.split('\0').find((kv) => kv.startsWith(`${name}=`))
        return hit?.slice(name.length + 1)
      }
      const ps = await tool('ps')
      const [argvOut, ewwOut] = await Promise.all([
        run(ps, ['-ww', '-o', 'command=', '-p', String(pid)], env, signal),
        run(ps, ['eww', '-o', 'command=', '-p', String(pid)], env, signal),
      ])
      return envFromPs(argvOut, ewwOut, name)
    },
    async argv(pid) {
      if (process.platform !== 'linux') return undefined
      try {
        const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8')
        const words = raw.split('\0')
        if (words.at(-1) === '') words.pop()
        const prog = basename(words[0] ?? '')
        return /^(node|bun|deno)$/.test(prog) ? words.slice(2) : words.slice(1)
      } catch {
        return undefined
      }
    },
    async openFiles(pid, signal) {
      try {
        const out = await run(await tool('lsof'), ['-n', '-P', '-Fn', '-p', String(pid)], env, signal)
        return out
          .split('\n')
          .filter((l) => l.startsWith('n/'))
          .map((l) => l.slice(1))
      } catch {
        return []
      }
    },
  }
}

/** What a Family's reader sees of the processes: one `ps` per listing, the rest asked per process. */
export interface ProcessView {
  list(): Promise<ProcessInfo[]>
  get(pid: number): Promise<ProcessInfo | undefined>
  envVar(pid: number, name: string): Promise<string | undefined>
  openFiles(pid: number): Promise<string[]>
  /** See `LiveSessionDeps.argv`. */
  argv(pid: number): Promise<string[] | undefined>
}

export function processView(deps: LiveSessionDeps, signal?: AbortSignal): ProcessView {
  let listed: Promise<ProcessInfo[]> | undefined
  const list = () => {
    listed ??= deps.processes(signal)
    return listed
  }
  const files = new Map<number, Promise<string[]>>()
  const envs = new Map<string, Promise<string | undefined>>()
  return {
    list,
    async get(pid) {
      return (await list()).find((p) => p.pid === pid)
    },
    envVar(pid, name) {
      const key = `${pid}\0${name}`
      let v = envs.get(key)
      if (!v) {
        v = deps.envVar(pid, name, signal)
        envs.set(key, v)
      }
      return v
    },
    argv: async (pid) => (deps.argv ? deps.argv(pid, signal).catch(() => undefined) : undefined),
    openFiles(pid) {
      let f = files.get(pid)
      if (!f) {
        f = deps.openFiles(pid, signal)
        files.set(pid, f)
      }
      return f
    },
  }
}

/** Whether a start time a Host recorded is this process's: within 2 s, as `ps` rounds to the second. */
export const sameStart = (proc: ProcessInfo, recordedMs: number): boolean =>
  Math.abs(proc.startMs - recordedMs) <= 2000

/**
 * Whether a command line runs the Host `bin`: its program is named `bin`, or it is `node` (or another
 * interpreter) running a script named `bin` or `bin.js`.
 */
export function runsHost(command: string, bin: string): boolean {
  const [prog, script] = command.split(/\s+/)
  const name = (s: string | undefined) => (s ? basename(s).replace(/\.(c|m)?js$/, '') : '')
  if (name(prog) === bin) return true
  return /^(node|bun|deno)$/.test(name(prog)) && name(script) === bin
}

/** The arguments of a command line after the Host program (and after the script, when an interpreter runs it). */
export function hostArgs(command: string): string[] {
  const words = command.split(/\s+/).filter(Boolean)
  const prog = basename(words[0] ?? '')
  return /^(node|bun|deno)$/.test(prog) ? words.slice(2) : words.slice(1)
}

/**
 * The Host processes of one Account: those running `bin` (and not left out by `skip`) whose variable `envName`
 * `belongs` to it. The variable is asked for all of them at once. A process whose environment cannot be read is left
 * out and named in `problems`, never taken as one without the variable (which would be the Main Account's).
 */
export async function accountProcesses(
  procs: ProcessView,
  o: {
    bin: string
    envName: string
    belongs(value: string | undefined): boolean
    /** `argv` holds the exact arguments where the system gives them, else the flattened `ps` words. */
    skip?(argv: string[], exact: boolean): boolean
  },
  problems: string[],
): Promise<number[]> {
  const candidates = (await procs.list()).filter((p) => runsHost(p.command, o.bin))
  const owned = await Promise.all(
    candidates.map(async (p) => {
      if (o.skip) {
        const exact = await procs.argv(p.pid)
        if (o.skip(exact ?? hostArgs(p.command), exact !== undefined)) return null
      }
      try {
        return o.belongs(await procs.envVar(p.pid, o.envName)) ? p.pid : null
      } catch (err) {
        problems.push(
          `could not tell which account ${o.bin} process ${p.pid} runs as (${(err as Error).message}), so its session is left out; run the command again, or check that the process is yours`,
        )
        return null
      }
    }),
  )
  return owned.filter((pid): pid is number => pid !== null)
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** The first `max` bytes of a file as text, for reading a header line without loading a large record. */
export async function readHead(path: string, max = 64 * 1024): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await fh.read(buf, 0, max, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** A string field of a JSON header line, also when the line is cut off before it ends. */
export function headerField(head: string, key: string): string | undefined {
  const line = head.split('\n')[0] ?? ''
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    const payload = (obj.payload ?? obj) as Record<string, unknown>
    const v = payload[key] ?? obj[key]
    return typeof v === 'string' ? v : undefined
  } catch {
    const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(line)
    if (!m) return undefined
    try {
      return JSON.parse(m[1]!) as string
    } catch {
      return undefined
    }
  }
}

/** Whether `path` lies inside the directory `dir` (not merely next to it, as `dir-backup/` would). */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export const isoOf = (ms: number | undefined): string | undefined =>
  ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
