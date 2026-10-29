// The Unattended page's routes (spec §3.37 "面板"): the status in the Panel state, turning it on and off with the
// request that undoes it, the Schedule written whole, Pending Decisions with the way back to their Session, and the
// Panel's usual checks. Live Sessions come from a fake, so no test reads real processes.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import type { LiveSession } from '../core/live-sessions.ts'
import { addPendingDecision } from '../core/unattended-pending.ts'
import { createRuntime } from '../runtime.ts'
import {
  createPanelHandler,
  LIVE_SESSIONS_SOURCE,
  type PanelState,
  type PanelUnattended,
  type PanelUnattendedChange,
} from './handler.ts'

const LIVE = '7a1c0d2e-0000-4000-8000-00000000a001'
const ENDED = '7a1c0d2e-0000-4000-8000-00000000a002'

function live(home: string): LiveSession {
  return {
    account: 'demo:main',
    accountLabel: 'dm',
    family: 'demo',
    sessionId: LIVE,
    title: 'night run',
    label: 'dm · night run · 7a1c0d2e',
    status: 'busy',
    cwd: join(home, 'code/app'),
    guessed: false,
    resumeCommand: `sideby run demo:main -- --resume ${LIVE}`,
    reference: "dm's session 7a1c0d2e (night run).",
    pid: 101,
  }
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } },
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
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function panel(h: FakeHome, readOnly = false) {
  await seedDemoMain(h.write)
  const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
  const home = h.env.HOME!
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => void handler!(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  handler = createPanelHandler({
    runtime,
    allowedHosts: [`127.0.0.1:${port}`],
    readOnly,
    ...{ [LIVE_SESSIONS_SOURCE]: { list: async () => ({ sessions: [live(home)], problems: [] }) } },
  })
  const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
  const post = (path: string, body: unknown = {}) => call(port, 'POST', path, good, body)
  const state = async () => (await call(port, 'GET', '/api/state', {})).body as unknown as PanelState
  return { server, port, good, post, state, home }
}

const close = (s: Server) =>
  new Promise<void>((r) => {
    s.close(() => r())
    s.closeAllConnections()
  })

const config = async (h: FakeHome) =>
  JSON.parse(await readFile(join(h.env.XDG_CONFIG_HOME ?? h.path('.config'), 'sideby/config.json'), 'utf8'))

describe('the Unattended page (spec §3.37)', () => {
  it('puts the status in the Panel state, for the computer and not for a session the server runs in', async () => {
    await withFakeHome(async (h) => {
      h.env.SIDEBY_UNATTENDED = '1'
      const p = await panel(h)
      try {
        const st = (await p.state()).unattended!
        assert.equal(st.on, false)
        assert.equal(st.reason, 'off')
        assert.equal(st.configured, false)
        assert.deepEqual(st.schedule, [])
        const page = (await p.post('/api/unattended')).body as unknown as PanelUnattended
        assert.equal(page.status.reason, 'off')
        assert.deepEqual(page.pending, [])
      } finally {
        await close(p.server)
      }
    })
  })

  it('turns it on for a chosen time, off again, and gives the request that undoes each', async () => {
    await withFakeHome(async (h) => {
      const p = await panel(h)
      try {
        const before = Date.now()
        const on = (await p.post('/api/unattended/on', { for: '4h' }))
          .body as unknown as PanelUnattendedChange
        assert.equal(on.changed, true)
        assert.equal(on.status.on, true)
        assert.equal(on.status.reason, 'manual')
        const until = Date.parse(on.status.until!)
        assert.ok(until >= before + 4 * 3600_000 - 1000 && until <= Date.now() + 4 * 3600_000 + 1000)
        assert.deepEqual(on.undo, { route: '/api/unattended/off', body: {} })
        assert.equal((await p.state()).unattended!.on, true)
        // A clock time is the next time it is that time, as the page shows it ("tomorrow 07:30" once it has passed).
        const clock = (await p.post('/api/unattended/on', { until: '07:30' }))
          .body as unknown as PanelUnattendedChange
        const at = new Date(Date.parse(clock.status.until!))
        assert.equal(`${at.getHours()}:${at.getMinutes()}`, '7:30')
        assert.ok(at.getTime() > Date.now() && at.getTime() - Date.now() <= 24 * 3600_000)
        const off = (await p.post('/api/unattended/off')).body as unknown as PanelUnattendedChange
        assert.equal(off.status.on, false)
        assert.equal(off.undo?.route, '/api/unattended/on')
        assert.match(String(off.undo?.body.until), /^\d{4}-\d{2}-\d{2}T/)
        // What the CLI refuses, the page is refused too, with the CLI's reason.
        const noSlot = await p.post('/api/unattended/on', { slotEnd: true })
        assert.equal(noSlot.status, 400)
        assert.equal(noSlot.body.code, 'bad-time')
        assert.equal((await p.post('/api/unattended/on', { for: '100h' })).status, 400)
        assert.equal((await p.state()).unattended!.on, false)
      } finally {
        await close(p.server)
      }
    })
  })

  it('writes the whole Schedule, refuses a bad Slot without writing, and returns what was there', async () => {
    await withFakeHome(async (h) => {
      const p = await panel(h)
      try {
        const slot = {
          name: 'Weeknights',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'],
          start: '23:00',
          end: '08:00',
        }
        const r = await p.post('/api/unattended/schedule', { schedule: [slot] })
        assert.equal(r.status, 200)
        assert.equal(r.body.changed, true)
        assert.deepEqual(r.body.previous, [])
        assert.deepEqual((await config(h)).unattended.schedule, [slot])
        assert.deepEqual((await p.state()).unattended!.schedule, [slot])
        assert.equal((await p.post('/api/unattended/schedule', { schedule: [slot] })).body.changed, false)
        const bad = await p.post('/api/unattended/schedule', {
          schedule: [slot, { days: [], start: '23:00', end: '08:00' }],
        })
        assert.equal(bad.status, 400)
        assert.match(String(bad.body.error), /Slot 2 is not one/)
        assert.equal(
          (await p.post('/api/unattended/schedule', { schedule: [{ ...slot, start: '25:00' }] })).status,
          400,
        )
        assert.equal((await p.post('/api/unattended/schedule', { schedule: 'weeknights' })).status, 400)
        assert.deepEqual((await config(h)).unattended.schedule, [slot])
        // The page's undo writes `previous` back.
        const undo = await p.post('/api/unattended/schedule', { schedule: [] })
        assert.deepEqual(undo.body.previous, [slot])
        assert.deepEqual((await config(h)).unattended.schedule, [])
      } finally {
        await close(p.server)
      }
    })
  })

  it('lists Pending Decisions with the way back to their Session, marks them done and opens them again', async () => {
    await withFakeHome(async (h) => {
      const p = await panel(h)
      try {
        const state = join(h.env.XDG_STATE_HOME ?? h.path('.local/state'), 'sideby')
        const cwd = join(p.home, "code/it's")
        const a = await addPendingDecision(state, {
          kind: 'question',
          family: 'demo',
          account: 'demo:main',
          sessionId: LIVE,
          cwd,
          text: 'Which database?',
        })
        const b = await addPendingDecision(state, {
          kind: 'deferred',
          family: 'demo',
          account: 'demo:main',
          sessionId: ENDED,
          cwd,
          text: 'Publish it.',
        })
        const c = await addPendingDecision(state, {
          kind: 'deferred',
          family: 'demo',
          account: 'demo:main',
          sessionId: 'x; rm -rf ~',
          text: 'Odd id.',
        })
        const d = await addPendingDecision(state, {
          kind: 'deferred',
          family: 'unknown',
          text: 'From a terminal.',
        })
        const page = (await p.post('/api/unattended')).body as unknown as PanelUnattended
        const by = (id: string) => page.pending.find((x) => x.id === id)!
        assert.equal(page.pending.length, 4)
        assert.equal(page.status.pending, 4)
        assert.deepEqual([...page.status.pendingIds].sort(), page.pending.map((x) => x.id).sort())
        // Running: where it runs; no command needed.
        assert.deepEqual(by(a.id).live, { label: 'dm · night run · 7a1c0d2e', accountLabel: 'dm' })
        assert.equal(by(a.id).cwd, "~/code/it's")
        // Ended: the command that resumes it, from its folder, quoted for the shell.
        assert.equal(by(b.id).live, undefined)
        assert.equal(
          by(b.id).resume,
          `cd '${cwd.replace("'", "'\\''")}' && sideby run demo:main -- ${by(b.id).resume!.split(' -- ')[1]}`,
        )
        assert.ok(by(b.id).resume!.endsWith(ENDED))
        // An id that is not plain text gets no command; one without an Account has nothing to resume.
        assert.equal(by(c.id).resume, undefined)
        assert.equal(by(d.id).resume, undefined)
        assert.equal(by(d.id).accountLabel, undefined)

        assert.deepEqual((await p.post('/api/unattended/pending', { id: b.id })).body, { ids: [b.id] })
        const after = (await p.post('/api/unattended')).body as unknown as PanelUnattended
        assert.deepEqual(after.pending.map((x) => x.id).sort(), [a.id, c.id, d.id].sort())
        assert.equal((await p.state()).unattended!.pending, 3)
        assert.deepEqual([...(await p.state()).unattended!.pendingIds].sort(), [a.id, c.id, d.id].sort())
        // The toast's undo opens it again.
        assert.deepEqual((await p.post('/api/unattended/pending', { id: b.id, done: false })).body, {
          ids: [b.id],
        })
        assert.equal(((await p.post('/api/unattended')).body as unknown as PanelUnattended).pending.length, 4)
        const all = await p.post('/api/unattended/pending', { all: true })
        assert.equal((all.body.ids as string[]).length, 4)
        assert.equal(((await p.post('/api/unattended')).body as unknown as PanelUnattended).pending.length, 0)
        assert.equal((await p.post('/api/unattended/pending', {})).status, 400)
        const missing = await p.post('/api/unattended/pending', { id: 'nope' })
        assert.equal(missing.status, 400)
        assert.equal(missing.body.code, 'no-pending')
      } finally {
        await close(p.server)
      }
    })
  })

  it('keeps the Panel checks, and a read-only Panel shows everything but writes nothing', async () => {
    await withFakeHome(async (h) => {
      const rw = await panel(h)
      try {
        const bare = { origin: rw.good.origin }
        assert.equal((await call(rw.port, 'POST', '/api/unattended/on', bare, {})).status, 403)
        assert.equal(
          (
            await call(
              rw.port,
              'POST',
              '/api/unattended/on',
              { ...rw.good, origin: 'http://evil.example' },
              {},
            )
          ).status,
          403,
        )
        assert.equal(
          (
            await call(
              rw.port,
              'POST',
              '/api/unattended/schedule',
              { ...rw.good, host: 'evil.example:80' },
              { schedule: [] },
            )
          ).status,
          403,
        )
        await rw.post('/api/unattended/schedule', {
          schedule: [{ days: ['sat'], start: '01:00', end: '02:00' }],
        })
        await addPendingDecision(join(h.env.XDG_STATE_HOME ?? h.path('.local/state'), 'sideby'), {
          kind: 'deferred',
          family: 'demo',
          text: 'Keep me.',
        })
      } finally {
        await close(rw.server)
      }
      const ro = await panel(h, true)
      try {
        const before = await snapshot(h.home)
        const page = await ro.post('/api/unattended')
        assert.equal(page.status, 200)
        assert.equal((page.body as unknown as PanelUnattended).pending.length, 1)
        assert.equal((await ro.state()).unattended!.schedule.length, 1)
        for (const [path, body] of [
          ['/api/unattended/on', { for: '4h' }],
          ['/api/unattended/off', {}],
          ['/api/unattended/schedule', { schedule: [] }],
          ['/api/unattended/pending', { all: true }],
        ] as const) {
          const r = await ro.post(path, body)
          assert.equal(r.status, 403, path)
          assert.equal(r.body.error, 'this panel is read-only')
        }
        assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      } finally {
        await close(ro.server)
      }
    })
  })
})
