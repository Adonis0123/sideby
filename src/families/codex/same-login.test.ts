// Codex Same Login by workspace (spec §3.21, ADR-0028): the Login Key groups Accounts and never reaches an output.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, fakeHost, withFakeHome } from '../../../testing/index.ts'
import { LOGIN_KEY_FAMILIES, SAME_LOGIN_FAMILIES } from '../../core/same-login.ts'
import { createPanelHandler, type PanelState } from '../../panel/handler.ts'
import { createRuntime } from '../../runtime.ts'
import type { Account } from '../../types.ts'
import { LOGIN_KEY_READERS } from '../login-keys.ts'
import { codexPlugin } from './index.ts'
import { codexLoginKey } from './login-key.ts'

const MAIN = fileURLToPath(new URL('../../cli/main.ts', import.meta.url))
const builtins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

// Fake ids only; the shapes Codex writes.
const WS_A = '00000000-0000-4000-8000-00000000aaaa'
const WS_B = '00000000-0000-4000-8000-00000000bbbb'
const USER = 'user-FakeUser00000001'
const EMAIL = 'codex@example.com'

/** A fake unsigned JWT; `auth` goes under the auth claim, unless null. */
function idToken(auth: Record<string, unknown> | null, email = EMAIL): string {
  const claims = { email, ...(auth ? { 'https://api.openai.com/auth': auth } : {}) }
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fake-sig`
}
const signIn = (h: FakeHome, dir: string, token: string) =>
  h.write(`${dir}/auth.json`, JSON.stringify({ tokens: { id_token: token } }), 0o600)
const key = (ws: string, user: string) =>
  createHash('sha256').update(`codex\0${ws}\0${user}`).digest('hex').slice(0, 16)

const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()
/** One rollout file whose Quota event was observed `ageHours` ago. */
const rollout = (h: FakeHome, dir: string, used: number, ageHours: number) =>
  h.write(
    `${dir}/sessions/2026/10/01/rollout-x.jsonl`,
    `${JSON.stringify({
      timestamp: iso(-ageHours),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          primary: {
            used_percent: used,
            window_minutes: 10080,
            resets_at: Math.floor(Date.now() / 1000) + 3 * 86400,
          },
          secondary: null,
          plan_type: 'pro',
        },
      },
    })}\n`,
  )

/** main and team in workspace A, other in workspace B, all the same email. */
async function threeDirs(h: FakeHome) {
  await h.write('.codex/AGENTS.md', '# rules\n')
  await signIn(h, '.codex', idToken({ chatgpt_account_id: WS_A, chatgpt_user_id: USER }))
  await signIn(h, '.codex-team', idToken({ chatgpt_account_id: WS_A, chatgpt_user_id: USER }))
  await signIn(h, '.codex-other', idToken({ chatgpt_account_id: WS_B, chatgpt_user_id: USER }))
  await fakeHost(h, 'codex')
}

/** Nothing that identifies the workspace or user leaves sideby: not the key, the ids or the token. */
function assertNoKey(text: string, where: string) {
  for (const secret of [key(WS_A, USER), key(WS_B, USER), WS_A, WS_B, USER, 'fake-sig', 'loginKey'])
    assert.ok(!text.includes(secret), `${where} must not contain ${secret}`)
}

function sideby(h: FakeHome, args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...h.env, ...extraEnv } as NodeJS.ProcessEnv,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

const account = (h: FakeHome, dir: string): Account => ({
  family: 'codex',
  name: 'x',
  ref: 'codex:x',
  dir: h.path(dir),
  isMain: false,
  kind: 'subscription',
})

describe('codexLoginKey', () => {
  it('is the reader of every Family that needs a Login Key, and only of those', () => {
    assert.deepEqual([...LOGIN_KEY_READERS.keys()].sort(), [...LOGIN_KEY_FAMILIES].sort())
    for (const f of LOGIN_KEY_FAMILIES) assert.ok(SAME_LOGIN_FAMILIES.has(f), f)
    assert.equal(LOGIN_KEY_READERS.get('codex'), codexLoginKey)
  })

  it('hashes the workspace and user ids, and gives nothing for a missing, odd or malformed token', async () => {
    await withFakeHome(async (h) => {
      await signIn(h, '.codex-a', idToken({ chatgpt_account_id: WS_A, chatgpt_user_id: USER }))
      assert.equal(await codexLoginKey(account(h, '.codex-a')), key(WS_A, USER))
      assert.match(key(WS_A, USER), /^[0-9a-f]{16}$/)
      const none = async (token: string) => {
        await signIn(h, '.codex-b', token)
        assert.equal(await codexLoginKey(account(h, '.codex-b')), undefined, token)
      }
      await none(idToken(null))
      await none(idToken({ chatgpt_user_id: USER }))
      await none(idToken({ chatgpt_account_id: WS_A }))
      await none(idToken({ chatgpt_account_id: 42, chatgpt_user_id: USER }))
      await none(idToken({ chatgpt_account_id: 'has space here', chatgpt_user_id: USER }))
      await none(idToken({ chatgpt_account_id: WS_A, chatgpt_user_id: 'not-a-user-id' }))
      await none('not.a-jwt')
      await none('a.%%%.b')
      await none('only-one-part')
      await h.write('.codex-c/auth.json', '{not json', 0o600)
      assert.equal(await codexLoginKey(account(h, '.codex-c')), undefined)
      assert.equal(await codexLoginKey(account(h, '.codex-missing')), undefined)
    })
  })
})

describe('codex Same Login (ADR-0028)', () => {
  it('groups the same email and workspace in list --json, and keeps another workspace apart', async () => {
    await withFakeHome(async (h) => {
      await threeDirs(h)
      const r = await sideby(h, ['list', '--json'])
      assert.equal(r.code, 0, r.err)
      assertNoKey(r.out + r.err, 'list --json')
      const data = JSON.parse(r.out) as { accounts: { ref: string; sameLogin?: string[] }[] }
      assert.deepEqual(Object.fromEntries(data.accounts.map((a) => [a.ref, a.sameLogin])), {
        'codex:main': ['codex:team'],
        'codex:other': undefined,
        'codex:team': ['codex:main'],
      })
      const human = await sideby(h, ['list'])
      assertNoKey(human.out + human.err, 'list')
    })
  })

  it('shares the freshest Quota with where it came from in quota --json, and next never picks the same login', async () => {
    await withFakeHome(async (h) => {
      await threeDirs(h)
      await rollout(h, '.codex', 96, 10)
      await rollout(h, '.codex-team', 5, 0.1)
      await rollout(h, '.codex-other', 40, 0.1)
      const q = await sideby(h, ['quota', '--json'])
      assert.equal(q.code, 0, q.err)
      assertNoKey(q.out + q.err, 'quota --json')
      const data = JSON.parse(q.out) as {
        accounts: { ref: string; quota: { windows?: { usedPercent: number }[]; from?: string } }[]
      }
      const by = Object.fromEntries(data.accounts.map((a) => [a.ref, a.quota]))
      assert.equal(by['codex:main']?.from, 'codex:team')
      assert.equal(by['codex:main']?.windows?.[0]?.usedPercent, 5)
      assert.equal(by['codex:team']?.from, undefined)
      assert.equal(by['codex:other']?.from, undefined)
      assert.equal(by['codex:other']?.windows?.[0]?.usedPercent, 40)

      const n = await sideby(h, ['next', 'codex', '--json'], { SIDEBY_ACCOUNT: 'codex:team' })
      assertNoKey(n.out + n.err, 'next --json')
      const plan = JSON.parse(n.out) as {
        pick?: string
        accounts: { ref: string; sameLoginAs?: string; quotaFrom?: string }[]
      }
      assert.notEqual(plan.pick, 'codex:main', 'main shares the quota of the current Account')
      const main = plan.accounts.find((a) => a.ref === 'codex:main')
      assert.equal(main?.sameLoginAs, 'codex:team')
      assert.equal(main?.quotaFrom, 'codex:team')
    })
  })

  it('keeps Accounts apart when a claim is missing or the token is malformed', async () => {
    await withFakeHome(async (h) => {
      await h.write('.codex/AGENTS.md', '# rules\n')
      await signIn(h, '.codex', idToken({ chatgpt_account_id: WS_A, chatgpt_user_id: USER }))
      await signIn(h, '.codex-team', idToken({ chatgpt_user_id: USER }))
      await signIn(h, '.codex-bad', `e30.${Buffer.from(`{"email":"${EMAIL}"`).toString('base64url')}.x`)
      await fakeHost(h, 'codex')
      const rt = await createRuntime({ env: h.env, builtins })
      const list = await Promise.all((await rt.accounts()).map((a) => rt.status(a)))
      assert.equal(list.length, 3)
      for (const a of list) assert.equal(a.sameLogin, undefined, a.ref)
      assertNoKey(JSON.stringify(list), 'AccountStatus')
    })
  })

  it('marks the Same Login in the Panel state, without the key', async () => {
    await withFakeHome(async (h) => {
      await threeDirs(h)
      await rollout(h, '.codex', 96, 10)
      await rollout(h, '.codex-team', 5, 0.1)
      const runtime = () => createRuntime({ env: h.env, builtins })
      let handler: ReturnType<typeof createPanelHandler> | undefined
      const server = createServer((req, res) => void handler!(req, res))
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as AddressInfo).port
      handler = createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${port}`] })
      try {
        const text = await new Promise<string>((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              method: 'GET',
              path: '/api/state',
              headers: { host: `127.0.0.1:${port}` },
            },
            (res) => {
              let body = ''
              res.on('data', (d: Buffer) => (body += d))
              res.on('end', () => resolve(body))
            },
          )
          req.on('error', reject)
          req.end()
        })
        assertNoKey(text, '/api/state')
        const state = JSON.parse(text) as PanelState
        const by = Object.fromEntries(state.accounts.map((a) => [a.ref, a]))
        assert.deepEqual(by['codex:main']?.sameLogin, ['codex:team'])
        assert.equal(by['codex:other']?.sameLogin, undefined)
        const q = by['codex:main']?.quota
        assert.equal(q?.status === 'ok' && q.from, 'codex:team')
      } finally {
        await new Promise<void>((r) => {
          server.close(() => r())
          server.closeAllConnections()
        })
      }
    })
  })
})
