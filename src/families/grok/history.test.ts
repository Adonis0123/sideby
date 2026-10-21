// Grok Build's Session History reader (spec §3.33): `summary.json` metadata and `chat_history.jsonl` turns; synthetic
// user turns, tool results and reasoning stay out; `session_kind` marks Script Sessions.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import type { HistoryMessage } from '../history.ts'
import { grokHistory } from './history.ts'

const SID = 'a1b2c3d4-0000-4000-8000-000000000001'
const BOT = 'a1b2c3d4-0000-4000-8000-000000000002'
const CWD = '/work/app/web'
const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

const account = (h: FakeHome): Account => ({
  family: 'grok',
  name: 'lab',
  ref: 'grok:lab',
  dir: h.path('.grok-lab'),
  isMain: false,
  kind: 'subscription',
})

const dirOf = (cwd: string, id: string) => `.grok-lab/sessions/${encodeURIComponent(cwd)}/${id}`

async function seed(h: FakeHome) {
  await h.write(
    `${dirOf(CWD, SID)}/summary.json`,
    JSON.stringify({
      generated_title: 'Login page fix',
      git_root_dir: '/work/app',
      head_branch: 'feat/login',
      current_model_id: 'grok-code-fast-2',
      created_at: '2026-10-18T07:00:00.000Z',
      last_active_at: '2026-10-18T07:30:00.000Z',
      num_messages: 9,
      session_kind: '',
    }),
  )
  await h.write(
    `${dirOf(CWD, SID)}/chat_history.jsonl`,
    jsonl([
      { type: 'system', content: 'SYSTEM_PROMPT_SECRET' },
      {
        type: 'user',
        content: '<system-reminder>INJECTED_REMINDER</system-reminder>登录页 button is broken',
        timestamp: '2026-10-18T07:00:05.000Z',
      },
      {
        type: 'assistant',
        content: 'Checking the button handler.',
        reasoning_content: 'REASONING_SECRET',
        tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"TOOL_ARGS_SECRET"}' } }],
      },
      { type: 'tool', content: 'TOOL_OUTPUT_MARKER', tool_call_id: 'c1' },
      { type: 'user', content: 'TOOL_RESULT_AS_USER', synthetic_reason: 'tool_result' },
      { type: 'assistant', content: [{ type: 'text', text: 'Fixed the onClick.' }] },
    ]),
  )
  await h.write(
    `${dirOf('/work/bot', BOT)}/summary.json`,
    JSON.stringify({ session_kind: 'headless', created_at: 1_760_000_000 }),
  )
  await h.write(
    `${dirOf('/work/bot', BOT)}/chat_history.jsonl`,
    jsonl([
      { type: 'user', content: 'nightly report' },
      { type: 'assistant', content: 'Report written.' },
    ]),
  )
  // A folder without a chat file is no Session file.
  await h.write(`${dirOf('/work/bot', 'empty')}/summary.json`, '{}')
}

async function parsedAll(h: FakeHome) {
  const a = account(h)
  const out = []
  for (const f of await grokHistory.list(a, [])) out.push(await grokHistory.parse(f, a))
  return out
}

describe('grok history reader', () => {
  it('lists one file per session folder, signed by the chat file and summary.json', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(await grokHistory.list(account(h), []), [])
      await seed(h)
      const files = await grokHistory.list(account(h), [])
      assert.equal(files.length, 2)
      assert.ok(files.every((f) => f.path.endsWith('/chat_history.jsonl') && f.sig.includes('|')))
    })
  })

  it('parses title, cwd, repository root, branch, model, times, prompts and replies', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const s = (await parsedAll(h)).find((x) => x?.sessionId === SID)
      assert.ok(s)
      assert.equal(s.title, 'Login page fix')
      assert.equal(s.titleFrom, 'host')
      assert.equal(s.cwd, CWD)
      assert.equal(s.gitRoot, '/work/app')
      assert.equal(s.branch, 'feat/login')
      assert.equal(s.model, 'grok-code-fast-2')
      assert.equal(s.startedAt, '2026-10-18T07:00:00.000Z')
      assert.equal(s.updatedAt, '2026-10-18T07:30:00.000Z')
      assert.deepEqual(s.prompts, ['登录页 button is broken'])
      assert.deepEqual(s.replies, ['Checking the button handler.', 'Fixed the onClick.'])
      assert.equal(s.messages, 3)
      assert.equal(s.script, false)
    })
  })

  it('keeps system prompts, synthetic turns, tool calls, tool output and reasoning out', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const text = JSON.stringify(await parsedAll(h))
      for (const secret of [
        'SYSTEM_PROMPT_SECRET',
        'INJECTED_REMINDER',
        'REASONING_SECRET',
        'TOOL_ARGS_SECRET',
        'TOOL_OUTPUT_MARKER',
        'TOOL_RESULT_AS_USER',
      ])
        assert.ok(!text.includes(secret), secret)
    })
  })

  it('marks a headless session as a Script Session titled by its first prompt', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const s = (await parsedAll(h)).find((x) => x?.sessionId === BOT)
      assert.equal(s?.script, true)
      assert.equal(s?.title, 'nightly report')
      assert.equal(s?.titleFrom, 'prompt')
      assert.equal(s?.cwd, '/work/bot')
      assert.equal(s?.startedAt, new Date(1_760_000_000_000).toISOString())
    })
  })

  it('reads messages with tool calls as names only', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const msgs: HistoryMessage[] = []
      for await (const m of grokHistory.messages(h.path(`${dirOf(CWD, SID)}/chat_history.jsonl`)))
        msgs.push(m)
      assert.deepEqual(
        msgs.map((m) => [m.role, m.text]),
        [
          ['user', '登录页 button is broken'],
          ['assistant', 'Checking the button handler.'],
          ['tool', 'read_file'],
          ['assistant', 'Fixed the onClick.'],
        ],
      )
      assert.ok(!JSON.stringify(msgs).includes('TOOL_OUTPUT_MARKER'))
    })
  })

  it('gives tool calls and tool results as tool text, never the system prompt', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const out: string[] = []
      for await (const t of grokHistory.toolText(h.path(`${dirOf(CWD, SID)}/chat_history.jsonl`))) out.push(t)
      const text = out.join('\n')
      for (const want of ['TOOL_ARGS_SECRET', 'TOOL_OUTPUT_MARKER', 'TOOL_RESULT_AS_USER'])
        assert.ok(text.includes(want), want)
      assert.ok(!text.includes('SYSTEM_PROMPT_SECRET'))
      assert.ok(!text.includes('Fixed the onClick.'))
    })
  })
})
