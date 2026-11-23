import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { NetworkDiagnosis } from '../core/network.ts'
import { NETWORK_PAGE_SCRIPT, networkPageController } from '../network/page-script.ts'
import type { Runtime } from '../runtime.ts'
import { createPanelHandler, PANEL_VIEW, type PanelHandlerOptions } from './handler.ts'
import { networkDiagnoseTaskFacts } from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'

const DIAGNOSIS: NetworkDiagnosis = {
  checkedAt: '2026-11-23T10:00:00.000Z',
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
  return { port, host, good, post, calls, close, handler: handler! }
}

async function controller(api: (path: string, body: unknown) => Promise<unknown>) {
  const ctx: { make?: typeof networkPageController } = {}
  runInNewContext(`${networkPageController.toString()}; this.make = networkPageController`, ctx)
  return ctx.make!({ api, facts: networkDiagnoseTaskFacts, version: '1.2.3', lang: 'en' })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('network Panel routes', () => {
  it('serves its own page and only the routes it needs', async () => {
    const s = await serve()
    try {
      const page = await request(s.port, 'GET', '/', { host: s.host })
      assert.equal(page.status, 200)
      assert.match(page.text, /Network connection/)
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
      // The old view still owns its state route; this fake deliberately fails after route selection.
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

describe('network Panel behaviour', () => {
  it('starts with offline diagnosis only and renders empty and error states', async () => {
    const paths: string[] = []
    const c = await controller(async (path) => {
      paths.push(path)
      if (path === '/api/network/diagnose') return { checkedAt: DIAGNOSIS.checkedAt, targets: [] }
      throw new Error(`unexpected ${path}`)
    })
    await c.start()
    assert.deepEqual(paths, ['/api/network/diagnose'])
    assert.deepEqual(c.state.diagnosis!.targets, [])
    const failed = await controller(async () => {
      throw new Error('offline failed')
    })
    await failed.start()
    assert.equal(failed.state.error, 'offline failed')
  })

  it('clears the target-list busy state after the first diagnosis completes', () => {
    const start = NETWORK_PAGE_SCRIPT.indexOf('function renderMain()')
    const end = NETWORK_PAGE_SCRIPT.indexOf('function renderAsk()', start)
    const source = NETWORK_PAGE_SCRIPT.slice(start, end)
    const element = () => ({
      attrs: {} as Record<string, string>,
      children: [] as unknown[],
      textContent: '',
      hidden: false,
      disabled: false,
      append(...children: unknown[]) {
        this.children.push(...children)
      },
      setAttribute(name: string, value: string) {
        this.attrs[name] = value
      },
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const targets = element()
    targets.attrs['aria-busy'] = 'true'
    elements.set('targets', targets)
    const state: { diagnosis: NetworkDiagnosis | null; loading: boolean } = { diagnosis: null, loading: true }
    const ctx: { render?: () => void } = {}
    Object.assign(ctx, {
      BOOT: { lang: 'zh' },
      lang: 'zh',
      controller: { state },
      document: { documentElement: {}, title: '' },
      $: (id: string) => {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      t: (key: string) => key,
      h: () => ({}),
      targetCard: () => ({}),
      clear: (el: ReturnType<typeof element>) => {
        el.children = []
      },
    })
    runInNewContext(`${source}; this.render = renderMain`, ctx)
    ctx.render!()
    assert.equal(targets.attrs['aria-busy'], 'true')
    state.diagnosis = { checkedAt: DIAGNOSIS.checkedAt, targets: [] }
    state.loading = false
    ctx.render!()
    assert.equal(targets.attrs['aria-busy'], 'false')
  })

  it('shows the actual prompt and sends only fixed redacted facts', async () => {
    const bodies: unknown[] = []
    const c = await controller(async (path, body) => {
      bodies.push(body)
      if (path === '/api/network/diagnose') return DIAGNOSIS
      if (path === '/api/ask/prompt') return { prompt: 'actual complete prompt\nline two' }
      throw new Error(`unexpected ${path}`)
    })
    await c.start()
    await c.openAsk()
    assert.equal(c.state.ask!.prompt, 'actual complete prompt\nline two')
    const body = bodies[1] as Record<string, unknown>
    assert.equal(body.task, 'network-diagnose')
    assert.equal(body.text, undefined)
    assert.equal(body.attachments, undefined)
    assert.equal(body.account, undefined)
    assert.equal(body.family, undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(body.context)), {
      networkDiagnose: networkDiagnoseTaskFacts(DIAGNOSIS),
      version: '1.2.3',
    })
    assert.equal(JSON.stringify(body).includes('password'), false)
  })

  it('requires confirmation again when the second prompt differs', async () => {
    let prompts = 0
    let asks = 0
    const bodies: unknown[] = []
    const c = await controller(async (path, body) => {
      if (path === '/api/network/diagnose') return DIAGNOSIS
      if (path === '/api/ask/prompt') {
        bodies.push(body)
        prompts++
        return { prompt: prompts === 1 ? 'first prompt' : 'changed prompt' }
      }
      if (path === '/api/ask') {
        asks++
        return { opened: true }
      }
      throw new Error(`unexpected ${path}`)
    })
    await c.start()
    await c.openAsk()
    await c.confirmAsk()
    assert.equal(asks, 0)
    assert.equal(c.state.ask!.prompt, 'changed prompt')
    assert.equal(c.state.ask!.promptChanged, true)
    assert.deepEqual(bodies[0], bodies[1])
  })

  it('does not apply a delayed accounts diagnosis to a reopened dialog', async () => {
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

  it('does not call ask when the dialog closes during the delayed second check', async () => {
    let prompts = 0
    let asks = 0
    const second = deferred<{ prompt: string }>()
    const c = await controller(async (path) => {
      if (path === '/api/network/diagnose') return DIAGNOSIS
      if (path === '/api/ask/prompt') {
        prompts++
        return prompts === 1 ? { prompt: 'same prompt' } : second.promise
      }
      if (path === '/api/ask') {
        asks++
        return { opened: true }
      }
      throw new Error(`unexpected ${path}`)
    })
    await c.start()
    await c.openAsk()
    const confirming = c.confirmAsk()
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(prompts, 2)
    c.closeAsk()
    second.resolve({ prompt: 'same prompt' })
    await confirming
    assert.equal(asks, 0)
    assert.equal(c.state.ask, null)
  })
})
