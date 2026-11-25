import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { addPendingDecision } from '../core/unattended-pending.ts'
import { checkSchema, sideby } from './cli-test-helpers.ts'
import { quotaText } from './format.ts'

describe('sideby sessions (spec §3.32)', () => {
  const ID_A = '61230c3d-1111-4111-8111-111111111111'
  const ID_B = '0799701d-2222-4222-8222-222222222222'
  const PROC_START = 'Tue Oct 20 02:14:43 2026'

  /** A fake `ps` that lists the given processes, and fake clipboards that write what they get to `<bin>/clip.txt`. */
  async function fakeMachine(h: FakeHome, pids: number[], clipboard = true) {
    const lines = pids.map((p) => `${p} 1 ${PROC_START} claude`).join('\n')
    const script = (body: string) => `#!${process.execPath}\n${body}\n`
    await writeFile(join(h.bin, 'ps'), script(`process.stdout.write(${JSON.stringify(`${lines}\n`)})`), {
      mode: 0o755,
    })
    if (!clipboard) return
    const clip = join(h.bin, 'clip.txt')
    for (const name of ['pbcopy', 'wl-copy', 'xclip'])
      await writeFile(
        join(h.bin, name),
        script(
          `let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(clip)},d))`,
        ),
        { mode: 0o755 },
      )
  }

  async function claudeSessions(h: FakeHome, twoInWork: boolean) {
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-work/settings.json', '{}')
    await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:work' } }))
    const rec = (pid: number, sessionId: string, name: string, status: string) =>
      h.write(
        `.claude-work/sessions/${pid}.json`,
        JSON.stringify({
          pid,
          sessionId,
          name,
          cwd: '/work/repo',
          status,
          procStart: PROC_START,
          updatedAt: 1792462484569,
        }),
      )
    await rec(4101, ID_A, 'knip cleanup', 'blocked')
    if (twoInWork) await rec(4102, ID_B, 'release notes', 'idle')
    await h.write(`.claude-work/projects/-work-repo/${ID_A}.jsonl`, '{}\n')
  }

  it('lists running sessions, needing you first, in text and --json', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const human = await sideby(h, ['sessions'])
      assert.equal(human.code, 0, human.err)
      const rows = human.out.split('\n')
      assert.match(rows[1]!, /^cc002 · knip cleanup · 61230c3d\s+needs you\s+\/work\/repo/)
      assert.match(rows[2]!, /^cc002 · release notes · 0799701d\s+idle/)
      const r = await sideby(h, ['sessions', 'cc002', '--json'])
      const data = checkSchema('sessions', r.out)
      const list = data.sessions as { label: string; reference: string; transcript?: string }[]
      assert.equal(list.length, 2)
      assert.match(
        list[0]!.reference,
        /^cc002's session 61230c3d \(knip cleanup\), working directory \/work\/repo, record at /,
      )
      const empty = await sideby(h, ['sessions', 'claude:main'])
      assert.match(
        empty.out,
        /claude:main has no running session now\. Start one with `sideby run <account>`/,
      )
    })
  })

  it('says where a session was started from, in the row and as startedFrom in --json (spec §3.32)', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      const from = async (pid: number, entrypoint: string) => {
        const file = `.claude-work/sessions/${pid}.json`
        const rec = JSON.parse(await readFile(join(h.env.HOME!, file), 'utf8')) as Record<string, unknown>
        await h.write(file, JSON.stringify({ ...rec, entrypoint }))
      }
      await from(4101, 'orca')
      await from(4102, 'cli')
      await fakeMachine(h, [4101, 4102])
      const human = await sideby(h, ['sessions'])
      assert.equal(human.code, 0, human.err)
      assert.match(human.out, /cc002 · knip cleanup · 61230c3d · Orca\s+needs you/)
      assert.match(human.out, /cc002 · release notes · 0799701d\s+idle/)
      const data = checkSchema('sessions', (await sideby(h, ['sessions', '--json'])).out)
      const list = data.sessions as { sessionId: string; startedFrom?: string }[]
      assert.deepEqual(
        list.map((s) => [s.sessionId, s.startedFrom ?? null]).sort(),
        [
          [ID_A, 'orca'],
          [ID_B, null],
        ].sort(),
      )
    })
  })

  it('says a session needs you for an open Pending Decision, with where to see it, in text and --json', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      await addPendingDecision(join(h.env.XDG_STATE_HOME!, 'sideby'), {
        kind: 'permission',
        family: 'claude',
        account: 'claude:work',
        sessionId: ID_B,
        text: 'Bash: git',
      })
      const human = await sideby(h, ['sessions'])
      assert.equal(human.code, 0, human.err)
      assert.match(human.out, /cc002 · release notes · 0799701d\s+needs you: a decision\s+\/work\/repo/)
      assert.match(human.out, /cc002 · knip cleanup · 61230c3d\s+needs you\s+\/work\/repo/)
      assert.match(human.out, /See the decisions waiting for you: sideby unattended pending/)
      const data = checkSchema('sessions', (await sideby(h, ['sessions', '--json'])).out)
      const list = data.sessions as { sessionId: string; status: string; reason?: string }[]
      assert.deepEqual(
        list.map((s) => [s.sessionId, s.status, s.reason]).sort(),
        [
          [ID_A, 'needs-you', 'host-waits'],
          [ID_B, 'needs-you', 'pending-decision'],
        ].sort(),
      )
    })
  })

  it("shows the Run a session works for from the orchestrator's Session Index (ADR-0041)", async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const board = await h.write('state/ad/boards/r1.html', '<!doctype html>\n', 0o600)
      const other = await h.write('state/ad/boards/r2.html', '<!doctype html>\n', 0o600)
      const entry = (b: string, runTitle: string, role: string, lane: string) => ({
        run: 'r',
        runTitle,
        board: b,
        lane,
        laneTitle: 'sideby link',
        role,
        url: `file://${b}#lane-${lane}`,
      })
      await h.write(
        'state/ad/session-index.json',
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          generatedAt: '2026-10-20T07:00:00Z',
          sessions: {
            [ID_A]: {
              entries: [entry(other, 'Review pass', 'review', 'R'), entry(board, 'Run board', 'write', 'D2')],
            },
          },
        }),
      )
      const env = { AGENT_DISPATCH_STATE_DIR: h.path('state/ad') }
      const human = await sideby(h, ['sessions'], env)
      assert.equal(human.code, 0, human.err)
      assert.match(human.out, /RUN/)
      assert.match(human.out, /knip cleanup · 61230c3d.*Run board \+1/)
      assert.match(human.out, /Run: Run board {2}~\/state\/ad\/boards\/r1\.html\n/)
      assert.match(human.out, /Run: Review pass {2}~\/state\/ad\/boards\/r2\.html\n/)
      const r = await sideby(h, ['sessions', '--json'], env)
      const data = checkSchema('sessions', r.out)
      const list = data.sessions as { sessionId: string; run?: unknown }[]
      assert.deepEqual(list.find((s) => s.sessionId === ID_A)?.run, {
        title: 'Run board',
        laneTitle: 'sideby link',
        role: 'write',
        board,
        url: `file://${board}#lane-D2`,
        others: [{ title: 'Review pass', laneTitle: 'sideby link', role: 'review', board: other }],
      })
      assert.equal(list.find((s) => s.sessionId === ID_B)?.run, undefined)
      // Without the index, nothing changes.
      const plain = await sideby(h, ['sessions'])
      assert.doesNotMatch(plain.out, /RUN|Run:/)
    })
  })

  it('copies one session, lists several instead of guessing, and prints the text without a clipboard', async () => {
    await withFakeHome(async (h) => {
      await claudeSessions(h, true)
      await fakeMachine(h, [4101, 4102])
      const several = await sideby(h, ['sessions', 'copy', 'cc002'])
      assert.equal(several.code, 1)
      assert.match(
        several.err,
        /cc002 runs 2 sessions now; copy one by its id:\n {2}sideby sessions copy 61230c3d/,
      )
      const severalJson = await sideby(h, ['sessions', 'copy', 'cc002', '--json'])
      assert.equal(severalJson.code, 1)
      assert.equal(JSON.parse(severalJson.out).code, 'several-sessions')

      const id = await sideby(h, ['sessions', 'copy', '61230c3d', '--as', 'id', '--json'])
      assert.equal(id.code, 0, id.err)
      const data = checkSchema('sessions-copy', id.out)
      assert.deepEqual([data.copied, data.as, data.text], [true, 'id', ID_A])
      assert.equal(await readFile(join(h.bin, 'clip.txt'), 'utf8'), ID_A)

      const zh = await sideby(h, ['sessions', 'copy', ID_A, '--lang', 'zh'])
      assert.equal(zh.code, 0, zh.err)
      assert.match(zh.out, /copied a reference to cc002 · knip cleanup · 61230c3d/)
      assert.match(
        await readFile(join(h.bin, 'clip.txt'), 'utf8'),
        /^cc002 的会话 61230c3d（knip cleanup），工作目录 \/work\/repo/,
      )
      const bad = await sideby(h, ['sessions', 'copy', ID_A, '--as', 'path'])
      assert.equal(bad.code, 2)
    })
    await withFakeHome(async (h) => {
      await claudeSessions(h, false)
      await fakeMachine(h, [4101], false)
      // Only the fake bin: no pbcopy, wl-copy or xclip anywhere on PATH.
      const env = { PATH: h.bin }
      const r = await sideby(h, ['sessions', 'copy', 'cc002', '--as', 'resume'], env)
      assert.equal(r.code, 0, r.err)
      assert.equal(r.out.trim(), `sideby resume claude -- --resume ${ID_A}`)
      assert.match(r.err, /no clipboard program found .*copy the text above yourself/)
      const j = checkSchema(
        'sessions-copy',
        (await sideby(h, ['sessions', 'copy', 'cc002', '--json'], env)).out,
      )
      assert.equal(j.copied, false)
      const none = await sideby(h, ['sessions', 'copy', 'claude:main'], env)
      assert.equal(none.code, 1)
      assert.match(
        none.err,
        /claude:main has no running session now; start one with `sideby run claude:main`/,
      )
    })
  })
})

describe('sideby send and messages (spec §3.32 step 2)', () => {
  const ID_A = '61230c3d-1111-4111-8111-111111111111'
  const ID_G = '01a14d11-4444-4444-8444-444444444444'
  const PROC_START = 'Tue Oct 20 02:14:43 2026'
  const script = (body: string) => `#!${process.execPath}\n${body}\n`

  /** cc002 runs one Claude session whose message socket a server in this test serves; grok:main runs one too. */
  async function setUp(h: FakeHome, settings = '{}') {
    const { createServer } = await import('node:net')
    const tmp = join(h.home, '..', 'tmp')
    await mkdir(join(tmp, 'cc-socks'), { recursive: true, mode: 0o700 })
    await chmod(join(tmp, 'cc-socks'), 0o700)
    const sock = join(tmp, 'cc-socks', '4101.sock')
    const got: string[] = []
    const server = createServer((c) => {
      let d = ''
      c.on('data', (x) => (d += x)).on('end', () => got.push(d))
    })
    await new Promise<void>((r) => server.listen(sock, r))
    await h.write('.claude/settings.json', '{}')
    await h.write('.claude-work/settings.json', settings)
    await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:work' } }))
    await h.write(
      '.claude-work/sessions/4101.json',
      JSON.stringify({
        pid: 4101,
        sessionId: ID_A,
        name: 'knip cleanup',
        cwd: '/work/repo',
        status: 'idle',
        procStart: PROC_START,
        messagingSocketPath: sock,
      }),
    )
    await h.mkdir('.grok/skills')
    await h.write(
      '.grok/active_sessions.json',
      JSON.stringify([
        { session_id: ID_G, pid: 555, pid_start: Date.UTC(2026, 9, 20, 2, 14, 43) * 1000, cwd: '/work/g' },
      ]),
    )
    const lines = `4101 1 ${PROC_START} claude\n555 1 ${PROC_START} grok\n`
    await writeFile(join(h.bin, 'ps'), script(`process.stdout.write(${JSON.stringify(lines)})`), {
      mode: 0o755,
    })
    const clip = join(h.bin, 'clip.txt')
    for (const name of ['pbcopy', 'wl-copy', 'xclip'])
      await writeFile(
        join(h.bin, name),
        script(
          `let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(clip)},d))`,
        ),
        { mode: 0o755 },
      )
    return { env: { TMPDIR: tmp }, got, clip, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  it('delivers to a Claude session, asks for a paste elsewhere, and lists both', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"crossSessionInbound":"accept"}')
      try {
        const human = await sideby(h, ['send', 'cc002', 'the tests pass now'], m.env)
        assert.equal(human.code, 0, human.err)
        assert.match(
          human.out,
          /^✓ delivered to cc002 · knip cleanup · 61230c3d \(message [0-9a-f]{8}\)\n {2}Kept at ~\/\.local\/state\/sideby\/messages\//,
        )
        assert.equal(m.got.length, 1)
        assert.match(
          JSON.parse(m.got[0]!).message.content,
          /^sideby message [0-9a-f]{8} from the user via sideby\nthe tests pass now$/,
        )

        const g = await sideby(h, ['send', 'grok:main', 'read', 'the plan', '--json'], m.env)
        assert.equal(g.code, 0, g.err)
        const data = checkSchema('send', g.out)
        const msg = data.message as { status: string; pasteText: string; note: string; id: string }
        assert.equal(msg.status, 'paste-needed')
        assert.equal(data.copied, true)
        assert.equal(await readFile(m.clip, 'utf8'), msg.pasteText)
        assert.match(msg.note, /Grok Build cannot receive messages directly yet/)
        const gh = await sideby(h, ['send', 'grok:main', 'again'], m.env)
        assert.match(
          gh.out,
          /needs a paste\n {2}Grok Build cannot receive messages directly .*\n {2}Paste this into the tab of grok:main · g · 01a14d11 \(it is on the clipboard\):\n {2}Read the message sideby kept for you at /,
        )

        const list = checkSchema('messages', (await sideby(h, ['messages', '--json'])).out)
        assert.deepEqual(
          (list.messages as { status: string }[]).map((x) => x.status),
          ['paste-needed', 'paste-needed', 'delivered'],
        )
        const to = checkSchema('messages', (await sideby(h, ['messages', '--to', 'cc002', '--json'])).out)
        assert.equal((to.messages as unknown[]).length, 1)
        const table = await sideby(h, ['messages'])
        assert.match(table.out.split('\n')[0]!, /^SENT\s+TO\s+STATUS\s+ID\s+FROM$/)
        assert.match(table.out, /needs paste/)
        // Only the newest Message to grok:main is waiting there, so its line is printed once.
        assert.equal(table.out.match(/Paste this line into /g)?.length, 1)
        assert.match(
          table.out,
          /Paste this line into grok:main · g · 01a14d11 \(Grok Build cannot receive .*\):\n {2}Read the message sideby kept/,
        )

        const shot = await h.write('notes.txt', 'text')
        const bad = await sideby(h, ['send', 'cc002', 'look', '--image', shot], m.env)
        assert.equal(bad.code, 1)
        assert.match(bad.err, /notes\.txt is not a PNG, JPEG, GIF or WebP image/)
        assert.equal((await sideby(h, ['send', 'cc002'])).code, 2)
        const none = await sideby(h, ['send', 'nobody', 'x', '--json'], m.env)
        assert.equal(JSON.parse(none.out).code, 'no-session')
      } finally {
        await m.close()
      }
      const empty = await withFakeHome(async (e) => (await sideby(e, ['messages'])).out)
      assert.match(empty, /No messages yet\. Send one with `sideby send <account\|session> "<text>"`\./)
    })
  })

  it('shows and sets crossSessionInbound with a preview, --yes and undo', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"model":"x"}')
      await m.close()
      const status = await sideby(h, ['messages', 'inbound'])
      assert.equal(status.code, 0, status.err)
      assert.match(status.out, /not set claude:main/)
      assert.match(status.out, /Run `sideby messages inbound accept`/)
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['messages', 'inbound', 'accept'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /~\/\.claude-work\/settings\.json: crossSessionInbound not set -> "accept"/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const j = checkSchema(
        'messages-inbound',
        (await sideby(h, ['messages', 'inbound', 'accept', '--json'])).out,
      )
      assert.equal(j.applied, false)
      const groups = j.groups as { file: string; change?: unknown }[]
      assert.ok(groups.some((g) => g.file === '~/.claude-work/settings.json'))
      for (const g of groups)
        assert.deepEqual(g.change, { key: 'crossSessionInbound', from: null, to: 'accept' })
      assert.deepEqual(j.leftAlone, [])
      const done = await sideby(h, ['messages', 'inbound', 'accept', '--yes', '--json'])
      assert.equal(done.code, 0, done.out)
      assert.equal(checkSchema('messages-inbound', done.out).applied, true)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude-work/settings.json'), 'utf8')), {
        model: 'x',
        crossSessionInbound: 'accept',
      })
      const undo = await sideby(h, ['messages', 'inbound', 'undo', '--yes'])
      assert.equal(undo.code, 0, undo.out)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude-work/settings.json'), 'utf8')), {
        model: 'x',
      })
      assert.equal((await sideby(h, ['messages', 'inbound', 'maybe'])).code, 2)
    })
  })

  it('sends a screenshot alone, and says nothing changed when every account refuses', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h, '{"crossSessionInbound":"refuse"}')
      try {
        const shot = h.path('shot.png')
        await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
        const r = await sideby(h, ['send', 'cc002', '--image', shot, '--json'], m.env)
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('send', r.out).copied, true)
      } finally {
        await m.close()
      }
      await h.write('.claude/settings.json', '{"crossSessionInbound":"refuse"}')
      const a = await sideby(h, ['messages', 'inbound', 'accept', '--yes'])
      assert.equal(a.code, 1)
      assert.match(a.out, /^Nothing was changed\. claude:main: you set it to refuse/)
      await h.write('.claude-work/settings.json', '{"crossSessionInbound":"hold"}')
      const p = await sideby(h, ['messages', 'inbound', 'accept', '--json'])
      assert.equal(p.code, 10, p.out)
      const j = checkSchema('messages-inbound', p.out)
      assert.deepEqual(
        (j.groups as { change?: unknown }[]).map((g) => g.change),
        [{ key: 'crossSessionInbound', from: 'hold', to: 'accept' }],
      )
      const left = j.leftAlone as { accounts: string[]; state: string; reason: string }[]
      assert.deepEqual(
        left.map((g) => [g.accounts, g.state]),
        [[['claude:main'], 'refuse']],
      )
      assert.match(left[0]!.reason, /you set it to refuse/)
    })
  })

  it('lines up the sessions table by display width and cuts long titles', async () => {
    await withFakeHome(async (h) => {
      const m = await setUp(h)
      await m.close()
      await h.write(
        '.claude-work/sessions/4101.json',
        JSON.stringify({
          pid: 4101,
          sessionId: ID_A,
          name: '修复会话标题对齐问题',
          cwd: '/work/repo',
          status: 'idle',
          procStart: PROC_START,
        }),
      )
      await writeFile(
        h.path('.grok/active_sessions.json'),
        JSON.stringify([
          {
            session_id: ID_G,
            pid: 555,
            pid_start: Date.UTC(2026, 9, 20, 2, 14, 43) * 1000,
            cwd: `/work/${'a-very-long-directory-name-'.repeat(3)}`,
          },
        ]),
      )
      const r = await sideby(h, ['sessions'])
      assert.equal(r.code, 0, r.err)
      const rows = r.out.split('\n').filter((l) => / {2}(idle|—|running)/.test(l))
      assert.equal(rows.length, 2)
      // The status column starts at the same terminal column on both rows (a Chinese character takes two).
      const { displayWidth } = await import('./format.ts')
      const col = (l: string) => displayWidth(l.slice(0, l.search(/ {2}(idle|—|running)/)))
      assert.equal(col(rows[0]!), col(rows[1]!))
      assert.ok(r.out.includes('…'), 'a long title is cut')
      assert.ok(r.out.includes('修复会话标题对齐问题'))
    })
  })
})

it('colors each quota window by its own levels: a weekly 87% is yellow, a 5-hour 87% red (spec §3.26)', () => {
  const tty = process.stdout.isTTY
  const noColor = process.env.NO_COLOR
  try {
    process.stdout.isTTY = true
    delete process.env.NO_COLOR
    const now = new Date('2026-10-05T12:00:00Z')
    const soon = new Date(now.getTime() + 3600_000).toISOString()
    const text = quotaText(
      {
        status: 'ok',
        observedAt: now.toISOString(),
        source: 'test',
        windows: [
          { label: '5h', windowMinutes: 300, usedPercent: 87, resetsAt: soon },
          { label: '7d', windowMinutes: 10080, usedPercent: 87, resetsAt: soon },
          { label: '30d', windowMinutes: 43200, usedPercent: 96, resetsAt: soon },
        ],
      },
      now,
    )
    const esc = String.fromCharCode(27)
    assert.ok(text.includes(`5h ${esc}[31m87%`), 'red')
    assert.ok(text.includes(`7d ${esc}[33m87%`), 'yellow')
    assert.ok(text.includes(`30d ${esc}[31m96%`), 'red')
  } finally {
    process.stdout.isTTY = tty
    if (noColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = noColor
  }
})
