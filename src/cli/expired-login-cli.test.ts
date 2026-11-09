// Expired Login (ADR-0071) through the CLI: `list`, `doctor`, `next` and `login`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import { confirmLogin } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

function sideby(h: FakeHome, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: h.env as NodeJS.ProcessEnv })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

function checkSchema(name: string, text: string) {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

const SECRET_TEXT = 'Login reached its time limit · Please run /login'

/** Two signed-in Claude accounts; `main`'s newest transcript ends on an expired login. */
async function seed(h: FakeHome) {
  for (const d of ['.claude', '.claude-work']) await h.write(`${d}/settings.json`, '{}\n')
  const login = JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } })
  await h.write('.claude.json', login, 0o600)
  await h.write(
    '.claude-work/.claude.json',
    JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }),
    0o600,
  )
  await h.write(
    '.claude/projects/-demo/s1.jsonl',
    `${[
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-08T09:00:00.000Z',
        message: { model: 'claude-fable-5-1', content: [] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-08T10:00:00.000Z',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: { model: '<synthetic>', content: [{ type: 'text', text: SECRET_TEXT }] },
      }),
    ].join('\n')}\n`,
  )
  // No `claude -p /usage` from tests.
  await h.write('.config/sideby/config.json', JSON.stringify({ quota: { check: { claude: false } } }))
}

describe('Expired Login in the CLI', () => {
  it('list --json carries loginProblem; the table marks it and names the command', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await sideby(h, ['list', '--json'])
      assert.equal(r.code, 0)
      const data = checkSchema('list', r.out)
      const accounts = data.accounts as {
        ref: string
        login: string
        loginProblem?: Record<string, unknown>
      }[]
      const main = accounts.find((a) => a.ref === 'claude:main')!
      assert.equal(main.login, 'logged-in')
      assert.equal(main.loginProblem?.kind, 'expired')
      assert.equal(main.loginProblem?.since, '2026-11-08T10:00:00.000Z')
      assert.equal(accounts.find((a) => a.ref === 'claude:work')!.loginProblem, undefined)
      // sideby's own words only, never the Host's text.
      assert.equal(r.out.includes('time limit'), false)
      const human = await sideby(h, ['list'])
      assert.match(human.out, /expired/)
      assert.match(human.out, /sideby login claude:main/)
    })
  })

  it('doctor warns login.expired, not fixable, and exits 0 on warnings alone', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await sideby(h, ['doctor', 'claude:main', '--json'])
      const data = checkSchema('doctor', r.out)
      const findings = (
        data.accounts as { findings: { code: string; level: string; fixable: boolean; hint?: string }[] }[]
      )[0]!.findings
      const f = findings.find((x) => x.code === 'login.expired')!
      assert.equal(f.level, 'warn')
      assert.equal(f.fixable, false)
      assert.match(f.hint ?? '', /sideby login claude:main/)
      if (!findings.some((x) => x.level === 'fail')) assert.equal(r.code, 0)
    })
  })

  it('next --json skips it with reason login-expired and the login command', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await sideby(h, ['next', 'claude', '--json'])
      const data = checkSchema('next', r.out)
      assert.notEqual(data.pick, 'claude:main')
      const main = (data.accounts as { ref: string; skip?: unknown }[]).find((a) => a.ref === 'claude:main')!
      assert.deepEqual(main.skip, { reason: 'login-expired', command: 'sideby login claude:main' })
    })
  })

  it('a later successful turn clears it', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write(
        '.claude/projects/-demo/s2.jsonl',
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T11:00:00.000Z', message: { model: 'claude-fable-5-1', content: [] } })}\n`,
      )
      const data = checkSchema('list', (await sideby(h, ['list', '--json'])).out)
      for (const a of data.accounts as { loginProblem?: unknown }[]) assert.equal(a.loginProblem, undefined)
    })
  })

  it('after a sign-in that exits 0 with quota checks off, it waits for confirmation and writes no Host file', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeHost(h, 'claude')
      const before = await snapshot(h.path('.claude'))
      const r = await sideby(h, ['login', 'claude:main'])
      assert.equal(r.code, 0)
      assert.match(r.err, /waiting|until its next session/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
      const data = checkSchema('list', (await sideby(h, ['list', '--json'])).out)
      const main = (data.accounts as { ref: string; loginProblem?: { signedInAt?: string } }[]).find(
        (a) => a.ref === 'claude:main',
      )!
      assert.ok(main.loginProblem?.signedInAt)
    })
  })
})

describe('confirmLogin', () => {
  const account = {
    family: 'claude',
    name: 'work',
    ref: 'claude:work',
    dir: '/x',
    isMain: false,
    kind: 'subscription' as const,
  }
  const run = async (afterLogin: () => Promise<unknown>) => {
    const err: string[] = []
    const rt = { afterLogin } as unknown as import('../runtime.ts').Runtime
    await confirmLogin(rt, account, { out: () => {}, err: (s) => err.push(s) })
    return err.join('\n')
  }
  it('says it could not confirm, never that quota checks are off, when the check throws', async () => {
    const text = await run(async () => {
      throw new Error('state folder not writable')
    })
    assert.match(text, /could not confirm/)
    assert.doesNotMatch(text, /quota checks are off/)
  })
  it('names quota checks only when they are off, and says when the login works again', async () => {
    assert.match(
      await run(async () => ({ checked: false, loginProblem: { kind: 'expired', message: 'x' } })),
      /quota checks are off/,
    )
    assert.doesNotMatch(
      await run(async () => ({ checked: true, loginProblem: { kind: 'expired', message: 'x' } })),
      /quota checks are off/,
    )
    assert.match(await run(async () => ({ checked: true })), /signed in again/)
  })
})
