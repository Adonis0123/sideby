// WHY: HTTP route and embedded client-script tests for `/runs`, `/runs/<id>`, `/api/runs*`, outward asks, 200->404->200 recovery, live resync, and >50 closed runs.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { withFakeHome } from '../../testing/index.ts'
import type { LiveSession } from '../core/live-sessions.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, LIVE_SESSIONS_SOURCE, PANEL_VIEW } from './handler.ts'

function httpReq(
  port: number,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (d: Buffer) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function serve(make: (port: number) => ReturnType<typeof createPanelHandler>) {
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => void handler!(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  handler = make(port)
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function extractInlineScript(html: string): string {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m?.[1], 'page includes inline nonce script')
  return m[1]
}

describe('Panel Live Run Board routes', () => {
  it('serves /runs, /runs/<id>, /api/runs*, CSP headers, /api/health untouched, 404 on missing/corrupt run.json, and 200 on 51st closed run via HEAD', async () => {
    await withFakeHome(async (h) => {
      const runDir = join(h.home, 'proj/.agent-dispatch/runs/demo-run')
      const missingRunDir = join(h.home, 'proj/.agent-dispatch/runs/ghost-run')
      await mkdir(runDir, { recursive: true })
      await mkdir(missingRunDir, { recursive: true })
      await writeFile(
        join(runDir, 'run.json'),
        JSON.stringify({
          id: 'demo-run',
          objective: 'Live panel run',
          state: 'active',
          created_at: '2026-11-26T10:00:00Z',
          updated_at: '2026-11-26T10:05:00Z',
          steps: [{ title: 'Implement routes', state: 'working' }],
          lanes: [{ id: 'l1', title: 'Panel worker', state: 'working' }],
          asks: [{ id: 'A1', state: 'open', question: 'Ready?', recommend: 'Yes' }],
          waits: [],
        }),
      )
      const registry: Record<string, unknown>[] = [
        { id: 'demo-run', dir: runDir, objective: 'Live panel run', state: 'active' },
        { id: 'ghost-run', dir: missingRunDir, objective: 'Missing run.json', state: 'active' },
      ]
      for (let i = 1; i <= 51; i++) {
        const id = `closed-${String(i).padStart(2, '0')}`
        const d = join(h.home, `proj/.agent-dispatch/archive/${id}`)
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, 'run.json'),
          JSON.stringify({
            id,
            objective: `Closed ${id}`,
            state: 'closed',
            updated_at: `2026-11-01T00:${String(i).padStart(2, '0')}:00Z`,
            lanes: [],
            asks: [],
            waits: [],
          }),
        )
        registry.push({ id, dir: d, objective: `Closed ${id}`, state: 'closed' })
      }
      await h.write('.local/state/agent-dispatch/runs.json', JSON.stringify(registry))

      const srv = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env: h.env }),
          allowedHosts: [`127.0.0.1:${port}`],
          [LIVE_SESSIONS_SOURCE]: {
            list: async () => ({ sessions: [], problems: [] }),
          },
        } as Parameters<typeof createPanelHandler>[0]),
      )
      try {
        const idx = await httpReq(srv.port, '/runs')
        assert.equal(idx.status, 200)
        assert.match(String(idx.headers['content-type']), /^text\/html/)
        assert.equal(idx.headers['cache-control'], 'no-store')
        assert.equal(idx.headers['x-content-type-options'], 'nosniff')
        assert.equal(idx.headers['referrer-policy'], 'no-referrer')
        const csp = String(idx.headers['content-security-policy'])
        assert.match(csp, /script-src 'nonce-[^']+'/)
        assert.match(csp, /frame-ancestors 'self'/)

        const page = await httpReq(srv.port, '/runs/demo-run')
        assert.equal(page.status, 200)
        assert.match(page.text, /"runId":"demo-run"/)

        const oldestHead = await httpReq(srv.port, '/runs/closed-01', 'HEAD')
        assert.equal(oldestHead.status, 200)
        assert.match(String(oldestHead.headers['content-type']), /^text\/html/)

        const ghostHead = await httpReq(srv.port, '/runs/ghost-run', 'HEAD')
        assert.equal(ghostHead.status, 404)

        const missingPage = await httpReq(srv.port, '/runs/no-such-run')
        assert.equal(missingPage.status, 404)

        const apiList = await httpReq(srv.port, '/api/runs')
        assert.equal(apiList.status, 200)
        const listBody = JSON.parse(apiList.text) as { runs: { id: string; state: string }[] }
        assert.equal(listBody.runs.filter((r) => r.state === 'closed').length, 50)
        assert.equal(listBody.runs[0]!.id, 'demo-run')

        const apiOne = await httpReq(srv.port, '/api/runs/demo-run')
        assert.equal(apiOne.status, 200)
        const oneBody = JSON.parse(apiOne.text) as { id: string; fingerprint: string; asks: unknown[] }
        assert.equal(oneBody.id, 'demo-run')
        assert.ok(oneBody.fingerprint.length >= 12)
        assert.equal(oneBody.asks.length, 1)

        const ch = await httpReq(srv.port, '/api/runs/demo-run/changes')
        assert.equal(ch.status, 200)
        const chBody = JSON.parse(ch.text) as { seq: number; changed: boolean; watching: boolean }
        assert.equal(typeof chBody.seq, 'number')
        assert.equal(chBody.changed, false)

        if (chBody.watching) {
          const waitNext = httpReq(srv.port, `/api/runs/demo-run/changes?since=${chBody.seq}`)
          await writeFile(
            join(runDir, 'run.json'),
            JSON.stringify({
              id: 'demo-run',
              objective: 'Live panel run updated',
              state: 'active',
              created_at: '2026-11-26T10:00:00Z',
              updated_at: '2026-11-26T10:06:00Z',
              steps: [{ title: 'Implement routes', state: 'done' }],
              lanes: [{ id: 'l1', title: 'Panel worker', state: 'working' }],
              asks: [],
              waits: [],
            }),
          )
          const ch2 = await waitNext
          assert.equal(ch2.status, 200)
          const ch2Body = JSON.parse(ch2.text) as { seq: number; changed: boolean; watching: boolean }
          assert.equal(ch2Body.changed, true)
          assert.ok(ch2Body.seq > chBody.seq)
        }

        const health = await httpReq(srv.port, '/api/health')
        assert.equal(health.status, 200)
        const healthBody = JSON.parse(health.text) as Record<string, unknown>
        assert.equal(healthBody.app, 'sideby')
        assert.equal(typeof healthBody.version, 'string')
      } finally {
        await srv.close()
      }
    })
  })

  it('enforces host, cross-site 403, invalid id 400, missing id 404, and network-view 404 checks', async () => {
    await withFakeHome(async (h) => {
      const srv = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env: h.env }),
          allowedHosts: [`127.0.0.1:${port}`],
          [LIVE_SESSIONS_SOURCE]: { list: async () => ({ sessions: [], problems: [] }) },
        } as Parameters<typeof createPanelHandler>[0]),
      )
      const netSrv = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env: h.env }),
          allowedHosts: [`127.0.0.1:${port}`],
          [PANEL_VIEW]: 'network',
        } as Parameters<typeof createPanelHandler>[0]),
      )
      try {
        assert.equal((await httpReq(srv.port, '/api/runs', 'GET', { host: 'evil.example' })).status, 403)
        assert.equal(
          (await httpReq(srv.port, '/api/runs', 'GET', { 'sec-fetch-site': 'cross-site' })).status,
          403,
        )
        assert.equal(
          (await httpReq(srv.port, '/api/runs/demo-run', 'GET', { 'sec-fetch-site': 'cross-site' })).status,
          403,
        )
        assert.equal(
          (await httpReq(srv.port, '/api/runs/demo-run/changes', 'GET', { 'sec-fetch-site': 'cross-site' }))
            .status,
          403,
        )
        assert.equal((await httpReq(srv.port, '/api/runs/bad!id')).status, 400)
        assert.equal((await httpReq(srv.port, '/runs/bad!id')).status, 400)
        assert.equal((await httpReq(srv.port, '/api/runs/missing-run')).status, 404)
        assert.equal((await httpReq(netSrv.port, '/runs')).status, 404)
        assert.equal((await httpReq(netSrv.port, '/api/runs')).status, 404)
      } finally {
        await srv.close()
        await netSrv.close()
      }
    })
  })

  it('renders full long outward ask details, disables copy when truncated or missing, aligns pre-watch updates, recovers across 200->404->200, and resyncs live sessions', async () => {
    await withFakeHome(async (h) => {
      const runDir = join(h.home, 'proj/.agent-dispatch/runs/live-sync')
      await mkdir(runDir, { recursive: true })
      const longRecipientTail = 'END_LONG_RECIPIENT_LIST'
      const longRecipient = `${'team-member@example.com, '.repeat(14)}${longRecipientTail}`
      const longChannelTail = 'END_LONG_CHANNEL_NAME'
      const longChannel = `${'Release Announcements / '.repeat(10)}${longChannelTail}`
      const longTailMarker = 'END_OF_LONG_OUTWARD_DRAFT_MARKER'
      const longDraft = `${'Draft line for review.\n'.repeat(110)}${longTailMarker}`
      const overLimitRecipient = 'r'.repeat(4200)
      assert.ok(longRecipient.length > 300)
      assert.ok(longChannel.length > 200)
      assert.ok(longDraft.length > 2000)

      const writeRun = (objective: string) =>
        writeFile(
          join(runDir, 'run.json'),
          JSON.stringify({
            id: 'live-sync',
            objective,
            state: 'active',
            created_at: '2026-11-26T10:00:00Z',
            updated_at: '2026-11-26T10:05:00Z',
            lanes: [{ id: 'l1', title: 'Worker', state: 'working', session: 'sess-live-1' }],
            asks: [
              {
                id: 'A1',
                state: 'open',
                question: 'Send release update?',
                recommend: 'Send as drafted',
                outward: true,
                recipient: longRecipient,
                channel: longChannel,
                draft: longDraft,
              },
              {
                id: 'A2',
                state: 'open',
                question: 'Send incomplete notice?',
                recommend: 'Send',
                outward: true,
                channel: 'Chat',
                draft: 'Short draft without recipient',
              },
              {
                id: 'A3',
                state: 'open',
                question: 'Send truncated recipient?',
                recommend: 'Send',
                outward: true,
                recipient: overLimitRecipient,
                channel: 'Email',
                draft: 'Draft text',
              },
            ],
            waits: [],
          }),
        )
      await writeRun('Initial objective')
      await h.write(
        '.local/state/agent-dispatch/runs.json',
        JSON.stringify([{ id: 'live-sync', dir: runDir, objective: 'Initial objective', state: 'active' }]),
      )

      let sessionStatus: LiveSession['status'] = 'busy'
      const srv = await serve((port) =>
        createPanelHandler({
          runtime: () => createRuntime({ env: h.env }),
          allowedHosts: [`127.0.0.1:${port}`],
          [LIVE_SESSIONS_SOURCE]: {
            list: async () => ({
              sessions: [
                {
                  account: 'claude:work',
                  accountLabel: 'cw',
                  family: 'claude',
                  sessionId: 'sess-live-1',
                  title: 'Worker',
                  label: 'cw · Worker · sess-liv',
                  status: sessionStatus,
                  cwd: h.home,
                  guessed: false,
                  transcript: join(h.home, '.claude-work/projects/p/sess-live-1.jsonl'),
                  resumeCommand: 'sideby resume claude -- --resume sess-live-1',
                  reference: 'ref',
                },
              ],
              problems: [],
            }),
          },
        } as Parameters<typeof createPanelHandler>[0]),
      )
      try {
        const page = await httpReq(srv.port, '/runs/live-sync')
        assert.equal(page.status, 200)
        const script = extractInlineScript(page.text).replace(
          '"panelLang":null',
          '"panelLang":"en","resyncMs":35',
        )

        let html = ''
        let patches = 0
        const appEl = {
          get innerHTML() {
            return html
          },
          set innerHTML(v: string) {
            html = v
            patches++
          },
          querySelectorAll: () => [],
          addEventListener: () => {},
        }
        let sawInitialFetch = false
        let mutatedBeforeWatch = false
        let inject404 = false
        let blockWatchResolve: (() => void) | undefined
        const watchHeld = new Promise<void>((r) => {
          blockWatchResolve = r
        })

        const wrappedFetch = async (url: string, init?: RequestInit) => {
          if (url === '/api/runs/live-sync/changes' && !mutatedBeforeWatch) {
            mutatedBeforeWatch = true
            await writeRun('Updated during pre-watch race')
          }
          if (url.startsWith('/api/runs/live-sync/changes?since=')) {
            await watchHeld
            return new Response(JSON.stringify({ seq: 99, changed: false, watching: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (url === '/api/runs/live-sync' && inject404) {
            return new Response(JSON.stringify({ error: 'run not found' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            })
          }
          const res = await fetch(`http://127.0.0.1:${srv.port}${url}`, init)
          if (url === '/api/runs/live-sync') sawInitialFetch = true
          return res
        }

        const win: Record<string, unknown> = {
          scrollX: 0,
          scrollY: 0,
          scrollTo: () => {},
        }
        const ctx = vm.createContext({
          window: win,
          document: {
            visibilityState: 'visible',
            activeElement: null,
            getElementById: (id: string) => (id === 'app' ? appEl : null),
            addEventListener: () => {},
          },
          navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
          fetch: wrappedFetch,
          setInterval,
          clearInterval,
          setTimeout,
          clearTimeout,
          URL,
          Date,
          Promise,
          Set,
        })
        vm.runInContext(script, ctx)

        const waitUntil = async (cond: () => boolean) => {
          for (let i = 0; i < 60; i++) {
            if (cond()) return
            await new Promise((r) => setTimeout(r, 20))
          }
          assert.fail('condition did not become true in time')
        }

        await waitUntil(() => sawInitialFetch && html.includes('Updated during pre-watch race'))
        assert.ok(html.includes(longRecipientTail), 'full >300 char recipient preserved without ellipsis')
        assert.ok(html.includes(longChannelTail), 'full >200 char channel preserved without ellipsis')
        assert.ok(html.includes(longTailMarker), 'full >2000 char draft preserved')
        assert.match(html, /id="copy-ask-A1"[^>]*>Copy recommended reply<\/button>/)
        assert.doesNotMatch(html, /id="copy-ask-A1"[^>]*disabled/)
        assert.match(html, /id="copy-ask-A2"[^>]*disabled/)
        assert.match(html, /id="copy-ask-A3"[^>]*disabled/)

        const patchesStable = patches
        await new Promise((r) => setTimeout(r, 80))
        assert.equal(patches, patchesStable, 'identical fingerprint causes zero DOM redraws')

        inject404 = true
        await waitUntil(() => html.includes('Run not found'))
        inject404 = false
        await waitUntil(() => html.includes('Updated during pre-watch race'))

        sessionStatus = 'needs-you'
        await waitUntil(() => html.includes('pill s-needs-you'))

        ;(win.__SIDEBY_RUNS_STOP__ as () => void)()
        blockWatchResolve?.()
      } finally {
        await srv.close()
      }
    })
  })
})
