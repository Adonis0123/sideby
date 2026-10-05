// `sideby ui --background` and `--stop`: one detached Panel per state directory, found again through a pid file.
// The detached process runs `sideby ui --serve-detached`; that flag is internal. `--stop` signals a pid only when
// the process, its start time and the Panel answering on the recorded port all match the pid file.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loginShellPath } from '../core/login-path.ts'
import type { Paths } from '../core/paths.ts'
import type { Env } from '../types.ts'
import {
  DEFAULT_PANEL_PORT,
  isSidebyPanel,
  type PanelServer,
  panelIdentity,
  startPanelServer,
} from './server.ts'

export const DETACHED_FLAG = 'serve-detached'
const START_TIMEOUT_MS = 20_000
const LOCK_STALE_MS = 30_000
const STOP_TIMEOUT_MS = 5000
const LOG_MAX_BYTES = 1_000_000

export interface PanelPidFile {
  pid: number
  port: number
  url: string
  startedAt: string
  /** Random id the Panel also returns on `/api/health`. */
  instance: string
  /** `ps -o lstart=` of the process, when `ps` gave one; a reused pid has another. */
  processStart?: string
}

export const pidFilePath = (p: Paths) => join(p.stateDir, 'panel.json')
export const logFilePath = (p: Paths) => join(p.stateDir, 'panel.log')
const lockPath = (p: Paths) => join(p.stateDir, 'panel.lock')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function readPidFile(p: Paths): Promise<PanelPidFile | undefined> {
  try {
    const d = JSON.parse(await readFile(pidFilePath(p), 'utf8')) as Partial<PanelPidFile>
    if (Number.isInteger(d.pid) && Number.isInteger(d.port) && typeof d.url === 'string')
      return { ...d, instance: typeof d.instance === 'string' ? d.instance : '' } as PanelPidFile
  } catch {}
  return undefined
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Output of `ps -o <field>= -p <pid>`, or undefined when the process is gone or `ps` is unavailable. */
function psField(pid: number, field: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-ww', '-o', `${field}=`, '-p', String(pid)],
      { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    )
  })
}

/** When `pid` started, as `ps` prints it; with the pid it names one process, which a reused pid does not match. */
export const processStartTime = (pid: number) => psField(pid, 'lstart')

type PanelCheck =
  | { status: 'ours' }
  /** The pid file does not name this process: stale, safe to remove. */
  | { status: 'stale'; reason: string }
  /** The process looks like the one that wrote the pid file, but no Panel on the port confirms it. */
  | { status: 'unconfirmed'; reason: string }

/**
 * Checks that the pid file names a live detached Panel: the process is alive, started when the pid file says,
 * runs `ui --serve-detached`, and the Panel on the recorded port answers with the same instance id and pid.
 */
async function checkPanel(rec: PanelPidFile): Promise<PanelCheck> {
  const stale = (reason: string): PanelCheck => ({ status: 'stale', reason })
  if (!rec.instance) return stale('it names no panel instance')
  if (!alive(rec.pid)) return stale(`process ${rec.pid} is not running`)
  if (rec.processStart && (await processStartTime(rec.pid)) !== rec.processStart)
    return stale(`process ${rec.pid} is not the one that wrote it`)
  const cmd = await psField(rec.pid, 'command')
  if (!(cmd && / ui( |$)/.test(cmd) && cmd.includes(`--${DETACHED_FLAG}`)))
    return stale(`process ${rec.pid} is not a sideby panel`)
  const id = await panelIdentity(rec.port)
  if (!id)
    return {
      status: 'unconfirmed',
      reason: `process ${rec.pid} does not answer as a sideby panel on port ${rec.port}; if it is one, stop it with \`kill ${rec.pid}\``,
    }
  if (id.instance !== rec.instance || id.pid !== rec.pid)
    return stale(`the panel on port ${rec.port} is not the one it names`)
  return { status: 'ours' }
}

/** URL of a running background Panel, or of any sideby Panel on `port`; removes a stale pid file. */
export async function findRunningPanel(p: Paths, port: number): Promise<string | undefined> {
  const rec = await readPidFile(p)
  if (rec) {
    const check = await checkPanel(rec)
    if (check.status === 'ours') return rec.url
    if (check.status === 'stale') await rm(pidFilePath(p), { force: true })
  }
  return (await isSidebyPanel(port)) ? `http://127.0.0.1:${port}/` : undefined
}

/** Takes the start lock, waiting while another launch holds it; a lock older than 30 s is taken over. */
async function withStartLock<T>(p: Paths, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(p)
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    try {
      const fh = await open(lock, 'wx', 0o600)
      await fh.writeFile(String(process.pid))
      await fh.close()
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      )
      if (age > LOCK_STALE_MS || Date.now() > deadline) await rm(lock, { force: true })
      else await sleep(200)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lock, { force: true })
  }
}

async function openLog(p: Paths) {
  const log = logFilePath(p)
  const size = await stat(log).then(
    (s) => s.size,
    () => 0,
  )
  if (size > LOG_MAX_BYTES) await rename(log, `${log}.1`).catch(() => {})
  return open(log, 'a', 0o600)
}

export interface StartBackgroundOptions {
  paths: Paths
  env: Env
  /** Absolute path of the sideby CLI entry the detached process runs. */
  entry: string
  port?: number
}

/**
 * Makes sure one background Panel runs and returns its URL. Reuses a running one; otherwise starts
 * `sideby ui --serve-detached` in its own session, logging to the state directory, and waits until it listens.
 */
export async function startBackgroundPanel(
  opts: StartBackgroundOptions,
): Promise<{ url: string; reused: boolean; pid?: number }> {
  const { paths } = opts
  const port = opts.port ?? DEFAULT_PANEL_PORT
  const running = await findRunningPanel(paths, port)
  if (running) return { url: running, reused: true }
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  return withStartLock(paths, async () => {
    // Another launch may have started one while this one waited for the lock.
    const again = await findRunningPanel(paths, port)
    if (again) return { url: again, reused: true }
    const log = await openLog(paths)
    try {
      await log.write(`\n[${new Date().toISOString()}] starting background panel on port ${port}\n`)
      const child = spawn(
        process.execPath,
        [opts.entry, 'ui', `--${DETACHED_FLAG}`, '--no-open', '--port', String(port)],
        {
          env: opts.env as NodeJS.ProcessEnv,
          detached: true,
          stdio: ['ignore', log.fd, log.fd, 'ipc'],
        },
      )
      const msg = await new Promise<{ url: string; reused: boolean }>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`the background panel did not start; see ${logFilePath(paths)}`))
        }, START_TIMEOUT_MS)
        child.once('message', (m) => {
          clearTimeout(timer)
          resolve(m as { url: string; reused: boolean })
        })
        child.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`the background panel exited (code ${code}); see ${logFilePath(paths)}`))
        })
      })
      child.removeAllListeners()
      if (child.connected) child.disconnect()
      child.unref()
      return msg.reused ? { url: msg.url, reused: true } : { url: msg.url, reused: false, pid: child.pid! }
    } finally {
      await log.close()
    }
  })
}

/**
 * Body of the detached process: serve the Panel with Hosts found through the login shell's PATH, tell the
 * launching process the URL over IPC, keep the pid file while running, and remove it on SIGTERM or SIGINT.
 */
export async function serveDetached(opts: {
  paths: Paths
  env: Env
  port?: number
  runtimeFactory: (env: Env) => Promise<import('../runtime.ts').Runtime>
  log: (s: string) => void
}): Promise<number> {
  const { paths, log } = opts
  // Started now, awaited by the first request: the server listens without waiting for the shell.
  const envReady = loginShellPath(opts.env).then((r) => {
    log(
      r.source === 'login-shell'
        ? 'host PATH: from the login shell'
        : `host PATH: login shell unusable (${r.reason}); using the inherited PATH`,
    )
    return { ...opts.env, PATH: r.path }
  })
  const instance = randomBytes(16).toString('hex')
  const srv: PanelServer = await startPanelServer({
    runtimeFactory: async () => opts.runtimeFactory(await envReady),
    instance,
    ...(opts.port ? { port: opts.port } : {}),
    open: false,
    log,
  })
  const send = (m: object) => {
    if (process.send) process.send(m)
    if (process.connected) process.disconnect()
  }
  if (srv.reused) {
    send({ url: srv.url, reused: true })
    return 0
  }
  const rec: PanelPidFile = {
    pid: process.pid,
    port: Number(new URL(srv.url).port),
    url: srv.url,
    startedAt: new Date().toISOString(),
    instance,
  }
  const processStart = await processStartTime(process.pid)
  if (processStart) rec.processStart = processStart
  await writeFile(pidFilePath(paths), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
  send({ url: srv.url, reused: false })
  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      log(`[${new Date().toISOString()}] ${sig}: stopping`)
      void srv.close().finally(resolve)
    }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
    process.on('SIGHUP', () => {})
  })
  const now = await readPidFile(paths)
  if (now?.pid === process.pid) await rm(pidFilePath(paths), { force: true })
  return 0
}

export type StopResult =
  | { status: 'stopped'; pid: number; url: string }
  | { status: 'not-running'; detail?: string }
  | { status: 'failed'; pid: number; detail: string }

/** Stops the background Panel named in the pid file, signalling it only when checkPanel confirms it. */
export async function stopBackgroundPanel(paths: Paths): Promise<StopResult> {
  const rec = await readPidFile(paths)
  if (!rec) return { status: 'not-running' }
  const check = await checkPanel(rec)
  if (check.status === 'stale') {
    await rm(pidFilePath(paths), { force: true })
    return { status: 'not-running', detail: `removed a stale pid file (${check.reason})` }
  }
  if (check.status === 'unconfirmed') return { status: 'failed', pid: rec.pid, detail: check.reason }
  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch (err) {
    return { status: 'failed', pid: rec.pid, detail: (err as Error).message }
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (alive(rec.pid) && Date.now() < deadline) await sleep(100)
  if (alive(rec.pid))
    return {
      status: 'failed',
      pid: rec.pid,
      detail: `process ${rec.pid} did not exit within ${STOP_TIMEOUT_MS / 1000} s; stop it with \`kill ${rec.pid}\``,
    }
  await rm(pidFilePath(paths), { force: true })
  return { status: 'stopped', pid: rec.pid, url: rec.url }
}
