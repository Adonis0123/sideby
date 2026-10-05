import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createPanelHandler } from '../panel/handler.ts'
import { createRuntime } from '../runtime.ts'
import { cleanEmail, identityMemoStats, identityOf, jwtEmail } from './identity.ts'

// Fake secrets: none of these may ever show up in any output.
const ACCESS = 'fake-access-token-AAAA1111'
const REFRESH = 'fake-refresh-token-BBBB2222'
const SIGNATURE = 'fake-signature-CCCC3333'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const fakeJwt = (claims: unknown) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.${SIGNATURE}`

async function seed(h: FakeHome) {
  // Claude: main keeps .claude.json in HOME; a personal default organization is left out.
  await h.write('.claude/settings.json', '{}')
  await h.write(
    '.claude.json',
    JSON.stringify({
      oauthAccount: { emailAddress: 'main@example.com', organizationName: "main@example.com's Organization" },
      primaryApiKey: ACCESS,
    }),
  )
  await h.write('.claude-work/settings.json', '{}')
  await h.write(
    '.claude-work/.claude.json',
    JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Fake Team' } }),
  )
  await h.write('.claude-out/settings.json', '{}')
  await h.write('.claude-out/.claude.json', '{}')
  // Codex: only the email claim of id_token.
  await h.write(
    '.codex/auth.json',
    JSON.stringify({
      tokens: {
        id_token: fakeJwt({ email: 'codex@example.com', sub: 'fake-subject', name: 'Fake Name' }),
        access_token: ACCESS,
        refresh_token: REFRESH,
      },
    }),
  )
  await h.write(
    '.codex-bad/auth.json',
    JSON.stringify({ tokens: { id_token: 'not.a-jwt', refresh_token: REFRESH } }),
  )
  await h.write('.codex-nojson/auth.json', 'garbage')
  // Grok: the single entry's email.
  await h.write(
    '.grok/auth.json',
    JSON.stringify({
      'https://auth.x.ai::00000000-fake': {
        email: 'grok@example.com',
        access_token: ACCESS,
        refresh_token: REFRESH,
      },
    }),
  )
  await h.write(
    '.grok-two/auth.json',
    JSON.stringify({
      'https://a::1': { email: 'a@example.com' },
      'https://b::2': { email: 'b@example.com' },
    }),
  )
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('identity helpers', () => {
  it('keeps only one well-formed email claim from a JWT', () => {
    assert.equal(jwtEmail(fakeJwt({ email: 'a@example.com', other: 'x' })), 'a@example.com')
    assert.equal(jwtEmail(fakeJwt({ sub: 'no-email' })), undefined)
    assert.equal(jwtEmail(fakeJwt({ email: 'not an email' })), undefined)
    assert.equal(jwtEmail('only.two'), undefined)
    assert.equal(jwtEmail(`a.${Buffer.from('{bad json').toString('base64url')}.c`), undefined)
    assert.equal(jwtEmail(42), undefined)
  })

  it('drops values that are not one short email or organization', () => {
    assert.equal(cleanEmail('x@example.com'), 'x@example.com')
    assert.equal(cleanEmail('x@example.com\nInjected'), undefined)
    assert.equal(cleanEmail(`${'a'.repeat(250)}@example.com`), undefined)
    assert.deepEqual(identityOf('x@example.com', ' Team '), { email: 'x@example.com', org: 'Team' })
    assert.equal(identityOf(undefined, ''), undefined)
  })
})

describe('account identity', () => {
  it('reads email and organization per family and never outputs a token', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({ env: h.env })
      const statuses = await Promise.all((await rt.accounts()).map((a) => rt.status(a)))
      const byRef = Object.fromEntries(statuses.map((s) => [s.ref, s.identity]))
      assert.deepEqual(byRef['claude:main'], { email: 'main@example.com' })
      assert.deepEqual(byRef['claude:work'], { email: 'work@example.com', org: 'Fake Team' })
      assert.equal(byRef['claude:out'], undefined)
      assert.deepEqual(byRef['codex:main'], { email: 'codex@example.com' })
      assert.equal(byRef['codex:bad'], undefined)
      assert.equal(byRef['codex:nojson'], undefined)
      assert.deepEqual(byRef['grok:main'], { email: 'grok@example.com' })
      assert.equal(byRef['grok:two'], undefined)
      for (const s of statuses) assert.equal(s.problems, undefined, `${s.ref} has no problems`)

      let handle: ReturnType<typeof createPanelHandler> | undefined
      const server = createServer((req, res) => void handle?.(req, res))
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as AddressInfo).port
      handle = createPanelHandler({
        runtime: () => createRuntime({ env: h.env }),
        allowedHosts: [`127.0.0.1:${port}`],
      })
      try {
        const state = await get(port, '/api/state')
        assert.match(state, /work@example\.com/)
        for (const out of [state, JSON.stringify(statuses)])
          for (const secret of [
            ACCESS,
            REFRESH,
            SIGNATURE,
            'fake-subject',
            'Fake Name',
            fakeJwt({}).split('.')[0]!,
          ])
            assert.equal(out.includes(secret), false, `output contains ${secret}`)
      } finally {
        server.close()
      }
    })
  })

  it('reads a login file again only after it changed', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({ env: h.env })
      const work = await rt.resolve('claude:work')
      assert.equal((await rt.status(work)).identity?.email, 'work@example.com')
      const before = { ...identityMemoStats }
      assert.equal((await rt.status(work)).identity?.email, 'work@example.com')
      assert.equal(identityMemoStats.hits - before.hits, 1)
      await h.write(
        '.claude-work/.claude.json',
        JSON.stringify({ oauthAccount: { emailAddress: 'other-work@example.com' } }),
      )
      assert.deepEqual((await rt.status(work)).identity, { email: 'other-work@example.com' })
      assert.equal(identityMemoStats.misses - before.misses, 1)
    })
  })
})
