// Standalone Panel server for `sideby ui`: loopback only, reuses a running Panel, shifts past busy ports.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { buildId, packageVersion } from '../core/version.ts'
import type { Runtime } from '../runtime.ts'
import { createPanelHandler } from './handler.ts'

export const DEFAULT_PANEL_PORT = 17420
const PORT_ATTEMPTS = 20
const LOOPBACK = '127.0.0.1'

/**
 * Whose Panel this is: a hash of the system user and HOME, so `sideby ui` reuses only its own user's Panel. Another
 * user of the same Mac may run one on the same port; reusing it would show that user's accounts and start none of
 * ours. A hash, so the health answer names no path. It only tells Panels apart; it is not authentication. The real
 * path, so one HOME reached through a symlink gives one owner.
 */
export function panelOwner(home: string = process.env.HOME || homedir()): string {
  let dir = resolve(home)
  try {
    dir = realpathSync(dir)
  } catch {
    // keep the resolved path when HOME does not exist
  }
  return createHash('sha256')
    .update(`sideby-panel\0${process.getuid?.() ?? ''}\0${dir}`)
    .digest('hex')
    .slice(0, 16)
}

export interface PanelServerOptions {
  runtimeFactory: () => Promise<Runtime>
  port?: number
  open?: boolean
  log?: (s: string) => void
  version?: string
  /**
   * Random id of a detached Panel. `/api/health` then also returns it with the server's pid, so `sideby ui
   * --stop` can tell this Panel from a reused pid or from another Panel before it sends a signal.
   */
  instance?: string
  /** panelOwner() of the HOME this Panel serves; defaults to this process's HOME. */
  owner?: string
}

export interface PanelServer {
  url: string
  reused: boolean
  close(): Promise<void>
}

function listen(server: Server, port: number): Promise<'ok' | 'busy'> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      if (err.code === 'EADDRINUSE') resolve('busy')
      else reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve('ok')
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK)
  })
}

export interface PanelIdentity {
  instance?: string
  pid?: number
  /** buildId() of the code serving it; absent from Panels older than this field. */
  build?: string
  /** panelOwner() of the user it serves; absent from Panels older than this field. */
  owner?: string
}

/** What the sideby Panel on this port says about itself, or undefined when none answers. */
export async function panelIdentity(port: number): Promise<PanelIdentity | undefined> {
  try {
    const res = await fetch(`http://${LOOPBACK}:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      app?: unknown
      instance?: unknown
      pid?: unknown
      build?: unknown
      owner?: unknown
    }
    if (body?.app !== 'sideby') return undefined
    return {
      ...(typeof body.instance === 'string' ? { instance: body.instance } : {}),
      ...(Number.isInteger(body.pid) ? { pid: body.pid as number } : {}),
      ...(typeof body.build === 'string' ? { build: body.build } : {}),
      ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * True when a sideby Panel of this user answers on this port. One that names another owner belongs to another user
 * and counts as a busy port; one too old to name an owner is taken as ours, as before.
 */
export async function isSidebyPanel(port: number, owner: string = panelOwner()): Promise<boolean> {
  const id = await panelIdentity(port)
  return id !== undefined && (id.owner === undefined || id.owner === owner)
}

/** Opens `url` in the default browser; returns false (and never throws) when that is not possible. */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}

export async function startPanelServer(opts: PanelServerOptions): Promise<PanelServer> {
  const log = opts.log ?? ((s: string) => console.log(s))
  const first = opts.port ?? DEFAULT_PANEL_PORT
  const owner = opts.owner ?? panelOwner()
  // /api/health always names app and version (ADR-0006), also when the caller did not pass one.
  const version = opts.version ?? packageVersion()
  const announce = async (url: string, reused: boolean) => {
    log(reused ? `sideby panel is already running at ${url}` : `sideby panel: ${url}`)
    if (opts.open && !(await openBrowser(url))) log(`open ${url} in your browser`)
  }

  for (let port = first; port < first + PORT_ATTEMPTS && port <= 65535; port++) {
    const hosts = [`${LOOPBACK}:${port}`, `localhost:${port}`]
    const handler = createPanelHandler({
      runtime: opts.runtimeFactory,
      allowedHosts: hosts,
      version,
    })
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/health' && hosts.includes(req.headers.host ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(
          JSON.stringify({
            app: 'sideby',
            version,
            build: buildId(),
            owner,
            ...(opts.instance ? { instance: opts.instance, pid: process.pid } : {}),
          }),
        )
        return
      }
      handler(req, res)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
          }
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
    })
    const result = await listen(server, port)
    const url = `http://${LOOPBACK}:${port}/`
    if (result === 'ok') {
      if (port !== first) log(`port ${first} is busy; using ${port}`)
      await announce(url, false)
      return {
        url,
        reused: false,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()))
            server.closeAllConnections()
          }),
      }
    }
    if (await isSidebyPanel(port, owner)) {
      await announce(url, true)
      return { url, reused: true, close: async () => {} }
    }
  }
  throw new Error(
    `ports ${first}-${first + PORT_ATTEMPTS - 1} are all busy; pick another with \`sideby ui --port <n>\``,
  )
}
