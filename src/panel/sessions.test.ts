// The Sessions page's endpoint (spec §3.32): Live Sessions with their copy texts, behind the Panel's usual checks.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { withFakeHome } from '../../testing/index.ts'
import type { LiveSession, SessionCopyAs } from '../core/live-sessions.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, LIVE_SESSIONS_SOURCE, type PanelSession } from './handler.ts'
import type { OrcaDeps } from './orca.ts'

function session(home: string, over: Partial<LiveSession> = {}): LiveSession {
  return {
    account: 'demo:work',
    accountLabel: 'dw',
    family: 'demo',
    sessionId: '61230c3d-0000-4000-8000-000000000001',
    title: 'knip cleanup',
    label: 'dw · knip cleanup · 61230c3d',
    status: 'busy',
    cwd: join(home, 'code/app'),
    guessed: false,
    transcript: join(home, '.demo-work/sessions/61230c3d.jsonl'),
    resumeCommand: 'sideby resume claude -- --resume 61230c3d-0000-4000-8000-000000000001',
    reference: "dw's session 61230c3d (knip cleanup).",
    ...over,
  }
}

/** An Orca that is not installed; the endpoint must never reach the real one in a test. */
const noOrca: OrcaDeps = {
  run: async () => {
    throw new Error('Orca is not installed')
  },
  envVar: async () => undefined,
}

/** An Orca whose live terminals are `handles`, and processes whose ORCA_TERMINAL_HANDLE is `envs[pid]`. */
function fakeOrca(
  handles: string[],
  envs: Record<number, string>,
  switchAnswer: { exitCode: number; stdout: string } | Error = { exitCode: 0, stdout: '{"ok":true}' },
) {
  const calls: string[][] = []
  const deps: OrcaDeps = {
    async run(args) {
      calls.push(args)
      if (args[1] === 'list')
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminals: handles.map((handle) => ({ handle, connected: true })) },
          }),
        }
      if (switchAnswer instanceof Error) throw switchAnswer
      return switchAnswer
    },
    envVar: async (pid, name) => (name === 'ORCA_TERMINAL_HANDLE' ? envs[pid] : undefined),
  }
  return { deps, calls }
}

const fakeCopy = (s: LiveSession, as: SessionCopyAs, lang: 'en' | 'zh') =>
  as === 'id' ? s.sessionId : as === 'resume' ? s.resumeCommand : `${lang}:${s.label}`

function request(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'POST',
  body: object = { lang: 'zh' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = ''
        res.on('data', (d: Buffer) => (text += d))
        res.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(text) as Record<string, unknown>
          } catch {}
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end(method === 'POST' ? JSON.stringify(body) : undefined)
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

describe('panel sessions endpoint', () => {
  it('returns Live Sessions with their copy texts in the asked language, and keeps the token and Host checks', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
      const home = h.env.HOME!
      const list = async () => ({
        sessions: [session(home), session(home, { sessionId: 'abc', cwd: undefined, guessed: true })],
        problems: [`codex: cannot read ${home}/.codex/sessions`],
      })
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({
          runtime,
          allowedHosts: [`127.0.0.1:${p}`],
          readOnly: true,
          ...{ [LIVE_SESSIONS_SOURCE]: { list, copyText: fakeCopy, orca: noOrca } },
        }),
      )
      try {
        const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const r = await request(port, '/api/sessions', good)
        // Reading sessions writes nothing, so a read-only Panel answers too.
        assert.equal(r.status, 200, JSON.stringify(r.body))
        const sessions = r.body.sessions as PanelSession[]
        assert.equal(sessions.length, 2)
        assert.equal(sessions[0]!.cwd, '~/code/app')
        assert.deepEqual(sessions[0]!.copy, {
          reference: 'zh:dw · knip cleanup · 61230c3d',
          id: '61230c3d-0000-4000-8000-000000000001',
          resume: 'sideby resume claude -- --resume 61230c3d-0000-4000-8000-000000000001',
        })
        assert.equal(sessions[0]!.orca, undefined, 'no Orca, no jump')
        assert.equal(sessions[1]!.cwd, undefined)
        assert.equal(sessions[1]!.guessed, true)
        assert.deepEqual(r.body.problems, ['codex: cannot read ~/.codex/sessions'])

        assert.equal((await request(port, '/api/sessions', { origin: good.origin })).status, 403)
        const stale = await request(port, '/api/sessions', { ...good, 'x-sideby-token': 'nope' })
        assert.equal(stale.status, 403)
        assert.equal(stale.body.code, 'bad-token')
        assert.equal(
          (await request(port, '/api/sessions', { ...good, origin: 'http://evil.example' })).status,
          403,
        )
        assert.equal((await request(port, '/api/sessions', { ...good, host: 'evil.example:80' })).status, 403)
        assert.equal((await request(port, '/api/sessions', {}, 'GET')).status, 405)
      } finally {
        await close(server)
      }
    })
  })

  it('adds the Run a Session works for and opens its board from the index only, never in a read-only Panel', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const sid = '61230c3d-0000-4000-8000-000000000001'
      const board = await h.write('.local/state/agent-dispatch/boards/r1.html', '<!doctype html>\n', 0o600)
      await h.write(
        '.local/state/agent-dispatch/session-index.json',
        JSON.stringify({
          schemaVersion: 1,
          revision: 3,
          generatedAt: '2026-10-20T07:00:00Z',
          sessions: {
            [sid]: {
              entries: [
                {
                  run: 'r1',
                  runTitle: 'Run board',
                  board,
                  lane: 'D2',
                  laneTitle: 'sideby link',
                  role: 'write',
                  url: `file://${board}#lane-D2`,
                },
              ],
            },
          },
        }),
      )
      const calls: string[][] = []
      const exec = async (cmd: string, args: readonly string[]) => {
        calls.push([cmd, ...args])
        return { code: 0, stdout: '', stderr: '' }
      }
      const runtime = () =>
        createRuntime({
          env: h.env,
          builtins: [asBuiltin(demoPlugin(demoFamily()))],
          desktop: { platform: 'darwin', exec },
        })
      const home = h.env.HOME!
      const list = async () => ({
        sessions: [session(home), session(home, { sessionId: 'abc' })],
        problems: [],
      })
      const panel = (readOnly: boolean) =>
        serve((p) =>
          createPanelHandler({
            runtime,
            allowedHosts: [`127.0.0.1:${p}`],
            readOnly,
            ...{ [LIVE_SESSIONS_SOURCE]: { list, copyText: fakeCopy, orca: noOrca } },
          }),
        )
      const ro = await panel(true)
      try {
        const good = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
        const r = await request(ro.port, '/api/sessions', good)
        assert.equal(r.status, 200, JSON.stringify(r.body))
        const sessions = r.body.sessions as PanelSession[]
        assert.deepEqual(sessions[0]!.run, {
          title: 'Run board',
          laneTitle: 'sideby link',
          role: 'write',
          board: '~/.local/state/agent-dispatch/boards/r1.html',
          url: `file://${board}#lane-D2`,
        })
        assert.equal(sessions[1]!.run, undefined)
        // Opening starts a program: a read-only Panel refuses it.
        assert.equal(
          (await request(ro.port, '/api/sessions/run', good, 'POST', { sessionId: sid })).status,
          403,
        )
        assert.equal((await request(ro.port, '/api/sessions', { origin: good.origin })).status, 403)
      } finally {
        await close(ro.server)
      }
      const rw = await panel(false)
      try {
        const good = { origin: `http://127.0.0.1:${rw.port}`, 'x-sideby-token': rw.handler.token }
        // A path from the page is ignored: the board comes from the index.
        const r = await request(rw.port, '/api/sessions/run', good, 'POST', {
          sessionId: sid,
          board: '/etc/hosts',
        })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.deepEqual(calls, [['/usr/bin/open', board]])
        const none = await request(rw.port, '/api/sessions/run', good, 'POST', { sessionId: 'abc' })
        assert.notEqual(none.status, 200)
        assert.equal(none.body.code, 'no-run')
        assert.equal((await request(rw.port, '/api/sessions/run', good, 'POST', {})).status, 400)
        assert.equal(
          (
            await request(rw.port, '/api/sessions/run', { ...good, 'x-sideby-token': 'nope' }, 'POST', {
              sessionId: sid,
            })
          ).status,
          403,
        )
        assert.equal(calls.length, 1)
      } finally {
        await close(rw.server)
      }
    })
  })

  it('answers a failed read with an error the page can show', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
      const list = async () => {
        throw new Error('ps failed')
      }
      const { server, port, handler } = await serve((p) =>
        createPanelHandler({
          runtime,
          allowedHosts: [`127.0.0.1:${p}`],
          ...{ [LIVE_SESSIONS_SOURCE]: { list, copyText: fakeCopy, orca: noOrca } },
        }),
      )
      try {
        const r = await request(port, '/api/sessions', {
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler.token,
        })
        assert.equal(r.status, 500)
        assert.equal(r.body.error, 'ps failed')
      } finally {
        await close(server)
      }
    })
  })

  it('offers the Orca tab only for a Session whose process runs in a live Orca terminal, and switches to it', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
      const home = h.env.HOME!
      const list = async () => ({
        sessions: [
          session(home, { sessionId: 'in-orca', pid: 101 }),
          session(home, { sessionId: 'stale-handle', pid: 102 }),
          session(home, { sessionId: 'no-pid', guessed: true }),
        ],
        problems: [],
      })
      const orca = fakeOrca(['term_a', 'term_other'], { 101: 'term_a', 102: 'term_gone' })
      const make = (readOnly: boolean) => (p: number) =>
        createPanelHandler({
          runtime,
          allowedHosts: [`127.0.0.1:${p}`],
          readOnly,
          ...{ [LIVE_SESSIONS_SOURCE]: { list, copyText: fakeCopy, orca: orca.deps } },
        })
      const { server, port, handler } = await serve(make(false))
      const ro = await serve(make(true))
      try {
        const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
        const r = await request(port, '/api/sessions', good)
        const byId = Object.fromEntries((r.body.sessions as PanelSession[]).map((x) => [x.sessionId, x.orca]))
        assert.deepEqual(byId, { 'in-orca': true, 'stale-handle': undefined, 'no-pid': undefined })
        assert.ok(!JSON.stringify(r.body).includes('term_a'), 'the handle stays on the server')

        orca.calls.length = 0
        const jump = await request(port, '/api/sessions/orca', good, 'POST', { sessionId: 'in-orca' })
        assert.equal(jump.status, 200, JSON.stringify(jump.body))
        assert.deepEqual(orca.calls.at(-1), ['terminal', 'switch', '--terminal', 'term_a', '--json'])

        const notOrca = await request(port, '/api/sessions/orca', good, 'POST', { sessionId: 'stale-handle' })
        assert.equal(notOrca.status, 409)
        assert.match(String(notOrca.body.error), /refresh the list/)
        assert.equal(
          (await request(port, '/api/sessions/orca', good, 'POST', { sessionId: 'gone' })).status,
          404,
        )
        assert.equal((await request(port, '/api/sessions/orca', good, 'POST', {})).status, 400)
        assert.ok(
          !orca.calls.some((c) => c[1] === 'switch' && c[3] !== 'term_a'),
          'switches only a listed handle',
        )
        assert.equal(
          (
            await request(port, '/api/sessions/orca', { origin: good.origin }, 'POST', {
              sessionId: 'in-orca',
            })
          ).status,
          403,
        )
        const roHdr = { origin: `http://127.0.0.1:${ro.port}`, 'x-sideby-token': ro.handler.token }
        assert.equal(
          (await request(ro.port, '/api/sessions/orca', roHdr, 'POST', { sessionId: 'in-orca' })).status,
          403,
        )
      } finally {
        await close(server)
        await close(ro.server)
      }
    })
  })

  it('answers every failed switch with a fixed message that never carries the handle or what Orca said', async () => {
    const secret = 'term_secret_handle_42'
    const body = (o: unknown) => JSON.stringify(o)
    const cases: [string, { exitCode: number; stdout: string } | Error, RegExp][] = [
      [
        'cannot run',
        new Error(`Command failed: orca terminal switch --terminal ${secret} --json`),
        /not running/,
      ],
      [
        'gone',
        {
          exitCode: 1,
          stdout: body({ ok: false, error: { code: 'terminal_handle_stale', message: secret } }),
        },
        /no longer exists/,
      ],
      [
        'other refusal',
        { exitCode: 1, stdout: body({ ok: false, error: { code: 'boom', message: `bad ${secret}` } }) },
        /did not confirm/,
      ],
      ['ok but failing exit', { exitCode: 1, stdout: body({ ok: true }) }, /did not confirm/],
      ['empty object', { exitCode: 0, stdout: '{}' }, /did not confirm/],
      ['false', { exitCode: 0, stdout: 'false' }, /did not confirm/],
      ['array', { exitCode: 0, stdout: '[]' }, /did not confirm/],
      ['ok as a string', { exitCode: 0, stdout: body({ ok: 'true' }) }, /did not confirm/],
      ['not JSON', { exitCode: 0, stdout: `switched ${secret}` }, /did not confirm/],
    ]
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
      const list = async () => ({ sessions: [session(h.env.HOME!, { pid: 7 })], problems: [] })
      for (const [name, answer, want] of cases) {
        const orca = fakeOrca([secret], { 7: secret }, answer)
        const { server, port, handler } = await serve((p) =>
          createPanelHandler({
            runtime,
            allowedHosts: [`127.0.0.1:${p}`],
            ...{ [LIVE_SESSIONS_SOURCE]: { list, copyText: fakeCopy, orca: orca.deps } },
          }),
        )
        try {
          const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
          const r = await request(port, '/api/sessions/orca', good, 'POST', {
            sessionId: session('').sessionId,
          })
          assert.equal(r.status, 400, name)
          assert.match(String(r.body.error), want, name)
          assert.ok(!JSON.stringify(r.body).includes(secret), `${name}: the handle stays on the server`)
          assert.ok(!/Command failed|boom|bad /.test(String(r.body.error)), `${name}: no Orca output`)
        } finally {
          await close(server)
        }
      }
    })
  })
})
