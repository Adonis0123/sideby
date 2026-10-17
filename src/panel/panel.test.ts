// Panel: spec §5 items 9 and 10 (security rules, per-card errors) and both mounting modes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { FAVICON_SVG } from '../core/brand-mark.ts'
import { packageVersion } from '../core/version.ts'
import type { Runtime } from '../runtime.ts'
import { createRuntime } from '../runtime.ts'
import {
  createPanelHandler,
  handoffByFamily,
  MAX_BODY_BYTES,
  type PanelAccount,
  type PanelState,
} from './handler.ts'
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
        // Only the app, its version and the build id (a random id per build): nothing about accounts.
        const version = packageVersion()
        assert.deepEqual(await health.json(), { app: 'sideby', version, build: `${version}+source` })

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

  it('names a broken Host install by its ~ path, so the page can say so instead of "not installed"', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const userBin = join(h.home, '.local', 'bin')
      await mkdir(userBin, { recursive: true })
      await symlink(join(userBin, 'gone.js'), join(userBin, 'demo'))
      const env = { ...h.env, PATH: `${userBin}:${h.env.PATH}` }
      const make = () => createRuntime({ env, builtins: [asBuiltin(demoPlugin(demoFamily({})))] })
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: make, allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as PanelState
        const fam = state.families.find((f) => f.id === 'demo')!
        assert.equal(fam.installed, false)
        assert.equal(fam.brokenBin, '~/.local/bin/demo')
        assert.equal(state.accounts.find((a) => a.ref === 'demo:main')!.hostInstalled, false)
      } finally {
        await close(server)
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
        assert.ok(dark.indexOf('--primary: #173a58') < dark.indexOf('--primary: rgb(31 99 150 / 90%)'))
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
        JSON.stringify({
          aliases: {
            dw: 'demo:work',
            zz: 'demo:main',
            aa: 'main',
            gone: 'demo:nope',
            'dm-x': { account: 'demo:main', args: ['--model', 'x'] },
          },
        }),
      )
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        const byRef = Object.fromEntries(state.accounts.map((a) => [a.ref, a.aliases]))
        assert.deepEqual(byRef, { 'demo:main': ['aa', 'dm-x', 'zz'], 'demo:work': ['dw'] })
        // Arguments ride along per alias; configAliases stays alias → ref so the page can check names.
        const main = state.accounts.find((a) => a.ref === 'demo:main')!
        assert.deepEqual(main.aliasArgs, { 'dm-x': ['--model', 'x'] })
        assert.equal(state.accounts.find((a) => a.ref === 'demo:work')!.aliasArgs, undefined)
        assert.equal(state.configAliases?.['dm-x'], 'demo:main')
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

describe('panel handoff (spec §3.13)', () => {
  const quotaOf = (pct: number) => ({
    status: 'ok' as const,
    observedAt: new Date().toISOString(),
    source: 'test',
    windows: [
      {
        label: '5h',
        windowMinutes: 300,
        usedPercent: pct,
        resetsAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
  })
  const used: Record<string, number> = { main: 90, work: 40, lab: 10 }
  const runtime = (h: FakeHome, withQuota: boolean | 'none') => () =>
    createRuntime({
      env: h.env,
      builtins: [
        asBuiltin(
          demoPlugin(
            demoFamily({
              loginState: async () => 'logged-in',
              ...(withQuota === 'none'
                ? {
                    readQuota: async () => ({
                      status: 'unavailable' as const,
                      reason: 'no-session' as const,
                    }),
                  }
                : withQuota
                  ? { readQuota: async (a) => quotaOf(used[a.name] ?? 0) }
                  : {}),
            }),
          ),
        ),
      ],
    })
  async function stateOf(h: FakeHome, withQuota: boolean | 'none'): Promise<PanelState> {
    const { server, port } = await serve((port) =>
      createPanelHandler({ runtime: runtime(h, withQuota), allowedHosts: [`127.0.0.1:${port}`] }),
    )
    try {
      return JSON.parse(
        (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
      ) as PanelState
    } finally {
      await close(server)
    }
  }

  it('names the account `sideby next` would pick, only where there is a choice and a quota source', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      assert.equal((await stateOf(h, true)).handoff, undefined, 'a single account is no choice')
      await (await runtime(h, true)()).createAccount('demo', 'work')
      assert.deepEqual((await stateOf(h, true)).handoff, { demo: 'demo:work' })
      await (await runtime(h, true)()).createAccount('demo', 'lab')
      assert.deepEqual((await stateOf(h, true)).handoff, { demo: 'demo:lab' })
      assert.equal((await stateOf(h, false)).handoff, undefined, 'no quota source, no recommendation')
      assert.equal((await stateOf(h, 'none')).handoff, undefined, 'no quota data yet, no recommendation')
    })
  })
})

describe('same login in the Panel (spec §3.21)', () => {
  it('marks each member and shows the freshest quota of the login, borrowed with where it came from', async () => {
    await withFakeHome(async (h) => {
      const login = JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } })
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude.json', login, 0o600)
      await h.write('.claude-001/settings.json', '{}\n')
      await h.write('.claude-001/.claude.json', login, 0o600)
      const iso = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString()
      const cache = (name: string, pct: number, age: number) =>
        h.write(
          `.local/state/sideby/quota/claude/${name}.json`,
          JSON.stringify({
            observedAt: iso(-age),
            windows: [{ label: '5h', windowMinutes: 300, usedPercent: pct, resetsAt: iso(2) }],
          }),
        )
      await cache('main', 25, 6)
      await cache('001', 64, 0.1)
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        const by = Object.fromEntries(state.accounts.map((a) => [a.ref, a]))
        assert.deepEqual(by['claude:main']?.sameLogin, ['claude:001'])
        assert.deepEqual(by['claude:001']?.sameLogin, ['claude:main'])
        const main = by['claude:main']?.quota
        assert.equal(main?.status === 'ok' && main.from, 'claude:001')
        assert.equal(main?.status === 'ok' && main.windows[0]?.usedPercent, 64)
        const own = by['claude:001']?.quota
        assert.equal(own?.status === 'ok' && own.from, undefined)
        const page = (await request(port, 'GET', '/', { host: `127.0.0.1:${port}` })).text
        assert.ok(page.includes('acct.sameLogin') || page.includes('Same login as'), 'the page knows the tag')
      } finally {
        await close(server)
      }
    })
  })
})

describe('panel lang', () => {
  it('serves a host lang in the page boot data, and auto when none is given', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const { server, port } = await serve((p) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${p}`], lang: 'zh' }),
      )
      const plain = await serve((p) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const zh = (await request(port, 'GET', '/', { host: `127.0.0.1:${port}` })).text
        assert.ok(zh.includes('"lang":"zh"'), 'the boot data carries the host lang')
        assert.match(zh, /<html lang="zh-CN">/)
        const auto = (await request(plain.port, 'GET', '/', { host: `127.0.0.1:${plain.port}` })).text
        assert.ok(auto.includes('"lang":"auto"'))
        assert.match(auto, /<html lang="en">/)
      } finally {
        await close(server)
        await close(plain.server)
      }
    })
  })

  it('refuses an unknown lang when the handler is created', () => {
    for (const lang of ['fr', 'zh-CN', 'EN', '', null, 1])
      assert.throws(
        () =>
          createPanelHandler({ runtime: async () => ({}) as never, allowedHosts: [], lang: lang as never }),
        (err: Error) => err instanceof TypeError && /lang must be "auto", "en" or "zh"/.test(err.message),
        String(lang),
      )
    for (const lang of ['auto', 'en', 'zh', undefined] as const)
      assert.doesNotThrow(() =>
        createPanelHandler({ runtime: async () => ({}) as never, allowedHosts: [], lang }),
      )
  })
})

describe('panel build identity', () => {
  it('reports the build in health, state and the page boot data, so an old page can reload itself', async () => {
    await withFakeHome(async (h) => {
      const { buildId } = await import('../core/version.ts')
      const { server, port } = await serve((port) =>
        createPanelHandler({ runtime: factory(h), allowedHosts: [`127.0.0.1:${port}`] }),
      )
      try {
        const host = { host: `127.0.0.1:${port}` }
        const health = JSON.parse((await request(port, 'GET', '/api/health', host)).text) as { build: string }
        const state = JSON.parse((await request(port, 'GET', '/api/state', host)).text) as PanelState
        const page = (await request(port, 'GET', '/', host)).text
        assert.equal(health.build, buildId())
        assert.equal(state.build, buildId())
        assert.ok(
          page.includes(`"build":${JSON.stringify(buildId())}`),
          'the page boot data carries the build',
        )
      } finally {
        await close(server)
      }
    })
  })
})

describe('Auto Handoff in the Panel (spec §3.17)', () => {
  it('changes an account’s model and effort only on confirm, and not from a read-only Panel', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      const config = h.path('.config/sideby/config.json')
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const plan = (await post(port, '/api/account/model', { account: 'claude:main', effort: 'high' }, hdr))
          .body as {
          changed: boolean
          diff: string
        }
        assert.equal(plan.changed, true)
        await assert.rejects(readFile(config, 'utf8'))
        await post(port, '/api/account/model', { account: 'claude:main', effort: 'high', confirm: true }, hdr)
        assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).accounts, {
          'claude:main': { args: ['--effort', 'high'] },
        })
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        assert.deepEqual(state.accounts.find((a) => a.ref === 'claude:main')!.modelInfo!.effort, {
          value: 'high',
          from: 'sideby',
        })
        assert.equal(
          (await post(port, '/api/account/model', { account: 'claude:main', effort: 3 }, hdr)).status,
          400,
        )
      } finally {
        await close(server)
      }
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal(
          (
            await post(
              ro.port,
              '/api/account/model',
              { account: 'claude:main', effort: 'low', confirm: true },
              hdr,
            )
          ).status,
          403,
        )
      } finally {
        await close(ro.server)
      }
    })
  })

  it('turns on in one step: plan first, writes on confirm, refuses in a read-only Panel, overview lists no Brief', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-001/projects/.keep', '')
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
      await chmod(join(h.bin, 'sideby'), 0o755)
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const plan = (await post(port, '/api/handoff/enable', {}, hdr)).body as {
          alreadyOn: boolean
          steps: { id: string; file?: string }[]
        }
        assert.equal(plan.alreadyOn, false)
        assert.deepEqual(
          plan.steps.map((s) => s.id),
          ['config', 'quota'],
        )
        assert.match(plan.steps[0]!.file!, /^~\//)
        await assert.rejects(readFile(h.path('.config/sideby/config.json'), 'utf8'))
        const done = (await post(port, '/api/handoff/enable', { confirm: true }, hdr)).body as {
          results: { ok: boolean }[]
        }
        assert.ok(done.results.length === 2 && done.results.every((r) => r.ok))
        const written = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(written.handoff, { auto: true })
        const overview = (await post(port, '/api/handoff/overview', {}, hdr)).body as {
          settings: { auto: boolean }
          recent: unknown[]
        }
        assert.equal(overview.settings.auto, true)
        assert.deepEqual(overview.recent, [])
        assert.equal((await post(port, '/api/handoff/enable', { sameFamily: 'yes' }, hdr)).status, 400)
      } finally {
        await close(server)
      }
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/handoff/overview', {}, hdr)).status, 200)
        assert.equal((await post(ro.port, '/api/handoff/enable', {}, hdr)).status, 200)
        assert.equal((await post(ro.port, '/api/handoff/enable', { confirm: true }, hdr)).status, 403)
      } finally {
        await close(ro.server)
      }
    })
  })

  it('sends the settings with the state, shows readiness, previews without writing and writes only on confirm', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-001/projects/.keep', '')
      await h.write('.claude-002/projects/.keep', '')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        ) as PanelState
        assert.equal(state.autoHandoff.settings.auto, false)
        assert.deepEqual(state.autoHandoff.starters, ['claude'])
        const status = (await post(port, '/api/handoff/status', {}, hdr)).body as { nextSteps: string[] }
        assert.equal(status.nextSteps[0], 'sideby handoff enable')
        const change = { auto: true, sameFamily: true, orders: [{ family: 'claude', order: ['claude:002'] }] }
        const preview = (await post(port, '/api/handoff/configure', { change }, hdr)).body as {
          applied: boolean
          diff: string
        }
        assert.equal(preview.applied, false)
        assert.match(preview.diff, /"auto": true/)
        await assert.rejects(readFile(h.path('.config/sideby/config.json'), 'utf8'))
        const saved = (await post(port, '/api/handoff/configure', { change, confirm: true }, hdr)).body as {
          applied: boolean
        }
        assert.equal(saved.applied, true)
        const written = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(written.handoff, {
          auto: true,
          sameFamily: true,
          families: { claude: { policy: 'order', order: ['claude:002'] } },
        })
        assert.equal(
          (await post(port, '/api/handoff/configure', { change: { rotate: true } }, hdr)).status,
          400,
        )
        assert.equal(
          (await post(port, '/api/handoff/configure', { change: { threshold: '95' } }, hdr)).status,
          400,
        )
      } finally {
        await close(server)
      }
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/handoff/status', {}, hdr)).status, 200)
        assert.equal(
          (await post(ro.port, '/api/handoff/configure', { change: { auto: false } }, hdr)).status,
          200,
        )
        assert.equal(
          (await post(ro.port, '/api/handoff/configure', { change: { auto: false }, confirm: true }, hdr))
            .status,
          403,
        )
      } finally {
        await close(ro.server)
      }
    })
  })
})

describe('context tuning in the Panel (spec §3.18)', () => {
  it('answers a token-checked read-only POST, also on a read-only Panel, and reports an unknown account', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/p/s.jsonl', '')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const { MIN_CALLS } = await import('../core/tuning.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      for (const readOnly of [false, true]) {
        const { server, port, handler } = await serve((p) =>
          createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly }),
        )
        try {
          const hdr = {
            host: `127.0.0.1:${port}`,
            origin: `http://127.0.0.1:${port}`,
            'x-sideby-token': handler.token,
          }
          const ok = await post(port, '/api/tuning', { account: 'claude:main' }, hdr)
          assert.equal(ok.status, 200, `readOnly=${readOnly}`)
          assert.deepEqual(
            (ok.body.accounts as { ref: string }[]).map((x) => x.ref),
            ['claude:main'],
          )
          assert.equal((ok.body.groups as { members: string[] }[])[0]?.members[0], 'claude:main')
          assert.equal(ok.body.minCalls, MIN_CALLS)
          assert.equal(
            (ok.body.accounts as { tuning: { status: string } }[])[0]?.tuning.status,
            'unavailable',
          )
          const all = await post(port, '/api/tuning', {}, hdr)
          assert.equal(all.status, 200)
          assert.equal(all.body.minCalls, MIN_CALLS)
          assert.deepEqual(
            (all.body.accounts as { ref: string; family: string }[]).map((x) => [x.ref, x.family]),
            [['claude:main', 'claude']],
          )
          assert.equal((await post(port, '/api/tuning', { account: 'claude:nope' }, hdr)).status, 400)
          // The checks every POST has stay on.
          assert.equal(
            (await post(port, '/api/tuning', { account: 'claude:main' }, { ...hdr, 'x-sideby-token': 'x' }))
              .status,
            403,
          )
          assert.equal(
            (
              await post(
                port,
                '/api/tuning',
                { account: 'claude:main' },
                { ...hdr, origin: 'http://evil.example' },
              )
            ).status,
            403,
          )
        } finally {
          await close(server)
        }
      }
    })
  })
})

describe('one setting per settings file (spec §3.18)', () => {
  it('puts the accounts that share a settings.json in one group, and an account with its own file in another', async () => {
    await withFakeHome(async (h) => {
      const { symlink } = await import('node:fs/promises')
      await h.write('.claude/settings.json', '{"autoCompactWindow":150000}\n')
      await h.write('.claude/projects/p/s.jsonl', '')
      for (const name of ['work', 'team']) await h.write(`.claude-${name}/projects/p/s.jsonl`, '')
      await symlink(h.path('.claude/settings.json'), h.path('.claude-work/settings.json'))
      await h.write('.claude-team/settings.json', '{}\n')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const r = (await post(port, '/api/tuning', {}, hdr)).body as {
          groups: { members: string[]; current: number | null; file: string }[]
        }
        const groups = r.groups.map((g) => [...g.members].sort())
        assert.deepEqual(groups.sort(), [['claude:main', 'claude:work'], ['claude:team']].sort())
        const shared = r.groups.find((g) => g.members.length === 2)
        assert.equal(shared?.current, 150_000)
        assert.match(shared?.file ?? '', /^~\/\.claude\/settings\.json$/)
        // Asking about one account returns only its own group.
        const one = (await post(port, '/api/tuning', { account: 'claude:team' }, hdr)).body as {
          groups: { members: string[] }[]
        }
        assert.deepEqual(
          one.groups.map((g) => g.members),
          [['claude:team']],
        )
        // From an account that has no sessions itself, its group and the others sharing the file still come back.
        const work = (await post(port, '/api/tuning', { account: 'claude:work' }, hdr)).body as {
          accounts: { ref: string }[]
          groups: { members: string[] }[]
        }
        assert.deepEqual(work.accounts.map((x) => x.ref).sort(), ['claude:main', 'claude:work'])
        assert.equal(work.groups.length, 1)
      } finally {
        await close(server)
      }
    })
  })
})

describe('what the settings file already says (spec §3.18)', () => {
  it('flags a size outside what Claude Code accepts and lists the models that keep a size of their own', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.claude/settings.json',
        JSON.stringify({
          autoCompactWindow: 80_000,
          modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 300_000, effortLevel: 'high' } },
        }),
      )
      await h.write('.claude/projects/p/s.jsonl', '')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const g = (
          (await post(port, '/api/tuning', {}, hdr)).body as {
            groups: {
              current: number | null
              outOfRange: boolean
              overrides: { model: string; value: number }[]
            }[]
          }
        ).groups[0]
        assert.deepEqual([g?.current, g?.outOfRange], [80_000, true])
        assert.deepEqual(g?.overrides, [{ model: 'claude-opus-5-5', value: 300_000 }])
      } finally {
        await close(server)
      }
    })
  })
})

describe('turning Remote Control off in the Panel (spec §3.22)', () => {
  it('lists the files in the state, writes only on the off route, never on a read-only Panel, and undoes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"theme":"dark","remoteControlAtStartup":true}\n')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const settings = async () => JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8'))
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/remote-control/off', {}, hdr)).status, 403)
        assert.equal((await post(ro.port, '/api/remote-control/on', {}, hdr)).status, 403)
        assert.equal((await post(ro.port, '/api/remote-control/undo', {}, hdr)).status, 403)
        assert.equal((await settings()).remoteControlAtStartup, true)
      } finally {
        await close(ro.server)
      }
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        )
        assert.deepEqual(state.remoteControl, [
          { file: '~/.claude/settings.json', accounts: ['claude:main'], state: 'on', undo: false },
        ])
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const off = await post(port, '/api/remote-control/off', {}, hdr)
        assert.equal(off.body.ok, true)
        assert.deepEqual(await settings(), { theme: 'dark', remoteControlAtStartup: false })
        const after = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        )
        assert.equal(after.remoteControl[0].undo, true)
        assert.equal((await post(port, '/api/remote-control/undo', {}, hdr)).body.ok, true)
        assert.deepEqual(await settings(), { theme: 'dark', remoteControlAtStartup: true })
        await post(port, '/api/remote-control/off', {}, hdr)
        assert.equal((await post(port, '/api/remote-control/on', {}, hdr)).body.ok, true)
        assert.deepEqual(await settings(), { theme: 'dark', remoteControlAtStartup: true })
      } finally {
        await close(server)
      }
    })
  })
})

describe('using a tuning suggestion in the Panel (ADR-0012)', () => {
  it('shows the plan without writing, writes only on confirm, never on a read-only Panel, and undoes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/p/s.jsonl', '')
      await h.write('.claude/settings.json', '{"theme":"dark"}\n')
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const settings = async () => JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8'))
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const plan = await post(port, '/api/tuning/apply', { account: 'claude:main', value: 120_000 }, hdr)
        assert.equal(plan.status, 200)
        assert.equal(plan.body.applied, false)
        assert.equal((plan.body.plan as { next: number; file: string }).next, 120_000)
        assert.match((plan.body.plan as { file: string }).file, /^~\/\.claude\/settings\.json$/)
        assert.deepEqual(await settings(), { theme: 'dark' })
        assert.equal((await post(port, '/api/tuning/apply', { account: 'claude:main' }, hdr)).status, 400)
        assert.equal(
          (await post(port, '/api/tuning/apply', { account: 'claude:main', value: 'big' }, hdr)).status,
          400,
        )
        assert.equal(
          (await post(port, '/api/tuning/apply', { account: 'claude:main', value: null }, hdr)).status,
          200,
        )
        assert.equal(
          (await post(port, '/api/tuning/apply', { account: 'claude:main', value: 5 }, hdr)).status,
          400,
        )
        const done = await post(
          port,
          '/api/tuning/apply',
          { account: 'claude:main', value: 120_000, confirm: true },
          hdr,
        )
        assert.equal(done.body.applied, true)
        assert.deepEqual(await settings(), { theme: 'dark', autoCompactWindow: 120_000 })
        const seen = (await post(port, '/api/tuning', { account: 'claude:main' }, hdr)).body as {
          groups: { undo: { value: number; previous: null } | null; current: number | null }[]
        }
        assert.deepEqual(seen.groups[0]?.undo, { value: 120_000, previous: null })
        assert.equal(
          (await post(port, '/api/tuning/undo', { account: 'claude:main' }, hdr)).body.undone,
          true,
        )
        assert.deepEqual(await settings(), { theme: 'dark' })
      } finally {
        await close(server)
      }
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal(
          (await post(ro.port, '/api/tuning/apply', { account: 'claude:main', value: 120_000 }, hdr)).status,
          200,
        )
        assert.equal(
          (
            await post(
              ro.port,
              '/api/tuning/apply',
              { account: 'claude:main', value: 120_000, confirm: true },
              hdr,
            )
          ).status,
          403,
        )
        assert.equal((await post(ro.port, '/api/tuning/undo', { account: 'claude:main' }, hdr)).status, 403)
        assert.deepEqual(await settings(), { theme: 'dark' })
        // The checks every POST has stay on.
        assert.equal(
          (
            await post(
              ro.port,
              '/api/tuning/apply',
              { account: 'claude:main', value: 120_000 },
              { ...hdr, 'x-sideby-token': 'x' },
            )
          ).status,
          403,
        )
      } finally {
        await close(ro.server)
      }
    })
  })
})

describe('panel: desktop apps (spec §3.20)', () => {
  it('shows which accounts can open their desktop app, opens it through the fake seam, and a read-only panel refuses', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-work/settings.json', '{}\n')
      await h.write('.claude-deepseek/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
      await h.write(
        'Apps/Claude.app/Contents/Info.plist',
        '<plist><dict><key>CFBundleExecutable</key><string>Claude</string><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>\n',
      )
      const calls: { cmd: string; args: readonly string[] }[] = []
      const rt = await createRuntime({
        env: h.env,
        desktop: {
          platform: 'darwin',
          appDirs: [h.path('Apps')],
          exec: async (cmd, args) => {
            calls.push({ cmd, args })
            return { code: 0, stdout: '', stderr: '' }
          },
        },
      })
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({ runtime: rt, allowedHosts: [`127.0.0.1:${port}`] }),
      )
      const ro = await serve((port) =>
        createPanelHandler({ runtime: rt, allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as PanelState
        const work = state.accounts.find((a) => a.ref === 'claude:work')!
        assert.deepEqual(work.desktopApp, { app: 'Claude Desktop', installed: true, running: false })
        assert.equal(state.accounts.find((a) => a.ref === 'claude:deepseek')!.desktopApp, undefined)

        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const r = await post(port, '/api/account/desktop', { account: 'claude:work' }, hdr)
        assert.equal(r.status, 200)
        assert.equal(r.body.action, 'started')
        assert.equal(r.body.appData, '~/Library/Application Support/sideby/claude/work')
        assert.equal(calls.filter((c) => c.cmd === '/usr/bin/open').length, 1)

        const api = await post(port, '/api/account/desktop', { account: 'claude:deepseek' }, hdr)
        assert.equal(api.status, 400)
        assert.equal(api.body.code, 'api-account')

        const roHdr = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
        assert.equal(
          (await post(ro.port, '/api/account/desktop', { account: 'claude:work' }, roHdr)).status,
          403,
        )
        assert.equal(calls.filter((c) => c.cmd === '/usr/bin/open').length, 1)
      } finally {
        await close(server)
        await close(ro.server)
      }
    })
  })
})

describe('panel: Grok Bot windows (ADR-0019)', () => {
  it('lists them in the state, creates and opens one, removes it, and a read-only panel refuses both', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write(
        'Apps/Grok Bot.app/Contents/Info.plist',
        '<plist><dict><key>CFBundleExecutable</key><string>Grok Bot</string><key>CFBundleIdentifier</key><string>com.anysphere.sand</string></dict></plist>\n',
      )
      await h.write('Library/Application Support/Grok Bot/desktop-status.json', '{"signedIn":true}')
      const calls: { cmd: string; args: readonly string[] }[] = []
      const rt = await createRuntime({
        env: h.env,
        desktop: {
          platform: 'darwin',
          appDirs: [h.path('Apps')],
          exec: async (cmd, args) => {
            calls.push({ cmd, args })
            return { code: 0, stdout: '', stderr: '' }
          },
        },
      })
      const { server, port, handler } = await serve((port) =>
        createPanelHandler({ runtime: rt, allowedHosts: [`127.0.0.1:${port}`] }),
      )
      const ro = await serve((port) =>
        createPanelHandler({ runtime: rt, allowedHosts: [`127.0.0.1:${port}`], readOnly: true }),
      )
      try {
        const state = async (p: number) =>
          (await (await fetch(`http://127.0.0.1:${p}/api/state`)).json()) as PanelState
        assert.deepEqual(
          (await state(port)).appProfiles?.map((p) => [p.ref, p.signedIn]),
          [['grok-bot:main', true]],
        )
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const roHdr = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
        assert.equal(
          (await post(ro.port, '/api/app-profile/open', { ref: 'grok-bot:002' }, roHdr)).status,
          403,
        )

        const r = await post(port, '/api/app-profile/open', { ref: 'grok-bot:002' }, hdr)
        assert.equal(r.status, 200)
        assert.equal(r.body.action, 'started')
        assert.equal(r.body.createdAppData, true)
        assert.equal(r.body.appData, '~/Library/Application Support/sideby/grok-bot/002')
        assert.equal(calls.filter((c) => c.cmd === '/usr/bin/open').length, 1)
        const after = (await state(port)).appProfiles!
        assert.deepEqual(
          after.map((p) => p.ref),
          ['grok-bot:main', 'grok-bot:002'],
        )
        assert.equal(after[1]!.appData, '~/Library/Application Support/sideby/grok-bot/002')

        const bad = await post(port, '/api/app-profile/open', { ref: 'grok-bot:No' }, hdr)
        assert.equal(bad.status, 400)
        assert.equal(bad.body.code, 'invalid-name')

        assert.equal(
          (await post(ro.port, '/api/app-profile/remove', { ref: 'grok-bot:002' }, roHdr)).status,
          403,
        )
        const main = await post(port, '/api/app-profile/remove', { ref: 'grok-bot:main' }, hdr)
        assert.equal(main.body.code, 'main-profile')
        const rm = await post(port, '/api/app-profile/remove', { ref: 'grok-bot:002' }, hdr)
        assert.equal(rm.status, 200)
        assert.equal(rm.body.removed, true)
        assert.deepEqual(
          (await state(port)).appProfiles?.map((p) => p.ref),
          ['grok-bot:main'],
        )
      } finally {
        await close(server)
        await close(ro.server)
      }
    })
  })
})

describe('panel next tag and Same Login (spec §3.21)', () => {
  const rt = {
    families: new Map([['claude', { readQuota: async () => ({ status: 'ok', windows: [] }) }]]),
  } as unknown as Runtime
  const now = new Date('2026-10-14T10:00:00Z')
  const quota = (used: number) => ({
    status: 'ok' as const,
    observedAt: '2026-10-14T09:59:00Z',
    windows: [{ label: '5h', usedPercent: used, resetsAt: '2026-10-14T12:00:00Z' }],
  })
  const acct = (name: string, used: number, sameLogin?: string[]) =>
    ({
      ref: `claude:${name}`,
      name,
      family: 'claude',
      isMain: name === 'main',
      kind: 'subscription',
      login: 'logged-in',
      quota: quota(used),
      ...(sameLogin ? { sameLogin } : {}),
    }) as unknown as PanelAccount

  it('tags no next account when the only two subscriptions are one login', () => {
    const out = handoffByFamily(rt, [acct('main', 10, ['claude:001']), acct('001', 10, ['claude:main'])], now)
    assert.deepEqual(out, {})
  })

  it('still tags one when another login exists', () => {
    const out = handoffByFamily(
      rt,
      [acct('main', 80, ['claude:001']), acct('001', 80, ['claude:main']), acct('002', 10)],
      now,
    )
    assert.equal(out.claude, 'claude:002')
  })
})

describe('panel updates (spec §3.23, ADR-0021)', () => {
  it('serves the mark, shows a newer version and the Auto Update switch, and hides it all with updates: false', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const { bindUpdateDeps } = await import('../core/update.ts')
      const asked: string[] = []
      const execs: string[][] = []
      let unbindNone = () => {}
      const unbind = bindUpdateDeps({
        fetch: (async (url: string | URL) => {
          asked.push(String(url))
          return new Response(JSON.stringify({ latest: '99.0.0' }))
        }) as typeof fetch,
        packageDir: async () => '/u/.nvm/versions/node/v22/lib/node_modules/sideby',
        writable: async () => true,
        exec: async (file, args) => {
          execs.push([file, ...args])
          return { code: 0, output: '' }
        },
        appInstalled: async () => true,
        refreshApp: async () => true,
      })
      const { SIDEBY_NO_UPDATE_NOTIFIER: _off, ...env } = h.env
      const make = (updates?: boolean) => (port: number) =>
        createPanelHandler({
          runtime: () => createRuntime({ env, builtins: [asBuiltin(demoPlugin(demoFamily({})))] }),
          allowedHosts: [`127.0.0.1:${port}`],
          ...(updates === undefined ? {} : { updates }),
        })
      const on = await serve(make())
      const off = await serve(make(false))
      try {
        const icon = await request(on.port, 'GET', '/icon.svg', { host: `127.0.0.1:${on.port}` })
        assert.equal(icon.status, 200)
        assert.match(icon.text, /^<svg xmlns=.*#f2b35e.*#3f8fc4/s)
        const page = await request(on.port, 'GET', '/', { host: `127.0.0.1:${on.port}` })
        // The link changes with the mark, so a browser fetches a new favicon after an Update changes it.
        const v = createHash('sha256').update(FAVICON_SVG).digest('hex').slice(0, 10)
        assert.ok(
          page.text.includes(`<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${v}">`),
          'favicon link carries the mark version',
        )
        const fav = await request(on.port, 'GET', `/favicon.svg?v=${v}`, { host: `127.0.0.1:${on.port}` })
        assert.equal(fav.status, 200)
        assert.equal(fav.text, FAVICON_SVG)
        // The running version stays in sight in the header and opens the dialog with "Check for updates" (spec §3.23).
        assert.match(
          page.text,
          /<div class="title-row"><h1>sideby<\/h1><button id="ver-top" class="ver-pill" type="button" aria-haspopup="dialog" aria-expanded="false" hidden><\/button><\/div>/,
        )
        assert.match(page.text, /function updCheck\(\)[\s\S]*api\('\/api\/update', \{\}\)/)
        const state = async (port: number) =>
          JSON.parse(
            (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
          ) as PanelState
        // The first state read starts the check; poll until its answer shows (no fixed sleep: the machine may be slow).
        let u = (await state(on.port)).update!
        for (let i = 0; i < 250 && !u.latest; i++) {
          await new Promise((r) => setTimeout(r, 20))
          u = (await state(on.port)).update!
        }
        assert.equal(asked.length, 1)
        assert.deepEqual(
          [u.latest, u.available, u.canRun, u.auto, u.method.kind],
          ['99.0.0', true, true, false, 'npm'],
        )
        assert.equal(u.command, 'npm install -g sideby@99.0.0')
        assert.equal((await state(off.port)).update, undefined)

        const good = { origin: `http://127.0.0.1:${on.port}`, 'x-sideby-token': on.handler.token }
        const preview = await post(on.port, '/api/update/settings', { auto: true }, good)
        assert.equal(preview.status, 200)
        assert.equal(preview.body.applied, false)
        await assert.rejects(readFile(h.path('.config/sideby/config.json'), 'utf8'))
        const saved = await post(on.port, '/api/update/settings', { auto: true, confirm: true }, good)
        assert.equal(saved.body.applied, true)
        const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')) as {
          update?: { auto?: boolean }
        }
        assert.equal(config.update?.auto, true)

        // The version the dialog showed is not the one the registry names now: nothing is installed.
        const stale = await post(on.port, '/api/update', { confirm: true, version: '98.0.0' }, good)
        assert.equal(stale.status, 200)
        assert.deepEqual([stale.body.updated, stale.body.changed, stale.body.latest], [false, true, '99.0.0'])
        assert.equal(execs.length, 0)
        const ran = await post(on.port, '/api/update', { confirm: true, version: '99.0.0' }, good)
        assert.equal(ran.body.updated, true)
        assert.equal(ran.body.refreshedApp, true)
        assert.equal(execs.length, 1)
        // The registry now names no newer version: a confirmation runs nothing and says so.
        unbindNone = bindUpdateDeps({
          fetch: (async () => new Response(JSON.stringify({ latest: '0.0.1' }))) as typeof fetch,
        })
        const none = await post(on.port, '/api/update', { confirm: true, version: '99.0.0' }, good)
        assert.deepEqual([none.body.updated, none.body.changed, none.body.available], [false, true, false])
        assert.equal(execs.length, 1)
        // The CLI is current and the skill agents read is behind: `skill: true` updates the skill alone.
        await h.write(
          '.agents/skills/sideby/SKILL.md',
          '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n',
        )
        const sk = (await state(on.port)).update!
        assert.deepEqual(
          [sk.available, sk.skillUpdate?.outdated, sk.skillUpdate?.canRun],
          [false, true, true],
        )
        const skillRan = await post(on.port, '/api/update', { confirm: true, skill: true }, good)
        assert.deepEqual([skillRan.body.updated, skillRan.body.skillUpdated], [false, true])
        assert.equal(execs.length, 2)
        unbindNone()

        const offGood = { origin: `http://127.0.0.1:${off.port}`, 'x-sideby-token': off.handler.token }
        assert.equal((await post(off.port, '/api/update', {}, offGood)).status, 403)
        assert.equal((await post(off.port, '/api/update/settings', { auto: false }, offGood)).status, 403)
        const ro = await serve((port) =>
          createPanelHandler({
            runtime: () => createRuntime({ env, builtins: [asBuiltin(demoPlugin(demoFamily({})))] }),
            allowedHosts: [`127.0.0.1:${port}`],
            readOnly: true,
          }),
        )
        try {
          const roGood = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
          assert.equal((await post(ro.port, '/api/update', {}, roGood)).status, 403)
        } finally {
          await close(ro.server)
        }
      } finally {
        unbind()
        await close(on.server)
        await close(off.server)
      }
    })
  })

  it('offers the switch between a kept Local Build and npm, and switches through /api/local (ADR-0024)', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const { bindUpdateDeps } = await import('../core/update.ts')
      const { globalPkg, pkgDir, devDir } = await import('../core/local-build.ts')
      const { SIDEBY_NO_UPDATE_NOTIFIER: _off, ...env } = h.env
      const d = { dev: devDir(env), prefix: h.path('.npm-global') }
      const pkgAt = async (dir: string, build: object) => {
        await mkdir(join(dir, 'dist'), { recursive: true })
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sideby', version: '0.15.0' }))
        await writeFile(join(dir, 'dist', 'build.json'), JSON.stringify(build))
      }
      await pkgAt(globalPkg(d), { id: 'npm' })
      const execs: string[] = []
      const unbind = bindUpdateDeps({
        fetch: (async () => new Response(JSON.stringify({ latest: '0.15.0' }))) as typeof fetch,
        packageDir: async () => globalPkg(d),
        writable: async () => true,
        exec: async (file, args) => {
          execs.push([file, ...args].join(' '))
          return { code: 0, output: '' }
        },
      })
      const on = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env, builtins: [asBuiltin(demoPlugin(demoFamily({})))] }),
          allowedHosts: [`127.0.0.1:${port}`],
        }),
      )
      const state = async () =>
        JSON.parse(
          (await request(on.port, 'GET', '/api/state', { host: `127.0.0.1:${on.port}` })).text,
        ) as PanelState
      try {
        // A plain npm install with no Local Build sees nothing of it.
        assert.equal((await state()).update?.localSwitch, undefined)
        await pkgAt(pkgDir(d), {
          id: 'l1',
          local: true,
          commit: 'abc1234',
          dirty: false,
          builtAt: '2026-10-17T12:00:00Z',
        })
        const s = (await state()).update?.localSwitch
        assert.equal(s?.running, 'npm')
        assert.equal(s?.local?.commit, 'abc1234')
        const good = { origin: `http://127.0.0.1:${on.port}`, 'x-sideby-token': on.handler.token }
        assert.equal((await post(on.port, '/api/local', { to: 'dev' }, good)).status, 400)
        const r = await post(on.port, '/api/local', { to: 'local', confirm: true }, good)
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.deepEqual([r.body.switched, r.body.running], [true, 'local'])
        assert.equal(await readlink(globalPkg(d)), pkgDir(d))
        assert.deepEqual(execs, [], 'an npm install knows its prefix; no npm call')
      } finally {
        unbind()
        await close(on.server)
      }
    })
  })
})

describe('Browser Sign-ins in the Panel (spec §3.24)', () => {
  it('shows the switch off without reading the browser, writes config only on confirm, and refuses opening when read-only', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write(
        '.claude.json',
        '{"oauthAccount":{"accountUuid":"11111111-2222-4333-8444-555555555555"}}\n',
        0o600,
      )
      const { claudePlugin } = await import('../families/claude/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const config = h.path('.config/sideby/config.json')
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/browser/open', { account: 'claude:main' }, hdr)).status, 403)
        assert.equal(
          (await post(ro.port, '/api/browser/settings', { enabled: true, confirm: true }, hdr)).status,
          403,
        )
      } finally {
        await close(ro.server)
      }
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        )
        assert.deepEqual(
          [state.browser.enabled, state.browser.profiles, state.browser.families],
          [false, [], { matched: ['claude'], openOnly: [] }],
        )
        assert.ok(!JSON.stringify(state).includes('11111111-2222'))
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const plan = await post(port, '/api/browser/settings', { enabled: true }, hdr)
        assert.deepEqual([plan.body.changed, plan.body.applied], [true, false])
        await assert.rejects(readFile(config, 'utf8'))
        const done = await post(port, '/api/browser/settings', { enabled: true, confirm: true }, hdr)
        assert.equal(done.body.applied, true)
        assert.equal(JSON.parse(await readFile(config, 'utf8')).browser.signIns, true)
      } finally {
        await close(server)
      }
    })
  })
})

describe('display order and quota checks (spec §3.25, §3.26)', () => {
  it('writes and removes `display`, refuses a bad body and a read-only Panel, and switches Grok checks', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/auth.json', '{}', 0o600)
      await h.write('.grok/config.toml', '')
      const { grokPlugin } = await import('../families/grok/index.ts')
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(grokPlugin)] })
      const config = h.path('.config/sideby/config.json')
      const ro = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`], readOnly: true }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${ro.port}`,
          origin: `http://127.0.0.1:${ro.port}`,
          'x-sideby-token': ro.handler.token,
        }
        assert.equal((await post(ro.port, '/api/display-order', { display: null }, hdr)).status, 403)
        assert.equal((await post(ro.port, '/api/quota/refresh', {}, hdr)).status, 403)
        assert.equal(
          (await post(ro.port, '/api/quota/check', { family: 'grok', on: false }, hdr)).status,
          403,
        )
      } finally {
        await close(ro.server)
      }
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({ runtime, allowedHosts: [`127.0.0.1:${p}`] }),
      )
      try {
        const hdr = {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        }
        const state = JSON.parse(
          (await request(port, 'GET', '/api/state', { host: `127.0.0.1:${port}` })).text,
        )
        assert.deepEqual(state.display, {})
        assert.deepEqual(
          state.quotaChecks.map((c: { family: string; on: boolean }) => [c.family, c.on]),
          [['grok', true]],
        )
        const set = await post(
          port,
          '/api/display-order',
          { display: { families: ['grok'], accounts: { grok: ['main'] } } },
          hdr,
        )
        assert.equal(set.status, 200)
        assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).display, {
          families: ['grok'],
          accounts: { grok: ['main'] },
        })
        const pin = await post(port, '/api/display-order', { display: { pinned: { grok: ['main'] } } }, hdr)
        assert.equal(pin.status, 200)
        assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).display, { pinned: { grok: ['main'] } })
        for (const bad of [
          { display: { families: 'grok' } },
          { display: { rows: [] } },
          { display: [] },
          { display: { pinned: ['main'] } },
          { display: { pinned: { grok: [1] } } },
          {},
        ])
          assert.equal((await post(port, '/api/display-order', bad, hdr)).status, 400, JSON.stringify(bad))
        assert.equal((await post(port, '/api/display-order', { display: null }, hdr)).status, 200)
        assert.equal(JSON.parse(await readFile(config, 'utf8')).display, undefined)
        const off = await post(port, '/api/quota/check', { family: 'grok', on: false }, hdr)
        assert.deepEqual([off.status, off.body.changed], [200, true])
        assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).quota, { check: { grok: false } })
        assert.equal((await post(port, '/api/quota/check', { family: 'nope', on: false }, hdr)).status, 400)
      } finally {
        await close(server)
      }
    })
  })
})
