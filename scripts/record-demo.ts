// Retakes docs/assets/demo.gif from the Motion scene in docs/assets/demo.html.
// The two terminals show what two real `sideby run` processes print with the fixture Host
// (scripts/demo-host.sh); the Panel is a fresh dark screenshot of `sideby ui` on the demo HOME;
// the last terminal is a real Auto Handoff from work to the next account, countdown included.
// Needs Node 22.18+, ffmpeg, gifsicle and Chrome or Chromium (set CHROME to its binary if it is elsewhere).
// Usage, from the repository root:
//   node scripts/record-demo.ts                 write docs/assets/demo.gif
//   node scripts/record-demo.ts --frames 2,8,14 write only those seconds as PNGs, for a quick look
// Do not point it at a real HOME: everything runs inside a throwaway demo HOME.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cli, demoHome, fail, openChrome, root, startPanel, track, workDir } from './chrome.ts'

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

for (const tool of preview ? [] : ['ffmpeg', 'gifsicle']) {
  if (spawnSync(tool, ['--version']).error) {
    fail(`${tool} is not on PATH. Install it (for example \`brew install ${tool}\`) and run this again.`)
  }
}
if (!existsSync(join(root, 'node_modules/motion/dist/motion.js'))) {
  fail('Motion is not installed. Run `pnpm install --frozen-lockfile` and run this again.')
}

const work = workDir('sideby-record-')
const demo = join(work, 'demo')

// The demo HOME, with the fixture Host standing in for Claude Code.
const env = demoHome(demo)
execFileSync('install', ['-m', '755', join(root, 'scripts/demo-host.sh'), join(demo, 'bin/claude')])

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
  const child = track(spawn(process.execPath, [import.meta.filename, '--handoff'], { env, cwd: demo }))
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

// The Panel on the demo HOME, in headless Chrome.
const panelUrl = await startPanel(env, 17421)
const { page, evaluate, until, screenshot, close } = await openChrome(work)

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
  // Token usage moved behind a click (6ea716b); the 7-day quota of claude:work is what the scene zooms into.
  `/\\d+%/.test(document.querySelector('.row[data-ref="claude:work"] .quota')?.innerText ?? '')`,
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
const panelPng = join(work, 'panel.png')
writeFileSync(panelPng, await screenshot())

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
  const name = preview ? `demo-${t}s.png` : `${String(i).padStart(4, '0')}.png`
  writeFileSync(join(preview ? previewDir : frames, name), await screenshot())
}
await close()

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
