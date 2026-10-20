// Messages between Sessions (spec §3.32 step 2): target resolution, the Message file and its screenshots, delivery to
// a fake Claude message socket (a server in the fake HOME's temp folder, never a real session), the socket checks,
// the read receipt, the sender, and the bypass note. No test looks at the machine's real processes or sessions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer, type Server } from 'node:net'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import {
  argsBypass,
  claudeSocketOf,
  messageLine,
  sessionBypass,
  socketProblem,
  writeToSocket,
} from '../families/claude/messaging.ts'
import { createRuntime } from '../runtime.ts'
import { UserError } from './errors.ts'
import { type LiveSessionDeps, type ProcessInfo, processView } from './live-sessions-procs.ts'
import {
  deliveredText,
  imageType,
  listMessages,
  type MessageDeps,
  senderSession,
  sendMessage,
} from './messages.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const ID_A = '61230c3d-1111-4111-8111-111111111111'
const ID_B = '0799701d-2222-4222-8222-222222222222'
const ID_C = '0799aaaa-3333-4333-8333-333333333333'
const ID_G = '01a14d11-4444-4444-8444-444444444444'
const ID_P = '01a11fc9-6666-4666-8666-666666666666'
const SECRET = 'fake-SECRET-value-must-not-appear'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])

const proc = (pid: number, command: string, ppid = 1): ProcessInfo => ({ pid, ppid, startMs: START, command })

function fakeDeps(procs: ProcessInfo[], env: Record<number, Record<string, string>> = {}): LiveSessionDeps {
  return {
    processes: async () => procs,
    envVar: async (pid, name) => env[pid]?.[name],
    openFiles: async () => [],
  }
}

/** A message socket served in `<fake temp>/cc-socks/<name>.sock`; `got` collects each connection's text. */
async function socketServer(h: FakeHome, name: string) {
  const root = join(h.home, '..', 'tmp')
  const dir = join(root, 'cc-socks')
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await fsp.chmod(dir, 0o700)
  const path = join(dir, `${name}.sock`)
  const got: string[] = []
  const ended: boolean[] = []
  const server: Server = createServer((c) => {
    let d = ''
    c.on('data', (x) => (d += x))
    c.on('end', () => {
      got.push(d)
      ended.push(true)
    })
  })
  await new Promise<void>((r) => server.listen(path, r))
  return { root, dir, path, got, ended, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** claude:001 (cc001) runs session A, claude:002 (cc002) runs B; grok:main runs G; pi:main has a guessed session. */
async function machine(h: FakeHome, sock: string, o: { inbound?: string; twoInB?: boolean } = {}) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-001/settings.json', '{}')
  await h.write(
    '.claude-002/settings.json',
    JSON.stringify({ model: 'x', ...(o.inbound ? { crossSessionInbound: o.inbound } : {}) }),
  )
  await h.write('.claude-002/.claude.json', `{"oauthAccount":"${SECRET}"}`)
  await h.write(
    '.config/sideby/config.json',
    JSON.stringify({ aliases: { cc001: 'claude:001', cc002: 'claude:002' } }),
  )
  const rec = (dir: string, pid: number, sessionId: string, cwd: string) =>
    h.write(
      `${dir}/sessions/${pid}.json`,
      JSON.stringify({
        pid,
        sessionId,
        cwd,
        status: 'idle',
        procStart: PROC_START,
        messagingSocketPath: sock,
      }),
    )
  await rec('.claude-001', 4101, ID_A, '/work/a')
  await rec('.claude-002', 4102, ID_B, '/work/b')
  if (o.twoInB) await rec('.claude-002', 4103, ID_C, '/work/c')
  await h.write(`.claude-002/sessions/4102.0123abcd.key`, SECRET, 0o600)
  await h.write(`.claude-002/projects/-work-b/${ID_B}.jsonl`, '{"type":"user"}\n')
  await h.write(
    '.grok/active_sessions.json',
    JSON.stringify([{ session_id: ID_G, pid: 555, pid_start: START * 1000, cwd: '/work/g' }]),
  )
  await h.mkdir('.grok/skills')
  await h.write('.pi/agent/AGENTS.md', '# rules\n')
  await h.write(
    `.pi/agent/sessions/--work-p--/2026-10-09T08-31-17-282Z_${ID_P}.jsonl`,
    `${JSON.stringify({ type: 'session', id: ID_P, cwd: '/work/p' })}\n`,
  )
  const procs = [
    proc(4101, 'claude'),
    proc(6000, '/bin/zsh -c sideby send', 4101),
    proc(6001, 'node sideby send', 6000),
    proc(4102, 'claude --dangerously-skip-permissions'),
    ...(o.twoInB ? [proc(4103, 'claude')] : []),
    proc(555, 'grok'),
    proc(800, 'node /usr/local/bin/pi'),
  ]
  return fakeDeps(procs, { 800: {} })
}

const depsFor = (procs: LiveSessionDeps, root: string, extra: Partial<MessageDeps> = {}): MessageDeps => ({
  procs,
  tempRoots: [root],
  selfPid: 999_999,
  ...extra,
})

describe('sideby send', () => {
  it('keeps the Message, delivers one JSON line to the Claude socket and closes, without reading any key file', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'accept' })
      const shot = await h.write('shot.png', PNG.toString('latin1'))
      await fsp.writeFile(shot, PNG)
      const opened: string[] = []
      const spy = (orig: (...a: never[]) => unknown) =>
        function (this: unknown, p: unknown, ...rest: never[]) {
          opened.push(String(p))
          return (orig as (...a: unknown[]) => unknown).call(this, p, ...rest)
        }
      const origRead = fsp.readFile
      const origOpen = fsp.open
      const origStream = fs.createReadStream
      fsp.readFile = spy(origRead as never) as typeof fsp.readFile
      fsp.open = spy(origOpen as never) as typeof fsp.open
      fs.createReadStream = spy(origStream as never) as typeof fs.createReadStream
      syncBuiltinESMExports()
      let r: Awaited<ReturnType<typeof sendMessage>>
      try {
        const rt = await createRuntime({ env: h.env })
        r = await sendMessage(
          rt,
          'cc002',
          { text: 'run the tests\nthen push', images: [shot] },
          depsFor(procs, s.root),
        )
      } finally {
        fsp.readFile = origRead
        fsp.open = origOpen
        fs.createReadStream = origStream
        syncBuiltinESMExports()
      }
      await s.close()
      assert.equal(r.status, 'delivered')
      assert.equal(r.note, undefined)
      assert.equal(r.to, 'cc002 · b · 0799701d')
      assert.equal(r.toAccount, 'claude:002')
      assert.match(r.id, /^[0-9a-f]{8}$/)
      assert.deepEqual(
        opened.filter((p) => /\.key$|\.claude\.json$|auth\.json$|proxy\.env$/.test(p)),
        [],
        'a key or credential file was opened',
      )
      assert.ok(opened.length > 0, 'the spy saw no reads at all')
      // One line, then the connection closed.
      assert.equal(s.got.length, 1)
      assert.deepEqual(s.ended, [true])
      assert.ok(s.got[0]!.endsWith('}\n') && s.got[0]!.split('\n').length === 2)
      const line = JSON.parse(s.got[0]!)
      assert.deepEqual(Object.keys(line), ['type', 'message'])
      assert.equal(line.type, 'user')
      assert.equal(line.message.role, 'user')
      assert.equal(
        line.message.content,
        `sideby message ${r.id} from the user via sideby\nrun the tests\nthen push\nScreenshot: ${r.attachments[0]}`,
      )
      // The Message file and its screenshot: mode 600 in folders of mode 700, under the target session's folder.
      const state = h.path('.local/state/sideby/messages')
      assert.equal(r.file, join(state, ID_B, basename(r.file)))
      assert.match(basename(r.file), new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\dZ-${r.id}\\.md$`))
      for (const p of [r.file, r.attachments[0]!]) assert.equal((await fsp.stat(p)).mode & 0o777, 0o600)
      for (const p of [state, join(state, ID_B)]) assert.equal((await fsp.stat(p)).mode & 0o777, 0o700)
      assert.ok(r.attachments[0]!.endsWith('-1.png'))
      assert.deepEqual(await fsp.readFile(r.attachments[0]!), PNG)
      const md = await fsp.readFile(r.file, 'utf8')
      assert.match(
        md,
        new RegExp(`^# sideby message ${r.id}\n\nFrom: the user\nTo: cc002 · b · 0799701d\nSent: `),
      )
      assert.match(md, /run the tests\nthen push\n\nScreenshots:\n- .*-1\.png\n$/)
      assert.match(
        r.pasteText,
        new RegExp(
          `^Read the message sideby kept for you at .*\\(sideby message ${r.id}\\) and the screenshots it lists\\.$`,
        ),
      )
      assert.ok(!JSON.stringify(r).includes(SECRET))
      const kept = JSON.parse(await fsp.readFile(r.file.replace(/\.md$/, '.json'), 'utf8'))
      assert.equal(kept.status, 'delivered')
      assert.equal((await fsp.stat(r.file.replace(/\.md$/, '.json'))).mode & 0o777, 0o600)
    })
  })

  it('names the sender it finds among its parent processes, and refuses to send to that same session', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'accept' })
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(rt, ID_B, { text: 'hi' }, depsFor(procs, s.root, { selfPid: 6001 }))
      await s.close()
      assert.equal(r.from, 'cc001 · a · 61230c3d')
      assert.match(
        JSON.parse(s.got[0]!).message.content,
        new RegExp(`^sideby message ${r.id} from cc001 · a · 61230c3d\nhi$`),
      )
      await assert.rejects(
        sendMessage(rt, 'cc001', { text: 'hi' }, depsFor(procs, s.root, { selfPid: 6001 })),
        (e: Error) => e instanceof UserError && e.code === 'same-session',
      )
    })
    assert.equal(
      senderSession(3, [proc(3, 'x', 2), proc(2, 'y', 3)], []),
      undefined,
      'a parent loop ends the walk',
    )
  })

  it('resolves an id, its first 8 characters, and lists several sessions instead of guessing', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'accept', twoInB: true })
      const rt = await createRuntime({ env: h.env })
      const d = depsFor(procs, s.root)
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x' }, d),
        (e: Error) =>
          e instanceof UserError &&
          e.code === 'several-sessions' &&
          /cc002 runs 2 sessions now; send to one by its id:\n {2}sideby send 0799701d "<text>"/.test(
            e.message,
          ),
      )
      // `0799` is too short to be an id; `0799701d` names exactly one.
      await assert.rejects(
        sendMessage(rt, '0799', { text: 'x' }, d),
        (e: Error) => (e as UserError).code === 'no-session',
      )
      assert.equal((await sendMessage(rt, '0799701d', { text: 'x' }, d)).toSessionId, ID_B)
      assert.equal((await sendMessage(rt, ID_C, { text: 'x' }, d)).toSessionId, ID_C)
      await assert.rejects(
        sendMessage(rt, 'claude:main', { text: 'x' }, d),
        (e: Error) =>
          (e as UserError).code === 'no-session' && /claude:main has no running session now/.test(e.message),
      )
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: '   ' }, d),
        (e: Error) => (e as UserError).code === 'empty',
      )
      await s.close()
    })
  })

  it('asks for a paste for Hosts without a channel and for a guessed session, with a plain reason', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const g = await sendMessage(rt, 'grok:main', { text: 'x', lang: 'zh' }, depsFor(procs, s.root))
      assert.equal(g.status, 'paste-needed')
      assert.match(
        g.note!,
        /^Grok Build has no channel sideby can deliver to yet; paste the line into its tab$/,
      )
      assert.match(g.pasteText, new RegExp(`^去读 sideby 留给你的消息 .*（sideby message ${g.id}）。$`))
      const p = await sendMessage(rt, 'pi:main', { text: 'x' }, depsFor(procs, s.root))
      assert.equal(p.status, 'paste-needed')
      assert.match(
        p.note!,
        /could not tell which pi:main session runs now \(it took the newest one\), so it did not deliver it/,
      )
      await s.close()
      assert.equal(s.got.length, 0)
      // Both are kept all the same.
      assert.match(await fsp.readFile(g.file, 'utf8'), /^# sideby message /)
    })
  })

  it('refuses anything but a screenshot up to 20 MB before writing anything', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const text = await h.write('notes.txt', 'just text')
      const big = h.path('big.png')
      await fsp.writeFile(big, PNG)
      await fsp.truncate(big, 20 * 1024 * 1024 + 1)
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x', images: [text] }, depsFor(procs, s.root)),
        /notes\.txt is not a PNG, JPEG, GIF or WebP image; only screenshots can be attached/,
      )
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x', images: [big] }, depsFor(procs, s.root)),
        /big\.png is larger than 20 MB, too large to send/,
      )
      await assert.rejects(
        sendMessage(rt, 'cc002', { text: 'x', images: [h.path('gone.png')] }, depsFor(procs, s.root)),
        /gone\.png is not a file sideby can read/,
      )
      await s.close()
      assert.equal(await fsp.stat(h.path('.local/state/sideby/messages')).catch(() => null), null)
    })
    assert.equal(imageType(Buffer.from('GIF89a')), 'gif')
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
    assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  })

  it('falls back to a paste when the socket refuses, does not answer, or fails a check', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      // A socket nobody listens on any more: rename it away before the server closes (which removes only its name).
      const stale = join(s.dir, 'stale.sock')
      await fsp.rename(s.path, stale)
      await s.close()
      const procs = await machine(h, stale, { inbound: 'accept' })
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(rt, 'cc002', { text: 'x' }, depsFor(procs, s.root))
      assert.equal(r.status, 'paste-needed')
      assert.match(
        r.note!,
        /^sideby could not reach cc002 · b · 0799701d \(it refused the connection\); paste the line into its tab$/,
      )
      const slow = await sendMessage(
        rt,
        'cc002',
        { text: 'x' },
        depsFor(procs, s.root, {
          write: (_p, _line, ms) => {
            assert.equal(ms, 3000)
            return Promise.reject(new Error(`it did not answer within ${ms / 1000} s`))
          },
        }),
      )
      assert.match(slow.note!, /\(it did not answer within 3 s\)/)
      const other = await sendMessage(rt, 'cc002', { text: 'x' }, depsFor(procs, s.root, { uid: 4242 }))
      assert.match(
        other.note!,
        /^sideby did not deliver it because its socket folder belongs to another user;/,
      )
    })
  })
})

describe('the message socket checks', () => {
  it('accepts only a socket of this user in cc-socks inside a temp folder, and times out a socket that does not read', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '1')
      const uid = process.getuid?.()
      const o = { tempRoots: [s.root], uid }
      assert.equal(await socketProblem(s.path, o), null)
      assert.equal(await socketProblem('rel/cc-socks/1.sock', o), 'its socket path is not absolute')
      const link = join(s.dir, 'link.sock')
      await fsp.symlink(s.path, link)
      assert.equal(await socketProblem(link, o), 'its socket is a link')
      assert.equal(await socketProblem(join(s.dir, 'none.sock'), o), 'its socket does not exist')
      const file = join(s.dir, 'file.sock')
      await fsp.writeFile(file, '')
      assert.equal(await socketProblem(file, o), 'its socket path is not a socket')
      assert.equal(
        await socketProblem(s.path, { tempRoots: [h.home], uid }),
        'its socket is not in the system temp folder',
      )
      const elsewhere = join(s.root, 'socks')
      await fsp.mkdir(elsewhere)
      assert.equal(
        await socketProblem(join(elsewhere, '1.sock'), o),
        'its socket is not in a cc-socks folder',
      )
      if (uid !== undefined)
        assert.equal(
          await socketProblem(s.path, { ...o, uid: uid + 1 }),
          'its socket folder belongs to another user',
        )
      await fsp.chmod(s.dir, 0o755)
      assert.equal(await socketProblem(s.path, o), 'others can enter its socket folder')
      await fsp.chmod(s.dir, 0o700)
      await s.close()

      // A server that never reads: the line cannot be written out, so the write gives up after its timeout.
      const held: import('node:net').Socket[] = []
      const quiet = createServer({ pauseOnConnect: true }, (c) => held.push(c))
      const qp = join(s.dir, 'q.sock')
      await new Promise<void>((r) => quiet.listen(qp, r))
      const t0 = Date.now()
      await assert.rejects(
        writeToSocket(qp, messageLine('x'.repeat(16 * 1024 * 1024)), 200),
        /did not answer within 0\.2 s/,
      )
      assert.ok(Date.now() - t0 < 2000)
      for (const c of held) c.destroy()
      await new Promise<void>((r) => quiet.close(() => r()))
    })
  })

  it('reads the socket path only from a record whose process still runs that session', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.claude-002/sessions/4102.json',
        JSON.stringify({
          sessionId: ID_B,
          procStart: PROC_START,
          messagingSocketPath: '/tmp/cc-socks/4102.sock',
        }),
      )
      const dir = h.path('.claude-002')
      const alive = processView(fakeDeps([proc(4102, 'claude')]))
      assert.deepEqual(await claudeSocketOf(dir, 4102, ID_B, alive), { path: '/tmp/cc-socks/4102.sock' })
      assert.deepEqual(await claudeSocketOf(dir, 4102, ID_B, processView(fakeDeps([]))), {
        problem: 'the session has ended',
      })
      const reused = processView(fakeDeps([{ ...proc(4102, 'claude'), startMs: START + 3_600_000 }]))
      assert.deepEqual(await claudeSocketOf(dir, 4102, ID_B, reused), { problem: 'the session has ended' })
      assert.deepEqual(await claudeSocketOf(dir, 4102, ID_A, alive), {
        problem: 'the process now runs another session',
      })
    })
  })
})

describe('bypass and the read receipt', () => {
  it('tells from the transcript, else the arguments, whether a session holds messages, and says what to do', async () => {
    await withFakeHome(async (h) => {
      const t = await h.write(
        't.jsonl',
        [
          '{"type":"permission-mode","permissionMode":"bypassPermissions"}',
          '{"type":"user","message":"x"}',
          '{"type":"permission-mode","permissionMode":"default"}',
        ].join('\n'),
      )
      assert.equal(await sessionBypass(t, ['--dangerously-skip-permissions']), false, 'the last record wins')
      assert.equal(await sessionBypass(h.path('none.jsonl'), ['--dangerously-skip-permissions']), true)
      assert.equal(argsBypass(['--permission-mode', 'bypassPermissions']), true)
      assert.equal(argsBypass(['--permission-mode=bypassPermissions']), true)
      assert.equal(argsBypass(['--permission-mode', 'plan']), false)

      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path)
      const rt = await createRuntime({ env: h.env })
      const held = await sendMessage(rt, 'cc002', { text: 'x' }, depsFor(procs, s.root))
      assert.equal(held.status, 'delivered')
      assert.equal(
        held.note,
        'cc002 holds messages from other sessions: approve it in its terminal within 5 minutes, or run `sideby messages inbound accept` so it shows them at once',
      )
      const plain = await sendMessage(rt, 'cc001', { text: 'x' }, depsFor(procs, s.root))
      assert.equal(plain.note, undefined, 'a session not in bypass shows it at once')
      await s.close()
    })
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'refuse' })
      const rt = await createRuntime({ env: h.env })
      const r = await sendMessage(rt, 'cc002', { text: 'x' }, depsFor(procs, s.root))
      await s.close()
      assert.equal(r.status, 'paste-needed')
      assert.match(r.note!, /cc002 refuses messages from other sessions \(crossSessionInbound is "refuse"\)/)
      assert.equal(s.got.length, 0)
    })
  })

  it('marks a Message read once its id shows in the end of the target transcript, newest first', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'accept' })
      const rt = await createRuntime({ env: h.env })
      const one = await sendMessage(rt, 'cc002', { text: 'first' }, depsFor(procs, s.root))
      const two = await sendMessage(rt, 'cc001', { text: 'second' }, depsFor(procs, s.root))
      await s.close()
      assert.deepEqual(
        (await listMessages(rt)).map((m) => [m.id, m.status]),
        [
          [two.id, 'delivered'],
          [one.id, 'delivered'],
        ],
      )
      const transcript = h.path(`.claude-002/projects/-work-b/${ID_B}.jsonl`)
      // Old content first, so the id sits only near the end of a file larger than the part that is read.
      await fsp.writeFile(transcript, `${'{"type":"assistant","x":"pad"}\n'.repeat(20_000)}`)
      await fsp.appendFile(
        transcript,
        `${JSON.stringify({ type: 'user', message: { content: deliveredText(one.id, undefined, 'first', []) } })}\n`,
      )
      const now = await listMessages(rt)
      assert.deepEqual(
        now.map((m) => [m.id, m.status]),
        [
          [two.id, 'delivered'],
          [one.id, 'read'],
        ],
      )
      assert.ok(!('transcript' in now[0]!), 'the transcript path stays internal')
      assert.deepEqual(
        (await listMessages(rt, { to: 'cc002' })).map((m) => m.id),
        [one.id],
      )
      assert.deepEqual(
        (await listMessages(rt, { to: '61230c3d' })).map((m) => m.id),
        [two.id],
      )
      assert.equal((await listMessages(rt, { limit: 1 })).length, 1)
      const kept = JSON.parse(await fsp.readFile(one.file.replace(/\.md$/, '.json'), 'utf8'))
      assert.equal(kept.status, 'read')
    })
  })
})

describe('a receipt that cannot be recorded', () => {
  it('still returns the delivery result with a note instead of failing', async () => {
    await withFakeHome(async (h) => {
      const s = await socketServer(h, '4102')
      const procs = await machine(h, s.path, { inbound: 'accept' })
      const folder = h.path(`.local/state/sideby/messages/${ID_B}`)
      const rt = await createRuntime({ env: h.env })
      let r: Awaited<ReturnType<typeof sendMessage>>
      try {
        r = await sendMessage(
          rt,
          'cc002',
          { text: 'hello' },
          depsFor(procs, s.root, {
            write: async () => {
              // Delivered; then the folder turns read-only, so the final receipt write fails.
              await fsp.chmod(folder, 0o500)
            },
          }),
        )
      } finally {
        await fsp.chmod(folder, 0o700)
        await s.close()
      }
      assert.equal(r.status, 'delivered')
      assert.match(r.note ?? '', /could not record that it was delivered \(EACCES\)/)
    })
  })
})
