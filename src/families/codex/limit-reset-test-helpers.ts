// Shared by the src/families/codex/limit-reset*.test.ts files. Kept out of dist/ by tsconfig.build.json.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, fakeHost, snapshot } from '../../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../../cli/json-schemas.ts'
import { LimitResetError } from '../../core/limit-reset.ts'
import { createRuntime } from '../../runtime.ts'
import type { Env } from '../../types.ts'
import { codexPlugin } from './index.ts'

export const builtins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]
// Fake ids only; the shapes Codex writes.
export const WS_A = '00000000-0000-4000-8000-00000000aaaa'
export const WS_B = '00000000-0000-4000-8000-00000000bbbb'
export const WS_C = '00000000-0000-4000-8000-00000000cccc'
export const USER = 'user-FakeUser00000001'
export const USER_2 = 'user-FakeUser00000002'
// chmod 000 does not stop root from reading.
export const root = process.getuid?.() === 0
export const EMAIL = 'codex@example.com'
export const SECRET = 'private-response-must-not-escape'
export const CONSUME = 'account/rateLimitResetCredit/consume'
export const MAIN = fileURLToPath(new URL('../../cli/main.ts', import.meta.url))

/** The real command line, as a child process against the fake HOME (async, so the fake Host can answer). */
export function cli(h: FakeHome, args: string[], env: Env = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...h.env, ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d))
    child.stderr.on('data', (d: Buffer) => (stderr += d))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}
/** Parses `--json` output and checks it against the published schema. */
export function checked(text: string, schema: string) {
  const value = JSON.parse(text)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[schema]!, JSON.parse(text)),
    `${schema}: ${JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[schema]!, value)].slice(0, 3))}`,
  )
  return value
}

export function idToken(workspace: string, user = USER): string {
  const claims = {
    email: EMAIL,
    'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_user_id: user },
  }
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-sig`
}
export const signIn = (h: FakeHome, dir: string, workspace: string, user = USER) =>
  h.write(`${dir}/auth.json`, JSON.stringify({ tokens: { id_token: idToken(workspace, user) } }), 0o600)

export interface HostState {
  credits: number
  used: string[]
  pct: [number, number]
  spends: number
}
export const setMode = (h: FakeHome, mode: string) => writeFile(join(h.bin, 'mode'), mode)
export const setState = (h: FakeHome, s: Partial<HostState> = {}) =>
  writeFile(
    join(h.bin, 'state.json'),
    JSON.stringify({ credits: 1, used: [], pct: [72, 61], spends: 0, ...s }),
  )
export const hostState = async (h: FakeHome) =>
  JSON.parse(await readFile(join(h.bin, 'state.json'), 'utf8')) as HostState

/** main and work are one login (workspace A); other is another (workspace B). The fake Host keeps one stock. */
export async function setup(h: FakeHome, state: Partial<HostState> = {}) {
  await signIn(h, '.codex', WS_A)
  await h.write('.codex/config.toml', '')
  await signIn(h, '.codex-work', WS_A)
  await h.write('.codex-work/config.toml', '')
  await signIn(h, '.codex-other', WS_B)
  await h.write('.codex-other/config.toml', '')
  await setMode(h, 'reset')
  await setState(h, state)
  await fakeHost(h, 'codex', {
    sleep: 3600,
    onStart: `
const dir = path.dirname(process.argv[1])
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim()
const file = path.join(dir, 'state.json')
const load = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const spend = (key) => { const s = load(); s.credits -= 1; s.used.push(key); s.pct = [0, 0]; s.spends += 1; fs.writeFileSync(file, JSON.stringify(s)) }
const say = (id, body) => process.stdout.write(JSON.stringify({ id, ...body }) + '\\n')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
    if (req.method === 'initialize') {
      rec({ method: req.method, experimentalApi: req.params.capabilities.experimentalApi })
      if (mode === 'noinit') say(req.id, { error: { code: -32000, message: '${SECRET}' } })
      else say(req.id, { result: { userAgent: 'test' } })
    } else if (req.method === 'account/rateLimits/read') {
      rec({ method: req.method })
      const s = load()
      const reset = Math.floor(Date.now() / 1000) + 7200
      const answer = { result: {
        rateLimitsByLimitId: { codex: { limitId: 'codex', planType: 'pro', accountId: '${SECRET}',
          primary: { usedPercent: s.pct[0], windowDurationMins: 300, resetsAt: reset },
          secondary: { usedPercent: s.pct[1], windowDurationMins: 10080, resetsAt: reset + 86400 } } },
        rateLimitResetCredits: { availableCount: s.credits, credits: Array.from({ length: s.credits }, (_, n) => (
          { id: 'credit-${SECRET}-' + n, status: 'available', expiresAt: reset + 86400 * (n + 2) })) },
      } }
      // The numbers are taken now and the answer arrives late: a read that began before a change and ends after it.
      if (mode === 'slowread') setTimeout(() => say(req.id, answer), 900)
      else say(req.id, answer)
    } else if (req.method === '${CONSUME}') {
      const key = req.params.idempotencyKey
      rec({ method: req.method, key, params: Object.keys(req.params) })
      if (mode === 'hang') continue
      if (mode === 'crash') process.exit(1)
      if (mode === 'old') { say(req.id, { error: { code: -32601, message: '${SECRET}' } }); continue }
      if (mode === 'error') { say(req.id, { error: { code: -32603, message: '${SECRET}' } }); continue }
      if (mode === 'nothing') { say(req.id, { result: { outcome: 'nothingToReset' } }); continue }
      if (mode === 'none') { say(req.id, { result: { outcome: 'noCredit' } }); continue }
      if (mode === 'already') { say(req.id, { result: { outcome: 'alreadyRedeemed' } }); continue }
      if (mode === 'odd') { say(req.id, { result: { outcome: 'somethingNew' } }); continue }
      const s = load()
      if (s.used.includes(key)) { say(req.id, { result: { outcome: 'alreadyRedeemed' } }); continue }
      if (s.credits < 1) { say(req.id, { result: { outcome: 'noCredit' } }); continue }
      spend(key)
      // The spend went through and the answer never arrives.
      if (mode === 'lost') process.exit(0)
      if (mode === 'slow') setTimeout(() => say(req.id, { result: { outcome: 'reset' } }), 400)
      else say(req.id, { result: { outcome: 'reset' } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  })
}

export const runtime = (h: FakeHome, env: Env = {}, timeoutMs?: number) =>
  createRuntime({
    env: { ...h.env, ...env },
    builtins,
    ...(timeoutMs ? { limitReset: { timeoutMs } } : {}),
  })

export interface Sent {
  method: string
  key?: string
  params?: string[]
  experimentalApi?: boolean
}
export async function sent(h: FakeHome): Promise<Sent[]> {
  const raw = await readFile(join(h.bin, 'codex.log'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sent)
    .filter((r) => r.method)
}
export const consumes = async (h: FakeHome) => (await sent(h)).filter((r) => r.method === CONSUME)
export const hostDirs = async (h: FakeHome) =>
  new Map(
    (
      await Promise.all(
        ['.codex', '.codex-work', '.codex-other'].map(async (d) =>
          [...(await snapshot(h.path(d)))].map(([k, v]) => [`${d}/${k}`, v] as const),
        ),
      )
    ).flat(),
  )
export const failure = async (p: Promise<unknown>): Promise<LimitResetError> => {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof LimitResetError, `a LimitResetError, got ${String(err)}`)
    return err
  }
  throw new Error('expected it to fail')
}

/**
 * From `when` on, sideby cannot save the record `file` any more, but can still read it: the fake Host turns it into a
 * link at that moment, and sideby's writer never writes through a link. As a full disk would, after the request left.
 * Returns what makes the record writable again, as it was last saved.
 */
export async function failSavesFrom(
  h: FakeHome,
  file: string,
  when: 'the spend request' | 'the read after the spend',
) {
  const moved = join(h.bin, 'record.moved')
  const swap = `(() => { const f = ${JSON.stringify(file)}, to = ${JSON.stringify(moved)}; if (!fs.lstatSync(f).isSymbolicLink()) { fs.renameSync(f, to); fs.symlinkSync(to, f) } })()`
  const script = await readFile(join(h.bin, 'codex'), 'utf8')
  const [at, then] =
    when === 'the spend request'
      ? ['const key = req.params.idempotencyKey', `const key = req.params.idempotencyKey; ${swap}`]
      : [
          'const s = load()\n      const reset =',
          `const s = load()\n      if (s.spends > 0) ${swap}\n      const reset =`,
        ]
  assert.ok(script.includes(at), 'the fake Host has the place to hook')
  await writeFile(
    join(h.bin, 'codex'),
    script.replace(at, () => then),
  )
  return async () => {
    await writeFile(join(h.bin, 'codex'), script)
    await rm(file)
    await rename(moved, file)
  }
}

/** Every file under `dir` with its text, for "nothing of X is kept" checks. */
export async function snapshotText(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push([p, await readFile(p, 'utf8')])
    }
  }
  await walk(dir).catch(() => {})
  return out
}
