// Retakes docs/assets/demo.gif from the Motion scene in docs/assets/demo.html.
// The two terminals show what two real `sideby run` processes print with the fixture Host
// (scripts/demo-host.sh); the Panel is a fresh dark screenshot of `sideby ui` on the demo HOME;
// the last terminal is a real Auto Handoff from work to the next account, countdown included.
// Needs Node 22.18+, ffmpeg, gifsicle and Chrome or Chromium (set CHROME to its binary if it is elsewhere).
// Usage, from the repository root:
//   node scripts/record-demo.ts                 write docs/assets/demo.gif
//   node scripts/record-demo.ts --frames 2,8,14 write only those seconds as PNGs, for a quick look
// Do not point it at a real HOME: everything runs inside a throwaway demo HOME.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'docs/assets/demo.gif')
const FPS = 10
const WIDTH = 1280
const HEIGHT = 760
// The README shows the GIF at most about 1010 px wide; frames are drawn at 1280 and scaled down.
const OUT_WIDTH = 1024
// GitHub proxies README images and drops large ones; stay well under its limit.
const MAX_BYTES = 4 * 1024 * 1024

// The Auto Handoff hop runs in a child process, so the Hosts it starts print into a pipe the parent reads.
if (process.argv[2] === '--handoff') {
  const { createRuntime } = await import('../src/runtime.ts')
  const { runWithHandoff } = await import('../src/core/handoff-run.ts')
  const { PassThrough } = await import('node:stream')
  // Auto Handoff needs a terminal; nobody presses Enter during the countdown.
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const code = await runWithHandoff(await createRuntime(), 'work', [], {
    err: (line) => process.stdout.write(`${line}\n`),
    stdin,
  })
  process.exit(code ?? 1)
}

const framesArg = process.argv.indexOf('--frames')
const preview =
  framesArg === -1 ? null : (process.argv[framesArg + 1] ?? '').split(',').filter(Boolean).map(Number)
if (preview && (preview.length === 0 || preview.some(Number.isNaN))) {
  fail('--frames takes seconds separated by commas, for example --frames 2,8,14')
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
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

for (const tool of preview ? [] : ['ffmpeg', 'gifsicle']) {
  if (spawnSync(tool, ['--version']).error) {
    fail(`${tool} is not on PATH. Install it (for example \`brew install ${tool}\`) and run this again.`)
  }
}
if (!existsSync(join(root, 'node_modules/motion/dist/motion.js'))) {
  fail('Motion is not installed. Run `pnpm install --frozen-lockfile` and run this again.')
}

const work = mkdtempSync(join(tmpdir(), 'sideby-record-'))
const demo = join(work, 'demo')
const children: ChildProcess[] = []
process.on('exit', () => {
  for (const child of children) child.kill()
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    console.error(`could not remove ${work}; delete it by hand`)
  }
})

// The demo HOME, with the fixture Host standing in for Claude Code.
execFileSync(process.execPath, [join(root, 'scripts/demo-home.ts'), demo, 'normal'], { stdio: 'ignore' })
execFileSync('install', ['-m', '755', join(root, 'scripts/demo-host.sh'), join(demo, 'bin/claude')])
const env = {
  ...process.env,
  HOME: join(demo, 'home'),
  XDG_CONFIG_HOME: join(demo, 'home/.config'),
  XDG_STATE_HOME: join(demo, 'home/.local/state'),
  PATH: `${join(demo, 'bin')}:${process.env.PATH}`,
}
const cli = join(root, 'src/cli/main.ts')

// Two real `sideby run` processes, each asked one question on stdin.
function session(target: string, question: string) {
  const run = spawnSync(process.execPath, [cli, 'run', target], {
    env,
    input: `${question}\n`,
    encoding: 'utf8',
  })
  const [head = '', rest = ''] = run.stdout.split('\n\n> ')
  const answer = rest.split('\n')[0] ?? ''
  if (run.status !== 0 || !answer) fail(`sideby run ${target} did not answer:\n${run.stdout}${run.stderr}`)
  return { command: `sideby run ${target}`, banner: head.split('\n'), question, answer }
}
const terminals = [
  session('claude:main', 'where do skills live?'),
  session('work', 'quota for this account?'),
]

// Auto Handoff on, as the Panel's "Turn on" leaves it; same-family hand-over, since both accounts are Claude.
const configFile = join(demo, 'home/.config/sideby/config.json')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
writeFileSync(
  configFile,
  `${JSON.stringify({ ...config, handoff: { auto: true, sameFamily: true } }, null, 2)}\n`,
)
// sideby checks that the `sideby` on PATH answers its hook before a run hands over. The fixture Host reports
// the hand-over level itself, so this one only answers that check.
writeFileSync(join(demo, 'bin/sideby'), '#!/bin/sh\necho ok\n', { mode: 0o755 })

// One hand-over as `sideby run work` prints it: the fixture Host ends a turn at the hand-over level,
// sideby counts down and starts the next account with the Brief.
async function handoff() {
  const question = 'write the release notes'
  const child = spawn(process.execPath, [import.meta.filename, '--handoff'], { env, cwd: demo })
  children.push(child)
  let log = ''
  await new Promise<void>((done) => {
    const timer = setTimeout(() => fail(`the hand-over did not finish; its output:\n${log}`), 60_000)
    let asked = false
    child.stderr?.on('data', (chunk: Buffer) => {
      log += chunk
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      log += chunk
      if (!asked && log.includes('> ')) {
        asked = true
        child.stdin?.write(`${question}\n`)
      }
      // The next account read its first prompt: end its input, so it exits and the run is over.
      if (log.includes('carrying on')) {
        clearTimeout(timer)
        child.stdin?.end()
        done()
      }
    })
  })
  await new Promise((done) => child.once('exit', done))
  const text = log.replaceAll(join(demo, 'home'), '~')
  const line = (re: RegExp) =>
    text.split('\n').find((l) => re.test(l)) ?? fail(`no line like ${re} in:\n${text}`)
  const handing = line(/^sideby: handing over from /)
  const next = text.slice(text.lastIndexOf('Claude Code (demo)')).split('\n')
  const counting = line(/^sideby: starting \S+ in \d+s/)
  return {
    question,
    answer: /> ([^\n]+)\n/.exec(text)?.[1] ?? fail(`the first account did not answer:\n${text}`),
    // The fixture Host's prompt is still on that line; a real terminal shows sideby's line on its own.
    saved: line(/sideby: \S+ saved its session /).replace(/^.*?sideby: /, 'sideby: '),
    countdown: { line: counting, from: Number(/ in (\d+)s/.exec(counting)?.[1]) },
    handing,
    next: {
      banner: next.slice(0, 3),
      prompt: line(/^> This task was handed over /).slice(2),
      answer: line(/^read the brief/),
    },
  }
}
const handover = await handoff()

// The Panel on the demo HOME.
const panel = spawn(process.execPath, [cli, 'ui', '--no-open', '--port', '17421'], { env })
children.push(panel)
const panelUrl = await new Promise<string>((done) => {
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

// A small Chrome DevTools Protocol client over Node's built-in WebSocket.
const chrome = spawn(findChrome(), [
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
])
children.push(chrome)
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
// biome-ignore lint/suspicious/noExplicitAny: CDP replies are untyped JSON; each caller reads the fields it asked for
type Reply = any
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
async function until(expression: string, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  fail(`timed out waiting for ${what}`)
}

// Dark Panel at twice the pixels, so the zoom stays sharp.
await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await page('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 860,
  deviceScaleFactor: 2,
  mobile: false,
})
await page('Page.navigate', { url: panelUrl })
await until(
  `document.body?.innerText.includes('Claude Code') && document.body.innerText.includes('cache hits')`,
  'the Panel to load quota',
)
await new Promise((r) => setTimeout(r, 800))
// Where the scene zooms and rings: the Claude Code group, work's 7-day window and the account marked Next.
const layout = await evaluate(`(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }
  const group = document.querySelector('section[data-key="g:claude"]')
  const work = document.querySelector('.row[data-ref="claude:work"]')
  const next = [...(group?.querySelectorAll('.row') ?? [])].find((r) => [...r.querySelectorAll('.ident-name .tag')].some((t) => t.textContent.trim() === 'Next'))
  const week = work?.querySelector('.quota')?.children[1]
  if (!group || !week || !next) return null
  return { group: box(group), week: box(week), next: box(next), weekUsed: /\\d+%/.exec(week.innerText)?.[0], nextName: next.dataset.ref }
})()`)
if (!layout)
  fail(
    'The Panel has no Claude Code group with claude:work and a Next account. Check scripts/demo-home.ts normal.',
  )
const shot = await page('Page.captureScreenshot', { format: 'png' })
const panelPng = join(work, 'panel.png')
writeFileSync(panelPng, Buffer.from(shot.data, 'base64'))

// The scene, one seek and one screenshot per frame.
await page('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
})
const data = { panel: pathToFileURL(panelPng).href, terminals, layout, handoff: handover }
const scene = pathToFileURL(join(root, 'docs/assets/demo.html'))
scene.search = new URLSearchParams({ record: '1', data: JSON.stringify(data) }).toString()
await page('Page.navigate', { url: scene.href })
await until('window.demo !== undefined', 'the scene script')
await evaluate('window.demo.ready')
const total: number = await evaluate('window.demo.total')
const frames = join(work, 'frames')
mkdirSync(frames)
const previewDir = join(tmpdir(), 'sideby-demo-frames')
if (preview) mkdirSync(previewDir, { recursive: true })
const times = preview ?? Array.from({ length: Math.ceil(total * FPS) }, (_, i) => i / FPS)
for (const [i, t] of times.entries()) {
  await evaluate(`window.demo.seek(${t})`)
  const png = await page('Page.captureScreenshot', { format: 'png' })
  const name = preview ? `demo-${t}s.png` : `${String(i).padStart(4, '0')}.png`
  writeFileSync(join(preview ? previewDir : frames, name), Buffer.from(png.data, 'base64'))
}
// Close Chrome before the temp directory goes, or it is still writing its profile there.
const closed = new Promise((done) => chrome.once('exit', done))
await send('Browser.close').catch(() => undefined)
await closed

if (preview) {
  console.log(`wrote ${times.map((t) => `demo-${t}s.png`).join(', ')} to ${previewDir}`)
  process.exit(0)
}

// One palette for the whole clip with ordered dithering, so pixels that do not move stay identical
// between frames; gifsicle then trims what the eye does not see.
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-framerate',
    String(FPS),
    '-i',
    join(frames, '%04d.png'),
    '-filter_complex',
    `scale=${OUT_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=112:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    out,
  ],
  { stdio: 'inherit' },
)
execFileSync('gifsicle', ['-O3', '--lossy=30', '--batch', out], { stdio: 'inherit' })
const bytes = statSync(out).size
console.log(`wrote docs/assets/demo.gif (${times.length} frames, ${(bytes / 1024 / 1024).toFixed(2)} MB)`)
if (bytes > MAX_BYTES) {
  fail(
    'The GIF is over 4 MB, which GitHub may not show in the README. Shorten the holds in demo.html or lower FPS, then retake.',
  )
}
process.exit(0)
