// Codex's Session History reader (spec §3.33): rollout files, the `session_meta` fields it may read, Script Sessions,
// titles from `session_index.jsonl`; tool output, injected context, reasoning, account ids and instructions stay out.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import type { HistoryMessage } from '../history.ts'
import { codexHistory, codexInteractive } from './history.ts'

const SID = '0199a1b2-0000-7000-8000-000000000001'
const EXEC = '0199a1b2-0000-7000-8000-000000000002'
const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

const account = (h: FakeHome): Account => ({
  family: 'codex',
  name: 'team',
  ref: 'codex:team',
  dir: h.path('.codex-team'),
  isMain: false,
  kind: 'subscription',
})

const meta = (id: string, extra: Record<string, unknown>) => ({
  timestamp: '2026-10-18T08:00:00.000Z',
  type: 'session_meta',
  payload: {
    id,
    timestamp: '2026-10-18T08:00:00.000Z',
    cwd: '/work/app',
    originator: 'codex_cli_rs',
    source: 'cli',
    instructions: 'INSTRUCTIONS_SECRET',
    account_id: 'acct-FAKE-ACCOUNT-ID',
    user_id: 'user-FAKE-USER-ID',
    git: { branch: 'feat/login', commit_hash: 'abc123' },
    ...extra,
  },
})

const item = (at: string, payload: Record<string, unknown>) => ({
  timestamp: at,
  type: 'response_item',
  payload,
})
const said = (role: string, kind: string, text: string, at: string) =>
  item(at, { type: 'message', role, content: [{ type: kind, text }] })

const MAIN = `.codex-team/sessions/2026/10/18/rollout-2026-10-18T08-00-00-${SID}.jsonl`

async function seed(h: FakeHome) {
  await h.write(
    MAIN,
    jsonl([
      meta(SID, {}),
      {
        timestamp: '2026-10-18T08:00:00.500Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.3-codex', cwd: '/work/app' },
      },
      said('developer', 'input_text', 'DEVELOPER_SECRET', '2026-10-18T08:00:01.000Z'),
      said(
        'user',
        'input_text',
        '<environment_context>ENV_SECRET</environment_context>',
        '2026-10-18T08:00:01.000Z',
      ),
      said(
        'user',
        'input_text',
        '# AGENTS.md instructions for /work/app\n\nAGENTS_SECRET',
        '2026-10-18T08:00:01.000Z',
      ),
      said('user', 'input_text', '修登录页 and the form', '2026-10-18T08:00:02.000Z'),
      item('2026-10-18T08:00:03.000Z', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'REASONING_SECRET' }],
      }),
      item('2026-10-18T08:00:04.000Z', {
        type: 'function_call',
        name: 'shell',
        arguments: '{"cmd":"TOOL_ARGS_SECRET"}',
      }),
      item('2026-10-18T08:00:05.000Z', { type: 'function_call_output', output: 'TOOL_OUTPUT_MARKER' }),
      {
        timestamp: '2026-10-18T08:00:05.500Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning', text: 'REASONING_SECRET' },
      },
      said('assistant', 'output_text', 'The form posts to /login now.', '2026-10-18T08:05:00.000Z'),
    ]),
  )
  await h.write(
    `.codex-team/sessions/2026/10/19/rollout-2026-10-19T08-00-00-${EXEC}.jsonl`,
    jsonl([
      meta(EXEC, { source: 'exec', git: undefined }),
      said('user', 'input_text', 'run the checks', '2026-10-19T08:00:01.000Z'),
      said('assistant', 'output_text', 'All green.', '2026-10-19T08:00:02.000Z'),
    ]),
  )
  // Only metadata: no Session.
  await h.write('.codex-team/sessions/2026/10/19/rollout-2026-10-19T09-00-00-x.jsonl', jsonl([meta('x', {})]))
  await h.write('.codex-team/sessions/2026/10/19/notes.txt', 'not a rollout')
}

async function parsedAll(h: FakeHome) {
  const a = account(h)
  const out = []
  for (const f of await codexHistory.list(a, [])) out.push(await codexHistory.parse(f, a))
  return out
}

describe('codex history reader', () => {
  it('lists rollout files in nested day folders only', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(await codexHistory.list(account(h), []), [])
      await seed(h)
      const files = await codexHistory.list(account(h), [])
      assert.equal(files.length, 3)
      assert.ok(files.every((f) => /rollout-.+\.jsonl$/.test(f.path)))
    })
  })

  it('parses id, cwd, branch, model, times, prompts and replies', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const s = (await parsedAll(h)).find((x) => x?.sessionId === SID)
      assert.ok(s)
      assert.deepEqual(s.prompts, ['修登录页 and the form'])
      assert.deepEqual(s.replies, ['The form posts to /login now.'])
      assert.equal(s.title, '修登录页 and the form')
      assert.equal(s.titleFrom, 'prompt')
      assert.equal(s.cwd, '/work/app')
      assert.equal(s.branch, 'feat/login')
      assert.equal(s.model, 'gpt-5.3-codex')
      assert.equal(s.startedAt, '2026-10-18T08:00:00.000Z')
      assert.equal(s.updatedAt, '2026-10-18T08:05:00.000Z')
      assert.equal(s.messages, 2)
      assert.equal(s.script, false)
    })
  })

  it('never puts account ids, instructions, injected context, reasoning or tool output in the result', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const text = JSON.stringify(await parsedAll(h))
      for (const secret of [
        'acct-FAKE-ACCOUNT-ID',
        'user-FAKE-USER-ID',
        'INSTRUCTIONS_SECRET',
        'DEVELOPER_SECRET',
        'ENV_SECRET',
        'AGENTS_SECRET',
        'REASONING_SECRET',
        'TOOL_ARGS_SECRET',
        'TOOL_OUTPUT_MARKER',
        'abc123',
      ])
        assert.ok(!text.includes(secret), secret)
    })
  })

  it('marks exec and non-Codex originators as Script Sessions; metadata alone is no session', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const all = await parsedAll(h)
      assert.equal(all.find((x) => x?.sessionId === EXEC)?.script, true)
      assert.equal(all.filter((x) => x === undefined).length, 1)
    })
    assert.equal(codexInteractive({ source: 'cli', originator: 'codex_cli_rs' }), true)
    assert.equal(codexInteractive({ source: 'vscode' }), true)
    assert.equal(codexInteractive({ source: 'exec' }), false)
    assert.equal(codexInteractive({ source: 'cli', thread_source: 'automation' }), false)
    assert.equal(codexInteractive({ source: 'vscode', originator: 'some_agent' }), false)
  })

  it('reads titles from session_index.jsonl and none when it is missing', async () => {
    await withFakeHome(async (h) => {
      assert.equal((await codexHistory.titles!(account(h))).size, 0)
      await h.write(
        '.codex-team/session_index.jsonl',
        `${JSON.stringify({ id: SID, thread_name: '  Login fix  ' })}\n{cut\n${JSON.stringify({ id: EXEC, thread_name: '' })}\n`,
      )
      assert.deepEqual([...(await codexHistory.titles!(account(h)))], [[SID, 'Login fix']])
    })
  })

  it('reads messages in order with tool calls as names only', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const msgs: HistoryMessage[] = []
      for await (const m of codexHistory.messages(h.path(MAIN))) msgs.push(m)
      assert.deepEqual(
        msgs.map((m) => [m.role, m.text]),
        [
          ['user', '修登录页 and the form'],
          ['tool', 'shell'],
          ['assistant', 'The form posts to /login now.'],
        ],
      )
      assert.ok(!JSON.stringify(msgs).includes('TOOL_ARGS_SECRET'))
      assert.ok(!JSON.stringify(msgs).includes('TOOL_OUTPUT_MARKER'))
    })
  })
})
