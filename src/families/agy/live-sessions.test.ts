// WHY: ADR-0088 tests for Antigravity CLI Live Session reader: strictly read-only listing, live cache status and
// staleness decay, batched SQLite candidate resolution, ambiguity/collision `guessed` guard, deterministic expected
// transcript path, and Orca terminal vs Orca Chat separation with timeout isolation.
import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { AGY_LIVE_DIR } from '../../agy/statusline.ts'
import { listLiveSessions } from '../../core/live-sessions.ts'
import type { LiveSessionDeps, ProcessInfo } from '../../core/live-sessions-procs.ts'
import { clearOrcaAgentCache, ORCA_AGENT_SESSION_VAR, ORCA_STRUCTURED_VAR } from '../../core/orca-chat.ts'
import { ORCA_HANDLE_VAR } from '../../panel/orca.ts'
import { createRuntime } from '../../runtime.ts'
import { agyPlugin } from './index.ts'
import { agyTranscriptPath } from './live-sessions.ts'

const MAIN = '.gemini/antigravity-cli'
const START = Date.UTC(2026, 10, 26, 10, 0, 0)
const NOW = new Date(Date.UTC(2026, 10, 26, 10, 10, 0))
const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ID3 = '3b1f2c90-1111-4222-8333-444444444444'
const SUB1 = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
const ORCA_CHAT = 'orca-chat-001'
const builtins = [{ plugin: agyPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

async function seedSummaryDb(
  h: FakeHome,
  rows: {
    id: string
    title: string
    updatedAt: string
    workspaces?: string[]
    parent?: string
    depth?: number
  }[],
): Promise<void> {
  await h.mkdir(`${MAIN}/conversations`)
  const db = new DatabaseSync(h.path(`${MAIN}/conversation_summaries.db`))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "",
    preview text NOT NULL DEFAULT "", step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
    workspace_uris text NOT NULL, status text NOT NULL DEFAULT "", agent_name text NOT NULL DEFAULT "",
    parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    raw_summary blob, PRIMARY KEY (conversation_id))`)
  const add = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, step_count,
    last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, 1, ?, ?, ?, ?)`)
  for (const r of rows) {
    add.run(
      r.id,
      r.title,
      r.updatedAt,
      JSON.stringify((r.workspaces ?? []).map((p) => `file://${p}`)),
      r.parent ?? '',
      r.depth ?? 0,
    )
  }
  db.close()
}

const proc = (pid: number, command: string, startMs = START): ProcessInfo => ({
  pid,
  ppid: 1,
  startMs,
  command,
})

describe('Antigravity CLI Live Sessions (ADR-0088)', () => {
  it('reads live cache strictly read-only, maps states, decays stale entries to unknown, and rejects wrong procStart/symlinks', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const writeLive = (pid: number, rec: Record<string, unknown>) =>
        h.write(`.local/state/sideby/${AGY_LIVE_DIR}/${pid}.json`, `${JSON.stringify(rec)}\n`, 0o600)
      await writeLive(101, {
        version: 1,
        pid: 101,
        procStart: START,
        conversationId: ID1,
        title: 'Reviewing PR',
        agentState: 'reviewing',
        cwd: '/work/app',
        updatedAt: new Date(NOW.getTime() - 10_000).toISOString(),
      })
      await writeLive(102, {
        version: 1,
        pid: 102,
        procStart: START,
        conversationId: ID2,
        title: 'Stale review',
        agentState: 'reviewing',
        cwd: '/work/stale',
        updatedAt: new Date(NOW.getTime() - 300_000).toISOString(),
      })
      await writeLive(103, {
        version: 1,
        pid: 103,
        procStart: START - 90_000,
        conversationId: ID3,
        title: 'Reused pid',
        agentState: 'working',
        cwd: '/work/reused',
        updatedAt: NOW.toISOString(),
      })
      await writeLive(999, {
        version: 1,
        pid: 999,
        procStart: START,
        conversationId: ID3,
        title: 'Dead pid must stay untouched',
        agentState: 'idle',
        updatedAt: NOW.toISOString(),
      })
      const decoy = await h.write(
        'decoy.json',
        JSON.stringify({
          version: 1,
          pid: 104,
          procStart: START,
          conversationId: ID3,
          updatedAt: NOW.toISOString(),
        }),
        0o600,
      )
      await symlink(decoy, h.path(`.local/state/sideby/${AGY_LIVE_DIR}/104.json`))

      const before = await snapshot(h.home)
      const rt = await createRuntime({ env: h.env, builtins, now: () => NOW })
      const deps: LiveSessionDeps = {
        processes: async () => [
          proc(101, 'agy'),
          proc(102, 'agy'),
          proc(103, 'agy'),
          proc(104, 'agy'),
          proc(105, 'agy -p /usage'),
          proc(106, 'agy mcp list'),
        ],
        envVar: async () => undefined,
        openFiles: async () => [],
      }
      const listed = await listLiveSessions(rt, {}, deps)
      assert.equal(listed.sessions.length, 2)
      const s1 = listed.sessions.find((s) => s.sessionId === ID1)!
      const s2 = listed.sessions.find((s) => s.sessionId === ID2)!
      assert.equal(s1.status, 'needs-you')
      assert.equal(s1.reason, 'host-waits')
      assert.equal(s1.guessed, false)
      assert.equal(s1.transcript, agyTranscriptPath(h.path(MAIN), ID1))
      assert.equal(s2.status, 'unknown')
      assert.equal(s2.reason, undefined)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('resolves plain agy via openFiles + batched summary query, filters subagents, falls back to workspace basename when untitled, and always sets expected transcript', async () => {
    await withFakeHome(async (h) => {
      await seedSummaryDb(h, [
        { id: ID1, title: '', updatedAt: '2026-11-26 10:05:00+00:00', workspaces: ['/work/demo-repo'] },
        {
          id: SUB1,
          title: 'Subagent task',
          updatedAt: '2026-11-26 10:09:00+00:00',
          workspaces: ['/work/demo-repo'],
          parent: ID1,
          depth: 1,
        },
      ])
      const before = await snapshot(h.path(MAIN))
      const rt = await createRuntime({ env: h.env, builtins, now: () => NOW })
      const deps: LiveSessionDeps = {
        processes: async () => [proc(201, 'agy')],
        envVar: async () => undefined,
        openFiles: async (pid) =>
          pid === 201
            ? [h.path(`${MAIN}/conversations/${ID1}.db`), h.path(`${MAIN}/brain/${SUB1}/notes.md`)]
            : [],
      }
      const listed = await listLiveSessions(rt, {}, deps)
      assert.equal(listed.sessions.length, 1)
      const s = listed.sessions[0]!
      assert.equal(s.sessionId, ID1)
      assert.equal(s.title, 'demo-repo')
      assert.equal(s.guessed, false)
      assert.equal(s.transcript, agyTranscriptPath(h.path(MAIN), ID1))
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path(MAIN))), [])
    })
  })

  it('prefers open conversation db over historical brain refs, and marks multi-db or two-process collisions as guessed', async () => {
    await withFakeHome(async (h) => {
      await seedSummaryDb(h, [
        { id: ID1, title: 'Older chat', updatedAt: '2026-11-26 09:00:00+00:00', workspaces: ['/work/a'] },
        { id: ID2, title: 'Newer chat', updatedAt: '2026-11-26 10:00:00+00:00', workspaces: ['/work/b'] },
        { id: ID3, title: 'Colliding chat', updatedAt: '2026-11-26 10:05:00+00:00', workspaces: ['/work/c'] },
      ])
      const rt = await createRuntime({ env: h.env, builtins, now: () => NOW })
      const deps: LiveSessionDeps = {
        processes: async () => [
          proc(300, 'agy acp'),
          proc(301, 'agy acp'),
          proc(302, 'agy'),
          proc(303, 'agy'),
        ],
        envVar: async () => undefined,
        openFiles: async (pid) => {
          if (pid === 300)
            return [h.path(`${MAIN}/conversations/${ID1}.db`), h.path(`${MAIN}/brain/${ID2}/x`)]
          if (pid === 301)
            return [h.path(`${MAIN}/conversations/${ID1}.db`), h.path(`${MAIN}/conversations/${ID2}.db`)]
          if (pid === 302 || pid === 303) return [h.path(`${MAIN}/conversations/${ID3}.db`)]
          return []
        },
      }
      const listed = await listLiveSessions(rt, {}, deps)
      assert.equal(listed.sessions.length, 4)
      const exactDb = listed.sessions.find((s) => s.pid === 300)!
      assert.equal(exactDb.sessionId, ID1)
      assert.equal(exactDb.guessed, false)
      assert.equal(exactDb.transcript, agyTranscriptPath(h.path(MAIN), ID1))
      const multi = listed.sessions.find((s) => s.pid === 301)!
      assert.equal(multi.sessionId, ID2)
      assert.equal(multi.guessed, true)
      assert.equal(multi.transcript, undefined)
      const collided = listed.sessions.filter((s) => s.sessionId === ID3)
      assert.equal(collided.length, 2)
      assert.ok(collided.every((s) => s.guessed === true && s.transcript === undefined))
    })
  })

  it('separates Orca terminal from Orca Chat, confirms orcaSessionId and status, and never drops rows when Orca fails', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedSummaryDb(h, [
        { id: ID1, title: 'Terminal tab', updatedAt: '2026-11-26 10:01:00+00:00', workspaces: ['/work/t'] },
        { id: ID2, title: 'Orca chat', updatedAt: '2026-11-26 10:02:00+00:00', workspaces: ['/work/c'] },
      ])
      const rt = await createRuntime({ env: h.env, builtins, now: () => NOW })
      const baseDeps: LiveSessionDeps = {
        processes: async () => [proc(401, 'agy'), proc(402, 'agy acp')],
        envVar: async (pid, name) => {
          if (pid === 401 && name === ORCA_HANDLE_VAR) return 'term_abc'
          if (pid === 402 && name === ORCA_STRUCTURED_VAR) return '1'
          if (pid === 402 && name === ORCA_AGENT_SESSION_VAR) return ORCA_CHAT
          return undefined
        },
        openFiles: async (pid) =>
          pid === 401
            ? [h.path(`${MAIN}/conversations/${ID1}.db`)]
            : [h.path(`${MAIN}/conversations/${ID2}.db`)],
      }

      const ok = await listLiveSessions(
        rt,
        {},
        {
          ...baseDeps,
          orcaAgents: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              result: {
                agents: [
                  {
                    orcaSessionId: ORCA_CHAT,
                    kind: 'chat',
                    state: 'working',
                    title: 'Fix login from Orca sidebar',
                  },
                ],
              },
            }),
          }),
        },
      )
      const term = ok.sessions.find((s) => s.sessionId === ID1)!
      const chat = ok.sessions.find((s) => s.sessionId === ID2)!
      assert.equal(term.startedFrom, 'orca')
      assert.equal(term.orcaSessionId, undefined)
      assert.equal(chat.startedFrom, 'orca')
      assert.equal(chat.orcaSessionId, ORCA_CHAT)
      assert.equal(chat.status, 'busy')
      assert.equal(chat.title, 'Fix login from Orca sidebar')

      const down = await listLiveSessions(
        rt,
        {},
        {
          ...baseDeps,
          orcaAgents: async () => {
            throw new Error('Orca timed out')
          },
        },
      )
      assert.equal(down.sessions.length, 2)
      const chatDown = down.sessions.find((s) => s.sessionId === ID2)!
      assert.equal(chatDown.startedFrom, 'orca')
      assert.equal(chatDown.orcaSessionId, undefined)
      assert.equal(chatDown.status, 'unknown')

      // WHY: slow Orca enrichment must yield within the outer listing deadline so local agy sessions stay visible (ADR-0088).
      let slowTimer: NodeJS.Timeout | undefined
      const slow = await listLiveSessions(
        rt,
        { deadlineMs: 250 },
        {
          ...baseDeps,
          orcaAgents: () =>
            new Promise((resolve) => {
              slowTimer = setTimeout(
                () =>
                  resolve({
                    exitCode: 0,
                    stdout: JSON.stringify({
                      ok: true,
                      result: { agents: [{ orcaSessionId: ORCA_CHAT, kind: 'chat', state: 'working' }] },
                    }),
                  }),
                800,
              )
              slowTimer.unref()
            }),
        },
      )
      clearTimeout(slowTimer)
      assert.equal(slow.partial, undefined)
      assert.equal(slow.sessions.length, 2)
      const chatSlow = slow.sessions.find((s) => s.sessionId === ID2)!
      assert.equal(chatSlow.startedFrom, 'orca')
      assert.equal(chatSlow.orcaSessionId, undefined)
      assert.equal(chatSlow.status, 'unknown')
    })
  })
})
