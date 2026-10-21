// The Panel's Session History endpoints (spec §3.33, ADR-0042): reading writes nothing, so a read-only Panel answers;
// paths come back with `~`; bad input is refused with what to do; clearing the index is a write.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin } from '../../testing/demo.ts'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { closeHistory } from '../core/history.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, LIVE_SESSIONS_SOURCE } from './handler.ts'

const SID = 'aaaa1111-0000-4000-8000-000000000001'
const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  const app = await h.mkdir('code/app')
  await h.mkdir('code/app/.git')
  const at = (i: number) => new Date(Date.now() - (10 - i) * 60_000).toISOString()
  const turns: [string, string][] = [
    ['把登录页的按钮改成蓝色', 'Changed the login button to blue.'],
    ['also fix the footer', 'Fixed the footer spacing.'],
  ]
  await h.write(
    `.claude/projects/-code-app/${SID}.jsonl`,
    jsonl(
      turns.flatMap(([q, a], i) => [
        {
          type: 'user',
          sessionId: SID,
          cwd: app,
          entrypoint: 'cli',
          timestamp: at(i),
          message: { content: q },
        },
        {
          type: 'assistant',
          sessionId: SID,
          timestamp: at(i),
          message: { model: 'claude-opus-4-5', content: [{ type: 'text', text: a }] },
        },
      ]),
    ),
  )
}

function post(port: number, path: string, headers: Record<string, string>, body: object) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let text = ''
        res.on('data', (d: Buffer) => (text += d))
        res.on('end', () => {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = JSON.parse(text) as Record<string, unknown>
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function serve(make: (port: number) => ReturnType<typeof createPanelHandler>) {
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => void handler!(req, res))
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

const noLive = { list: async () => ({ sessions: [], problems: [] }) }

describe('panel history endpoints', () => {
  it('lists, searches, opens and scans tool output on a read-only Panel, with `~` paths', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({
          runtime: rt,
          allowedHosts: [`127.0.0.1:${p}`],
          readOnly: true,
          ...{ [LIVE_SESSIONS_SOURCE]: noLive },
        }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        // The first answer may come while the index is still being built; ask until it is in.
        let r = await post(port, '/api/history', hdr, { since: 'all', lang: 'zh' })
        for (let i = 0; i < 100 && (r.body.total as number) === 0; i++) {
          await new Promise((ok) => setTimeout(ok, 30))
          r = await post(port, '/api/history', hdr, { since: 'all', lang: 'zh' })
        }
        assert.equal(r.status, 200, JSON.stringify(r.body))
        const sessions = r.body.sessions as Record<string, string>[]
        assert.equal(sessions.length, 1)
        const s = sessions[0]!
        assert.equal(s.sessionId, SID)
        assert.equal(s.cwd, '~/code/app')
        assert.equal(s.project, '~/code/app')
        // What is pasted (the continue command, the reference for another AI) keeps real paths; what is shown does not.
        const { continueCommand: _cmd, reference: _ref, ...shown } = s
        assert.ok(
          !JSON.stringify({ ...r.body, sessions: [shown] }).includes(h.env.HOME!),
          JSON.stringify(shown),
        )
        assert.ok(s.continueCommand!.includes(join(h.env.HOME!, 'code/app')))

        const found = await post(port, '/api/history', hdr, { q: '登录页', since: 'all' })
        assert.equal((found.body.sessions as unknown[]).length, 1)
        const none = await post(port, '/api/history', hdr, { q: 'nothing-like-this', since: 'all' })
        assert.equal(none.body.total, 0)

        const projects = await post(port, '/api/history/projects', hdr, { since: 'all' })
        assert.deepEqual(
          (projects.body.projects as { project: string }[]).map((p) => p.project),
          ['~/code/app'],
        )
        const byProject = await post(port, '/api/history', hdr, { since: 'all', project: '~/code/app' })
        assert.equal(byProject.body.total, 1)

        const grouped = await post(port, '/api/history', hdr, { since: 'all', group: 'project' })
        assert.deepEqual(
          (grouped.body.groups as { key: string }[]).map((g) => g.key),
          ['~/code/app'],
        )
        const folded = await post(port, '/api/history', hdr, {
          since: 'all',
          group: 'project',
          collapsed: ['~/code/app'],
        })
        assert.equal(folded.body.total, 0)
        assert.equal((folded.body.groups as { collapsed?: boolean }[])[0]?.collapsed, true)
        for (const bad of [{ group: 'week' }, { collapsed: 'x' }, { collapsed: ['x'.repeat(1025)] }]) {
          const r = await post(port, '/api/history', hdr, { since: 'all', ...bad })
          assert.equal(r.status, 400, JSON.stringify(bad))
        }

        const show = await post(port, '/api/history/show', hdr, { id: SID, lang: 'en' })
        assert.equal(show.status, 200, JSON.stringify(show.body))
        const texts = (show.body.messages as { text: string }[]).map((m) => m.text)
        assert.ok(texts.includes('把登录页的按钮改成蓝色'))
        assert.equal((show.body.session as { cwd: string }).cwd, '~/code/app')

        const job = await post(port, '/api/history/tools', hdr, { q: 'footer', since: 'all' })
        assert.equal(job.status, 200, JSON.stringify(job.body))
        assert.equal(typeof job.body.job, 'string')
        const stop = await post(port, '/api/history/tools', hdr, { job: job.body.job, cancel: true })
        assert.equal(stop.body.stopped, true)
        const gone = await post(port, '/api/history/tools', hdr, { job: job.body.job })
        assert.equal(gone.status, 404)
        assert.match(String(gone.body.error), /search again/)
      } finally {
        await close(server)
        await closeHistory(rt)
      }
    })
  })

  it('answers without waiting for a slow list of running sessions, and marks them once it is in', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      const slowLive = {
        list: async () => {
          await gate
          return { sessions: [{ account: 'claude:main', sessionId: SID }], problems: [] }
        },
      }
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({
          runtime: rt,
          allowedHosts: [`127.0.0.1:${p}`],
          readOnly: true,
          ...{ [LIVE_SESSIONS_SOURCE]: slowLive as never },
        }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        let r = await post(port, '/api/history', hdr, { since: 'all' })
        for (let i = 0; i < 100 && (r.body.total as number) === 0; i++) {
          await new Promise((ok) => setTimeout(ok, 30))
          r = await post(port, '/api/history', hdr, { since: 'all' })
        }
        const started = Date.now()
        r = await post(port, '/api/history', hdr, { since: 'all' })
        assert.ok(Date.now() - started < 1_000, 'a search waits for the running sessions')
        assert.equal((r.body.sessions as { live?: boolean }[])[0]?.live, false)
        release()
        await new Promise((ok) => setTimeout(ok, 20))
        r = await post(port, '/api/history', hdr, { since: 'all' })
        assert.equal((r.body.sessions as { live?: boolean }[])[0]?.live, true)
      } finally {
        release()
        await close(server)
        await closeHistory(rt)
      }
    })
  })

  it('refuses bad input with what to do, refuses clearing on a read-only Panel, and keeps the token check', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({
          runtime: rt,
          allowedHosts: [`127.0.0.1:${p}`],
          readOnly: true,
          ...{ [LIVE_SESSIONS_SOURCE]: noLive },
        }),
      )
      try {
        const hdr = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        assert.equal((await post(port, '/api/history', { origin: hdr.origin }, {})).status, 403)
        assert.equal((await post(port, '/api/history', hdr, { since: '3d' })).status, 400)
        assert.equal((await post(port, '/api/history', hdr, { limit: 1000 })).status, 400)
        assert.equal((await post(port, '/api/history/show', hdr, {})).status, 400)
        const empty = await post(port, '/api/history/tools', hdr, { q: '  ' })
        assert.equal(empty.status, 400)
        assert.match(String(empty.body.error), /Type the words/)
        assert.equal((await post(port, '/api/history/index', hdr, { clear: true })).status, 403)
      } finally {
        await close(server)
        await closeHistory(rt)
      }
    })
  })
})
