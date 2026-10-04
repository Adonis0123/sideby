// Standalone Panel server for `sideby ui`: loopback only, reuses a running Panel, shifts past busy ports.
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { Runtime } from '../runtime.ts'
import { createPanelHandler } from './handler.ts'

export const DEFAULT_PANEL_PORT = 17420
const PORT_ATTEMPTS = 20
const LOOPBACK = '127.0.0.1'

export interface PanelServerOptions {
  runtimeFactory: () => Promise<Runtime>
  port?: number
  open?: boolean
  log?: (s: string) => void
  version?: string
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

/** True when a sideby Panel answers on this port. */
export async function isSidebyPanel(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOOPBACK}:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { app?: unknown }
    return body?.app === 'sideby'
  } catch {
    return false
  }
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
  const announce = async (url: string, reused: boolean) => {
    log(reused ? `sideby panel is already running at ${url}` : `sideby panel: ${url}`)
    if (opts.open && !(await openBrowser(url))) log(`open ${url} in your browser`)
  }

  for (let port = first; port < first + PORT_ATTEMPTS && port <= 65535; port++) {
    const handler = createPanelHandler({
      runtime: opts.runtimeFactory,
      allowedHosts: [`${LOOPBACK}:${port}`, `localhost:${port}`],
      ...(opts.version ? { version: opts.version } : {}),
    })
    const server = createServer((req, res) => {
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
    if (await isSidebyPanel(port)) {
      await announce(url, true)
      return { url, reused: true, close: async () => {} }
    }
  }
  throw new Error(
    `ports ${first}-${first + PORT_ATTEMPTS - 1} are all busy; pick another with \`sideby ui --port <n>\``,
  )
}
