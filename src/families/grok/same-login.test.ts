// Grok Same Login by x.ai user and team (spec §3.21, ADR-0037): the Login Key groups Accounts and never reaches an output.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, fakeHost, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import { LOGIN_KEY_READERS } from '../login-keys.ts'
import { grokLoginKey } from './login-key.ts'

const MAIN = fileURLToPath(new URL('../../cli/main.ts', import.meta.url))

// Fake ids only; the shapes Grok Build writes.
const USER = '00000000-0000-4000-8000-0000000000aa'
const TEAM = '00000000-0000-4000-8000-0000000000bb'
const EMAIL = 'grok@example.com'

const signIn = (h: FakeHome, dir: string, fields: Record<string, unknown>) =>
  h.write(
    `${dir}/auth.json`,
    JSON.stringify({
      'https://auth.x.ai::fake-client': { email: EMAIL, refresh_token: 'fake-refresh', ...fields },
    }),
    0o600,
  )
const key = (team: string, user: string) =>
  createHash('sha256').update(`grok\0${team}\0${user}`).digest('hex').slice(0, 16)

const account = (h: FakeHome, dir: string): Account => ({
  family: 'grok',
  name: 'x',
  ref: 'grok:x',
  dir: h.path(dir),
  isMain: false,
  kind: 'subscription',
})

function sideby(h: FakeHome, args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: h.env as NodeJS.ProcessEnv })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

describe('grokLoginKey', () => {
  it('is the Login Key reader of the grok Family', () => {
    assert.equal(LOGIN_KEY_READERS.get('grok'), grokLoginKey)
  })

  it('hashes the user and team ids, and gives nothing for a missing, odd or ambiguous sign-in', async () => {
    await withFakeHome(async (h) => {
      await signIn(h, '.grok-a', { user_id: USER, team_id: TEAM })
      assert.equal(await grokLoginKey(account(h, '.grok-a')), key(TEAM, USER))
      await signIn(h, '.grok-b', { user_id: USER, team_id: null })
      assert.equal(await grokLoginKey(account(h, '.grok-b')), key('', USER), 'no team')
      await signIn(h, '.grok-c', { user_id: USER })
      assert.equal(await grokLoginKey(account(h, '.grok-c')), key('', USER), 'team left out')
      const none = async (fields: Record<string, unknown>) => {
        await signIn(h, '.grok-d', fields)
        assert.equal(await grokLoginKey(account(h, '.grok-d')), undefined, JSON.stringify(fields))
      }
      await none({ team_id: TEAM })
      await none({ user_id: 42, team_id: TEAM })
      await none({ user_id: 'has space here', team_id: TEAM })
      await none({ user_id: USER, team_id: 7 })
      await h.write(
        '.grok-e/auth.json',
        JSON.stringify({ a: { user_id: USER }, b: { user_id: USER } }),
        0o600,
      )
      assert.equal(await grokLoginKey(account(h, '.grok-e')), undefined, 'two sign-ins')
      await h.write('.grok-f/auth.json', '{not json', 0o600)
      assert.equal(await grokLoginKey(account(h, '.grok-f')), undefined)
      assert.equal(await grokLoginKey(account(h, '.grok-missing')), undefined)
    })
  })
})

describe('grok Same Login (ADR-0037)', () => {
  it('groups the same user and team in list --json, keeps another team apart, and shows no id', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/config.toml', 'model = "grok-demo"\n')
      await signIn(h, '.grok', { user_id: USER, team_id: TEAM })
      await signIn(h, '.grok-001', { user_id: USER, team_id: TEAM })
      await signIn(h, '.grok-solo', { user_id: USER, team_id: null })
      await fakeHost(h, 'grok')
      const r = await sideby(h, ['list', '--json'])
      assert.equal(r.code, 0, r.err)
      for (const secret of [USER, TEAM, key(TEAM, USER), key('', USER), 'fake-refresh', 'fake-client'])
        assert.ok(!(r.out + r.err).includes(secret), `list --json must not contain ${secret}`)
      const data = JSON.parse(r.out) as { accounts: { ref: string; sameLogin?: string[] }[] }
      assert.deepEqual(Object.fromEntries(data.accounts.map((a) => [a.ref, a.sameLogin])), {
        'grok:main': ['grok:001'],
        'grok:001': ['grok:main'],
        'grok:solo': undefined,
      })
    })
  })
})
