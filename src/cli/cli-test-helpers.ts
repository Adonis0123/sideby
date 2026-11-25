// Shared by the src/cli/cli-*.test.ts files (spec §5: 1, 2, 3, 11, 12 and the --json contract), which run `sideby`
// through main() in this process against a fake HOME and fake Host binaries; `sidebySpawn` runs a real child process.
// Kept out of dist/ by tsconfig.build.json.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import type { FakeHome } from '../../testing/index.ts'
import { closeHistory } from '../core/history.ts'
import { resolvePaths } from '../core/paths.ts'
import { clearLoginListings } from '../families/claude/login-events.ts'
import type { Runtime } from '../runtime.ts'
import type { Env } from '../types.ts'
import { setJsonNotice } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'
import { main } from './main.ts'

export const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

export interface Run {
  code: number | null
  signal: NodeJS.Signals | null
  out: string
  err: string
}

export interface MainCall {
  env: Env
  cwd?: string
  input?: string
}

export function sideby(h: FakeHome, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return runMain(args, { env: { ...h.env, ...extraEnv } })
}

export function sidebySpawn(
  h: FakeHome,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<Run> {
  return spawnMain(args, { env: { ...h.env, ...extraEnv } })
}

export function spawnMain(args: string[], call: MainCall): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: call.env as NodeJS.ProcessEnv,
      ...(call.cwd ? { cwd: call.cwd } : {}),
      stdio: [call.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout!.on('data', (d: Buffer) => (out += d))
    child.stderr!.on('data', (d: Buffer) => (err += d))
    child.stdin?.end(call.input)
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, out, err }))
  })
}

// WHY: the global console takes process.stdout and stderr on first use and keeps them. Taking the real ones now means
// a first console call made while runMain swaps the streams cannot keep the fake ones for the rest of the file.
const consoleStreams = console as unknown as { _stdout: unknown; _stderr: unknown }
if (!consoleStreams._stdout || !consoleStreams._stderr) throw new Error('console has no streams')

const STDIO = ['stdin', 'stdout', 'stderr'] as const
let running = false

// WHY: a child process exits only once nothing keeps its event loop alive, so runMain waits for the work main() left
// behind before a test reads what it wrote. SIDEBY_TEST_SPAWN=1 spawns every call, to tell an in-process difference
// from a real failure.
export async function runMain(args: string[], call: MainCall): Promise<Run> {
  if (process.env.SIDEBY_TEST_SPAWN) return spawnMain(args, call)
  if (running) throw new Error('in-process sideby calls cannot overlap; use sidebySpawn')
  running = true
  let out = ''
  let err = ''
  const sink = (add: (s: string) => void) =>
    new Writable({
      write(chunk: Buffer | string, _enc, done) {
        add(chunk.toString())
        done()
      },
    })
  const stdin = new PassThrough()
  stdin.end(call.input ?? '')
  const fake = {
    stdin,
    stdout: sink((s) => (out += s)),
    stderr: sink((s) => (err += s)),
  }
  const saved = {
    env: process.env,
    envValues: { ...process.env },
    cwd: process.cwd(),
    stdio: STDIO.map((name) => [name, Object.getOwnPropertyDescriptor(process, name)!] as const),
  }
  try {
    // WHY: os.tmpdir(), os.homedir() and TZ read the native environment, which only the real process.env object
    // writes through to. A separate copy for JS keeps a Runtime that outlives the call on the fake HOME.
    replaceEnv(saved.env, call.env)
    process.env = { ...call.env } as NodeJS.ProcessEnv
    if (call.cwd) process.chdir(call.cwd)
    for (const name of STDIO)
      Object.defineProperty(process, name, { configurable: true, enumerable: true, get: () => fake[name] })
    setJsonNotice(null)
    const before = activeResources()
    let code: number
    try {
      code = await main(args, { out: (s) => (out += `${s}\n`), err: (s) => (err += `${s}\n`) })
    } catch (e) {
      err += `sideby: ${e instanceof Error ? e.message : String(e)}\n`
      code = 1
    }
    await settle(before)
    // WHY: a child process drops these when it exits; the next call must open the History Index and list logins anew.
    await closeHistory({ paths: resolvePaths(call.env) } as Runtime)
    clearLoginListings()
    return { code, signal: null, out, err }
  } finally {
    for (const [name, desc] of saved.stdio) Object.defineProperty(process, name, desc)
    process.chdir(saved.cwd)
    process.env = saved.env
    replaceEnv(saved.env, saved.envValues)
    running = false
  }
}

function replaceEnv(env: NodeJS.ProcessEnv, values: Env): void {
  for (const key of Object.keys(env)) if (!(key in values)) delete env[key]
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && env[key] !== value) env[key] = value
}

function activeResources(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1)
  return counts
}

async function settle(before: Map<string, number>): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve))
    const left = [...activeResources()].filter(([type, n]) => n > (before.get(type) ?? 0))
    if (left.length === 0) return
    if (Date.now() > deadline)
      throw new Error(`main() left ${left.map(([type]) => type).join(', ')} running; use sidebySpawn`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export function checkSchema(name: string, text: string) {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

export async function codexMain(h: FakeHome) {
  await h.write('.codex/config.toml', 'model = "gpt-main"\n')
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.mkdir('.codex/skills')
}
