// Shared by the scripts that retake README media (record-demo.ts, shoot-panel.ts): a demo HOME,
// the Panel started on it and a small Chrome DevTools Protocol client over Node's built-in WebSocket.
// Every child process is killed and the work directory removed when the calling script exits.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const cli = join(root, 'src/cli/main.ts')

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const children: ChildProcess[] = []
/** Kill `child` when the script exits. */
export function track(child: ChildProcess): ChildProcess {
  children.push(child)
  return child
}

/** A throwaway directory, removed with every tracked child when the script exits. */
export function workDir(prefix: string): string {
  const work = mkdtempSync(join(tmpdir(), prefix))
  process.on('exit', () => {
    for (const child of children) child.kill()
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      console.error(`could not remove ${work}; delete it by hand`)
    }
  })
  return work
}

/** Build a demo HOME (scripts/demo-home.ts) in `dir` and the environment that points sideby at it. */
export function demoHome(dir: string, variant = 'normal'): NodeJS.ProcessEnv {
  execFileSync(process.execPath, [join(root, 'scripts/demo-home.ts'), dir, variant], { stdio: 'ignore' })
  return {
    ...process.env,
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'home/.config'),
    XDG_STATE_HOME: join(dir, 'home/.local/state'),
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
  }
}

/** Start `sideby ui` on `env` and resolve to the URL it prints. */
export async function startPanel(env: NodeJS.ProcessEnv, port: number): Promise<string> {
  const panel = track(spawn(process.execPath, [cli, 'ui', '--no-open', '--port', String(port)], { env }))
  return new Promise<string>((done) => {
    let log = ''
    const timer = setTimeout(() => fail(`the Panel did not start; its output:\n${log}`), 15_000)
    const read = (chunk: Buffer) => {
      log += chunk
      const url = /sideby panel: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(log)?.[1]
      if (url) {
        clearTimeout(timer)
        done(url)
      }
    }
    panel.stdout?.on('data', read)
    panel.stderr?.on('data', read)
  })
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    if (found) candidates.push(found)
  }
  const chrome = candidates.find((c) => c && existsSync(c))
  return (
    chrome ?? fail('Chrome not found. Install Google Chrome or set CHROME to its binary and run this again.')
  )
}

// biome-ignore lint/suspicious/noExplicitAny: CDP replies are untyped JSON; each caller reads the fields it asked for
export type Reply = any

export interface Chrome {
  /** Send a CDP command to the browser itself. */
  send(method: string, params?: object): Promise<Reply>
  /** Send a CDP command to the one page. */
  page(method: string, params?: object): Promise<Reply>
  evaluate(expression: string): Promise<Reply>
  until(expression: string, what: string): Promise<void>
  /** A PNG of the page as it is now. */
  screenshot(): Promise<Buffer>
  close(): Promise<void>
}

/** Headless Chrome with one blank page; its profile lives under `work`. */
export async function openChrome(work: string): Promise<Chrome> {
  const chrome = track(
    spawn(findChrome(), [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--lang=en-US',
      '--allow-file-access-from-files',
      `--user-data-dir=${join(work, 'chrome')}`,
      '--remote-debugging-port=0',
      'about:blank',
    ]),
  )
  const wsUrl = await new Promise<string>((done) => {
    let log = ''
    const timer = setTimeout(() => fail(`Chrome did not start; its output:\n${log}`), 20_000)
    chrome.stderr?.on('data', (chunk: Buffer) => {
      log += chunk
      const url = /DevTools listening on (ws:\/\/\S+)/.exec(log)?.[1]
      if (url) {
        clearTimeout(timer)
        done(url)
      }
    })
  })
  const socket = new WebSocket(wsUrl)
  await new Promise((done) => socket.addEventListener('open', done, { once: true }))
  let nextId = 1
  const pending = new Map<number, { done: (v: Reply) => void; reject: (e: Error) => void }>()
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    const waiter = msg.id ? pending.get(msg.id) : undefined
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.done(msg.result)
  })
  function send(method: string, params: object = {}, sessionId?: string): Promise<Reply> {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((done, reject) => pending.set(id, { done, reject }))
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method: string, params: object = {}) => send(method, params, sessionId)
  async function evaluate(expression: string) {
    const { result, exceptionDetails } = await page('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (exceptionDetails)
      fail(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    return result.value
  }
  return {
    send: (method, params) => send(method, params),
    page,
    evaluate,
    async until(expression, what) {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return
        await new Promise((r) => setTimeout(r, 150))
      }
      fail(`timed out waiting for ${what}`)
    },
    async screenshot() {
      const shot = await page('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(shot.data, 'base64')
    },
    // Close Chrome before the work directory goes, or it is still writing its profile there.
    async close() {
      const closed = new Promise((done) => chrome.once('exit', done))
      await send('Browser.close').catch(() => undefined)
      await closed
    },
  }
}
