// "Send to it" on the Sessions page (spec §3.32 step 2): the screenshot upload, the send and the latest-Message
// endpoints, behind the Panel's usual checks. sendMessage and listMessages are replaced, so no test reaches a Session.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { UserError } from '../core/errors.ts'
import type { LiveSession } from '../core/live-sessions.ts'
import type { MessageReceipt, SendOptions } from '../core/messages.ts'
import type { Runtime } from '../runtime.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, LIVE_SESSIONS_SOURCE, type LiveSessionsSource } from './handler.ts'
import type { OrcaDeps } from './orca.ts'

const SID = '61230c3d-0000-4000-8000-000000000001'
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)])

function session(home: string, over: Partial<LiveSession> = {}): LiveSession {
  return {
    account: 'demo:work',
    accountLabel: 'dw',
    family: 'demo',
    sessionId: SID,
    title: 'knip cleanup',
    label: 'dw · knip cleanup · 61230c3d',
    status: 'busy',
    cwd: join(home, 'code/app'),
    guessed: false,
    resumeCommand: `sideby resume claude -- --resume ${SID}`,
    reference: "dw's session 61230c3d (knip cleanup).",
    pid: 101,
    ...over,
  }
}

function receipt(home: string, over: Partial<MessageReceipt> = {}): MessageReceipt {
  return {
    id: 'm1a2b3',
    to: 'dw · knip cleanup · 61230c3d',
    toSessionId: SID,
    toAccount: 'demo:work',
    status: 'delivered',
    file: join(home, '.local/state/sideby/messages/61230c3d/m1a2b3.md'),
    attachments: [],
    pasteText: `Read ${join(home, '.local/state/sideby/messages/61230c3d/m1a2b3.md')}`,
    sentAt: '2026-10-20T10:00:00.000Z',
    ...over,
  }
}

const noOrca: OrcaDeps = {
  run: async () => {
    throw new Error('Orca is not installed')
  },
  envVar: async () => undefined,
}
const inOrca: OrcaDeps = {
  run: async (args) =>
    args[1] === 'list'
      ? {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminals: [{ handle: 'term_a', connected: true }] },
          }),
        }
      : { exitCode: 0, stdout: '{"ok":true}' },
  envVar: async (pid, name) => (name === 'ORCA_TERMINAL_HANDLE' && pid === 101 ? 'term_a' : undefined),
}

function request(
  port: number,
  path: string,
  headers: Record<string, string | number>,
  body?: object | Buffer,
  opts: { chunked?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', ...headers },
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
    // A refused upload may close the connection before the whole body is written.
    req.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'EPIPE' || err.code === 'ECONNRESET' ? undefined : reject(err),
    )
    if (raw && opts.chunked) {
      // No content-length: the server only learns the size by reading.
      for (let at = 0; at < body.length; at += 1024 * 1024) req.write(body.subarray(at, at + 1024 * 1024))
      req.end()
    } else req.end(raw ? body : JSON.stringify(body ?? {}))
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

/** A Panel over a fake HOME whose sends and Message list are `fake`; `readOnly` for the second Panel. */
async function panel(h: FakeHome, source: LiveSessionsSource, readOnly = false) {
  await seedDemoMain(h.write)
  const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(demoFamily()))] })
  const home = h.env.HOME!
  const s = await serve((p) =>
    createPanelHandler({
      runtime,
      allowedHosts: [`127.0.0.1:${p}`],
      readOnly,
      ...{
        [LIVE_SESSIONS_SOURCE]: {
          list: async () => ({ sessions: [session(home)], problems: [] }),
          orca: noOrca,
          ...source,
        },
      },
    }),
  )
  const good = { origin: `http://127.0.0.1:${s.port}`, 'x-sideby-token': s.handler.token }
  return { ...s, good, home }
}

/** A sendMessage that records what it was asked and answers `answer`. */
function fakeSend(answer: (home: string) => MessageReceipt) {
  const calls: { target: string; opts: SendOptions; existed: boolean[] }[] = []
  const send = async (rt: Runtime, target: string, opts: SendOptions) => {
    calls.push({ target, opts, existed: (opts.images ?? []).map((p) => existsSync(p)) })
    return answer(rt.paths.home)
  }
  return { send, calls }
}

describe('panel "Send to it"', () => {
  it('sends text to a Live Session and answers the receipt with its files under ~', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) => receipt(home))
      const { server, port, good } = await panel(h, { send: f.send })
      try {
        const r = await request(port, '/api/sessions/send', good, {
          sessionId: SID,
          text: '  run the tests again  ',
          lang: 'zh',
        })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.deepEqual(
          f.calls.map((c) => [c.target, c.opts]),
          [[SID, { text: 'run the tests again', images: [], lang: 'zh' }]],
        )
        const m = r.body.message as MessageReceipt
        assert.equal(m.status, 'delivered')
        assert.equal(m.file, '~/.local/state/sideby/messages/61230c3d/m1a2b3.md')
        // Only a Message the user pastes gets the way to the tab.
        assert.equal(r.body.orca, undefined)
      } finally {
        await close(server)
      }
    })
  })

  it('stages images, sends their paths and frees the staged copies after the send', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) => receipt(home, { attachments: [join(home, 'x/1.png')] }))
      const { server, port, good, home } = await panel(h, { send: f.send })
      try {
        const ids: string[] = []
        for (let i = 0; i < 2; i++) {
          const up = await request(port, '/api/sessions/attach', good, PNG)
          assert.equal(up.status, 200, JSON.stringify(up.body))
          assert.equal(up.body.kind, 'image')
          ids.push(up.body.id as string)
        }
        const r = await request(port, '/api/sessions/send', good, { sessionId: SID, attachments: ids })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        const call = f.calls[0]!
        assert.equal(call.opts.text, '', 'a screenshot alone may go')
        assert.equal(call.opts.images!.length, 2)
        assert.deepEqual(call.existed, [true, true], 'the staged files exist while sendMessage copies them')
        assert.ok(call.opts.images!.every((p) => p.startsWith(home) && p.endsWith('.png')))
        assert.ok(!call.opts.images!.some((p) => existsSync(p)), 'freed after the send')
        assert.deepEqual((r.body.message as MessageReceipt).attachments, ['~/x/1.png'])
      } finally {
        await close(server)
      }
    })
  })

  it('refuses anything that is not an image, and images over 20 MB, on the server', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) => receipt(home))
      const { server, port, good } = await panel(h, { send: f.send })
      try {
        const video = await request(port, '/api/sessions/attach', good, MP4)
        assert.equal(video.status, 415)
        assert.match(String(video.body.error), /Only images/)
        const text = await request(port, '/api/sessions/attach', good, Buffer.from('hello, not a picture'))
        assert.equal(text.status, 415)
        const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)])
        // Only the header: the server answers before reading a byte, so a body could race its closing.
        const declared = await request(
          port,
          '/api/sessions/attach',
          { ...good, 'content-length': String(big.length) },
          Buffer.alloc(0),
        )
        assert.equal(declared.status, 413)
        assert.match(String(declared.body.error), /over 20 MB/)
        const streamed = await request(port, '/api/sessions/attach', good, big, { chunked: true })
        assert.equal(streamed.status, 413)
        // A video staged through the AI Task upload cannot be sent either.
        const staged = await request(port, '/api/ask/attach', good, MP4)
        assert.equal(staged.status, 200, JSON.stringify(staged.body))
        const r = await request(port, '/api/sessions/send', good, {
          sessionId: SID,
          text: 'look',
          attachments: [staged.body.id],
        })
        assert.equal(r.status, 415)
        assert.equal(f.calls.length, 0, 'nothing was sent')
      } finally {
        await close(server)
      }
    })
  })

  it('says what to do for an empty message, a bad list and a Session that stopped', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) => receipt(home))
      const { server, port, good } = await panel(h, { send: f.send })
      try {
        const empty = await request(port, '/api/sessions/send', good, { sessionId: SID, text: '   ' })
        assert.equal(empty.status, 400)
        assert.match(String(empty.body.error), /Write a message or add a screenshot/)
        assert.equal((await request(port, '/api/sessions/send', good, { text: 'hi' })).status, 400)
        const many = await request(port, '/api/sessions/send', good, {
          sessionId: SID,
          attachments: Array.from({ length: 6 }, (_, i) => `${i}`.repeat(16)),
        })
        assert.equal(many.status, 400)
        const long = await request(port, '/api/sessions/send', good, {
          sessionId: SID,
          text: 'x'.repeat(8001),
        })
        assert.equal(long.status, 400)
        const gone = await request(port, '/api/sessions/send', good, { sessionId: 'gone', text: 'hi' })
        assert.equal(gone.status, 404)
        assert.match(String(gone.body.error), /refresh the list/)
        assert.equal(f.calls.length, 0)
      } finally {
        await close(server)
      }
    })
  })

  it('answers paste-needed with the line, the note and the Orca tab when there is one', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) =>
        receipt(home, { status: 'paste-needed', note: 'Codex cannot receive messages by itself yet.' }),
      )
      const withOrca = await panel(h, { send: f.send, orca: inOrca })
      const without = await panel(h, { send: f.send })
      try {
        const r = await request(withOrca.port, '/api/sessions/send', withOrca.good, {
          sessionId: SID,
          text: 'hi',
        })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        const m = r.body.message as MessageReceipt
        assert.equal(m.status, 'paste-needed')
        assert.match(m.pasteText, /^Read /)
        assert.equal(m.note, 'Codex cannot receive messages by itself yet.')
        assert.equal(r.body.orca, true)
        assert.ok(!JSON.stringify(r.body).includes('term_a'), 'the handle stays on the server')
        const r2 = await request(without.port, '/api/sessions/send', without.good, {
          sessionId: SID,
          text: 'hi',
        })
        assert.equal(r2.body.orca, undefined)
      } finally {
        await close(withOrca.server)
        await close(without.server)
      }
    })
  })

  it('passes an error of sendMessage on in its own words', async () => {
    await withFakeHome(async (h) => {
      const send = async () => {
        throw new Error('sendMessage: not implemented yet (lane S2A)')
      }
      const { server, port, good } = await panel(h, { send })
      try {
        const r = await request(port, '/api/sessions/send', good, { sessionId: SID, text: 'hi' })
        assert.equal(r.status, 500)
        assert.match(String(r.body.error), /not implemented/)
      } finally {
        await close(server)
      }
    })
  })

  it('answers a refusal of the core as a 400 the dialog shows, and sends an image with no text', async () => {
    await withFakeHome(async (h) => {
      const seen: SendOptions[] = []
      const send = async (_rt: Runtime, _target: string, opts: SendOptions) => {
        seen.push(opts)
        if (!opts.text && !opts.images?.length)
          throw new UserError('Write a message or attach an image.', { code: 'empty' })
        if (opts.text === 'refuse')
          throw new UserError('That session cannot take messages now.', { code: 'busy' })
        return receipt(h.env.HOME!)
      }
      const { server, port, good } = await panel(h, { send })
      try {
        const up = await request(port, '/api/sessions/attach', good, PNG)
        const imageOnly = await request(port, '/api/sessions/send', good, {
          sessionId: SID,
          attachments: [up.body.id],
        })
        assert.equal(imageOnly.status, 200, JSON.stringify(imageOnly.body))
        assert.equal(seen[0]!.text, '')
        assert.equal(seen[0]!.images!.length, 1)
        const refused = await request(port, '/api/sessions/send', good, { sessionId: SID, text: 'refuse' })
        assert.equal(refused.status, 400)
        assert.deepEqual(refused.body, { error: 'That session cannot take messages now.', code: 'busy' })
      } finally {
        await close(server)
      }
    })
  })

  it('keeps the read-only, token, Origin and Host checks on every new endpoint', async () => {
    await withFakeHome(async (h) => {
      const f = fakeSend((home) => receipt(home))
      const messages = async () => [receipt(h.env.HOME!)]
      const rw = await panel(h, { send: f.send, messages })
      const ro = await panel(h, { send: f.send, messages }, true)
      try {
        for (const [path, body] of [
          ['/api/sessions/send', { sessionId: SID, text: 'hi' }],
          ['/api/sessions/attach', PNG],
        ] as const) {
          assert.equal((await request(ro.port, path, ro.good, body)).status, 403, `${path} read-only`)
          assert.equal(
            (await request(rw.port, path, { origin: rw.good.origin }, body)).status,
            403,
            `${path} token`,
          )
          const bad = await request(rw.port, path, { ...rw.good, 'x-sideby-token': 'nope' }, body)
          assert.equal(bad.body.code, 'bad-token')
          assert.equal(
            (await request(rw.port, path, { ...rw.good, origin: 'http://evil.example' }, body)).status,
            403,
            `${path} origin`,
          )
          const noOrigin = { 'x-sideby-token': rw.good['x-sideby-token'] }
          assert.equal((await request(rw.port, path, noOrigin, body)).status, 403, `${path} no origin`)
          assert.equal(
            (await request(rw.port, path, { ...rw.good, host: 'evil.example:80' }, body)).status,
            403,
            `${path} host`,
          )
        }
        assert.equal(f.calls.length, 0, 'nothing refused was sent')
        // The chips are a read: a read-only Panel shows them too.
        assert.equal((await request(ro.port, '/api/sessions/messages', ro.good)).status, 200)
        assert.equal(
          (await request(rw.port, '/api/sessions/messages', { origin: rw.good.origin })).status,
          403,
        )
      } finally {
        await close(rw.server)
        await close(ro.server)
      }
    })
  })

  it('lists the latest Message to each Session for the chips', async () => {
    await withFakeHome(async (h) => {
      const home = h.env.HOME!
      let asked: unknown
      const messages = async (_rt: Runtime, opts?: { to?: string; limit?: number }) => {
        asked = opts
        return [
          receipt(home, { id: 'new', status: 'read', sentAt: '2026-10-20T10:05:00.000Z' }),
          receipt(home, { id: 'old', status: 'paste-needed' }),
          receipt(home, { id: 'other', toSessionId: 'abc', status: 'paste-needed' }),
        ]
      }
      const { server, port, good } = await panel(h, { messages })
      try {
        const r = await request(port, '/api/sessions/messages', good)
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.deepEqual(asked, { limit: 200 })
        assert.deepEqual(r.body.latest, {
          [SID]: { id: 'new', status: 'read', sentAt: '2026-10-20T10:05:00.000Z' },
          abc: { id: 'other', status: 'paste-needed', sentAt: '2026-10-20T10:00:00.000Z' },
        })
        assert.ok(!JSON.stringify(r.body).includes(home), 'no paths')
      } finally {
        await close(server)
      }
    })
  })
})
