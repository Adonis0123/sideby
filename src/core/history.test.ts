// Session History (spec §3.33, ADR-0042): building the History Index from fake Host records, searching it (Chinese,
// short words, every word must match), filters, reading one Session, the index file's modes, `history.index: false`,
// what the database never holds, and the tool-output scan.
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import {
  closeHistory,
  historyIndexInfo,
  historyIndexPath,
  historyProjects,
  historyShow,
  projectsNamed,
  scanToolOutput,
  searchHistory,
  snippetOf,
  syncHistory,
} from './history.ts'
import { ProjectResolver } from './history-project.ts'

const A = 'aaaa1111-0000-4000-8000-000000000001' // claude:main, app, 登录页
const B = 'bbbb2222-0000-4000-8000-000000000002' // claude:main, web, dark mode; tool output only word
const C = 'cccc3333-0000-4000-8000-000000000003' // codex:main, app/src, login form
const D = 'dddd4444-0000-4000-8000-000000000004' // claude:main, web, 250 messages, old
const S = 'eeee5555-0000-4000-8000-000000000005' // claude:main, SDK script
const TOOL_WORD = 'ZEBRAFROGTOOL'
const ACCOUNT_ID = 'acct-FAKE-ACCOUNT-ID'

const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const DAY = 86_400_000

function claudeTurns(
  sid: string,
  cwd: string,
  turns: [string, string][],
  at: (i: number) => string,
  extra = {},
) {
  return turns.flatMap(([q, a], i) => [
    {
      type: 'user',
      sessionId: sid,
      cwd,
      entrypoint: 'cli',
      timestamp: at(i),
      message: { content: q },
      ...extra,
    },
    {
      type: 'assistant',
      sessionId: sid,
      timestamp: at(i),
      message: { model: 'claude-opus-4-5', content: [{ type: 'text', text: a }] },
    },
  ])
}

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.codex/config.toml', 'model = "gpt-main"\n')
  const app = await h.mkdir('code/app')
  await h.mkdir('code/app/.git')
  await h.mkdir('code/app/src')
  const web = await h.mkdir('code/web')
  await h.write(
    `.claude/projects/-code-app/${A}.jsonl`,
    jsonl([
      ...claudeTurns(
        A,
        app,
        [['我想修一下登录页面的按钮', 'The login handler was wrong; fixed it.']],
        () => ago(MIN),
        {
          gitBranch: 'feat/login',
        },
      ),
    ]),
  )
  await h.write(
    `.claude/projects/-code-app/${A}/subagents/agent-x1.jsonl`,
    jsonl([
      {
        type: 'user',
        sessionId: A,
        isSidechain: true,
        cwd: app,
        timestamp: ago(MIN),
        message: { content: 'search the router for widgets' },
      },
      {
        type: 'assistant',
        sessionId: A,
        isSidechain: true,
        timestamp: ago(MIN),
        message: { content: [{ type: 'text', text: 'Found widgets.' }] },
      },
    ]),
  )
  await h.write(
    `.claude/projects/-code-web/${B}.jsonl`,
    jsonl([
      {
        type: 'user',
        sessionId: B,
        cwd: web,
        timestamp: ago(20 * DAY),
        message: { content: 'add dark mode (暗色) to the UI' },
      },
      {
        type: 'assistant',
        sessionId: B,
        timestamp: ago(20 * DAY),
        message: {
          content: [
            { type: 'text', text: 'Reading the theme.' },
            { type: 'tool_use', name: 'Bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        sessionId: B,
        timestamp: ago(20 * DAY),
        message: { content: [{ type: 'tool_result', content: `output ${TOOL_WORD} here` }] },
        toolUseResult: { stdout: `output ${TOOL_WORD} here` },
      },
      {
        type: 'assistant',
        sessionId: B,
        timestamp: ago(20 * DAY),
        message: { content: [{ type: 'text', text: 'Dark mode is on.' }] },
      },
    ]),
  )
  const many: [string, string][] = Array.from({ length: 125 }, (_, i) => [
    `question ${i + 1}`,
    `answer ${i + 1}`,
  ])
  await h.write(
    `.claude/projects/-code-web/${D}.jsonl`,
    jsonl(claudeTurns(D, web, many, () => ago(60 * DAY))),
  )
  await h.write(
    `.claude/projects/-code-tool/${S}.jsonl`,
    jsonl([
      {
        type: 'user',
        sessionId: S,
        cwd: web,
        entrypoint: 'sdk-ts',
        timestamp: ago(2 * MIN),
        message: { content: 'scripted login check' },
      },
      {
        type: 'assistant',
        sessionId: S,
        timestamp: ago(2 * MIN),
        message: { content: [{ type: 'text', text: 'ok' }] },
      },
    ]),
  )
  await h.write(
    `.codex/sessions/2026/10/17/rollout-2026-10-17T08-00-00-${C}.jsonl`,
    jsonl([
      {
        timestamp: ago(3 * DAY),
        type: 'session_meta',
        payload: {
          id: C,
          cwd: h.path('code/app/src'),
          source: 'cli',
          originator: 'codex_cli_rs',
          account_id: ACCOUNT_ID,
          instructions: 'INSTRUCTIONS_SECRET',
        },
      },
      {
        timestamp: ago(3 * DAY),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'fix login page form' }],
        },
      },
      {
        timestamp: ago(3 * DAY),
        type: 'response_item',
        payload: { type: 'function_call_output', output: `TOOL_OUTPUT_CODEX ${ACCOUNT_ID}` },
      },
      {
        timestamp: ago(3 * DAY),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Form fixed.' }],
        },
      },
    ]),
  )
  return { app, web }
}

async function withHistory(
  fn: (
    h: FakeHome,
    rt: Awaited<ReturnType<typeof createRuntime>>,
    dirs: { app: string; web: string },
  ) => Promise<void>,
) {
  await withFakeHome(async (h) => {
    const dirs = await seed(h)
    const rt = await createRuntime({ env: h.env })
    try {
      await fn(h, rt, dirs)
    } finally {
      await closeHistory(rt)
    }
  })
}

const ids = (r: { sessions: { sessionId: string }[] }) => r.sessions.map((s) => s.sessionId).sort()

describe('Session History', () => {
  it('builds the index and lists top-level sessions newest first, scripts only when asked', async () => {
    await withHistory(async (_h, rt, { app }) => {
      const r = await searchHistory(rt, {}, { wait: true })
      assert.equal(r.state, 'ready')
      assert.deepEqual(
        r.sessions.map((s) => s.sessionId),
        [A, C, B, D],
      )
      assert.equal(r.total, 4)
      const a = r.sessions[0]!
      assert.equal(a.project, app)
      assert.equal(a.projectName, 'app')
      assert.equal(a.branch, 'feat/login')
      assert.equal(a.children, 1)
      assert.equal(a.account, 'claude:main')
      assert.equal(a.title, '我想修一下登录页面的按钮')
      assert.match(a.continueCommand, /^cd .+ && sideby run claude:main -- --resume aaaa1111-/)
      assert.equal(r.sessions[1]!.project, app, 'a subfolder folds into its repository')
      const withScripts = await searchHistory(rt, { scripts: true })
      assert.ok(withScripts.sessions.some((s) => s.sessionId === S && s.script))
      const sources = Object.fromEntries(r.sources.map((s) => [s.account, s.sessions]))
      assert.deepEqual(sources, { 'claude:main': 5, 'codex:main': 1 })
    })
  })

  it('says why an Account shows no sessions', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-work/settings.json', '{}')
      await h.write(
        '.claude-lab/projects/-x/1111aaaa-0000-4000-8000-000000000009.jsonl',
        jsonl([{ type: 'summary', summary: 'nothing typed', leafUuid: 'u1' }]),
      )
      const rt = await createRuntime({ env: h.env })
      try {
        const r = await searchHistory(rt, {}, { wait: true })
        const why = Object.fromEntries(r.sources.map((x) => [x.account, x.reason ?? null]))
        assert.deepEqual(why, {
          'claude:main': 'empty',
          'claude:work': 'empty',
          'claude:lab': 'no-conversation',
        })
        assert.equal(
          r.sources.find((x) => x.account === 'claude:lab')!.note,
          'its records hold no conversation yet',
        )
      } finally {
        await closeHistory(rt)
      }
    })
  })

  it('finds a Chinese word inside longer text, and one- and two-character words', async () => {
    await withHistory(async (_h, rt) => {
      const zh = await searchHistory(rt, { q: '登录页' }, { wait: true })
      assert.deepEqual(ids(zh), [A])
      assert.match(zh.sessions[0]!.snippet ?? '', /登录页/)
      assert.deepEqual(ids(await searchHistory(rt, { q: '登录' })), [A])
      assert.deepEqual(ids(await searchHistory(rt, { q: '修' })), [A])
      assert.deepEqual(ids(await searchHistory(rt, { q: '暗色' })), [B])
    })
  })

  it('needs every word to match, and lifts a subagent match to its parent', async () => {
    await withHistory(async (_h, rt) => {
      assert.deepEqual(ids(await searchHistory(rt, { q: 'login' }, { wait: true })), [A, C])
      assert.deepEqual(ids(await searchHistory(rt, { q: 'login form' })), [C])
      assert.deepEqual(ids(await searchHistory(rt, { q: 'login 暗色' })), [])
      assert.deepEqual(ids(await searchHistory(rt, { q: 'widgets' })), [A])
      // The script also says "login", and shows only with scripts.
      assert.deepEqual(ids(await searchHistory(rt, { q: 'login', scripts: true })), [A, C, S].sort())
    })
  })

  it('filters by project, AI, account and time', async () => {
    await withHistory(async (_h, rt, { app, web }) => {
      assert.deepEqual(ids(await searchHistory(rt, { project: 'app' }, { wait: true })), [A, C])
      assert.deepEqual(ids(await searchHistory(rt, { project: web })), [B, D])
      assert.deepEqual(ids(await searchHistory(rt, { project: `${app}/` })), [A, C])
      assert.deepEqual(ids(await searchHistory(rt, { family: 'codex' })), [C])
      assert.deepEqual(ids(await searchHistory(rt, { account: 'claude:main' })), [A, B, D])
      assert.deepEqual(ids(await searchHistory(rt, { since: '7d' })), [A, C])
      assert.deepEqual(ids(await searchHistory(rt, { since: '30d' })), [A, B, C])
      assert.deepEqual(ids(await searchHistory(rt, { since: 'all' })), [A, B, C, D])
      assert.deepEqual(ids(await searchHistory(rt, { q: 'login', family: 'claude' })), [A])
      await assert.rejects(searchHistory(rt, { project: 'nope' }), /no project named "nope"/)
      await assert.rejects(searchHistory(rt, { family: 'nope' }), /unknown AI "nope"/)
      // A time the CLI and the Panel would refuse is refused here too, not read as 30 days.
      await assert.rejects(searchHistory(rt, { since: '3d' as '7d' }), /unknown time "3d"/)
      await assert.rejects(historyProjects(rt, { since: '3d' as '7d' }), /unknown time "3d"/)
      assert.deepEqual(ids(await searchHistory(rt, { project: '~/code/app' })), [A, C])
      const p = await historyProjects(rt)
      assert.deepEqual(
        p.projects.map((x) => [x.name, x.sessions]),
        [
          ['app', 2],
          ['web', 2],
        ],
      )
    })
  })

  it('shows the newest 200 messages and the ones before', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      const last = await historyShow(rt, D.slice(0, 8))
      assert.equal(last.session.sessionId, D)
      assert.equal(last.messages.length, 200)
      assert.equal(last.messages[0]!.n, 51)
      assert.equal(last.messages.at(-1)!.text, 'answer 125')
      assert.equal(last.before, 51)
      const earlier = await historyShow(rt, D, { before: last.before! })
      assert.equal(earlier.messages.length, 50)
      assert.deepEqual([earlier.messages[0]!.n, earlier.messages[0]!.text], [1, 'question 1'])
      assert.equal(earlier.before, undefined)
      assert.equal((await historyShow(rt, D, { limit: 10 })).messages.length, 10)
      await assert.rejects(historyShow(rt, 'ffff0000'), /no session "ffff0000"/)
      // Fewer than eight characters is never a prefix.
      await assert.rejects(historyShow(rt, D.slice(0, 7)), /no session/)
    })
  })

  it('keeps the index at mode 600 in a 700 folder, and never stores tool output or account ids', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      const path = historyIndexPath(rt)
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
      await closeHistory(rt)
      let bytes = ''
      for (const p of [path, `${path}-wal`]) bytes += await readFile(p, 'latin1').catch(() => '')
      for (const secret of [TOOL_WORD, ACCOUNT_ID, 'TOOL_OUTPUT_CODEX', 'INSTRUCTIONS_SECRET'])
        assert.ok(!bytes.includes(secret), secret)
      assert.ok(Buffer.from(bytes, 'latin1').includes(Buffer.from('dark mode')), 'prompts are stored')
    })
  })

  it('finds a word that is only in tool output when asked, keeping nothing', async () => {
    await withHistory(async (_h, rt) => {
      assert.deepEqual(ids(await searchHistory(rt, { q: TOOL_WORD }, { wait: true })), [])
      const hits = []
      for await (const hit of scanToolOutput(rt, { q: TOOL_WORD })) hits.push(hit)
      assert.deepEqual(
        hits.map((x) => x.session.sessionId),
        [B],
      )
      assert.match(hits[0]!.snippet, new RegExp(TOOL_WORD))
      assert.equal(hits[0]!.session.live, false)
      const marked = []
      for await (const hit of scanToolOutput(rt, { q: TOOL_WORD }, { live: new Set([`claude:main\0${B}`]) }))
        marked.push(hit)
      assert.equal(marked[0]?.session.live, true)
      const lower = []
      for await (const hit of scanToolOutput(rt, { q: TOOL_WORD.toLowerCase(), family: 'codex' }))
        lower.push(hit)
      assert.equal(lower.length, 0)
      const ac = new AbortController()
      ac.abort()
      const none = []
      for await (const hit of scanToolOutput(rt, { q: TOOL_WORD }, { signal: ac.signal })) none.push(hit)
      assert.equal(none.length, 0)
    })
  })

  it('reads the Hosts read-only', async () => {
    await withHistory(async (h, rt) => {
      const before = await snapshot(h.path('.claude'))
      const codex = await snapshot(h.path('.codex'))
      await searchHistory(rt, { q: 'login' }, { wait: true })
      await historyShow(rt, A)
      for await (const _ of scanToolOutput(rt, { q: TOOL_WORD })) {
        // drain
      }
      assert.deepEqual(await snapshot(h.path('.claude')), before)
      assert.deepEqual(await snapshot(h.path('.codex')), codex)
    })
  })

  it('with history.index false deletes the file and still lists sessions by title and folder', async () => {
    await withHistory(async (h, rt) => {
      assert.deepEqual(ids(await searchHistory(rt, { q: 'theme' }, { wait: true })), [B])
      const path = historyIndexPath(rt)
      await stat(path)
      await h.write('.config/sideby/config.json', JSON.stringify({ history: { index: false } }))
      const off = await createRuntime({ env: h.env })
      try {
        const r = await searchHistory(off, {}, { wait: true })
        assert.equal(r.state, 'off')
        assert.deepEqual(ids(r), [A, B, C, D])
        await assert.rejects(stat(path), { code: 'ENOENT' })
        // Titles and folders are searched; the text of replies is not kept.
        assert.deepEqual(ids(await searchHistory(off, { q: '登录页' })), [A])
        assert.deepEqual(ids(await searchHistory(off, { q: 'theme' })), [])
        const info = await historyIndexInfo(off, { wait: true })
        assert.equal(info.enabled, false)
        assert.equal(info.bytes, 0)
        await assert.rejects(stat(path), { code: 'ENOENT' })
      } finally {
        await closeHistory(off)
      }
    })
  })

  it('leaves out a session whose id could break the command to continue it, and Codex reasoning', async () => {
    await withHistory(async (h, rt) => {
      await h.write(
        '.codex/sessions/2026/10/17/rollout-2026-10-17T09-00-00-ffff6666-0000-4000-8000-000000000006.jsonl',
        jsonl([
          {
            timestamp: ago(DAY),
            type: 'session_meta',
            payload: {
              id: 'x; printf INJECTED',
              cwd: h.path('code/app'),
              source: 'cli',
              originator: 'codex_cli_rs',
            },
          },
          {
            timestamp: ago(DAY),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'unsafe id prompt' }],
            },
          },
        ]),
      )
      await h.write(
        '.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-abab7777-0000-4000-8000-000000000007.jsonl',
        jsonl([
          {
            timestamp: ago(DAY),
            type: 'session_meta',
            payload: {
              id: 'abab7777-0000-4000-8000-000000000007',
              cwd: h.path('code/app'),
              source: 'cli',
              originator: 'codex_cli_rs',
            },
          },
          {
            timestamp: ago(DAY),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'plain question' }],
            },
          },
          {
            timestamp: ago(DAY),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              channel: 'analysis',
              content: [{ type: 'output_text', text: 'REASONINGMARKER' }],
            },
          },
        ]),
      )
      assert.deepEqual(ids(await searchHistory(rt, { q: 'unsafe' }, { wait: true })), [])
      assert.deepEqual(ids(await searchHistory(rt, { q: 'REASONINGMARKER' })), [])
      const all = await searchHistory(rt, { since: 'all' })
      assert.ok(all.sessions.some((x) => x.sessionId === 'abab7777-0000-4000-8000-000000000007'))
      for (const x of all.sessions) assert.doesNotMatch(x.continueCommand, /;|\$\(|`/)
    })
  })

  it('opens a session id two accounts share only with --account', async () => {
    await withHistory(async (h, rt, { app }) => {
      await h.write('.claude-work/settings.json', '{}')
      await h.write(
        `.claude-work/projects/-code-app/${A}.jsonl`,
        jsonl(claudeTurns(A, app, [['work copy', 'from work']], () => ago(MIN))),
      )
      await searchHistory(rt, {}, { wait: true })
      await assert.rejects(historyShow(rt, A), /--account/)
      const shown = await historyShow(rt, A, { account: 'claude:work' })
      assert.equal(shown.session.account, 'claude:work')
      assert.equal(shown.messages[0]?.text, 'work copy')
    })
  })

  it('marks a project gone once its folder is deleted, with no change to the records', async () => {
    await withHistory(async (_h, rt, { web }) => {
      await historyProjects(rt, { since: 'all' }, { wait: true })
      await rm(web, { recursive: true })
      await syncHistory(rt, { force: true })
      const p = await historyProjects(rt, { since: 'all' })
      assert.equal(p.projects.find((x) => x.name === 'web')?.gone, true)
      assert.equal(p.projects.find((x) => x.name === 'app')?.gone, undefined)
    })
  })

  it('reports the index state and deletes it with clear', async () => {
    await withHistory(async (_h, rt) => {
      const info = await historyIndexInfo(rt, { wait: true })
      assert.equal(info.enabled, true)
      assert.equal(info.state, 'ready')
      assert.equal(info.sessions, 6)
      assert.equal(info.files, 6)
      assert.ok(info.bytes > 0)
      const cleared = await historyIndexInfo(rt, { clear: true })
      assert.equal(cleared.cleared, true)
    })
  })

  it('ends a clear without a rebuild, so the file stays deleted until the next listing', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      const path = historyIndexPath(rt)
      const cleared = await historyIndexInfo(rt, { clear: true, rebuild: false })
      assert.equal(cleared.cleared, true)
      assert.equal(cleared.sessions, 0)
      assert.deepEqual(cleared.sources, [])
      await assert.rejects(stat(path), { code: 'ENOENT' })
      assert.equal((await searchHistory(rt, {}, { wait: true })).total, 4)
      await stat(path)
    })
  })

  it('opens the index again when another process deleted it, instead of writing into the deleted file', async () => {
    await withHistory(async (_h, rt) => {
      const before = await searchHistory(rt, {}, { wait: true })
      const path = historyIndexPath(rt)
      for (const p of [path, `${path}-wal`, `${path}-shm`]) await rm(p, { force: true })
      const after = await searchHistory(rt, {}, { wait: true })
      assert.equal(after.total, before.total)
      await stat(path)
    })
  })

  it('never writes or deletes through a link where the index folder should be', async () => {
    await withHistory(async (h, rt) => {
      const elsewhere = await h.mkdir('elsewhere')
      await writeFile(`${elsewhere}/keep.txt`, 'keep')
      await mkdir(dirname(dirname(historyIndexPath(rt))), { recursive: true })
      await symlink(elsewhere, dirname(historyIndexPath(rt)))
      const before = await snapshot(elsewhere)
      const r = await searchHistory(rt, {}, { wait: true })
      assert.equal(r.total, 4)
      assert.ok(r.problems.some((p) => p.includes('is a link or not a folder of yours')))
      await assert.rejects(historyIndexInfo(rt, { clear: true }), /is a link or not a folder of yours/)
      assert.deepEqual(await snapshot(elsewhere), before)
    })
  })

  it('never opens a database the index file links to, and clear removes only the link', async () => {
    await withHistory(async (h, rt) => {
      const other = await h.write('elsewhere/other.sqlite', 'precious')
      await mkdir(dirname(historyIndexPath(rt)), { recursive: true, mode: 0o700 })
      await symlink(other, historyIndexPath(rt))
      const r = await searchHistory(rt, {}, { wait: true })
      assert.equal(r.total, 4)
      assert.ok(r.problems.some((p) => p.includes('sideby history index --clear')))
      await historyIndexInfo(rt, { clear: true, rebuild: false })
      await assert.rejects(lstat(historyIndexPath(rt)), { code: 'ENOENT' })
      assert.equal(await readFile(other, 'utf8'), 'precious')
    })
  })

  it('filters by each shown name when one same-named project sits inside another path', async () => {
    await withHistory(async (h, rt) => {
      const P = 'ffff6666-0000-4000-8000-000000000006'
      const Q = 'ffff7777-0000-4000-8000-000000000007'
      for (const [sid, cwd] of [
        [P, h.path('deep/a/app')],
        [Q, h.path('deep/x/a/app')],
      ] as const) {
        await mkdir(cwd, { recursive: true })
        const file = h.path(`.claude/projects/-deep-${sid.slice(0, 4)}/${sid}.jsonl`)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, jsonl(claudeTurns(sid, cwd, [['hello', 'hi']], () => ago(MIN))))
      }
      await searchHistory(rt, {}, { wait: true })
      const names = (await historyProjects(rt)).projects.map((x) => x.name)
      assert.ok(names.includes('deep/a/app') && names.includes('x/a/app'), names.join(', '))
      assert.deepEqual(ids(await searchHistory(rt, { project: 'deep/a/app' })), [P])
      assert.deepEqual(ids(await searchHistory(rt, { project: 'x/a/app' })), [Q])
    })
  })

  it('says a session is gone when its file was deleted, and the next listing leaves it out', async () => {
    await withHistory(async (h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      await rm(h.path(`.claude/projects/-code-web/${B}.jsonl`))
      await assert.rejects(historyShow(rt, B), (e: Error & { code?: string }) => e.code === 'session-gone')
      // Within the sync throttle: the listing must not wait for the next full sync to drop it.
      assert.ok(!ids(await searchHistory(rt, {})).includes(B))
    })
  })

  it('keeps a tool-output hit whose session is indexed again while its file is read', async () => {
    await withHistory(async (h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      let once = false
      const hits = []
      const onProgress = async () => {
        if (once) return
        once = true
        await appendFile(
          h.path(`.claude/projects/-code-web/${B}.jsonl`),
          jsonl([{ type: 'user', sessionId: B, timestamp: ago(MIN), message: { content: 'one more' } }]),
        )
        await syncHistory(rt, { force: true })
      }
      for await (const hit of scanToolOutput(rt, { q: TOOL_WORD, since: 'all' }, { onProgress }))
        hits.push(hit)
      assert.deepEqual(
        hits.map((x) => x.session.sessionId),
        [B],
      )
    })
  })

  it('finds sessions read before by the name an Account gets later', async () => {
    await withHistory(async (h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { mainbox: 'claude:main' } }))
      const renamed = await createRuntime({ env: h.env })
      await syncHistory(renamed, { force: true })
      const r = await searchHistory(renamed, { q: 'mainbox', since: 'all' }, { wait: true })
      assert.ok(ids(r).includes(A), 'found by its new name')
      assert.equal(r.sessions.find((x) => x.sessionId === A)?.accountLabel, 'mainbox')
    })
  })

  it('binds the command to continue to the account of the row, not the newest copy', async () => {
    await withHistory(async (h, rt, { app }) => {
      await h.write('.claude-work/settings.json', '{}')
      await h.write(
        `.claude-work/projects/-code-app/${A}.jsonl`,
        jsonl(claudeTurns(A, app, [['work copy', 'from work']], () => ago(1000))),
      )
      const r = await searchHistory(rt, { since: 'all' }, { wait: true })
      for (const x of r.sessions.filter((x) => x.sessionId === A))
        assert.match(x.continueCommand, new RegExp(`sideby run ${x.account} -- --resume ${A}$`))
      const codex = r.sessions.find((x) => x.family === 'codex')!
      assert.match(codex.resumeCommand, /^sideby run codex:main -- resume /)
    })
  })

  it('searches tool output case-insensitively and never matches the record’s other fields', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      const found = async (q: string) => {
        const out: string[] = []
        for await (const hit of scanToolOutput(rt, { q, since: 'all' })) out.push(hit.session.sessionId)
        return out
      }
      assert.deepEqual(await found(TOOL_WORD.toLowerCase()), [B])
      assert.deepEqual(await found('tool_output_codex'), [C])
      assert.deepEqual(await found('INSTRUCTIONS_SECRET'), [])
      assert.deepEqual(await found('codex_cli_rs'), [])
    })
  })

  it('finishes a search that is in flight when the index closes or is cleared', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      const inFlight = searchHistory(rt, { q: 'login' })
      await closeHistory(rt)
      assert.ok((await inFlight).sessions.length > 0)
      const [during, info] = await Promise.all([
        searchHistory(rt, { q: 'login' }),
        historyIndexInfo(rt, { clear: true }),
        searchHistory(rt, { q: 'dark' }),
      ])
      assert.ok(during.problems.every((p) => !/not open/.test(p)))
      assert.equal(info.cleared, true)
      const after = await searchHistory(rt, { q: 'login' }, { wait: true })
      assert.deepEqual(ids(after), [A, C].sort())
      assert.ok((await stat(historyIndexPath(rt))).size > 0, 'the index is rebuilt after clear')
    })
  })

  it('deletes an index of an older version instead of keeping its text', async () => {
    await withHistory(async (_h, rt) => {
      await searchHistory(rt, {}, { wait: true })
      await closeHistory(rt)
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(historyIndexPath(rt))
      db.exec("INSERT INTO text(title, place, prompts, replies) VALUES ('', '', 'STALE_REASONING_TEXT', '')")
      db.exec('PRAGMA user_version = 1')
      db.close()
      await searchHistory(rt, {}, { wait: true })
      await closeHistory(rt)
      let bytes = ''
      for (const p of [historyIndexPath(rt), `${historyIndexPath(rt)}-wal`])
        bytes += await readFile(p, 'latin1').catch(() => '')
      assert.ok(!bytes.includes('STALE_REASONING_TEXT'))
      assert.ok(bytes.includes('dark mode'))
    })
  })

  it('counts a folder reached through a symlink as present', async () => {
    await withFakeHome(async (h) => {
      const real = await h.mkdir('real/repo')
      await h.mkdir('real/repo/.git')
      await symlink(real, h.path('linked'))
      const p = await new ProjectResolver().resolve(h.path('linked'))
      assert.equal(p.gone, false)
      assert.equal(p.path, h.path('linked'))
    })
  })
})

describe('projectsNamed', () => {
  it('takes the project a shown name belongs to, even where that name is the tail of a longer path', () => {
    const names = new Map([
      ['/a/app', 'a/app'],
      ['/x/a/app', 'x/a/app'],
      ['/code/web', 'web'],
    ])
    assert.deepEqual(projectsNamed(names, 'a/app'), ['/a/app'])
    assert.deepEqual(projectsNamed(names, 'x/a/app'), ['/x/a/app'])
    // Not a shown name: every path that ends with it.
    assert.deepEqual(projectsNamed(names, 'app'), ['/a/app', '/x/a/app'])
    assert.deepEqual(projectsNamed(names, 'nope'), [])
  })
})

describe('snippetOf', () => {
  it('cuts around the word even where lowercasing changes the length, and never inside an emoji', () => {
    const text = `${'İ'.repeat(30)} the word is here ${'😀'.repeat(30)}`
    const snip = snippetOf(text, ['WORD'])!
    assert.match(snip, /the word is here/)
    assert.doesNotMatch(snip, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    const before = snippetOf(`${'😀'.repeat(30)}word`, ['word'])!
    assert.doesNotMatch(before, /^…[\uDC00-\uDFFF]/)
  })
})
