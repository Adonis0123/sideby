// Live Sessions (spec §3.32): every Family reader against a fake HOME and fake processes, the order, the `only`
// filter, the copy texts, and the tab title. No test looks at the machine's real processes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { UserError } from './errors.ts'
import { watchesTitle } from './launch.ts'
import {
  type LiveSession,
  listLiveSessions,
  type SessionCopyAs,
  sessionCopyText,
  sortSessions,
} from './live-sessions.ts'
import { type LiveSessionDeps, type ProcessInfo, parseLstart, parsePs } from './live-sessions-procs.ts'
import { sessionTitleOf, watchSessionTitle } from './live-sessions-title.ts'
import { pickSession } from './session-select.ts'

const START = Date.UTC(2026, 9, 20, 2, 14, 43)
const PROC_START = 'Tue Oct 20 02:14:43 2026'
const ID1 = '61230c3d-1111-4111-8111-111111111111'
const ID2 = '0799701d-2222-4222-8222-222222222222'
const ID3 = '01a14d11-3333-4333-8333-333333333333'
const ID4 = '01a157ef-4444-4444-8444-444444444444'
const ID5 = '01a15823-5555-4555-8555-555555555555'
const ID6 = '01a11fc9-6666-4666-8666-666666666666'
const SECRET = 'fake-SECRET-value-must-not-appear'

const proc = (pid: number, command: string, ppid = 1, startMs = START): ProcessInfo => ({
  pid,
  ppid,
  startMs,
  command,
})

function fakeDeps(
  procs: ProcessInfo[],
  env: Record<number, Record<string, string>> = {},
  open: Record<number, string[]> = {},
): LiveSessionDeps & { envAsked: string[] } {
  const envAsked: string[] = []
  return {
    envAsked,
    processes: async () => procs,
    envVar: async (pid, name) => {
      envAsked.push(name)
      return env[pid]?.[name]
    },
    openFiles: async (pid) => open[pid] ?? [],
  }
}

/** Every Family with a Main Account and one more, credential files filled with a value that must never show. */
async function homeWithAccounts(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-002/settings.json', '{}')
  await h.write('.claude-002/.claude.json', `{"oauthAccount":"${SECRET}"}`)
  await h.write('.claude.json', `{"token":"${SECRET}"}`)
  await h.write('.codex/config.toml', 'model = "m"\n')
  await h.write('.codex/auth.json', `{"token":"${SECRET}"}`)
  await h.write('.codex-team/config.toml', 'model = "m"\n')
  await h.mkdir('.grok/skills')
  await h.write('.grok/auth.json', `{"token":"${SECRET}"}`)
  await h.write('.pi/agent/AGENTS.md', '# rules\n')
  await h.write('.pi/agent/auth.json', `{"token":"${SECRET}"}`)
  await h.write('.claude-api/proxy.env', `ANTHROPIC_API_KEY=${SECRET}\n`)
  await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:002' } }))
}

async function claudeSession(h: FakeHome, dir: string, pid: number, rec: Record<string, unknown>) {
  await h.write(`${dir}/sessions/${pid}.json`, JSON.stringify({ pid, procStart: PROC_START, ...rec }))
}

const rollout = (id: string, cwd: string) =>
  `${JSON.stringify({ timestamp: '2026-10-20T06:11:32.141Z', type: 'session_meta', payload: { id, timestamp: '2026-10-20T06:11:32.141Z', cwd, base_instructions: 'x'.repeat(200) } })}\n`

describe('Live Sessions of every Family (spec §3.32)', () => {
  it('reads each Family, skips dead and reused pids, reports malformed files and never reads a credential', async () => {
    await withFakeHome(async (h) => {
      await homeWithAccounts(h)
      // Claude: alive and waiting for a permission; dead pid; reused pid; malformed; the main account has none.
      await claudeSession(h, '.claude-002', 111, {
        sessionId: ID1,
        name: 'knip cleanup',
        cwd: '/work/repo',
        status: 'blocked',
        startedAt: START,
        updatedAt: START + 1000,
      })
      await h.write(`.claude-002/projects/-work-repo/${ID1}.jsonl`, '{}\n')
      await claudeSession(h, '.claude-002', 222, { sessionId: ID2, cwd: '/work/dead', status: 'idle' })
      await claudeSession(h, '.claude-002', 333, {
        sessionId: ID2,
        cwd: '/work/reused',
        status: 'idle',
        procStart: 'Tue Oct 20 01:00:00 2026',
      })
      await h.write('.claude-002/sessions/444.json', '{not json')
      // Grok: one live entry with its own title.
      await h.write(
        '.grok/active_sessions.json',
        JSON.stringify([
          {
            session_id: ID3,
            pid: 555,
            pid_start: START * 1000 + 823112,
            cwd: '/work/g',
            opened_at: '2026-10-20T02:14:53Z',
          },
          { session_id: ID2, pid: 556, pid_start: START * 1000, cwd: '/work/gone' },
          { session_id: ID5, pid: 557, pid_start: (START - 3_600_000) * 1000, cwd: '/work/reused' },
        ]),
      )
      await h.write(
        `.grok/sessions/${encodeURIComponent('/work/g')}/${ID3}/summary.json`,
        JSON.stringify({ generated_title: 'Name the bot', updated_at: '2026-10-20T06:34:44Z' }),
      )
      await h.write(`.grok/sessions/${encodeURIComponent('/work/g')}/${ID3}/chat_history.jsonl`, '')
      // Codex main: the rollout its process holds open; codex:team: only a guess. A server process is ignored.
      const open = await h.write(
        `.codex/sessions/2026/10/20/rollout-2026-10-20T14-11-32-${ID4}.jsonl`,
        rollout(ID4, '/work/c'),
      )
      await h.write(
        '.codex/session_index.jsonl',
        `${JSON.stringify({ id: ID4, thread_name: 'fix quota' })}\n`,
      )
      await h.write(
        `.codex-team/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`,
        rollout(ID2, '/work/old'),
      )
      await h.write(
        `.codex-team/sessions/2026/10/20/rollout-2026-10-20T10-00-00-${ID5}.jsonl`,
        rollout(ID5, '/work/t'),
      )
      await fsp.utimes(
        h.path(`.codex-team/sessions/2026/10/19/rollout-2026-10-19T10-00-00-${ID2}.jsonl`),
        1,
        1,
      )
      // pi: started through node; newest session file is a guess.
      await h.write(
        `.pi/agent/sessions/--work-p--/2026-10-09T08-31-17-282Z_${ID6}.jsonl`,
        `${JSON.stringify({ type: 'session', version: 3, id: ID6, timestamp: '2026-10-09T08:31:17.282Z', cwd: '/work/p' })}\n`,
      )
      const at = (iso: string) => new Date(iso)
      await fsp.utimes(open, at('2026-10-20T06:00:00Z'), at('2026-10-20T06:00:00Z'))
      await fsp.utimes(
        h.path(`.codex-team/sessions/2026/10/20/rollout-2026-10-20T10-00-00-${ID5}.jsonl`),
        at('2026-10-20T05:00:00Z'),
        at('2026-10-20T05:00:00Z'),
      )
      await fsp.utimes(
        h.path(`.pi/agent/sessions/--work-p--/2026-10-09T08-31-17-282Z_${ID6}.jsonl`),
        at('2026-10-09T09:00:00Z'),
        at('2026-10-09T09:00:00Z'),
      )
      const deps = fakeDeps(
        [
          proc(111, 'claude --dangerously-skip-permissions'),
          proc(333, 'claude'),
          proc(444, 'claude'),
          proc(555, 'grok --resume x'),
          proc(557, 'grok'),
          proc(700, '/opt/codex/bin/codex'),
          proc(701, '/opt/codex/bin/codex app-server --listen unix://'),
          proc(702, 'codex resume'),
          proc(800, 'node /usr/local/bin/pi'),
        ],
        { 700: {}, 701: {}, 702: { CODEX_HOME: h.path('.codex-team') }, 800: {} },
        { 700: [open, '/dev/null'] },
      )

      const read: string[] = []
      const spy = (orig: (...a: never[]) => unknown) =>
        function (this: unknown, p: unknown, ...rest: never[]) {
          read.push(String(p))
          return (orig as (...a: unknown[]) => unknown).call(this, p, ...rest)
        }
      const origRead = fsp.readFile
      const origOpen = fsp.open
      const origStream = fs.createReadStream
      fsp.readFile = spy(origRead as never) as typeof fsp.readFile
      fsp.open = spy(origOpen as never) as typeof fsp.open
      fs.createReadStream = spy(origStream as never) as typeof fs.createReadStream
      syncBuiltinESMExports()
      let r: Awaited<ReturnType<typeof listLiveSessions>>
      try {
        const rt = await createRuntime({ env: h.env })
        read.length = 0
        r = await listLiveSessions(rt, {}, deps)
      } finally {
        fsp.readFile = origRead
        fsp.open = origOpen
        fs.createReadStream = origStream
        syncBuiltinESMExports()
      }

      const credential = read.filter((p) => ['auth.json', '.claude.json', 'proxy.env'].includes(basename(p)))
      assert.deepEqual(credential, [], 'a credential file was opened')
      assert.ok(
        read.some((p) => p.endsWith('summary.json')),
        'the spy saw no reads at all',
      )
      assert.ok(!JSON.stringify(r).includes(SECRET))
      // Only the two variables that tie a process to an Account were asked for.
      assert.deepEqual([...new Set(deps.envAsked)].sort(), ['CODEX_HOME', 'PI_CODING_AGENT_DIR'])

      const by = (id: string) => r.sessions.find((s) => s.sessionId === id)
      assert.deepEqual(
        r.sessions.map((s) => s.label),
        [
          'cc002 · knip cleanup · 61230c3d',
          'grok:main · Name the bot · 01a14d11',
          'codex:main · fix quota · 01a157ef',
          'codex:team · t · 01a15823',
          'pi:main · p · 01a11fc9',
        ],
      )
      const cc = by(ID1)!
      assert.equal(cc.status, 'needs-you')
      assert.equal(cc.account, 'claude:002')
      assert.equal(cc.accountLabel, 'cc002')
      assert.equal(cc.pid, 111)
      assert.equal(cc.guessed, false)
      assert.equal(cc.transcript, h.path(`.claude-002/projects/-work-repo/${ID1}.jsonl`))
      assert.equal(cc.resumeCommand, `sideby resume claude -- --resume ${ID1}`)
      assert.equal(
        by(ID3)!.transcript,
        h.path(`.grok/sessions/${encodeURIComponent('/work/g')}/${ID3}/chat_history.jsonl`),
      )
      assert.equal(by(ID4)!.guessed, false)
      assert.equal(by(ID4)!.pid, 700)
      assert.equal(by(ID4)!.resumeCommand, `sideby resume codex -- resume ${ID4}`)
      assert.equal(by(ID5)!.guessed, true)
      assert.equal(by(ID6)!.guessed, true)
      assert.equal(by(ID6)!.resumeCommand, `sideby run pi:main -- --session ${ID6}`)
      assert.equal(r.problems.length, 1)
      assert.match(r.problems[0]!, /claude:002: could not read .*444\.json/)
      // Nothing is deleted: dead and reused records stay.
      await fsp.access(h.path('.claude-002/sessions/222.json'))
      await fsp.access(h.path('.claude-002/sessions/333.json'))
    })
  })

  it('narrows to a Family or an Account, and reports missing ps without throwing', async () => {
    await withFakeHome(async (h) => {
      await homeWithAccounts(h)
      await claudeSession(h, '.claude-002', 111, { sessionId: ID1, cwd: '/w/a', status: 'idle' })
      await claudeSession(h, '.claude', 112, { sessionId: ID2, cwd: '/w/b', status: 'busy' })
      const deps = fakeDeps([proc(111, 'claude'), proc(112, 'claude')])
      const rt = await createRuntime({ env: h.env })
      const fam = await listLiveSessions(rt, { only: 'claude' }, deps)
      assert.equal(fam.sessions.length, 2)
      const one = await listLiveSessions(rt, { only: 'cc002' }, deps)
      assert.deepEqual(
        one.sessions.map((s) => s.sessionId),
        [ID1],
      )
      const none = await listLiveSessions(rt, { only: 'codex' }, deps)
      assert.deepEqual(none, { sessions: [], problems: [] })
      await assert.rejects(listLiveSessions(rt, { only: 'nobody' }, deps), /no account named nobody/)
      const broken = await listLiveSessions(
        rt,
        {},
        {
          ...deps,
          processes: async () => {
            throw new Error('`ps` is not on PATH')
          },
        },
      )
      assert.deepEqual(broken.sessions, [])
      assert.match(broken.problems[0]!, /could not list running programs .*needs `ps` on PATH/)
    })
  })

  it('has no Live Sessions where an Account has no session directory, and names a malformed Grok list', async () => {
    await withFakeHome(async (h) => {
      await homeWithAccounts(h)
      const rt = await createRuntime({ env: h.env })
      const deps = fakeDeps([proc(111, 'claude'), proc(700, 'codex'), proc(800, 'pi')])
      // codex and pi run, but neither Account has a session file yet.
      assert.deepEqual(await listLiveSessions(rt, {}, deps), { sessions: [], problems: [] })
      await h.write('.grok/active_sessions.json', '[{"session_id":')
      const r = await listLiveSessions(rt, {}, deps)
      assert.deepEqual(r.sessions, [])
      assert.match(
        r.problems[0]!,
        /^grok:main: could not read .*active_sessions\.json; Grok Build rewrites it/,
      )
    })
  })
})

const session = (over: Partial<LiveSession>): LiveSession => ({
  account: 'claude:002',
  accountLabel: 'cc002',
  family: 'claude',
  sessionId: ID1,
  title: 'knip cleanup',
  label: 'cc002 · knip cleanup · 61230c3d',
  status: 'idle',
  cwd: '/work/repo',
  guessed: false,
  transcript: '/home/.claude-002/projects/-work-repo/x.jsonl',
  resumeCommand: `sideby resume claude -- --resume ${ID1}`,
  reference: '',
  ...over,
})

describe('order and copy texts', () => {
  it('puts sessions that need the user first, then the most recent', () => {
    const list = sortSessions([
      session({ sessionId: 'a', label: 'a', updatedAt: '2026-10-20T10:00:00Z' }),
      session({ sessionId: 'b', label: 'b', updatedAt: '2026-10-20T08:00:00Z', status: 'needs-you' }),
      session({ sessionId: 'c', label: 'c', startedAt: '2026-10-20T11:00:00Z' }),
    ])
    assert.deepEqual(
      list.map((s) => s.sessionId),
      ['b', 'c', 'a'],
    )
  })

  it('copies the reference in English and Chinese, the id and the resume command', () => {
    const s = session({})
    const text = (as: SessionCopyAs, lang: 'en' | 'zh') => sessionCopyText(s, as, lang)
    assert.equal(
      text('reference', 'en'),
      "cc002's session 61230c3d (knip cleanup), working directory /work/repo, record at /home/.claude-002/projects/-work-repo/x.jsonl. Read its record for the context.",
    )
    assert.equal(
      text('reference', 'zh'),
      'cc002 的会话 61230c3d（knip cleanup），工作目录 /work/repo，记录在 /home/.claude-002/projects/-work-repo/x.jsonl。去读它的记录了解上下文。',
    )
    assert.equal(text('id', 'zh'), ID1)
    assert.equal(text('resume', 'en'), `sideby resume claude -- --resume ${ID1}`)
    const bare = session({ transcript: undefined, cwd: undefined, guessed: true })
    assert.equal(
      sessionCopyText(bare, 'reference', 'en'),
      `cc002's session 61230c3d (knip cleanup) (its newest session, a guess). Resume it with \`sideby resume claude -- --resume ${ID1}\`.`,
    )
    assert.equal(
      sessionCopyText(bare, 'reference', 'zh'),
      `cc002 的会话 61230c3d（knip cleanup）（最新会话，推测）。用 \`sideby resume claude -- --resume ${ID1}\` 恢复它。`,
    )
  })

  it('picks one session by id or Account, and lists several instead of guessing', () => {
    const a = session({ sessionId: ID1, label: 'cc002 · a · 61230c3d' })
    const b = session({ sessionId: ID2, label: 'cc002 · b · 0799701d' })
    const acc = { ref: 'claude:002', label: 'cc002' }
    assert.equal(pickSession('61230c3d', [a, b], undefined), a)
    assert.equal(pickSession(ID2, [a, b], undefined), b)
    assert.equal(pickSession('cc002', [a], acc), a)
    assert.throws(
      () => pickSession('cc002', [a, b], acc),
      (e: unknown) =>
        e instanceof UserError &&
        e.code === 'several-sessions' &&
        /cc002 runs 2 sessions now; copy one by its id:\n {2}sideby sessions copy 61230c3d/.test(e.message),
    )
    assert.throws(
      () => pickSession('cc002', [], acc),
      /cc002 has no running session now; start one with `sideby run cc002`/,
    )
    assert.throws(() => pickSession('zzz', [a], undefined), /no running session or account named zzz/)
  })
})

describe('process listing', () => {
  it('reads ps lines in UTC and Claude Code procStart the same way', () => {
    assert.equal(parseLstart(PROC_START), START)
    assert.ok(Number.isNaN(parseLstart('yesterday')))
    assert.deepEqual(parsePs(`  111     1 ${PROC_START}     claude --resume x\nbad line\n`), [
      { pid: 111, ppid: 1, startMs: START, command: 'claude --resume x' },
    ])
  })
})

describe('tab title (spec §3.32)', () => {
  const account: Account = {
    family: 'claude',
    name: '002',
    ref: 'claude:002',
    dir: '',
    isMain: false,
    kind: 'subscription',
  }

  it('grows only for a known Account on a terminal with accountTitle on', () => {
    const base = { family: {} as never, bin: 'claude', args: [], env: {} }
    assert.equal(watchesTitle({ ...base, title: '[cc002]', account }, true), true)
    assert.equal(watchesTitle({ ...base, title: '[cc002]', account }, false), false)
    assert.equal(watchesTitle({ ...base, title: '[cc002]', account }, undefined), false)
    assert.equal(watchesTitle({ ...base, account }, true), false)
    assert.equal(watchesTitle({ ...base, title: '[cc002]' }, true), false)
  })

  it('finds the session of this Host process or one under it, never a guess', async () => {
    await withFakeHome(async (h) => {
      const acc = { ...account, dir: h.path('.claude-002') }
      await claudeSession(h, '.claude-002', 901, {
        sessionId: ID1,
        name: 'knip cleanup',
        cwd: '/w/r',
        status: 'idle',
      })
      await claudeSession(h, '.claude-002', 950, {
        sessionId: ID2,
        name: 'other tab',
        cwd: '/w/o',
        status: 'idle',
      })
      const deps = fakeDeps([proc(900, 'sh -c claude'), proc(901, 'claude', 900), proc(950, 'claude')])
      assert.equal(
        await sessionTitleOf({ account: acc, accountLabel: 'cc002', pid: 900, deps }),
        '[cc002 · knip cleanup · 61230c3d]',
      )
      assert.equal(await sessionTitleOf({ account: acc, accountLabel: 'cc002', pid: 999, deps }), undefined)
    })
  })

  it('writes once per change and nothing before the session exists', async () => {
    await withFakeHome(async (h) => {
      const acc = { ...account, dir: h.path('.claude-002') }
      const deps = fakeDeps([proc(901, 'claude')])
      const written: string[] = []
      const tick = () => new Promise((r) => setTimeout(r, 40))
      const stop = watchSessionTitle({
        account: acc,
        accountLabel: 'cc002',
        pid: 901,
        deps,
        write: (t) => written.push(t),
        firstMs: 1,
        everyMs: 10,
      })
      try {
        await tick()
        assert.deepEqual(written, [], 'a title was written before the session existed')
        await claudeSession(h, '.claude-002', 901, { sessionId: ID1, name: 'knip cleanup', cwd: '/w/r' })
        await tick()
        await tick()
        assert.deepEqual(written, ['[cc002 · knip cleanup · 61230c3d]'])
        await claudeSession(h, '.claude-002', 901, { sessionId: ID1, name: 'renamed', cwd: '/w/r' })
        await tick()
        await tick()
        assert.deepEqual(written, ['[cc002 · knip cleanup · 61230c3d]', '[cc002 · renamed · 61230c3d]'])
      } finally {
        stop()
      }
      const after = written.length
      await claudeSession(h, '.claude-002', 901, { sessionId: ID2, name: 'later', cwd: join('/w', 'r') })
      await tick()
      assert.equal(written.length, after, 'it kept checking after it was stopped')
    })
  })
})

describe('Claude session title (spec §3.32)', () => {
  it("prefers a name the user gave, then Claude Code's own ai-title, then the derived name", async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-002/settings.json', '{}')
      await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:002' } }))
      const transcriptOf = (id: string) => `.claude-002/projects/-work-repo/${id}.jsonl`
      await claudeSession(h, '.claude-002', 111, {
        sessionId: ID1,
        name: 'repo-3f',
        nameSource: 'derived',
        cwd: '/work/repo',
        status: 'idle',
      })
      await h.write(
        transcriptOf(ID1),
        [
          JSON.stringify({ type: 'ai-title', aiTitle: 'first guess', sessionId: ID1 }),
          JSON.stringify({ type: 'user', message: { content: `"ai-title" ${SECRET}` } }),
          JSON.stringify({ type: 'ai-title', aiTitle: '第5项任务分工', sessionId: ID1 }),
          '{"type":"ai-ti',
        ].join('\n'),
      )
      await claudeSession(h, '.claude-002', 222, {
        sessionId: ID2,
        name: 'payments',
        nameSource: 'user',
        cwd: '/work/repo',
        status: 'idle',
      })
      await h.write(
        transcriptOf(ID2),
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'ignored', sessionId: ID2 })}\n`,
      )
      await claudeSession(h, '.claude-002', 333, {
        sessionId: ID3,
        name: 'repo-a1',
        nameSource: 'derived',
        cwd: '/work/repo',
        status: 'idle',
      })
      const rt = await createRuntime({ env: h.env })
      const r = await listLiveSessions(
        rt,
        { only: 'claude' },
        fakeDeps([proc(111, 'claude'), proc(222, 'claude'), proc(333, 'claude')]),
      )
      const title = (id: string) => r.sessions.find((s) => s.sessionId === id)?.title
      assert.equal(title(ID1), '第5项任务分工')
      assert.equal(title(ID2), 'payments')
      assert.equal(title(ID3), 'repo-a1')
      assert.ok(!JSON.stringify(r).includes(SECRET))
    })
  })
})
