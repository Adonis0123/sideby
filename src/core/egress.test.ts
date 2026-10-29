// Network Guard's check (spec §3.35, ADR-0053). Every request goes through a fake fetcher or a local socket; no test
// asks the network.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { type AddressInfo, createServer as createTcpServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  blockMessage,
  cacheKey,
  type EgressEntry,
  FRESH_MS,
  fetchTrace,
  judge,
  netPrint,
  parseTrace,
  plan,
  proxyFor,
  refresh,
  STALE_MS,
  verdict,
} from './egress.ts'

const URL_A = 'https://api.anthropic.com/cdn-cgi/trace'
const trace =
  (loc: string, ip = '203.0.113.7') =>
  async () =>
    `fl=1\nh=x\nip=${ip}\nts=1\nloc=${loc}\ncolo=SIN\n`
const at = (ms: number) => () => new Date(ms)
const T0 = Date.parse('2026-10-27T00:00:00Z')

const entry = (o: Partial<EgressEntry> = {}): EgressEntry => ({
  url: URL_A,
  checkedAt: new Date(T0).toISOString(),
  loc: 'US',
  netPrint: 'p1',
  ...o,
})

describe('proxyFor', () => {
  it('takes HTTPS_PROXY first, then ALL_PROXY, and honours NO_PROXY', () => {
    assert.equal(proxyFor(URL_A, {}), null)
    assert.equal(proxyFor(URL_A, { HTTPS_PROXY: 'http://127.0.0.1:7890' }), 'http://127.0.0.1:7890')
    assert.equal(proxyFor(URL_A, { https_proxy: 'http://a:1', ALL_PROXY: 'http://b:2' }), 'http://a:1')
    assert.equal(proxyFor(URL_A, { ALL_PROXY: 'http://b:2' }), 'http://b:2')
    assert.equal(proxyFor(URL_A, { HTTPS_PROXY: 'http://a:1', NO_PROXY: 'localhost,.anthropic.com' }), null)
    assert.equal(proxyFor(URL_A, { HTTPS_PROXY: 'http://a:1', NO_PROXY: 'anthropic.com:443' }), null)
    assert.equal(proxyFor(URL_A, { HTTPS_PROXY: 'http://a:1', NO_PROXY: '*' }), null)
    assert.equal(proxyFor(URL_A, { HTTPS_PROXY: 'http://a:1', NO_PROXY: 'openai.com' }), 'http://a:1')
  })
})

describe('cache key and print', () => {
  it('differs by proxy setting and never holds the proxy in clear', () => {
    const a = cacheKey(URL_A, { HTTPS_PROXY: 'http://user:secret@10.0.0.1:1' })
    assert.notEqual(a, cacheKey(URL_A, {}))
    assert.ok(!a.includes('secret'))
  })
  it('changes with the interfaces and ignores loopback', () => {
    const i = (addr: string) =>
      ({
        en0: [{ address: addr, internal: false }],
        lo0: [{ address: '127.0.0.1', internal: true }],
      }) as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    assert.equal(
      netPrint(() => i('10.0.0.2')),
      netPrint(() => i('10.0.0.2')),
    )
    assert.notEqual(
      netPrint(() => i('10.0.0.2')),
      netPrint(() => i('10.0.0.3')),
    )
  })
})

describe('parseTrace and judge', () => {
  it('reads ip and a two-letter loc only', async () => {
    assert.deepEqual(parseTrace(await trace('SG')()), { ip: '203.0.113.7', loc: 'SG' })
    assert.deepEqual(parseTrace('loc=XX1\n'), {})
  })
  it('blocks a country outside the list and cannot tell without one', () => {
    assert.equal(judge(entry(), ['US']), 'ok')
    assert.equal(judge(entry({ loc: 'HK' }), ['US', 'JP']), 'blocked')
    const { loc: _, ...none } = entry()
    assert.equal(judge(none, ['US']), 'unknown')
  })
})

describe('plan: when to ask', () => {
  const e = entry()
  it('uses a result up to 60 seconds old at every moment', () => {
    for (const m of ['launch', 'prompt', 'tool'] as const)
      assert.equal(plan(e, ['US'], m, T0 + FRESH_MS, 'p1'), 'use')
  })
  it('between 60 seconds and 5 minutes refreshes in the background only for a tool call', () => {
    const t = T0 + FRESH_MS + 1
    assert.equal(plan(e, ['US'], 'tool', t, 'p1'), 'refresh')
    assert.equal(plan(e, ['US'], 'tool', T0 + STALE_MS, 'p1'), 'refresh')
    assert.equal(plan(e, ['US'], 'prompt', t, 'p1'), 'check')
    assert.equal(plan(e, ['US'], 'launch', t, 'p1'), 'check')
  })
  it('asks now beyond 5 minutes, after a failed result, after a network change and without a result', () => {
    assert.equal(plan(e, ['US'], 'tool', T0 + STALE_MS + 1, 'p1'), 'check')
    assert.equal(plan(entry({ loc: 'HK' }), ['US'], 'tool', T0, 'p1'), 'check')
    assert.equal(plan(e, ['US'], 'tool', T0, 'p2'), 'check')
    assert.equal(plan(null, ['US'], 'tool', T0, 'p1'), 'check')
    assert.equal(plan(e, ['US'], 'tool', T0 - 1, 'p1'), 'check', 'a result from the future is not trusted')
  })
})

describe('verdict and refresh', () => {
  it('asks once, keeps country and an address hash only, then answers from the cache', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      let calls = 0
      const fetcher = async () => {
        calls++
        return trace('US')()
      }
      const o = { url: URL_A, env: {}, allow: ['US'], dir, moment: 'prompt' as const, fetcher, print: 'p1' }
      const v1 = await verdict({ ...o, now: at(T0) })
      assert.equal(v1.status, 'ok')
      assert.equal(v1.fresh, true)
      const v2 = await verdict({ ...o, now: at(T0 + 1000) })
      assert.equal(v2.fresh, false)
      assert.equal(calls, 1)
      const [file] = await readdir(dir)
      const text = await readFile(join(dir, file!), 'utf8')
      assert.ok(!text.includes('203.0.113.7'), 'the address is never kept')
      assert.match(text, /"loc":"US"/)
    })
  })

  it('starts a background refresh for a tool call in the middle tier and still answers', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      await refresh({ url: URL_A, env: {}, dir, fetcher: trace('US'), print: 'p1', now: at(T0) })
      let started = 0
      const v = await verdict({
        url: URL_A,
        env: {},
        allow: ['US'],
        dir,
        moment: 'tool',
        fetcher: async () => assert.fail('no request in this tier'),
        print: 'p1',
        now: at(T0 + FRESH_MS + 5),
        background: () => started++,
      })
      assert.equal(v.status, 'ok')
      assert.equal(started, 1)
    })
  })

  it('cannot tell when the request fails, and says why without the proxy', async () => {
    await withFakeHome(async (h) => {
      const v = await verdict({
        url: URL_A,
        env: { HTTPS_PROXY: 'http://user:secret@127.0.0.1:9' },
        allow: ['US'],
        dir: h.path('state'),
        moment: 'launch',
        fetcher: async () => {
          throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
        },
        print: 'p1',
      })
      assert.equal(v.status, 'unknown')
      assert.equal(v.attempts, 1, 'before a Launch one request decides')
      assert.match(v.entry.error ?? '', /refused/)
      assert.ok(!JSON.stringify(v).includes('secret'))
    })
  })

  it('notes an address change and keeps the time', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const o = { url: URL_A, env: {}, dir, print: 'p1' }
      const a = await refresh({ ...o, fetcher: trace('US', '198.51.100.1'), now: at(T0) })
      assert.equal(a.ipChanged, false)
      const b = await refresh({ ...o, fetcher: trace('US', '198.51.100.2'), now: at(T0 + 1) })
      assert.equal(b.ipChanged, true)
      assert.equal(b.entry.ipChangedAt, new Date(T0 + 1).toISOString())
      const c = await refresh({ ...o, fetcher: trace('US', '198.51.100.2'), now: at(T0 + 2) })
      assert.equal(c.ipChanged, false)
      assert.equal(c.entry.ipChangedAt, new Date(T0 + 1).toISOString())
    })
  })
})

describe('fetchTrace', () => {
  it('goes through an http proxy with CONNECT and reports its refusal', async () => {
    const seen: string[] = []
    const server = createServer()
    server.on('connect', (req, socket) => {
      seen.push(req.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      await assert.rejects(
        fetchTrace(URL_A, { HTTPS_PROXY: `http://127.0.0.1:${port}` }, 3000),
        /the proxy answered 403/,
      )
      assert.deepEqual(seen, ['api.anthropic.com:443'])
    } finally {
      server.close()
    }
  })
  // A proxy that accepts and then says nothing, before or after the tunnel opens: the timeout must close the client's
  // socket, or the leftover handle keeps `network-hook` alive past the Host's hook timeout.
  for (const stage of ['before the tunnel', 'inside the tunnel'] as const) {
    it(`closes its connection on a timeout when the proxy goes silent ${stage}`, async () => {
      let closed!: () => void
      const gone = new Promise<void>((r) => {
        closed = r
      })
      const held: Socket[] = []
      const server = createTcpServer((socket) => {
        held.push(socket)
        socket.resume() // read, so the client's end of the connection is seen
        socket.on('error', () => {})
        socket.on('close', () => closed())
        if (stage === 'inside the tunnel')
          socket.once('data', () => socket.write('HTTP/1.1 200 Connection established\r\n\r\n'))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as AddressInfo).port
      try {
        const t0 = Date.now()
        await assert.rejects(fetchTrace(URL_A, { HTTPS_PROXY: `http://127.0.0.1:${port}` }, 150), /timeout/)
        let wait: NodeJS.Timeout | undefined
        const stillOpen = new Promise((_, no) => {
          wait = setTimeout(() => no(new Error('the client socket is still open')), 1000)
        })
        await Promise.race([gone, stillOpen])
        clearTimeout(wait)
        assert.ok(Date.now() - t0 < 1500)
      } finally {
        for (const s of held) s.destroy()
        server.close()
      }
    })
  }
  it('refuses a proxy kind it cannot speak', async () => {
    await assert.rejects(fetchTrace(URL_A, { ALL_PROXY: 'socks5://127.0.0.1:1080' }, 3000), /socks5 proxy/)
  })
})

describe('blockMessage', () => {
  const v = { status: 'blocked' as const, entry: entry({ loc: 'HK' }) }
  it('says what happened, why and what to do, in Chinese or English', () => {
    const zh = blockMessage(v, ['US', 'JP'], { ref: 'cc008', at: 'prompt', zh: true })
    assert.match(zh, /香港（HK）/)
    assert.match(zh, /美国（US）、日本（JP）/)
    assert.match(zh, /重新发送这条消息/)
    assert.match(zh, /sideby run cc008 --ignore-network/)
    const en = blockMessage(v, ['US'], { ref: 'cc008', at: 'launch', zh: false })
    assert.match(en, /exits in HK/)
    assert.match(en, /start again/)
  })
  it('says it could not tell when there is no country', () => {
    const { loc: _, ...none } = entry({ error: 'no answer within 3 seconds' })
    const zh = blockMessage({ status: 'unknown', entry: none }, ['US'], { at: 'tool', zh: true })
    assert.match(zh, /没能确认网络出口（3 秒内没有回应）/)
    const tried = { status: 'unknown' as const, entry: none, attempts: 5, triedMs: 29_600 }
    const en = blockMessage(tried, ['US'], { at: 'prompt', zh: false })
    assert.match(
      en,
      /could not tell this network's exit after 5 tries in about 30 s \(no answer within 3 seconds\)/,
    )
  })
})
