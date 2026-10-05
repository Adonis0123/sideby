// Panel: spec §5 items 9 and 10 (security rules, per-card errors) and both mounting modes.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, MAX_BODY_BYTES, type PanelState } from './handler.ts'
import { jsonForScript, pageStyles, renderPage } from './page.ts'
import { startPanelServer } from './server.ts'
import { resolveTheme } from './theme.ts'

function factory(h: FakeHome, broken = false) {
  const def = demoFamily(
    broken
      ? {
          async model(a) {
            if (a.name === 'bad') throw new Error('settings unreadable')
            return 'm1'
          },
        }
      : { model: async () => 'm1' },
  )
  return () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(def))] })
}

/** Listens on a free port, then builds the handler for that port's Host. */
async function serve(make: (port: number) => ReturnType<typeof createPanelHandler>) {
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => {
    void handler!(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404)
        res.end('outer')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  handler = make(port)
  return { server, port, handler }
}

const close = (s: Server) =>
  new Promise<void>((r) => {
    s.close(() => r())
    s.closeAllConnections()
  })

/** Raw HTTP request: unlike fetch, node:http lets a test set the Host header (DNS rebinding, embedding). */
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.on('data', (d: Buffer) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string>) {
  const r = await request(
    port,
    'POST',
    path,
    { 'content-type': 'application/json', ...headers },
    typeof body === 'string' ? body : JSON.stringify(body),
  )
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(r.text) as Record<string, unknown>
  } catch {}
  return { status: r.status, body: parsed }
}

describe('panel handler security', () => {
  it('rejects bad Host, missing or cross Origin, bad token, big bodies and read-only writes', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const {
        server: s2,
        port,
        handler: real,
      } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': real.token }
        const health = await fetch(`http://127.0.0.1:${port}/api/health`)
        assert.deepEqual(await health.json(), { app: 'sideby', version: '0.1.0' })

        const rebinding = await request(port, 'GET', '/api/state', { host: 'evil.example:80' })
        assert.equal(rebinding.status, 403)

        assert.equal((await post(port, '/api/doctor', {}, { 'x-sideby-token': real.token })).status, 403)
        assert.equal(
          (
            await post(
              port,
              '/api/doctor',
              {},
              { origin: 'http://evil.example', 'x-sideby-token': real.token },
            )
          ).status,
          403,
        )
        assert.equal((await post(port, '/api/doctor', {}, { origin: good.origin })).status, 403)
        const stale = await post(port, '/api/doctor', {}, { ...good, 'x-sideby-token': 'nope' })
        assert.equal(stale.status, 403)
        assert.equal((stale.body as { code?: string }).code, 'bad-token')
        // A page whose token went stale (the server restarted) gets the current one from api/session.
        const session = await request(port, 'GET', '/api/session', {})
        assert.equal(session.status, 200)
        assert.deepEqual(JSON.parse(session.text), { token: real.token })
        const crossSite = await request(port, 'GET', '/api/session', { 'sec-fetch-site': 'cross-site' })
        assert.equal(crossSite.status, 403)
        assert.equal((await request(port, 'GET', '/api/session', { host: 'evil.example:80' })).status, 403)
        assert.equal((await post(port, '/api/doctor', 'x'.repeat(MAX_BODY_BYTES + 10), good)).status, 413)
        assert.equal((await post(port, '/api/doctor', '[1]', good)).status, 400)
        assert.equal((await post(port, '/api/doctor', {}, good)).status, 200)
        const created = await post(port, '/api/accounts', { family: 'demo', name: 'work' }, good)
        assert.equal(created.status, 200, JSON.stringify(created.body))
        assert.equal(
          (await post(port, '/api/accounts', { family: 'demo', name: 'Bad Name' }, good)).status,
          400,
        )
      } finally {
        await close(s2)
      }

      const {
        server: s3,
        port: p3,
        handler: r,
      } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${p3}`, 'x-sideby-token': r.token }
        assert.equal((await post(p3, '/api/fix', {}, hdr)).status, 403)
        assert.equal((await post(p3, '/api/accounts', { family: 'demo', name: 'x' }, hdr)).status, 403)
        assert.equal((await post(p3, '/api/doctor', {}, hdr)).status, 200)
      } finally {
        await close(s3)
      }
    })
  })

  it('keeps one broken account from breaking the others', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await factory(h)()
      await rt.createAccount('demo', 'bad')
      await rt.createAccount('demo', 'good')
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: factory(h, true), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as PanelState
        const bad = state.accounts.find((a) => a.ref === 'demo:bad')!
        const good = state.accounts.find((a) => a.ref === 'demo:good')!
        assert.match(bad.error!, /settings unreadable/)
        assert.equal(good.error, undefined)
        assert.equal(good.model, 'm1')
      } finally {
        await close(server)
      }
    })
  })
})

describe('panel server', () => {
  it('serves the page and API, reuses a running panel, and shifts past a busy port', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const blocker = createServer((_q, res) => res.end('busy'))
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
      const busyPort = (blocker.address() as AddressInfo).port
      const logs: string[] = []
      const srv = await startPanelServer({
        runtimeFactory: factory(h),
        port: busyPort,
        log: (s) => logs.push(s),
      })
      try {
        assert.equal(srv.reused, false)
        assert.notEqual(srv.url, `http://127.0.0.1:${busyPort}/`)
        assert.ok(logs.some((l) => l.includes('is busy')))
        const page = await (await fetch(srv.url)).text()
        assert.match(page, /sideby/)
        const port = Number(new URL(srv.url).port)
        const again = await startPanelServer({ runtimeFactory: factory(h), port, log: () => {} })
        assert.equal(again.reused, true)
        assert.equal(again.url, srv.url)
      } finally {
        await srv.close()
        await close(blocker)
      }
    })
  })

  it('works embedded under a basePath with the host the embedder allows', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      let handler: ReturnType<typeof createPanelHandler> | undefined
      const outer = createServer((req, res) => {
        void handler!(req, res).then((done) => {
          if (!done) {
            res.writeHead(200)
            res.end('outer app')
          }
        })
      })
      await new Promise<void>((r) => outer.listen(0, '127.0.0.1', r))
      const port = (outer.address() as AddressInfo).port
      const host = `accounts.localhost:${port}`
      handler = createPanelHandler({ runtime: factory(h), basePath: '/accounts', allowedHosts: [host] })
      try {
        const get = (path: string, hostHeader = host) => request(port, 'GET', path, { host: hostHeader })
        assert.equal((await get('/other')).text, 'outer app')
        const page = (await get('/accounts/')).text
        assert.ok(page.includes(handler.token))
        assert.equal((await get('/accounts/api/state', `127.0.0.1:${port}`)).status, 403)
        const ok = await post(
          port,
          '/accounts/api/doctor',
          {},
          {
            host,
            origin: `http://${host}`,
            'x-sideby-token': handler.token,
          },
        )
        assert.equal(ok.status, 200)
        const cross = await post(
          port,
          '/accounts/api/doctor',
          {},
          {
            host,
            origin: `http://127.0.0.1:${port}`,
            'x-sideby-token': handler.token,
          },
        )
        assert.equal(cross.status, 403)
      } finally {
        await close(outer)
      }
    })
  })
})

describe('page', () => {
  it('escapes injected data and references no external resources', () => {
    assert.equal(jsonForScript({ a: '</script><!-- ' }).includes('</script>'), false)
    const html = renderPage({
      basePath: '/x',
      token: 'tok"</script>',
      nonce: 'n',
      version: '0.1.0',
      readOnly: false,
    })
    assert.equal(html.match(/<\/script>/g)?.length, html.match(/<script/g)?.length)
    assert.doesNotMatch(html, /(src|href)="https?:\/\//)
    // An incomplete account creation is not shown as a success.
    assert.match(html, /r\.ok\s*\?/)
    assert.match(html, /with problems; see below/)
    // A refresh requested while one is running is queued (not dropped) and only the newest response renders.
    assert.match(html, /seq === loadSeq/)
    assert.match(html, /if \(next\) return load\(next\)/)
  })
})

describe('panel theme', () => {
  it('puts the host tokens into the nonce style, light before dark, and fixes the scheme on request', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const { server, port } = await serve((p) =>
        createPanelHandler({
          runtime: factory(h),
          allowedHosts: [`127.0.0.1:${p}`],
          theme: {
            header: 'bar',
            light: { font: '-apple-system, "PingFang SC", sans-serif', primary: '#e1f0fb', radius: '10px' },
            dark: { primary: 'rgb(31 99 150 / 90%)' },
          },
        }),
      )
      try {
        const r = await request(port, 'GET', '/', { host: `127.0.0.1:${port}` })
        assert.equal(r.status, 200)
        const style = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(r.text)?.[1] ?? ''
        assert.match(
          style,
          /:root \{ --font: -apple-system, "PingFang SC", sans-serif; --primary: #e1f0fb; --radius: 10px; \}/,
        )
        // The host's dark values come after the built-in dark palette, inside the media query.
        const dark = style.slice(style.indexOf('@media (prefers-color-scheme: dark)'))
        assert.ok(dark.indexOf('--primary: #5b54e8') < dark.indexOf('--primary: rgb(31 99 150 / 90%)'))
        assert.match(r.text, /<body class="header-bar">/)
      } finally {
        await close(server)
      }
    })
    const light = pageStyles(resolveTheme({ colorScheme: 'light', light: { bg: '#f2f8fc' } }))
    assert.doesNotMatch(light, /prefers-color-scheme: dark/)
    assert.match(light, /color-scheme: light;/)
    const html = renderPage({ basePath: '', token: 't', theme: resolveTheme({ colorScheme: 'light' }) })
    assert.match(html, /<meta name="color-scheme" content="light">/)
    // Without a theme the page keeps following the system.
    assert.match(pageStyles(), /@media \(prefers-color-scheme: dark\)/)
  })

  it('refuses values that could leave their declaration, and unknown tokens', () => {
    const bad = [
      'red; } body { display: none',
      '#fff</style><script>',
      'red}',
      'url(https://example.invalid/x.png)',
      'calc(1px',
      '"PingFang SC',
      'red /* x */',
      'a\\62 c',
      'expression:x',
      '',
      'x'.repeat(201),
    ]
    for (const value of bad)
      assert.throws(
        () =>
          createPanelHandler({
            runtime: async () => ({}) as never,
            allowedHosts: [],
            theme: { light: { text: value } },
          }),
        (err: Error) => err instanceof TypeError && /light\.text/.test(err.message),
        value,
      )
    assert.throws(() => resolveTheme({ light: { colour: 'red' } as never }), /unknown token light\.colour/)
    assert.throws(() => resolveTheme({ dark: { text: 1 as never } }), /dark\.text must be a string/)
    assert.throws(() => resolveTheme({ colorScheme: 'sepia' as never }), /colorScheme/)
    assert.throws(() => resolveTheme({ header: 'tall' as never }), /header/)
    assert.throws(() => resolveTheme({ css: 'x' } as never), /unknown option css/)
    assert.deepEqual(
      resolveTheme({
        light: { shadow: 'none', focusRing: '0 0 0 3px color-mix(in srgb, #74acdf 30%, transparent)' },
      }).light,
      ['--shadow: none', '--focus-ring: 0 0 0 3px color-mix(in srgb, #74acdf 30%, transparent)'],
    )
  })
})

describe('family logos', () => {
  const PATH = 'M11.5.1 1.9 5.7a.84.84 0 0 0-.42.73v11.19Z'
  it('sends a valid logo to the page and drops an unsafe one with a plugin error', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const good = demoFamily({ logo: { path: PATH, title: 'Demo', extra: '<b>' } as never })
      const bad = demoFamily({ id: 'evil', logo: { path: 'M0 0"/><script>alert(1)</script>' } })
      const plugins = [
        asBuiltin(demoPlugin(good)),
        asBuiltin({ name: 'evil-family', register: (api) => api.family(bad) }),
        asBuiltin({
          name: 'red-family',
          register: (api) => api.family(demoFamily({ id: 'red', logo: { path: PATH, color: 'red;x' } })),
        }),
      ]
      const rt = await createRuntime({ env: h.env, builtins: plugins })
      assert.deepEqual(rt.families.get('demo')?.logo, { path: PATH, title: 'Demo' })
      assert.equal(rt.families.get('evil')?.logo, undefined)
      assert.ok(rt.families.has('evil'), 'the Family itself still loads')
      const errors = rt.pluginErrors.map((e) => `${e.where}: ${e.message}`).join('\n')
      assert.match(errors, /evil-family: family evil: logo\.path may hold only SVG path commands/)
      assert.match(errors, /red-family: family red: logo\.color must be a hex color/)

      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime: async () => rt, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const r = await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })
        const state = JSON.parse(r.text) as PanelState
        assert.deepEqual(state.families.find((f) => f.id === 'demo')?.logo, { path: PATH, title: 'Demo' })
        assert.equal(state.families.find((f) => f.id === 'evil')?.logo, undefined)
        assert.ok(handler.token)
      } finally {
        await close(server)
      }
    })
  })

  it('gives every built-in Family a logo that passes the same check', async () => {
    await withFakeHome(async (h) => {
      const rt = await createRuntime({ env: h.env })
      for (const id of ['claude', 'codex', 'grok', 'pi']) assert.ok(rt.families.get(id)?.logo?.path, id)
      assert.deepEqual(rt.pluginErrors, [])
    })
  })
})

describe('panel through the Runtime (hardening round 1)', () => {
  it('answers 400 with the fix when config.json is broken, and a read-only check writes nothing', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.config/sideby/config.json', '{ broken')
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const r = await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })
        assert.equal(r.status, 400)
        assert.match(r.text, /not valid JSON; fix the syntax/)
      } finally {
        await close(server)
      }
      await h.write('.config/sideby/config.json', '{}')
      const ro = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/doctor', {}, hdr)).status, 200)
        const { lstat } = await import('node:fs/promises')
        await assert.rejects(lstat(h.path('.local/state/sideby/last-doctor.json')))
      } finally {
        await close(ro.server)
      }
    })
  })

  it('answers 400 with the plugin message and code when account.create.before refuses', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const refusing = demoPlugin(demoFamily(), (api) => {
        api.on('account.create.before', (ctx) => {
          if (!ctx.api) throw api.abort('one login only; turn on API key account')
        })
      })
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env: h.env, builtins: [asBuiltin(refusing)] }),
          allowedHosts: [`127.0.0.1:${port}`],
        }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const r = await post(port, '/api/accounts', { family: 'demo', name: 'work' }, hdr)
        assert.equal(r.status, 400)
        assert.deepEqual(r.body, {
          error: '[demo-family] one login only; turn on API key account',
          code: 'create-refused',
        })
        const { lstat } = await import('node:fs/promises')
        await assert.rejects(lstat(h.path('.demo-work')))
        const ok = await post(port, '/api/accounts', { family: 'demo', name: 'work', api: true }, hdr)
        assert.equal(ok.status, 200, JSON.stringify(ok.body))
      } finally {
        await close(server)
      }
    })
  })
})

describe('panel health (hardening round 3)', () => {
  it('shows only checked Accounts as healthy, and a read-only Panel refuses every writing route', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await factory(h)()
      await rt.createAccount('demo', 'work')
      await rt.doctor({ target: 'demo:main' })
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        const byRef = Object.fromEntries(state.accounts.map((a) => [a.ref, a.health]))
        assert.equal(byRef['demo:main']?.fail, 0)
        assert.equal(byRef['demo:work'], undefined)
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const checked = (await post(port, '/api/doctor', { target: 'demo:work' }, hdr)).body as {
          history: { accounts: Record<string, unknown> }
        }
        assert.deepEqual(Object.keys(checked.history.accounts).sort(), ['demo:main', 'demo:work'])
      } finally {
        await close(server)
      }
      const ro = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/quota/setup', { family: 'demo' }, hdr)).status, 400)
        assert.equal(
          (await post(ro.port, '/api/quota/setup', { family: 'demo', confirm: true }, hdr)).status,
          403,
        )
        assert.equal((await post(ro.port, '/api/fix', {}, hdr)).status, 403)
      } finally {
        await close(ro.server)
      }
    })
  })
})

describe('panel v2 server data', () => {
  it('lists the config aliases of each Account, sorted, and skips aliases that match no Account', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await (await factory(h)()).createAccount('demo', 'work')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ aliases: { dw: 'demo:work', zz: 'demo:main', aa: 'main', gone: 'demo:nope' } }),
      )
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        const byRef = Object.fromEntries(state.accounts.map((a) => [a.ref, a.aliases]))
        assert.deepEqual(byRef, { 'demo:main': ['aa', 'zz'], 'demo:work': ['dw'] })
      } finally {
        await close(server)
      }
    })
  })

  it('creates an Account with a short command, exposes the config aliases and checks the alias', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ aliases: { dm001: 'demo:main' }, shellInitFile: { zsh: '~/.sideby.zsh' } }),
      )
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        assert.deepEqual(state.configAliases, { dm001: 'demo:main' })
        const page = (await request(port, 'GET', '/', { host: `127.0.0.1:${port}` })).text
        assert.match(page, /"aliasPattern":/)
        assert.match(page, /"reservedAliases":\[/)
        const bad = await post(port, '/api/accounts', { family: 'demo', name: 'work', alias: 'dm001' }, hdr)
        assert.equal(bad.status, 400)
        assert.equal(bad.body.code, 'alias-invalid')
        assert.equal(
          (await post(port, '/api/accounts', { family: 'demo', name: 'work', alias: 7 }, hdr)).status,
          400,
        )
        const ok = await post(port, '/api/accounts', { family: 'demo', name: 'work', alias: 'dmwork' }, hdr)
        assert.equal(ok.status, 200, JSON.stringify(ok.body))
        assert.deepEqual(ok.body.alias, { name: 'dmwork', added: true })
        assert.equal((ok.body.shellInitFiles as { ok: boolean }[])[0]?.ok, true)
        const after = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        assert.deepEqual(after.configAliases, { dm001: 'demo:main', dmwork: 'demo:work' })
        assert.deepEqual(after.accounts.find((a) => a.ref === 'demo:work')?.aliases, ['dmwork'])
      } finally {
        await close(server)
      }
    })
  })

  it('tears quota setup down only with token and Origin, and never when read-only', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      let teardowns = 0
      const withSetup = () =>
        createRuntime({
          env: h.env,
          builtins: [
            asBuiltin(
              demoPlugin(
                demoFamily({
                  quotaSetup: {
                    summary: 'demo setup',
                    async plan() {
                      return { status: 'enabled', file: 'f', diff: '', message: 'on' }
                    },
                    async apply() {
                      return { status: 'enabled', file: 'f', diff: '', message: 'on' }
                    },
                    async teardown() {
                      teardowns++
                      return { ok: true, message: 'restored', diff: '-x\n+y\n' }
                    },
                  },
                }),
              ),
            ),
          ],
        })
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({ runtime: withSetup, allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const origin = `http://127.0.0.1:${port}`
        const good = { origin, 'x-sideby-token': handler.token }
        const path = '/api/quota/teardown'
        assert.equal((await post(port, path, { family: 'demo' }, { origin })).status, 403)
        assert.equal(
          (await post(port, path, { family: 'demo' }, { ...good, origin: 'http://evil.example' })).status,
          403,
        )
        assert.equal(
          (await post(port, path, { family: 'demo' }, { 'x-sideby-token': handler.token })).status,
          403,
        )
        assert.equal((await request(port, 'GET', path, { host: `127.0.0.1:${port}` })).status, 405)
        assert.equal(teardowns, 0)
        assert.equal((await post(port, path, {}, good)).status, 400)
        assert.equal((await post(port, path, { family: 'nofamily' }, good)).status, 400)
        const done = await post(port, path, { family: 'demo' }, good)
        assert.equal(done.status, 200)
        assert.deepEqual(done.body, {
          family: 'demo',
          result: { ok: true, message: 'restored', diff: '-x\n+y\n' },
        })
        assert.equal(teardowns, 1)
      } finally {
        await close(server)
      }
      const ro = await serve((port) =>
        createPanelHandler({ runtime: withSetup, allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
        const refused = await post(ro.port, '/api/quota/teardown', { family: 'demo' }, hdr)
        assert.equal(refused.status, 403)
        assert.equal(refused.body.error, 'this panel is read-only')
        assert.equal(teardowns, 1)
      } finally {
        await close(ro.server)
      }
      // A Family without a quota setup is a user error, not a crash.
      const plain = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${plain.port}`, 'x-sideby-token': plain.handler.token }
        const none = await post(plain.port, '/api/quota/teardown', { family: 'demo' }, hdr)
        assert.equal(none.status, 400)
        assert.match(String(none.body.error), /needs no quota setup/)
      } finally {
        await close(plain.server)
      }
    })
  })
})
