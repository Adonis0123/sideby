// Using a Codex Limit Reset (spec §3.40, ADR-0072), against a scripted fake `codex app-server` only: the plan, the
// four outcomes, every way an answer can go missing, and what is kept on disk.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, fakeHost, snapshot, withFakeHome } from '../../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../../cli/json-schemas.ts'
import {
  LimitResetError,
  limitResetDir,
  limitResetFile,
  listLimitResetRecords,
  pruneLimitResetRecords,
  RECORD_KEEP_MS,
  writeLimitResetRecord,
} from '../../core/limit-reset.ts'
import { createPanelHandler } from '../../panel/handler.ts'
import { createRuntime } from '../../runtime.ts'
import type { Env } from '../../types.ts'
import { codexPlugin } from './index.ts'
import { codexLoginKey } from './login-key.ts'

const builtins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]
// Fake ids only; the shapes Codex writes.
const WS_A = '00000000-0000-4000-8000-00000000aaaa'
const WS_B = '00000000-0000-4000-8000-00000000bbbb'
const WS_C = '00000000-0000-4000-8000-00000000cccc'
const USER = 'user-FakeUser00000001'
const USER_2 = 'user-FakeUser00000002'
// chmod 000 does not stop root from reading.
const root = process.getuid?.() === 0
const EMAIL = 'codex@example.com'
const SECRET = 'private-response-must-not-escape'
const CONSUME = 'account/rateLimitResetCredit/consume'
const MAIN = fileURLToPath(new URL('../../cli/main.ts', import.meta.url))

/** The real command line, as a child process against the fake HOME (async, so the fake Host can answer). */
function cli(h: FakeHome, args: string[], env: Env = {}) {
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
function checked(text: string, schema: string) {
  const value = JSON.parse(text)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[schema]!, JSON.parse(text)),
    `${schema}: ${JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[schema]!, value)].slice(0, 3))}`,
  )
  return value
}

function idToken(workspace: string, user = USER): string {
  const claims = {
    email: EMAIL,
    'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_user_id: user },
  }
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-sig`
}
const signIn = (h: FakeHome, dir: string, workspace: string, user = USER) =>
  h.write(`${dir}/auth.json`, JSON.stringify({ tokens: { id_token: idToken(workspace, user) } }), 0o600)

interface HostState {
  credits: number
  used: string[]
  pct: [number, number]
  spends: number
}
const setMode = (h: FakeHome, mode: string) => writeFile(join(h.bin, 'mode'), mode)
const setState = (h: FakeHome, s: Partial<HostState> = {}) =>
  writeFile(
    join(h.bin, 'state.json'),
    JSON.stringify({ credits: 1, used: [], pct: [72, 61], spends: 0, ...s }),
  )
const hostState = async (h: FakeHome) =>
  JSON.parse(await readFile(join(h.bin, 'state.json'), 'utf8')) as HostState

/** main and work are one login (workspace A); other is another (workspace B). The fake Host keeps one stock. */
async function setup(h: FakeHome, state: Partial<HostState> = {}) {
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

const runtime = (h: FakeHome, env: Env = {}, timeoutMs?: number) =>
  createRuntime({
    env: { ...h.env, ...env },
    builtins,
    ...(timeoutMs ? { limitReset: { timeoutMs } } : {}),
  })

interface Sent {
  method: string
  key?: string
  params?: string[]
  experimentalApi?: boolean
}
async function sent(h: FakeHome): Promise<Sent[]> {
  const raw = await readFile(join(h.bin, 'codex.log'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Sent)
    .filter((r) => r.method)
}
const consumes = async (h: FakeHome) => (await sent(h)).filter((r) => r.method === CONSUME)
const hostDirs = async (h: FakeHome) =>
  new Map(
    (
      await Promise.all(
        ['.codex', '.codex-work', '.codex-other'].map(async (d) =>
          [...(await snapshot(h.path(d)))].map(([k, v]) => [`${d}/${k}`, v] as const),
        ),
      )
    ).flat(),
  )
const failure = async (p: Promise<unknown>): Promise<LimitResetError> => {
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
async function failSavesFrom(
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

describe('Codex Limit Reset', () => {
  it('shows a plan from a fresh read and sends nothing until it is confirmed', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const before = await hostDirs(h)
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:work'))
      assert.equal(plan.account, 'codex:work')
      assert.deepEqual(plan.sameLogin, ['codex:main'])
      assert.equal(plan.canUse, true)
      assert.ok(plan.operationId)
      assert.equal(plan.limitResets?.available, 2)
      assert.equal(plan.expectedAfter, 1)
      assert.ok(plan.limitResets?.nextExpiresAt, 'the next expiry, when the Host tells it')
      assert.equal(plan.quota.status, 'ok')
      if (plan.quota.status === 'ok')
        assert.deepEqual(
          plan.quota.windows.map((w) => [w.label, w.usedPercent, Boolean(w.resetsAt)]),
          [
            ['5h', 72, true],
            ['7d', 61, true],
          ],
        )
      assert.match(plan.message, /cannot be undone/)
      assert.match(plan.message, /does not say beforehand which windows/)
      assert.match(plan.message, /codex:main/, 'names the other accounts of the login')
      // The read asked the Host now, and nothing else was sent.
      assert.deepEqual(await consumes(h), [])
      assert.ok((await sent(h)).some((r) => r.method === 'account/rateLimits/read'))
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec?.state, 'planned')
      assert.deepEqual(rec?.accounts, ['codex:main', 'codex:work'])
      assert.deepEqual(diffSnapshots(before, await hostDirs(h)), [])
      assert.equal((await hostState(h)).spends, 0)
    })
  })

  it('uses one after the confirmation, then shows what the Host reports for every account of the login', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const before = await hostDirs(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.operationId, plan.operationId)
      assert.deepEqual(r.sameLogin, ['codex:work'])
      assert.equal(r.quotaPending, undefined)
      assert.equal(r.quota?.status, 'ok')
      if (r.quota?.status === 'ok') {
        assert.deepEqual(
          r.quota.windows.map((w) => w.usedPercent),
          [0, 0],
        )
        assert.equal(r.quota.limitResets?.available, 0)
      }
      // The other account of the login shows the same read, without another ask.
      const asked = (await sent(h)).length
      const peer = await rt.quota(await rt.resolve('codex:work'), { fetch: 'never' })
      assert.equal(peer.status === 'ok' && peer.windows[0]!.usedPercent, 0)
      assert.equal(peer.status === 'ok' && peer.limitResets?.available, 0)
      assert.equal((await sent(h)).length, asked)
      // One request, with the key on disk and no credit id: the vendor picks the credit.
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      const calls = await consumes(h)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.key, rec!.idempotencyKey)
      assert.deepEqual(calls[0]!.params, ['idempotencyKey'])
      assert.ok((await sent(h)).every((s) => s.method !== 'initialize' || s.experimentalApi === false))
      assert.equal(rec!.state, 'reset')
      assert.ok(rec!.quotaReadAt)
      assert.equal(rec!.attempts.length, 1)
      // Asking again with the same operation says the same and sends nothing.
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.outcome, 'reset')
      assert.equal(again.replayed, true)
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
      assert.deepEqual(diffSnapshots(before, await hostDirs(h)), [], 'nothing written under a Host directory')
    })
  })

  it('keeps the operation as a 600 file in a 700 folder, without a login key, an identity or a credit id', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await rt.limitResetUse(main, plan.operationId!)
      const dir = limitResetDir(rt.paths.stateDir)
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      const files = (await readdir(dir)).filter((n) => n.endsWith('.json'))
      assert.deepEqual(files, [`${plan.operationId}.json`])
      const file = join(dir, files[0]!)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const text = await readFile(file, 'utf8')
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
        'accounts',
        'attempts',
        'createdAt',
        'finishedAt',
        'idempotencyKey',
        'login',
        'operationId',
        'quotaReadAt',
        'state',
        'version',
      ])
      // Of the login only a salted digest: not the Login Key, the ids it is made of, nor the Identity.
      const loginKey = await codexLoginKey(main)
      assert.ok(loginKey)
      assert.deepEqual(Object.keys(JSON.parse(text).login).sort(), ['digest', 'salt'])
      for (const no of [WS_A, USER, EMAIL, SECRET, 'credit-', 'id_token', 'e30.', loginKey])
        assert.equal(text.includes(no), false, `the record holds no ${no}`)
      // Nor does anything else sideby keeps about it.
      for (const [name, body] of await snapshotText(rt.paths.stateDir))
        assert.equal(body.includes(SECRET), false, `${name} holds nothing of the Host's raw answer`)
    })
  })

  it('tells the three other answers apart, and says in each that nothing more was spent', async () => {
    for (const [mode, outcome, words] of [
      ['nothing', 'nothing-to-reset', /Nothing was spent: no limit of codex:main can be reset/],
      ['none', 'none-left', /Nothing was spent: codex:main holds no limit reset/],
      ['already', 'already-done', /already used for codex:main; nothing more was spent/],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const r = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(r.outcome, outcome)
        assert.match(r.message, words)
        assert.equal((await hostState(h)).spends, 0)
        // The bars and the count are what the Host says, never changed by sideby.
        assert.equal(r.quota?.status === 'ok' && r.quota.windows[0]!.usedPercent, 72)
        assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 1)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, outcome)
      })
    }
  })

  it('refuses without a plan: an id nobody made, a plan of another login, a blocked account', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 0 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const none = await rt.limitResetPlan(main)
      assert.equal(none.canUse, false)
      assert.equal(none.operationId, undefined)
      assert.match(none.blocked ?? '', /holds no limit reset/)
      assert.equal((await failure(rt.limitResetUse(main, 'lr-zzzzzzzz-00000000'))).code, 'unknown-operation')
      await setState(h, { credits: 1 })
      const other = await rt.limitResetPlan(await rt.resolve('codex:other'))
      assert.deepEqual(other.sameLogin, [])
      const err = await failure(rt.limitResetUse(main, other.operationId!))
      assert.equal(err.code, 'unknown-operation')
      assert.match(err.message, /Nothing was sent/)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('knows nothing was spent when the request never left, and ends that operation', async () => {
    for (const mode of ['noinit', 'old']) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'not-sent')
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, /Nothing was sent, so nothing was spent/)
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await hostState(h)).spends, 0)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'not-sent')
        // It is not left unresolved: the next step is a new plan.
        await setMode(h, 'reset')
        assert.equal((await failure(rt.limitResetUse(main, plan.operationId!))).code, 'operation-ended')
        const next = await rt.limitResetPlan(main)
        assert.notEqual(next.operationId, plan.operationId)
        assert.equal(next.unresolved, undefined)
        assert.equal((await rt.limitResetUse(main, next.operationId!)).outcome, 'reset')
      })
    }
  })

  it('repeats the same request after a lost answer, from another process, and spends once', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'lost')
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /cannot tell whether a limit reset was used/)
      assert.match(err.message, new RegExp(`--yes --operation ${plan.operationId}`))
      assert.equal((await hostState(h)).spends, 1, 'the spend went through; only its answer was lost')
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'pending')

      // Another sideby process, later, through the other account of the login.
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const work = await rt2.resolve('codex:work')
      const seen = await rt2.limitResetPlan(work)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId, 'the unresolved operation, not a new one')
      assert.equal(seen.canUse, true)
      assert.match(seen.message, /earlier attempt/)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir)).length, 1)
      // Whatever operation the caller names, the unresolved one of the login goes first, with its own key.
      const r = await rt2.limitResetUse(work, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]!.key, calls[1]!.key)
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
      // The numbers are the Host's: one left, not zero.
      assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 1)
      const [rec] = await listLimitResetRecords(rt2.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.equal(rec!.attempts.length, 2)
    })
  })

  it('leaves a request that got no answer in time unresolved, never ages it out, and resolves it on a retry', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h, {}, 300)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'hang')
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /no answer in time|did not answer in time/)
      await pruneLimitResetRecords(rt.paths.stateDir, new Date(Date.now() + 400 * 24 * 3600_000))
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec?.state, 'pending')
      // The Host never ran it: the same key now gets the first real answer.
      await setMode(h, 'reset')
      const r = await (await runtime(h)).limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.resumed, true)
      const calls = await consumes(h)
      assert.deepEqual(
        calls.map((c) => c.key),
        [rec!.idempotencyKey, rec!.idempotencyKey],
      )
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('treats a Host that crashed or refused after the request left as unknown, not as unspent', async () => {
    for (const mode of ['crash', 'error', 'odd']) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        await setMode(h, mode)
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'outcome-unknown', mode)
        assert.equal(err.operationId, plan.operationId)
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'pending')
        await setMode(h, 'reset')
        const r = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(r.outcome, 'reset')
        assert.equal((await hostState(h)).spends, 1)
      })
    }
  })

  it('lets two confirmations of one login through one at a time: one spend, whatever they name', async () => {
    // The same plan confirmed twice at once (a double click, two windows).
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const [a, b] = [await runtime(h), await runtime(h)]
      const plan = await a.limitResetPlan(await a.resolve('codex:main'))
      await setMode(h, 'slow')
      const [x, y] = await Promise.all([
        a.limitResetUse(await a.resolve('codex:main'), plan.operationId!),
        b.limitResetUse(await b.resolve('codex:work'), plan.operationId!),
      ])
      assert.deepEqual([x.outcome, y.outcome], ['reset', 'reset'])
      assert.equal(
        [x, y].filter((r) => r.replayed).length,
        1,
        'the second one is told the first one’s answer',
      )
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
    })
    // Two plans of the same login, shown before either was confirmed: the later confirmation is out of date.
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const [a, b] = [await runtime(h), await runtime(h)]
      const p1 = await a.limitResetPlan(await a.resolve('codex:main'))
      const p2 = await b.limitResetPlan(await b.resolve('codex:work'))
      assert.notEqual(p1.operationId, p2.operationId)
      await setMode(h, 'slow')
      const done = await Promise.allSettled([
        a.limitResetUse(await a.resolve('codex:main'), p1.operationId!),
        b.limitResetUse(await b.resolve('codex:work'), p2.operationId!),
      ])
      const ok = done.filter((d) => d.status === 'fulfilled')
      const no = done.filter((d) => d.status === 'rejected')
      assert.equal(ok.length, 1)
      assert.equal(no.length, 1)
      const err = (no[0] as PromiseRejectedResult).reason as LimitResetError
      assert.equal(err.code, 'plan-outdated')
      assert.match(err.message, /nothing was sent/)
      assert.equal((await consumes(h)).length, 1)
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
    })
  })

  it('goes on with the same request, never a new one, after an account of the login signed in elsewhere', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      assert.equal((await hostState(h)).spends, 1, 'used, and the answer was lost')
      const [first] = await consumes(h)
      // codex:work signs in to another workspace: main is alone in its login now, and work is one login with other.
      await signIn(h, '.codex-work', WS_B)
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const [main, work] = [await rt2.resolve('codex:main'), await rt2.resolve('codex:work')]
      assert.deepEqual(await rt2.sameLogin(main), [])
      assert.deepEqual(await rt2.sameLogin(work), ['codex:other'])
      // From the account that left, and from its new login: not sent, no new operation, still unresolved; the
      // message names the account that may still be the original login.
      for (const ref of ['codex:work', 'codex:other']) {
        const a = await rt2.resolve(ref)
        const seen = await rt2.limitResetPlan(a)
        assert.equal(seen.canUse, false, ref)
        assert.equal(seen.operationId, undefined)
        assert.equal(seen.unresolved, true)
        const err = await failure(rt2.limitResetUse(a, plan.operationId!))
        assert.equal(err.code, 'login-changed', ref)
        assert.equal(err.operationId, plan.operationId)
        assert.match(
          err.message,
          new RegExp(
            `If codex:main is still signed in as the original login, run .sideby quota reset codex:main --yes --operation ${plan.operationId}`,
          ),
        )
      }
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir)).length, 1)
      assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'pending')
      // From the account that is still the login: the plan is the unresolved operation, and confirming repeats its
      // request with its own key, which uses nothing more.
      const seen = await rt2.limitResetPlan(main)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal(seen.canUse, true)
      const r = await rt2.limitResetUse(main, seen.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.deepEqual(
        calls.map((c) => c.key),
        [first!.key, first!.key],
        'the Host never saw a second key',
      )
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
      // The outcome is kept for the accounts of the login as they are now, and never as "stopped".
      const [rec] = await listLimitResetRecords(rt2.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.deepEqual(rec!.accounts, ['codex:main'])
      // Only now, with the first one answered, is a new plan made: for main, and for the login work moved to.
      for (const a of [main, work]) {
        const next = await rt2.limitResetPlan(a)
        assert.equal(next.unresolved, undefined)
        assert.equal(next.canUse, true)
        assert.notEqual(next.operationId, plan.operationId)
      }
      assert.equal((await consumes(h)).length, 2)
    })
  })

  it('finds the unresolved operation of a login from an account that signed in as it afterwards', async () => {
    const lostOnce = async (h: FakeHome) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      await setMode(h, 'reset')
      const [first] = await consumes(h)
      // A new account signs in as the same login.
      await signIn(h, '.codex-new', WS_A)
      await h.write('.codex-new/config.toml', '')
      return { plan, key: first!.key }
    }
    const oneKeyOneSpend = async (h: FakeHome, key: string | undefined, requests: number) => {
      const calls = await consumes(h)
      assert.equal(calls.length, requests)
      assert.deepEqual([...new Set(calls.map((c) => c.key))], [key], 'the Host never saw a second key')
      assert.equal((await hostState(h)).spends, 1)
    }
    // It joins the accounts the operation names.
    await withFakeHome(async (h) => {
      const { plan, key } = await lostOnce(h)
      const rt = await runtime(h)
      const fresh = await rt.resolve('codex:new')
      assert.deepEqual((await rt.sameLogin(fresh)).sort(), ['codex:main', 'codex:work'])
      const seen = await rt.limitResetPlan(fresh)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir)).length, 1, 'no new operation beside it')
      // The answer is lost once more: still the same operation, now also under the new account's name.
      await setMode(h, 'hang')
      const slow = await runtime(h, {}, 300)
      const err = await failure(slow.limitResetUse(await slow.resolve('codex:new'), seen.operationId!))
      assert.equal(err.code, 'outcome-unknown')
      assert.equal(err.operationId, plan.operationId)
      const [open] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(open!.state, 'pending')
      assert.deepEqual(open!.accounts, ['codex:main', 'codex:new', 'codex:work'])
      await setMode(h, 'reset')
      const r = await rt.limitResetUse(fresh, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      await oneKeyOneSpend(h, key, 3)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.deepEqual(rec!.accounts, ['codex:main', 'codex:new', 'codex:work'])
    })
    // Every account the operation names left the login; the only account of that login now is one it never named.
    await withFakeHome(async (h) => {
      const { plan, key } = await lostOnce(h)
      await signIn(h, '.codex', WS_C)
      await signIn(h, '.codex-work', WS_C)
      const rt = await runtime(h)
      const fresh = await rt.resolve('codex:new')
      assert.deepEqual(await rt.sameLogin(fresh), [])
      // The accounts that left cannot send it and get no new plan while it is unresolved; they are told who may ask.
      const main = await rt.resolve('codex:main')
      assert.equal((await rt.limitResetPlan(main)).canUse, false)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'login-changed')
      // The account that is the login now finds it through the login, not through its name: no new key is made.
      const seen = await rt.limitResetPlan(fresh)
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      assert.equal(seen.canUse, true)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir)).length, 1, 'no new operation beside it')
      const r = await rt.limitResetUse(fresh, 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      await oneKeyOneSpend(h, key, 2)
      assert.equal((await hostState(h)).credits, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'already-done')
      assert.deepEqual(rec!.accounts, ['codex:new'])
    })
  })

  it('keeps a plan that was confirmed while pruning looked at it, with the key its request was sent with', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      await setMode(h, 'lost')
      // Pruning, with a clock a day ahead, has read the plan as one nobody confirmed. Before it removes anything the
      // plan is confirmed: the request is sent, a reset is used and the answer is lost.
      let confirmed = 0
      await pruneLimitResetRecords(rt.paths.stateDir, new Date(Date.now() + RECORD_KEEP_MS + 60_000), {
        afterRead: async (r) => {
          assert.equal(r.operationId, plan.operationId)
          assert.equal(r.state, 'planned')
          const err = await failure(rt.limitResetUse(main, plan.operationId!))
          assert.equal(err.code, 'outcome-unknown')
          confirmed++
        },
      })
      assert.equal(confirmed, 1)
      assert.equal((await hostState(h)).spends, 1)
      const [first] = await consumes(h)
      // The record is still there, unresolved, with that key.
      const kept = JSON.parse(await readFile(file, 'utf8')) as { state: string; idempotencyKey: string }
      assert.equal(kept.state, 'pending')
      assert.equal(kept.idempotencyKey, first!.key)
      // So the retry repeats that request instead of making a new one.
      await setMode(h, 'reset')
      const rt2 = await runtime(h)
      const seen = await rt2.limitResetPlan(await rt2.resolve('codex:work'))
      assert.equal(seen.unresolved, true)
      assert.equal(seen.operationId, plan.operationId)
      const r = await rt2.limitResetUse(await rt2.resolve('codex:work'), seen.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.deepEqual(
        (await consumes(h)).map((c) => c.key),
        [first!.key, first!.key],
      )
      const s = await hostState(h)
      assert.equal(s.spends, 1)
      assert.equal(s.credits, 1)
    })
  })

  it('refuses a plan shown more than a day ago at the confirmation, and sends nothing', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const [made] = await listLimitResetRecords(rt.paths.stateDir)
      const old = { ...made!, createdAt: new Date(Date.now() - RECORD_KEEP_MS - 1000).toISOString() }
      await writeLimitResetRecord(rt.paths.stateDir, old)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'plan-outdated')
      assert.match(err.message, /shown more than a day ago/)
      assert.match(err.message, /nothing was sent; run `sideby quota reset codex:main`/)
      assert.deepEqual(await consumes(h), [])
      assert.equal((await hostState(h)).spends, 0)
      // It was never made unresolved, so pruning may remove it, and the next plan is a new one that can be used.
      assert.deepEqual(await listLimitResetRecords(rt.paths.stateDir), [old])
      const next = await rt.limitResetPlan(main)
      assert.notEqual(next.operationId, plan.operationId)
      assert.deepEqual(
        (await listLimitResetRecords(rt.paths.stateDir)).map((r) => r.operationId),
        [next.operationId],
      )
      assert.equal((await rt.limitResetUse(main, next.operationId!)).outcome, 'reset')
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('does not send a confirmed plan once the account is signed in as another login under the same name', async () => {
    // codex:other is alone in its login, so its group of accounts is the same before and after: only the login moved.
    for (const [why, again] of [
      ['another workspace', (h: FakeHome) => signIn(h, '.codex-other', WS_C)],
      ['another user', (h: FakeHome) => signIn(h, '.codex-other', WS_B, USER_2)],
      ['a sign-in that cannot be read', (h: FakeHome) => h.write('.codex-other/auth.json', '{}', 0o600)],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const plan = await rt.limitResetPlan(await rt.resolve('codex:other'))
        assert.equal(plan.canUse, true, why)
        await again(h)
        const rt2 = await runtime(h)
        const other = await rt2.resolve('codex:other')
        assert.deepEqual(await rt2.sameLogin(other), [], 'still the same group of accounts')
        const err = await failure(rt2.limitResetUse(other, plan.operationId!))
        assert.equal(err.code, 'plan-outdated', why)
        assert.match(err.message, /nothing was sent/)
        assert.match(err.message, /sideby quota reset codex:other/)
        assert.deepEqual(await consumes(h), [], why)
        assert.equal((await hostState(h)).spends, 0)
        assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'planned')
      })
    }
  })

  it('keeps an unresolved operation for its own login: another login under the same account name cannot retry it', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:other'))
      await setMode(h, 'lost')
      assert.equal(
        (await failure(rt.limitResetUse(await rt.resolve('codex:other'), plan.operationId!))).code,
        'outcome-unknown',
      )
      const [first] = await consumes(h)
      await setMode(h, 'reset')
      const dir = limitResetDir(rt.paths.stateDir)
      const refused = async (how: RegExp) => {
        const rt2 = await runtime(h)
        const other = await rt2.resolve('codex:other')
        // A retry by its id, and a bare retry, which looks at the plan first.
        const err = await failure(rt2.limitResetUse(other, plan.operationId!))
        assert.equal(err.code, 'login-changed')
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, how)
        assert.match(err.message, /will not retry that operation from this account/)
        assert.match(err.message, /Nothing was sent/)
        assert.match(
          err.message,
          new RegExp(`sideby quota reset codex:other --yes --operation ${plan.operationId}`),
        )
        for (const no of [WS_B, WS_C, USER, USER_2, EMAIL]) assert.equal(err.message.includes(no), false)
        const seen = await rt2.limitResetPlan(other)
        assert.equal(seen.canUse, false)
        assert.equal(seen.operationId, undefined)
        assert.equal(seen.unresolved, true)
        assert.ok(seen.blocked)
        // Nothing reached the Host, the operation is still unresolved, and no new one was made beside it.
        assert.equal((await consumes(h)).length, 1)
        assert.deepEqual(
          (await readdir(dir)).filter((n) => n.endsWith('.json')),
          [`${plan.operationId}.json`],
        )
        assert.equal((await listLimitResetRecords(rt2.paths.stateDir))[0]!.state, 'pending')
      }
      await signIn(h, '.codex-other', WS_C)
      await refused(/now signed in as a different login/)
      await signIn(h, '.codex-other', WS_B, USER_2)
      await refused(/now signed in as a different login/)
      // Signed out: the plan says to sign in; a retry cannot tell the login and sends nothing either.
      await rm(h.path('.codex-other/auth.json'))
      const out = await runtime(h)
      const err = await failure(out.limitResetUse(await out.resolve('codex:other'), plan.operationId!))
      assert.equal(err.code, 'login-changed')
      assert.match(err.message, /cannot read which login codex:other is signed in as now/)
      assert.equal((await consumes(h)).length, 1)
      // A record from before the digest was kept cannot be shown to be this login's: the same refusal.
      await signIn(h, '.codex-other', WS_B)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      const kept = await readFile(file, 'utf8')
      const { login: _login, ...old } = JSON.parse(kept)
      await writeFile(file, JSON.stringify(old))
      const legacy = await runtime(h)
      assert.equal(
        (await failure(legacy.limitResetUse(await legacy.resolve('codex:other'), plan.operationId!))).code,
        'login-changed',
      )
      assert.equal((await consumes(h)).length, 1)
      await writeFile(file, kept)
      // Back as the original login: the same operation goes on, with the same key, and spends nothing more.
      const back = await runtime(h)
      const r = await back.limitResetUse(await back.resolve('codex:other'), plan.operationId!)
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      assert.equal(r.operationId, plan.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[1]!.key, first!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('sends nothing when every account of a Same Login moved to another login together', async () => {
    const moveBoth = async (h: FakeHome) => {
      await signIn(h, '.codex', WS_C)
      await signIn(h, '.codex-work', WS_C)
    }
    // A plan that was shown, then confirmed after the move.
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await moveBoth(h)
      const rt2 = await runtime(h)
      const work = await rt2.resolve('codex:work')
      assert.deepEqual(await rt2.sameLogin(work), ['codex:main'], 'the same accounts, still one login')
      assert.equal((await failure(rt2.limitResetUse(work, plan.operationId!))).code, 'plan-outdated')
      assert.deepEqual(await consumes(h), [])
      // A plan made now is for the new login, and can be used.
      const next = await rt2.limitResetPlan(work)
      assert.notEqual(next.operationId, plan.operationId)
      assert.equal((await rt2.limitResetUse(work, next.operationId!)).outcome, 'reset')
      assert.equal((await consumes(h)).length, 1)
    })
    // An attempt that got no answer, then retried after the move.
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const plan = await rt.limitResetPlan(await rt.resolve('codex:main'))
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(await rt.resolve('codex:main'), plan.operationId!))
      await setMode(h, 'reset')
      await moveBoth(h)
      for (const ref of ['codex:main', 'codex:work']) {
        const rt2 = await runtime(h)
        const err = await failure(rt2.limitResetUse(await rt2.resolve(ref), plan.operationId!))
        assert.equal(err.code, 'login-changed', ref)
        assert.equal(err.operationId, plan.operationId)
      }
      assert.equal((await consumes(h)).length, 1, 'no second request')
      assert.equal((await hostState(h)).spends, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'pending', 'still unresolved, not stopped')
      assert.equal(rec!.attempts.length, 1)
    })
  })

  it('makes no new operation and sends nothing while an operation file is there but cannot be read', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      await setMode(h, 'lost')
      await failure(rt.limitResetUse(main, plan.operationId!))
      await setMode(h, 'reset')
      const [first] = await consumes(h)
      const state = rt.paths.stateDir
      const dir = limitResetDir(state)
      const file = limitResetFile(state, plan.operationId!)
      const good = await readFile(file, 'utf8')
      const blocked = async (path: string) => {
        // A preview, a retry by id, and a bare `--yes` (which is a preview, then its operation).
        const rt2 = await runtime(h)
        const work = await rt2.resolve('codex:work')
        const seen = await rt2.limitResetPlan(work)
        assert.equal(seen.canUse, false)
        assert.equal(seen.operationId, undefined)
        assert.ok(seen.blocked?.includes(path), 'the plan names what cannot be read')
        assert.match(seen.blocked ?? '', /will not use a limit reset/)
        assert.equal(seen.quota.status, 'ok', 'the plan still shows the numbers')
        for (const id of [plan.operationId!, 'lr-zzzzzzzz-00000000']) {
          const err = await failure(rt2.limitResetUse(work, id))
          assert.equal(err.code, 'records-unreadable')
          assert.ok(err.message.includes(path))
          assert.match(err.message, /Nothing was sent/)
          assert.equal(err.message.includes(first!.key!), false, 'never the contents')
        }
        const cli1 = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
        assert.equal(cli1.status, 1)
        const e = checked(cli1.stdout, 'error')
        assert.equal(e.code, 'cannot-use')
        assert.ok(e.error.includes(path))
        assert.equal((await consumes(h)).length, 1, 'nothing reached the Host')
      }
      try {
        // Damaged.
        await writeFile(file, good.slice(0, 30))
        await blocked(file)
        await writeFile(file, good)
        if (!root) {
          // No permission to read the file.
          await chmod(file, 0o000)
          await blocked(file)
          await chmod(file, 0o600)
          // The folder cannot be listed.
          await chmod(dir, 0o000)
          await blocked(dir)
          await chmod(dir, 0o700)
        }
      } finally {
        await chmod(dir, 0o700)
        await chmod(file, 0o600)
      }
      // No new operation was made beside the unresolved one, and that one was never removed or changed.
      assert.deepEqual(
        (await readdir(dir)).filter((n) => n.endsWith('.json')),
        [`${plan.operationId}.json`],
      )
      assert.equal(await readFile(file, 'utf8'), good)
      // Readable again: the unresolved operation goes on with its own key.
      const rt3 = await runtime(h)
      const r = await rt3.limitResetUse(await rt3.resolve('codex:work'), 'lr-zzzzzzzz-00000000')
      assert.equal(r.outcome, 'already-done')
      assert.equal(r.resumed, true)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[1]!.key, first!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('reads the quota anew after a spend when a read that began before it is kept after it', async () => {
    const reads = async (h: FakeHome) =>
      (await sent(h)).filter((r) => r.method === 'account/rateLimits/read').length
    const until = async (ok: () => Promise<boolean>) => {
      for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20))
      assert.ok(await ok(), 'waited for the slow read to reach the Host')
    }
    for (const where of ['this process', 'another process'] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        const before = await reads(h)
        // A read takes the numbers of before the spend (72%) and answers late.
        await setMode(h, 'slowread')
        const slow =
          where === 'this process'
            ? (await runtime(h)).quota(main, { fetch: 'force' })
            : cli(h, ['quota', 'codex:main', '--refresh', '--json'])
        await until(async () => (await reads(h)) > before)
        await setMode(h, 'reset')
        const r = await rt.limitResetUse(main, plan.operationId!)
        await slow
        assert.equal(r.outcome, 'reset', where)
        // What is shown is a read that began after the spend: the Host's new numbers, not the late old ones.
        assert.equal(r.quotaPending, undefined)
        assert.deepEqual(r.quota?.status === 'ok' && r.quota.windows.map((w) => w.usedPercent), [0, 0], where)
        assert.equal(r.quota?.status === 'ok' && r.quota.limitResets?.available, 0)
        const log = await sent(h)
        const spendAt = log.findIndex((x) => x.method === CONSUME)
        assert.ok(
          log.slice(spendAt + 1).some((x) => x.method === 'account/rateLimits/read'),
          `${where}: a read was sent after the spend`,
        )
        const kept = await rt.quota(main, { fetch: 'never' })
        assert.equal(kept.status === 'ok' && kept.windows[0]!.usedPercent, 0)
        const [rec] = await listLimitResetRecords(rt.paths.stateDir)
        assert.ok(rec!.quotaReadAt, 'stamped by the read that came after the spend')
      })
    }
  })

  it('says "used; quota pending update" when the read after a spend fails, and changes no number itself', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.quotaPending, true)
      assert.equal(r.quota, undefined)
      assert.match(r.message, /could not be read yet/)
      // What is on show is still the last real read: 72% and one reset, not zeros of sideby's own.
      const shown = await rt.quota(main, { fetch: 'never' })
      assert.equal(shown.status === 'ok' && shown.windows[0]!.usedPercent, 72)
      assert.equal(shown.status === 'ok' && shown.limitResets?.available, 1)
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'reset')
      assert.equal(rec!.quotaReadAt, undefined)
    })
  })

  it('never shows the numbers from before a spend as current when the same operation is asked again', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      const first = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(first.outcome, 'reset')
      assert.equal(first.quotaPending, true)
      // Asked again while the Host still cannot be read: the same answer, and still no numbers of sideby's choosing.
      const still = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(still.outcome, 'reset')
      assert.equal(still.replayed, true)
      assert.equal(still.quotaPending, true, 'the kept 72% is from before the spend: not shown as current')
      assert.equal(still.quota, undefined)
      assert.match(still.message, /A limit reset was used for codex:main/)
      assert.match(still.message, /could not be read yet/)
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt, undefined)
      // The Host can be read again: asking again reads the Quota (a read, never a second spend) and shows it.
      await setMode(h, 'reset')
      const now = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(now.replayed, true)
      assert.equal(now.quotaPending, undefined)
      assert.deepEqual(now.quota?.status === 'ok' && now.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal(now.quota?.status === 'ok' && now.quota.limitResets?.available, 0)
      assert.ok(
        (await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt,
        'the read after the spend is noted once it is kept',
      )
      // From then on the kept answer is known to be from after the spend: nobody is asked for it again.
      const asked = (await sent(h)).length
      const later = await (await runtime(h)).limitResetUse(main, plan.operationId!)
      assert.deepEqual(later.quota?.status === 'ok' && later.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal((await sent(h)).length, asked)
      assert.equal((await consumes(h)).length, 1, 'one spend request in all')
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('does not take a noted read as proof for the Account asked now: its own kept numbers must be from after the spend', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The fake answers the spend, then refuses to start for the read that follows.
      const real = await readFile(join(h.bin, 'codex'), 'utf8')
      await writeFile(
        join(h.bin, 'codex'),
        real.replace(
          "if (mode === 'slow')",
          "fs.writeFileSync(path.join(dir, 'mode'), 'noinit'); if (mode === 'slow')",
        ),
      )
      assert.equal((await rt.limitResetUse(main, plan.operationId!)).quotaPending, true)
      // The record says a read after the spend was kept (for an Account that has left the login since, say), while
      // what is kept for this Account is still from before.
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      await writeLimitResetRecord(rt.paths.stateDir, { ...rec!, quotaReadAt: new Date().toISOString() })
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.replayed, true)
      assert.equal(again.quotaPending, true, 'the kept 72% is from before the spend: not shown as current')
      assert.equal(again.quota, undefined)
      assert.equal((await consumes(h)).length, 1, 'never a second spend')
    })
  })

  it('says what the Host answered when that answer cannot be recorded, and a retry repeats the same request', async () => {
    for (const [mode, words, spends] of [
      ['reset', /A limit reset was used for codex:main/, 1],
      ['nothing', /Nothing was spent: no limit of codex:main can be reset/, 0],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        await setMode(h, mode)
        const rt = await runtime(h)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
        const writable = await failSavesFrom(h, file, 'the spend request')
        const retry = `sideby quota reset codex:main --yes --operation ${plan.operationId}`
        const err = await failure(rt.limitResetUse(main, plan.operationId!))
        assert.equal(err.code, 'outcome-not-saved', mode)
        assert.equal(err.operationId, plan.operationId)
        assert.match(err.message, words, 'what the Host answered, in plain words')
        assert.ok(err.message.includes(file), 'names the file that could not be written')
        assert.ok(err.message.includes(retry), 'and the retry that repeats the same request')
        assert.equal(err.message.includes(SECRET), false)
        assert.equal((await hostState(h)).spends, spends)
        // On disk the operation is still unresolved, with its key, so nothing new is made beside it.
        const [open] = await listLimitResetRecords(rt.paths.stateDir)
        assert.equal(open!.state, 'pending')
        if (mode === 'reset') {
          // The spend went through, so the Quota was read all the same: the numbers on show are the Host's new ones.
          const shown = await rt.quota(main, { fetch: 'never' })
          assert.equal(shown.status === 'ok' && shown.windows[0]!.usedPercent, 0)
          // Another process retries while the file still cannot be written: nothing is sent before the request is
          // on disk, and the failure names the same operation and how to go on.
          const cmd = await cli(h, [
            'quota',
            'reset',
            'codex:main',
            '--yes',
            '--operation',
            plan.operationId!,
            '--json',
          ])
          assert.equal(cmd.status, 1)
          const e = checked(cmd.stdout, 'error')
          assert.equal(e.code, 'outcome-unknown')
          assert.equal(e.operationId, plan.operationId)
          assert.match(e.error, /Nothing was sent now/)
          assert.ok(e.error.includes(file) && e.error.includes(retry))
          assert.equal((await consumes(h)).length, 1)
        }
        // The file can be written again: the retry sends the request with the key it had, and spends nothing more.
        await writable()
        const again = await rt.limitResetUse(main, plan.operationId!)
        assert.equal(again.outcome, mode === 'reset' ? 'already-done' : 'nothing-to-reset')
        assert.equal(again.resumed, true)
        assert.equal(again.operationId, plan.operationId)
        const calls = await consumes(h)
        assert.equal(calls.length, 2)
        assert.deepEqual([...new Set(calls.map((c) => c.key))], [open!.idempotencyKey], 'one key throughout')
        assert.equal((await hostState(h)).spends, spends)
        const [done] = await listLimitResetRecords(rt.paths.stateDir)
        assert.equal(done!.state, again.outcome)
      })
    }
  })

  it('sends nothing, and says so, when a confirmed plan cannot be put on disk before the request', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      // The plan can be read but not written: sideby's writer never writes through a link.
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      await rename(file, join(h.bin, 'record.moved'))
      await symlink(join(h.bin, 'record.moved'), file)
      const err = await failure(rt.limitResetUse(main, plan.operationId!))
      assert.equal(err.code, 'not-sent')
      assert.equal(err.operationId, plan.operationId)
      assert.match(err.message, /Nothing was sent, so nothing was spent/)
      assert.ok(err.message.includes(file), 'names the file that could not be written')
      assert.deepEqual(await consumes(h), [])
      assert.equal((await listLimitResetRecords(rt.paths.stateDir))[0]!.state, 'planned')
    })
  })

  it('reports a used reset as used when only the note of the quota read after it cannot be saved', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      const plan = await rt.limitResetPlan(main)
      const file = limitResetFile(rt.paths.stateDir, plan.operationId!)
      const writable = await failSavesFrom(h, file, 'the read after the spend')
      const r = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(r.outcome, 'reset')
      assert.equal(r.operationId, plan.operationId)
      assert.equal(r.quotaPending, undefined)
      assert.deepEqual(r.quota?.status === 'ok' && r.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.match(r.message, /A limit reset was used for codex:main/)
      assert.match(r.message, /could not note/)
      assert.ok(r.message.includes(file), 'names the file that could not be written')
      const [rec] = await listLimitResetRecords(rt.paths.stateDir)
      assert.equal(rec!.state, 'reset')
      assert.equal(rec!.quotaReadAt, undefined)
      assert.equal((await consumes(h)).length, 1)
      assert.equal((await hostState(h)).spends, 1)
      // Once the file can be written, asking for the same operation notes the read already kept: nobody is asked.
      await writable()
      const asked = (await sent(h)).length
      const again = await rt.limitResetUse(main, plan.operationId!)
      assert.equal(again.replayed, true)
      assert.deepEqual(again.quota?.status === 'ok' && again.quota.windows.map((w) => w.usedPercent), [0, 0])
      assert.equal((await sent(h)).length, asked)
      assert.ok((await listLimitResetRecords(rt.paths.stateDir))[0]!.quotaReadAt)
    })
  })

  it('is off in CI and inside a session under Unattended Mode, before anything is read or sent', async () => {
    for (const [env, code] of [
      [{ CI: 'true' }, 'ci'],
      [{ SIDEBY_ACCOUNT: 'codex:main', SIDEBY_UNATTENDED: '1' }, 'unattended'],
    ] as const) {
      await withFakeHome(async (h) => {
        await setup(h)
        // A plan made by the user beforehand does not open the door.
        const user = await runtime(h)
        const made = await user.limitResetPlan(await user.resolve('codex:main'))
        const rt = await runtime(h, env)
        const main = await rt.resolve('codex:main')
        const plan = await rt.limitResetPlan(main)
        assert.equal(plan.canUse, false)
        assert.equal(plan.operationId, undefined)
        assert.ok(plan.blocked)
        const err = await failure(rt.limitResetUse(main, made.operationId!))
        assert.equal(err.code, code)
        assert.match(err.message, /Nothing was sent/)
        assert.deepEqual(await consumes(h), [])
        assert.equal((await hostState(h)).spends, 0)
      })
    }
  })

  it('is never sent by a quota read, a refresh, the Handoff ranking or an Auto Handoff decision', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { pct: [99, 99] })
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const rt = await runtime(h)
      const main = await rt.resolve('codex:main')
      await rt.refreshQuota()
      await rt.quota(main, { fetch: 'wait' })
      await rt.handoff('codex')
      await rt.handoffDecision(main, [])
      assert.ok((await sent(h)).some((r) => r.method === 'account/rateLimits/read'))
      assert.deepEqual(await consumes(h), [])
      assert.deepEqual(await listLimitResetRecords(rt.paths.stateDir), [])
    })
  })

  it('lets Auto Handoff take an account back after a confirmed spend, once its Quota shows room', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { pct: [99, 40] })
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ handoff: { auto: true, sameFamily: true } }),
      )
      const rt = await runtime(h)
      const [main, other] = [await rt.resolve('codex:main'), await rt.resolve('codex:other')]
      await rt.refreshQuota()
      // The chain left codex:main because its 5-hour window was full; that window resets in two hours.
      const hop = {
        ref: 'codex:main',
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        window: { resetsAt: new Date(Date.now() + 7200_000).toISOString() },
      }
      const before = await rt.handoffDecision(other, [hop], { manual: true })
      assert.notEqual(before.kind === 'pick' && before.ref, 'codex:main')
      const plan = await rt.limitResetPlan(main)
      await rt.limitResetUse(main, plan.operationId!)
      const after = await rt.handoffDecision(other, [hop], { manual: true })
      assert.deepEqual([after.kind, after.kind === 'pick' && after.ref], ['pick', 'codex:main'])
    })
  })
})

describe('sideby quota reset', () => {
  it('shows the plan and exits 10; --yes uses one and exits 0; both print schema-valid JSON', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const plan = await cli(h, ['quota', 'reset', 'codex:main', '--json'])
      assert.equal(plan.status, 10, plan.stderr)
      const p = checked(plan.stdout, 'quota-reset')
      assert.equal(p.schemaVersion, 1)
      assert.equal(p.confirmationRequired, true)
      assert.match(p.operationId, /^lr-/)
      assert.deepEqual(p.sameLogin, ['codex:work'])
      assert.equal(p.limitResets.available, 1)
      assert.equal(p.expectedAfter, 0)
      assert.deepEqual(await consumes(h), [], 'the plan sends nothing')
      // In words: the windows, the count, that it cannot be undone, and the command that confirms.
      const text = await cli(h, ['quota', 'reset', 'codex:main'])
      assert.equal(text.status, 10)
      assert.match(text.stdout, /Also applies to: codex:work/)
      assert.match(text.stdout, /5h\s+72% used · resets/)
      assert.match(text.stdout, /1 available → 0 expected afterwards · the next one expires/)
      assert.match(text.stdout, /cannot be undone/)
      assert.match(text.stdout, /sideby quota reset codex:main --yes --operation lr-/)
      assert.deepEqual(await consumes(h), [])

      const used = await cli(h, [
        'quota',
        'reset',
        'codex:main',
        '--yes',
        '--operation',
        p.operationId,
        '--json',
      ])
      assert.equal(used.status, 0, used.stderr)
      const u = checked(used.stdout, 'quota-reset')
      assert.equal(u.outcome, 'reset')
      assert.equal(u.operationId, p.operationId)
      assert.equal(u.quota.windows[0].usedPercent, 0)
      assert.equal(u.quota.limitResets.available, 0)
      assert.equal((await consumes(h)).length, 1)
      for (const out of [plan.stdout, text.stdout, used.stdout, used.stderr])
        for (const no of [SECRET, WS_A, USER]) assert.equal(out.includes(no), false)

      // Nothing left: --yes reads the plan first, sees there is none, and sends nothing. Exit 1, with what to know.
      const none = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(none.status, 1)
      const e = checked(none.stdout, 'error')
      assert.equal(e.code, 'cannot-use')
      assert.match(e.error, /holds no limit reset; nothing was sent/)
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('exits 1 with "nothing was spent" for an answer that used none, and never asks twice by itself', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await setMode(h, 'nothing')
      const r = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(r.status, 1)
      const v = checked(r.stdout, 'quota-reset')
      assert.equal(v.outcome, 'nothing-to-reset')
      assert.match(v.message, /Nothing was spent/)
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('carries the operation in a failure, so the next --yes repeats the same request and not a new one', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      await setMode(h, 'lost')
      const lost = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(lost.status, 1)
      const e = checked(lost.stdout, 'error')
      assert.equal(e.schemaVersion, 1)
      assert.equal(e.code, 'outcome-unknown')
      assert.equal(typeof e.error, 'string')
      assert.match(e.operationId, /^lr-/)
      assert.match(e.error, new RegExp(`sideby quota reset codex:main --yes --operation ${e.operationId}`))
      // Another process, with a bare --yes for the other account of the login: the unresolved one is resumed.
      await setMode(h, 'reset')
      const plan = checked((await cli(h, ['quota', 'reset', 'codex:work', '--json'])).stdout, 'quota-reset')
      assert.equal(plan.unresolved, true)
      assert.equal(plan.operationId, e.operationId)
      const again = await cli(h, ['quota', 'reset', 'codex:work', '--yes', '--json'])
      assert.equal(again.status, 0, again.stderr)
      const v = checked(again.stdout, 'quota-reset')
      assert.equal(v.outcome, 'already-done')
      assert.equal(v.resumed, true)
      assert.equal(v.operationId, e.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]!.key, calls[1]!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('refuses in CI and for a session under Unattended Mode, and rejects flags that do not belong', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const ci = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'], { CI: 'true' })
      assert.equal(ci.status, 1)
      assert.match(checked(ci.stdout, 'error').error, /off in CI/)
      const un = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'], {
        SIDEBY_ACCOUNT: 'codex:main',
        SIDEBY_UNATTENDED: '1',
      })
      assert.equal(un.status, 1)
      assert.match(checked(un.stdout, 'error').error, /Unattended Mode is on/)
      assert.deepEqual(await consumes(h), [])
      assert.equal(
        (await cli(h, ['quota', 'reset', 'codex:main', '--operation', 'lr-zzzzzzzz-00000000'])).status,
        2,
      )
      assert.equal((await cli(h, ['quota', 'reset'])).status, 2)
      assert.equal((await cli(h, ['quota', '--open'])).status, 2)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('for Claude Code prints the vendor page and its purpose, and for a tool with neither says what to do', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await h.write('.claude/settings.json', '{}\n')
      await h.write(
        '.claude.json',
        JSON.stringify({ oauthAccount: { accountUuid: 'fake-uuid', emailAddress: 'me@example.com' } }),
        0o600,
      )
      await h.write('.grok/skills/x.md', 'x\n')
      await fakeHost(h, 'claude')
      const r = await cli(h, ['quota', 'reset', 'claude:main', '--json'])
      assert.equal(r.status, 0, r.stderr)
      const v = checked(r.stdout, 'quota-reset')
      assert.equal(v.outcome, 'open-vendor-page')
      assert.equal(v.url, 'https://claude.ai/settings/usage')
      assert.equal(v.opened, false)
      assert.equal(v.identity.email, 'me@example.com')
      assert.match(v.message, /cannot see whether claude:main holds one/)
      const text = await cli(h, ['quota', 'reset', 'claude:main'])
      assert.equal(text.status, 0)
      assert.match(text.stdout, /https:\/\/claude\.ai\/settings\/usage/)
      assert.match(text.stdout, /signed in as me@example\.com/)
      assert.match(text.stdout, /sideby quota reset claude:main --open/)
      // There is nothing to confirm on a page sideby only opens.
      const yes = await cli(h, ['quota', 'reset', 'claude:main', '--yes', '--json'])
      assert.equal(yes.status, 1)
      assert.equal(checked(yes.stdout, 'error').code, 'no-limit-reset')
      const grok = await cli(h, ['quota', 'reset', 'grok:main', '--json'])
      assert.equal(grok.status, 1)
      const e = checked(grok.stdout, 'error')
      assert.equal(e.code, 'no-limit-reset')
      assert.match(e.error, /check the vendor's own usage page/)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('`menubar reset` only opens the Panel on that account’s confirmation: it reads no plan and uses nothing', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      // The browser is a fake that writes down what it was asked to open.
      const opened = join(h.bin, 'open.log')
      await writeFile(join(h.bin, 'open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 })
      await writeFile(join(h.bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 })
      try {
        const r = await cli(h, ['menubar', 'reset', 'codex:work', '--json'])
        assert.equal(r.status, 0, r.stderr)
        const v = checked(r.stdout, 'menubar-reset')
        assert.equal(v.account, 'codex:work')
        assert.equal(v.opened, true)
        assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/#reset=codex%3Awork$/)
        assert.equal((await readFile(opened, 'utf8')).trim(), v.url)
        assert.deepEqual(await consumes(h), [])
        assert.deepEqual(await listLimitResetRecords(h.path('.local/state/sideby')), [])
        assert.equal((await cli(h, ['menubar', 'reset'])).status, 2)
      } finally {
        await cli(h, ['ui', '--stop'])
      }
    })
  })

  it('shows "Use a reset…" in the menu snapshot only where there is something to use', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const snap = checked(
        (await cli(h, ['menubar', 'snapshot', '--json', '--refresh'])).stdout,
        'menubar-snapshot',
      )
      const rows = snap.sections.flatMap((s: { rows: unknown[]; more?: { rows: unknown[] } | null }) => [
        ...s.rows,
        ...(s.more?.rows ?? []),
      ]) as { ref: string; useReset?: { title: string; tip: string } }[]
      const by = Object.fromEntries(rows.map((r) => [r.ref, r.useReset?.title]))
      // One line for the login that holds one (not on its Same Login's line too); none where none is held.
      assert.equal(by['codex:main'], 'Use a reset…')
      assert.equal(by['codex:work'], undefined)
      assert.deepEqual(await consumes(h), [], 'drawing the menu uses nothing')
      await setState(h, { credits: 0 })
      const after = JSON.parse(
        (await cli(h, ['menubar', 'snapshot', '--json', '--ask', 'codex:main'])).stdout,
      )
      const again = after.sections.flatMap((s: { rows: { ref: string; useReset?: object }[] }) => s.rows)
      assert.equal(again.find((r: { ref: string }) => r.ref === 'codex:main').useReset, undefined)
      assert.deepEqual(await consumes(h), [])
    })
  })
})

describe('Panel: using a Limit Reset', () => {
  const request = (
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let text = ''
          res.on('data', (d: Buffer) => (text += d))
          res.on('end', () => {
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(text) as Record<string, unknown>
            } catch {}
            resolve({ status: res.statusCode ?? 0, body: parsed })
          })
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  async function serve(h: FakeHome, readOnly = false) {
    let handler: ReturnType<typeof createPanelHandler> | undefined
    const server = createServer((req, res) => void handler!(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    handler = createPanelHandler({
      runtime: () => runtime(h),
      allowedHosts: [`127.0.0.1:${port}`],
      ...(readOnly ? { readOnly } : {}),
    })
    const good = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'x-sideby-token': handler.token,
    }
    const close = () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      })
    return { port, good, close }
  }

  it('refuses a request with a bad Host, Origin or token, and a read-only Panel, before anything is read', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const { port, good, close } = await serve(h)
      const ro = await serve(h, true)
      try {
        const body = { account: 'codex:main', confirm: true, operationId: 'lr-zzzzzzzz-00000000' }
        for (const path of ['/api/quota/reset', '/api/quota/reset/open']) {
          const bad: Record<string, string>[] = [
            { ...good, host: 'evil.example:80' },
            { ...good, origin: 'http://evil.example' },
            { host: good.host, 'x-sideby-token': good['x-sideby-token'] },
            { ...good, 'x-sideby-token': 'nope' },
            { host: good.host, origin: good.origin },
          ]
          for (const headers of bad)
            assert.equal((await request(port, path, body, headers)).status, 403, path)
          assert.equal((await request(ro.port, path, body, ro.good)).status, 403, `${path} read-only`)
        }
        assert.deepEqual(await sent(h), [], 'the Host was never started')
        assert.deepEqual(await listLimitResetRecords(h.path('.local/state/sideby')), [])
      } finally {
        await close()
        await ro.close()
      }
    })
  })

  it('gives the plan first, uses one only with confirm and its operation, and reports a lost answer to retry', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      const { port, good, close } = await serve(h)
      try {
        const post = (body: unknown) => request(port, '/api/quota/reset', body, good)
        assert.equal((await post({})).status, 400)
        const planned = await post({ account: 'codex:main' })
        assert.equal(planned.status, 200)
        const plan = planned.body.plan as { operationId: string; canUse: boolean; sameLogin: string[] }
        assert.equal(plan.canUse, true)
        assert.deepEqual(plan.sameLogin, ['codex:work'])
        assert.deepEqual(await consumes(h), [])
        // `confirm` without the operation it confirms is a malformed request, not a spend.
        assert.equal((await post({ account: 'codex:main', confirm: true })).status, 400)
        assert.deepEqual(await consumes(h), [])
        await setMode(h, 'lost')
        const lost = await post({ account: 'codex:main', confirm: true, operationId: plan.operationId })
        assert.equal(lost.status, 400)
        assert.equal(lost.body.code, 'outcome-unknown')
        assert.equal(lost.body.operationId, plan.operationId)
        assert.equal(String(lost.body.error).includes(SECRET), false)
        // "Check again": the same operation, the same key, no second spend.
        await setMode(h, 'reset')
        const again = await post({ account: 'codex:main', confirm: true, operationId: plan.operationId })
        assert.equal(again.status, 200)
        const result = again.body.result as { outcome: string; resumed?: boolean; quota?: { status: string } }
        assert.equal(result.outcome, 'already-done')
        assert.equal(result.resumed, true)
        assert.equal(result.quota?.status, 'ok')
        const calls = await consumes(h)
        assert.equal(calls.length, 2)
        assert.equal(calls[0]!.key, calls[1]!.key)
        assert.equal((await hostState(h)).spends, 1)
      } finally {
        await close()
      }
    })
  })
})

/** Every file under `dir` with its text, for "nothing of X is kept" checks. */
async function snapshotText(dir: string): Promise<[string, string][]> {
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
