import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { NetworkDiagnosis } from '../core/network.ts'
import type { Runtime } from '../runtime.ts'
import { createPanelHandler, PANEL_VIEW, type PanelHandlerOptions } from './handler.ts'
import { PAGE_SCRIPT } from './page-script.ts'

const DIAGNOSIS: NetworkDiagnosis = {
  checkedAt: '2026-11-23T10:00:00.000Z',
  system: {
    warp: { status: 'unavailable', state: 'unknown' },
    proxy: {
      status: 'available',
      pacEnabled: false,
      autoDiscoveryEnabled: false,
      protocols: [
        { protocol: 'http', enabled: true, host: '127.0.0.1', port: 7890 },
        { protocol: 'https', enabled: false },
        { protocol: 'socks', enabled: false },
      ],
    },
    dns: { status: 'available', nameservers: ['192.0.2.53'] },
    route: { status: 'available', interface: 'en0', gateway: '192.0.2.1' },
  },
  localProxyCandidates: [
    { label: 'Clash mixed', protocol: 'HTTP / SOCKS', host: '127.0.0.1', port: 7897, reachable: false },
  ],
  targets: [
    {
      url: 'https://api.example.com',
      proxy: 'http://127.0.0.1:7890',
      guardSupport: 'http-connect',
      listener: { host: '127.0.0.1', port: 7890, reachable: true },
      guard: { status: 'ok', loc: 'US', checkedAt: '2026-11-23T09:00:00.000Z' },
    },
    {
      url: 'https://other.example.com',
      proxy: 'socks5://127.0.0.1:1080',
      guardSupport: 'unsupported',
      listener: null,
      guard: { status: 'not-checked' },
    },
  ],
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.on('data', (d: Buffer) => (text += d))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers as Record<string, unknown> }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function serve(view: 'accounts' | 'network' = 'network') {
  const calls = { diagnose: 0, online: 0 }
  const runtime = {
    config: {},
    networkDiagnose: async () => {
      calls.diagnose++
      return DIAGNOSIS
    },
    networkStatus: async () => {
      calls.online++
      throw new Error('online trace must not run')
    },
  } as unknown as Runtime
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => {
    void handler!(req, res).then((done) => {
      if (!done) res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  handler = createPanelHandler({ runtime, allowedHosts: [host], [PANEL_VIEW]: view } as PanelHandlerOptions)
  const good = {
    host,
    origin: `http://${host}`,
    'x-sideby-token': handler.token,
    'content-type': 'application/json',
  }
  const post = (path: string, body: unknown = {}, headers = good) =>
    request(port, 'POST', path, headers, JSON.stringify(body))
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
  return { port, host, good, post, calls, close }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('network Panel routes', () => {
  it('serves the reusable page with sideby chrome and only the routes it needs', async () => {
    const s = await serve()
    try {
      const page = await request(s.port, 'GET', '/', { host: s.host })
      assert.equal(page.status, 200)
      assert.match(page.text, /<h1>Network<\/h1>/)
      assert.match(page.text, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=[a-f0-9]+">/)
      assert.match(page.text, /<img src="\/favicon\.svg\?v=[a-f0-9]+" alt="">/)
      assert.doesNotMatch(page.text, /\/panel\/favicon\.svg/)
      assert.match(page.text, /"tokenHeader":"x-sideby-token"/)
      assert.match(page.text, /<footer class="foot muted small">sideby<\/footer>/)
      assert.doesNotMatch(page.text, /id="accounts"/)
      assert.match(String(page.headers['content-security-policy']), /default-src 'none'/)
      for (const path of ['/index.html', '/favicon.svg', '/icon.svg', '/api/health', '/api/session'])
        assert.equal((await request(s.port, 'GET', path, { host: s.host })).status, 200, path)
      for (const path of ['/api/state', '/api/themes', '/api/autostart'])
        assert.equal((await request(s.port, 'GET', path, { host: s.host })).status, 404, path)
      for (const path of ['/api/state', '/api/network/settings', '/api/panel/settings', '/api/ask/attach'])
        assert.equal((await s.post(path)).status, 404, path)
      const diagnosed = await s.post('/api/network/diagnose')
      assert.equal(diagnosed.status, 200)
      assert.deepEqual(JSON.parse(diagnosed.text), DIAGNOSIS)
      assert.equal(s.calls.diagnose, 1)
      assert.equal(s.calls.online, 0)
    } finally {
      await s.close()
    }
  })

  it('keeps Host, Origin and token checks on allowed routes', async () => {
    const s = await serve()
    try {
      assert.equal((await request(s.port, 'GET', '/', { host: 'evil.test' })).status, 403)
      assert.equal(
        (await request(s.port, 'GET', '/api/session', { host: s.host, 'sec-fetch-site': 'cross-site' }))
          .status,
        403,
      )
      assert.equal(
        (await s.post('/api/network/diagnose', {}, { ...s.good, origin: 'http://evil.test' })).status,
        403,
      )
      assert.equal(
        (await s.post('/api/network/diagnose', {}, { ...s.good, 'x-sideby-token': 'wrong' })).status,
        403,
      )
      assert.equal(s.calls.diagnose, 0)
    } finally {
      await s.close()
    }
  })

  it('leaves the ordinary accounts view mounted as before', async () => {
    const s = await serve('accounts')
    try {
      assert.equal((await request(s.port, 'GET', '/', { host: s.host })).status, 200)
      assert.notEqual((await request(s.port, 'GET', '/api/state', { host: s.host })).status, 404)
    } finally {
      await s.close()
    }
  })

  it('exports a Portal-loadable network module', async () => {
    const panel = await import('../network/panel.ts')
    assert.equal(typeof panel.createPanelHandler, 'function')
    assert.equal(typeof panel.createRuntime, 'function')
  })
})

describe('accounts Network dialog integration', () => {
  it('does not apply a delayed diagnosis to a reopened dialog', async () => {
    const at = PAGE_SCRIPT.indexOf('  async function netDiagnose()')
    const end = PAGE_SCRIPT.indexOf('\n  // Every change in the dialog applies', at)
    assert.ok(at >= 0 && end > at)
    const source = PAGE_SCRIPT.slice(at, end)
    const pending = deferred<NetworkDiagnosis>()
    const original = { diagnosing: false, diagnosis: null as NetworkDiagnosis | null }
    const ctx: Record<string, unknown> = {
      net: original,
      dlg: { kind: 'net' },
      api: () => pending.promise,
      renderNet: () => {},
      toast: () => {},
      t: (key: string) => key,
    }
    runInNewContext(`${source}; this.run = netDiagnose`, ctx)
    const running = (ctx.run as () => Promise<void>)()
    assert.equal(original.diagnosing, true)
    const reopened = { diagnosing: true, diagnosis: null as NetworkDiagnosis | null }
    ctx.net = reopened
    pending.resolve(DIAGNOSIS)
    await running
    assert.equal(reopened.diagnosis, null)
    assert.equal(reopened.diagnosing, true)
  })
})
