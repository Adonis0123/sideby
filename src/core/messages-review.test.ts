// Messages, round 1 of review (spec §3.32 step 2, ADR-0040): a socket or folder swapped after the check, a session
// that ends meanwhile, unsafe message folders, screenshots changed after the check, a screenshot without text, a peer
// that keeps the connection open, failures after the Message is kept, and receipts that are not sideby's.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { checkSocket, messageLine, socketChanged, writeToSocket } from '../families/claude/messaging.ts'
import { createRuntime } from '../runtime.ts'
import { UserError } from './errors.ts'
import type { LiveSessionDeps, ProcessInfo } from './live-sessions-procs.ts'
import { listMessages, type MessageDeps, messageFolder, safeName, sendMessage } from './messages.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const ID_B = '0799701d-2222-4222-8222-222222222222'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const proc = (pid: number, command: string): ProcessInfo => ({ pid, ppid: 1, startMs: START, command })

/** A server on `<fake temp>/cc-socks/<name>.sock`; `got` collects what each connection sent. */
async function serve(h: FakeHome, name: string, onConn?: (c: Socket) => void) {
  const root = join(h.home, '..', 'tmp')
  const dir = join(root, 'cc-socks')
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await fsp.chmod(dir, 0o700)
  const path = join(dir, `${name}.sock`)
  const got: string[] = []
  const open: Socket[] = []
  const server: Server = createServer((c) => {
    open.push(c)
    let d = ''
    c.on('data', (x) => {
      d += x
      if (d.endsWith('\n')) got.push(d)
    })
    onConn?.(c)
  })
  await new Promise<void>((r) => server.listen(path, r))
  const close = () =>
    new Promise<void>((r) => {
      for (const c of open) c.destroy()
      server.close(() => r())
    })
  return { root, dir, path, got, open, close }
}

/** cc002 (claude:002) runs session B, whose record names `sock`; `alive` says on which `ps` calls it still runs. */
async function machine(h: FakeHome, sock: string, alive: (call: number) => boolean = () => true) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-002/settings.json', '{"crossSessionInbound":"accept"}')
  await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:002' } }))
  await h.write(
    '.claude-002/sessions/4102.json',
    JSON.stringify({
      pid: 4102,
      sessionId: ID_B,
      cwd: '/work/b',
      status: 'idle',
      procStart: PROC_START,
      messagingSocketPath: sock,
    }),
  )
  let calls = 0
  const deps: LiveSessionDeps & { onList?: () => Promise<void> } = {
    processes: async () => {
      calls++
      await deps.onList?.()
      return alive(calls) ? [proc(4102, 'claude')] : []
    },
    envVar: async () => undefined,
    openFiles: async () => [],
  }
  return deps
}

const with_ = (procs: LiveSessionDeps, root: string, extra: Partial<MessageDeps> = {}): MessageDeps => ({
  procs,
  tempRoots: [root],
  selfPid: 999_999,
  ...extra,
})

describe('the socket is checked again at delivery', () => {
  it('writes nothing when the socket or its folder was replaced after the check', async () => {
    await withFakeHome(async (h) => {
      const a = await serve(h, 's')
      const checked = await checkSocket(a.path, { tempRoots: [a.root], uid: process.getuid?.() })
      assert.ok('identity' in checked)
      await a.close()
      const b = await serve(h, 's')
      await assert.rejects(
        writeToSocket(b.path, messageLine('x'), 1000, () => socketChanged(b.path, checked.identity)),
        /its socket was replaced after sideby checked it/,
      )
      assert.deepEqual(b.got, [])
      // The whole folder swapped for another one holding a socket of the same name.
      const c = await checkSocket(b.path, { tempRoots: [b.root], uid: process.getuid?.() })
      assert.ok('identity' in c)
      await fsp.rename(b.dir, `${b.dir}-old`)
      const d = await serve(h, 's')
      await assert.rejects(
        writeToSocket(d.path, messageLine('x'), 1000, () => socketChanged(d.path, c.identity)),
        /its socket folder was replaced after sideby checked it/,
      )
      assert.deepEqual(d.got, [])
      await b.close()
      await d.close()
    })
  })

  it('turns a swap between check and write into a paste, and re-checks that the session still runs', async () => {
    await withFakeHome(async (h) => {
      let s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(
        rt,
        'cc002',
        { text: 'x' },
        with_(procs, s.root, {
          write: async (p, line, ms, verify) => {
            await s.close()
            s = await serve(h, '4102')
            return writeToSocket(p, line, ms, verify)
          },
        }),
      )
      assert.equal(r.status, 'paste-needed')
      assert.match(
        r.note!,
        /\(its socket was replaced after sideby checked it\); paste the line into its tab/,
      )
      assert.deepEqual(s.got, [])
      await s.close()
    })
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      // Running for the listing and the sender search, gone when sideby is about to deliver.
      const procs = await machine(h, s.path, (call) => call <= 2)
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(rt, 'cc002', { text: 'x' }, with_(procs, s.root))
      await s.close()
      assert.equal(r.status, 'paste-needed')
      assert.match(r.note!, /because the session has ended/)
      assert.deepEqual(s.got, [])
    })
  })

  it('closes the connection once the line is written, also when the peer keeps its end open', async () => {
    await withFakeHome(async (h) => {
      let closed = false
      const s = await serve(h, 'p', (c) => c.on('close', () => (closed = true)))
      const t0 = Date.now()
      await writeToSocket(s.path, messageLine('hello'), 3000)
      assert.ok(Date.now() - t0 < 1000, 'it did not wait for the peer to close')
      for (let i = 0; i < 50 && (!closed || !s.got.length); i++) await new Promise((r) => setTimeout(r, 20))
      assert.equal(s.got.length, 1)
      assert.ok(closed, 'the connection was left open')
      await s.close()
    })
  })
})

describe('message folders', () => {
  it('never names a folder ., .. or with a separator', () => {
    for (const id of ['.', '..', 'a/b', '../x', '', '.hidden']) {
      const n = safeName(id)
      assert.ok(!['.', '..'].includes(n) && !n.includes('/') && /^[0-9a-f]*$/.test(n), `${id} -> ${n}`)
    }
    assert.equal(safeName(ID_B), ID_B)
  })

  it('refuses a message folder that is a link, and changes nothing where it points', async () => {
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const host = await h.mkdir('.claude-002/projects')
      await fsp.chmod(host, 0o755)
      const state = h.path('.local/state/sideby/messages')
      await fsp.mkdir(state, { recursive: true, mode: 0o700 })
      await fsp.symlink(host, join(state, ID_B))
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x' }, with_(procs, s.root)),
        (e: Error) => e instanceof UserError && e.code === 'messages-unsafe',
      )
      assert.deepEqual(await fsp.readdir(host), [])
      assert.equal((await fsp.stat(host)).mode & 0o777, 0o755)
      assert.deepEqual(s.got, [])
      await fsp.rm(join(state, ID_B))
      // The messages folder itself a link.
      await fsp.rm(state, { recursive: true })
      await fsp.symlink(host, state)
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x' }, with_(procs, s.root)),
        (e: Error) => (e as UserError).code === 'messages-unsafe',
      )
      assert.deepEqual(await fsp.readdir(host), [])
      await assert.rejects(
        messageFolder(h.path('.local/state/sideby'), ['..'], true),
        /is not a folder sideby can keep messages in/,
      )
      await s.close()
    })
  })
})

describe('screenshots', () => {
  it('copies the file that was checked, and refuses one that grew or changed in place meanwhile', async () => {
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const shot = h.path('shot.png')
      await fsp.writeFile(shot, PNG)
      // Replaced by another file after the check: the opened one is still what is copied.
      procs.onList = async () => {
        await fsp.writeFile(`${shot}.new`, 'plain text')
        await fsp.rename(`${shot}.new`, shot)
      }
      const r = await sendMessage(rt, 'cc002', { text: 'x', images: [shot] }, with_(procs, s.root))
      assert.deepEqual(await fsp.readFile(r.attachments[0]!), PNG)

      // The same file grown past 20 MB after the check.
      await fsp.writeFile(shot, PNG)
      procs.onList = async () => {
        procs.onList = undefined
        await fsp.truncate(shot, 20 * 1024 * 1024 + 1)
      }
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'grown', images: [shot] }, with_(procs, s.root)),
        /larger than 20 MB/,
      )
      // The same file overwritten with text after the check.
      await fsp.writeFile(shot, PNG)
      procs.onList = async () => {
        procs.onList = undefined
        const fh = await fsp.open(shot, 'r+')
        await fh.write(Buffer.from('not an image at all'), 0, 19, 0)
        await fh.close()
      }
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'changed', images: [shot] }, with_(procs, s.root)),
        /is not a PNG, JPEG, GIF or WebP image/,
      )
      const kept = await listMessages(rt)
      assert.equal(kept.length, 1, 'a refused screenshot leaves no Message behind')
      const link = h.path('link.png')
      await fsp.symlink(h.path('shot.png'), link)
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x', images: [link] }, with_(procs, s.root)),
        /is a link/,
      )
      await s.close()
    })
  })

  it('sends a screenshot without text, and refuses only a message with neither', async () => {
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const shot = h.path('shot.png')
      await fsp.writeFile(shot, PNG)
      const r = await sendMessage(rt, 'cc002', { text: '  ', images: [shot] }, with_(procs, s.root))
      assert.equal(r.status, 'delivered')
      for (let i = 0; i < 50 && !s.got.length; i++) await new Promise((res) => setTimeout(res, 20))
      assert.equal(
        JSON.parse(s.got[0]!).message.content,
        `sideby message ${r.id} from the user via sideby\nScreenshot: ${r.attachments[0]}`,
      )
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: '' }, with_(procs, s.root)),
        (e: Error) => (e as UserError).code === 'empty',
      )
      await s.close()
    })
  })
})

describe('after the Message is kept', () => {
  it('turns any failure before delivery into a paste with a plain note', async () => {
    if (process.getuid?.() === 0) return
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      await fsp.chmod(h.path('.claude-002/settings.json'), 0o000)
      try {
        const r = await sendMessage(rt, 'cc002', { text: 'x' }, with_(procs, s.root))
        assert.equal(r.status, 'paste-needed')
        assert.match(r.note!, /^sideby could not deliver it \(EACCES\); paste the line into its tab$/)
        const [kept] = await listMessages(rt)
        assert.equal(kept!.status, 'paste-needed')
      } finally {
        await fsp.chmod(h.path('.claude-002/settings.json'), 0o644)
      }
      assert.deepEqual(s.got, [])
      await s.close()
    })
  })

  it('skips receipts that are not sideby’s, and writes a read status only where the receipt was read', async () => {
    await withFakeHome(async (h) => {
      const s = await serve(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(rt, 'cc002', { text: 'x' }, with_(procs, s.root))
      await s.close()
      const dir = join(h.path('.local/state/sideby/messages'), ID_B)
      const transcript = h.path('t.jsonl')
      await fsp.writeFile(transcript, `{"m":"sideby message aaaaaaaa"}\n`)
      const good = JSON.parse(await fsp.readFile(r.file.replace(/\.md$/, '.json'), 'utf8'))
      const forged = (name: string, patch: Record<string, unknown>) =>
        fsp.writeFile(
          join(dir, `${name}.json`),
          JSON.stringify({ ...good, id: 'aaaaaaaa', status: 'delivered', transcript, ...patch }),
        )
      await forged('2026-10-20T00-00-00Z-aaaaaaaa', { file: h.path('evil.md') })
      await forged('2026-10-20T00-00-01Z-aaaaaaaa', {
        file: join(dir, '2026-10-20T00-00-01Z-aaaaaaaa.md'),
        attachments: [h.path('x.png')],
      })
      await forged('2026-10-20T00-00-02Z-aaaaaaaa', {
        file: join(dir, '2026-10-20T00-00-02Z-aaaaaaaa.md'),
        status: 'gone',
      })
      await fsp.writeFile(
        join(dir, 'broken.json'),
        '{"id":"aaaaaaaa","toSessionId":"x","sentAt":"2026-10-20"}',
      )
      const list = await listMessages(rt)
      assert.deepEqual(
        list.map((m) => m.id),
        [r.id],
      )
      assert.equal(await fsp.stat(h.path('evil.json')).catch(() => null), null)
      assert.equal(await fsp.stat(h.path('evil.md')).catch(() => null), null)
      // A messages folder that became a link is not read at all.
      const other = await h.mkdir('elsewhere')
      await fsp.symlink(other, join(h.path('.local/state/sideby/messages'), 'linked'))
      assert.deepEqual(
        (await listMessages(rt)).map((m) => m.id),
        [r.id],
      )
    })
  })
})
