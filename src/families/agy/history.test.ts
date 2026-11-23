// Antigravity CLI's Session History reader (ADR-0082): rows of `conversation_summaries.db`, read-only; subagent
// conversations and rows without a title stay out, and the conversation records are never opened.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { searchHistory } from '../../core/history.ts'
import { resumeCommandFor } from '../../core/live-sessions.ts'
import { createRuntime } from '../../runtime.ts'
import type { Account } from '../../types.ts'
import { agyHistory } from './history.ts'
import { agyPlugin } from './index.ts'

const MAIN = '.gemini/antigravity-cli'
const TOP = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OLDER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

const account = (h: FakeHome): Account => ({
  family: 'agy',
  name: 'main',
  ref: 'agy:main',
  dir: h.path(MAIN),
  isMain: true,
  kind: 'subscription',
})

/** agy's summary table as agy 1.5.14 creates it (2026-11-23), with fake rows. */
async function seed(h: FakeHome): Promise<void> {
  await h.mkdir(`${MAIN}/conversations`)
  // A record file sideby must never open: it is not even a database.
  await h.write(`${MAIN}/conversations/${TOP}.db`, 'NOT_A_DATABASE')
  const db = new DatabaseSync(h.path(`${MAIN}/conversation_summaries.db`))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "",
    preview text NOT NULL DEFAULT "", step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
    workspace_uris text NOT NULL, status text NOT NULL DEFAULT "", agent_name text NOT NULL DEFAULT "",
    parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    raw_summary blob, PRIMARY KEY (conversation_id))`)
  const add = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, preview, step_count,
    last_modified_time, workspace_uris, status, agent_name, parent_conversation_id, nesting_depth, raw_summary)
    VALUES (?, ?, 'PREVIEW_SECRET', ?, ?, ?, 'CASCADE_RUN_STATUS_IDLE', ?, ?, ?, X'00')`)
  add.run(
    TOP,
    'Fix the login redirect',
    12,
    '2026-11-23 02:21:12.812657+00:00',
    '["file:///work/app","file:///work/lib"]',
    '',
    '',
    0,
  )
  add.run(OLDER, 'Write release notes', 4, '2026-11-20 09:00:00+00:00', '[]', '', '', 0)
  add.run('a1', '', 2, '2026-11-23 03:00:00+00:00', '["file:///work/app"]', '', '', 0)
  add.run(
    'a2',
    'Research the API',
    8,
    '2026-11-23 03:00:00+00:00',
    '["file:///work/app"]',
    'research',
    TOP,
    1,
  )
  add.run('a3', 'Nested without parent', 3, '2026-11-23 03:00:00+00:00', '["file:///work/app"]', '', '', 1)
  db.close()
}

describe('Antigravity CLI Session History (ADR-0082)', () => {
  it('lists titled top-level conversations from the summary table, read-only', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const before = await snapshot(h.path(MAIN))
      const a = account(h)
      const files = await agyHistory.list(a, [])
      assert.deepEqual(
        files.map((f) => f.path),
        [h.path(`${MAIN}/conversations/${TOP}.db`), h.path(`${MAIN}/conversations/${OLDER}.db`)],
      )
      assert.equal(files[0]!.mtimeMs, Date.parse('2026-11-23T02:21:12.812Z'))
      const s = await agyHistory.parse(files[0]!, a)
      assert.deepEqual(s, {
        sessionId: TOP,
        title: 'Fix the login redirect',
        titleFrom: 'host',
        messages: 0,
        script: false,
        prompts: [],
        replies: [],
        cwd: '/work/app',
        updatedAt: '2026-11-23T02:21:12.812Z',
      })
      assert.equal((await agyHistory.parse(files[1]!, a))?.cwd, undefined)
      assert.doesNotMatch(JSON.stringify(s), /PREVIEW_SECRET|NOT_A_DATABASE/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path(MAIN))), [])
    })
  })

  it('reads the newest rows while agy has the database open, without adding files', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const agy = new DatabaseSync(h.path(`${MAIN}/conversation_summaries.db`))
      try {
        agy
          .prepare(
            `INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris)
             VALUES ('b1', 'Still running', '2026-11-24 00:00:00+00:00', '[]')`,
          )
          .run()
        const files = new Set((await snapshot(h.path(MAIN))).keys())
        const listed = await agyHistory.list(account(h), [])
        assert.equal(listed[0]!.path, h.path(`${MAIN}/conversations/b1.db`))
        assert.deepEqual(
          [...(await snapshot(h.path(MAIN))).keys()].filter((p) => !files.has(p)),
          [],
        )
      } finally {
        agy.close()
      }
    })
  })

  it('changes a Session signature when its row changes', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const [first] = await agyHistory.list(account(h), [])
      const db = new DatabaseSync(h.path(`${MAIN}/conversation_summaries.db`))
      db.prepare('UPDATE conversation_summaries SET step_count = 13 WHERE conversation_id = ?').run(TOP)
      db.close()
      const [again] = await agyHistory.list(account(h), [])
      assert.notEqual(again!.sig, first!.sig)
    })
  })

  it('is empty when agy has no summary database yet', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      assert.deepEqual(await agyHistory.list(account(h), []), [])
    })
  })

  it('shows the conversations in sideby history, resumed with --conversation', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: agyPlugin, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      const r = await searchHistory(rt, {}, { wait: true })
      assert.deepEqual(
        r.sessions.map((s) => s.title),
        ['Fix the login redirect', 'Write release notes'],
      )
      assert.equal(resumeCommandFor('agy', 'agy:main', TOP), `sideby run agy:main -- --conversation ${TOP}`)
    })
  })
})
