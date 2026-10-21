// Claude Code's Session History reader (spec §3.33): titles, prompts, replies, place and time from the records;
// subagents and SDK Sessions; tool output, injected context and reasoning never reach the prompts or replies.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import type { HistoryMessage } from '../history.ts'
import { claudeHistory } from './history.ts'

const SID = '61230c3d-0000-4000-8000-000000000001'
const SDK = '72340d4e-0000-4000-8000-000000000002'
const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

const account = (h: FakeHome): Account => ({
  family: 'claude',
  name: 'work',
  ref: 'claude:work',
  dir: h.path('.claude-work'),
  isMain: false,
  kind: 'subscription',
})

const base = { sessionId: SID, cwd: '/work/app', gitBranch: 'feat/login', entrypoint: 'cli' }

async function seed(h: FakeHome) {
  await h.write(
    `.claude-work/projects/-work-app/${SID}.jsonl`,
    jsonl([
      {
        type: 'user',
        ...base,
        timestamp: '2026-10-18T09:00:00.000Z',
        isMeta: true,
        message: { content: 'META_CONTEXT' },
      },
      {
        type: 'user',
        ...base,
        timestamp: '2026-10-18T09:00:01.000Z',
        message: {
          role: 'user',
          content: '<system-reminder>INJECTED_REMINDER</system-reminder>修一下登录页面 please',
        },
      },
      {
        type: 'assistant',
        ...base,
        timestamp: '2026-10-18T09:00:05.000Z',
        message: {
          model: 'claude-opus-4-5',
          content: [
            { type: 'thinking', thinking: 'REASONING_SECRET' },
            { type: 'text', text: 'I will look at the login form.' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'TOOL_INPUT_PATH' } },
          ],
        },
      },
      {
        type: 'user',
        ...base,
        timestamp: '2026-10-18T09:00:06.000Z',
        message: { content: [{ type: 'tool_result', content: 'TOOL_OUTPUT_MARKER' }] },
        toolUseResult: { stdout: 'TOOL_OUTPUT_MARKER' },
      },
      {
        type: 'user',
        ...base,
        timestamp: '2026-10-18T09:00:07.000Z',
        message: { content: '<local-command-stdout>LOCAL_STDOUT</local-command-stdout>' },
      },
      {
        type: 'user',
        ...base,
        timestamp: '2026-10-18T09:00:08.000Z',
        message: { content: '<command-name>/review</command-name><command-args>pr 12</command-args>' },
      },
      {
        type: 'user',
        ...base,
        isSidechain: true,
        timestamp: '2026-10-18T09:00:09.000Z',
        message: { content: 'SIDECHAIN_PROMPT' },
      },
      { type: 'ai-title', aiTitle: 'Fix the login page' },
      'not json at all',
      {
        type: 'assistant',
        ...base,
        gitBranch: 'feat/login-2',
        timestamp: '2026-10-18T09:10:00.000Z',
        message: {
          model: 'claude-opus-4-5',
          content: [{ type: 'text', text: 'Done: the form submits now.' }],
        },
      },
    ]).replace('"not json at all"', '{"type":"user", cut'),
  )
  await h.write(
    `.claude-work/projects/-work-app/${SID}/subagents/agent-a1.jsonl`,
    jsonl([
      {
        type: 'user',
        sessionId: SID,
        isSidechain: true,
        cwd: '/work/app',
        timestamp: '2026-10-18T09:01:00.000Z',
        message: { content: 'Find the login handler' },
      },
      {
        type: 'assistant',
        sessionId: SID,
        isSidechain: true,
        timestamp: '2026-10-18T09:02:00.000Z',
        message: { content: [{ type: 'text', text: 'It is in auth.ts' }] },
      },
    ]),
  )
  await h.write(
    `.claude-work/projects/-work-tool/${SDK}.jsonl`,
    jsonl([
      {
        type: 'user',
        sessionId: SDK,
        cwd: '/work/tool',
        entrypoint: 'sdk-ts',
        timestamp: '2026-10-19T10:00:00.000Z',
        message: { content: 'Summarise the diff' },
      },
      { type: 'custom-title', customTitle: 'My own name' },
      {
        type: 'assistant',
        sessionId: SDK,
        timestamp: '2026-10-19T10:00:03.000Z',
        message: { content: [{ type: 'text', text: 'Two files changed.' }] },
      },
    ]),
  )
  // Nothing said: not a Session.
  await h.write(
    '.claude-work/projects/-work-tool/83450e5f-0000-4000-8000-000000000003.jsonl',
    jsonl([{ type: 'summary', summary: 'only a summary' }]),
  )
}

async function parsedAll(h: FakeHome) {
  const a = account(h)
  const files = await claudeHistory.list(a, [])
  const out = []
  for (const f of files) out.push({ file: f, s: await claudeHistory.parse(f, a) })
  return out
}

describe('claude history reader', () => {
  it('lists every session file and its subagents, and nothing for an account without projects', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(await claudeHistory.list(account(h), []), [])
      await seed(h)
      const files = await claudeHistory.list(account(h), [])
      assert.equal(files.length, 4)
      const sub = files.find((f) => f.path.includes('/subagents/'))
      assert.equal(sub?.parent, SID)
      assert.ok(files.every((f) => /^\d+:[\d.]+:\d+$/.test(f.sig)))
    })
  })

  it('parses title, prompts, replies, cwd, branch, model and times', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const all = await parsedAll(h)
      const main = all.find((x) => x.s?.sessionId === SID && !x.file.parent)?.s
      assert.ok(main)
      assert.equal(main.title, 'Fix the login page')
      assert.equal(main.titleFrom, 'host')
      assert.deepEqual(main.prompts, ['修一下登录页面 please', '/review pr 12'])
      assert.deepEqual(main.replies, ['I will look at the login form.', 'Done: the form submits now.'])
      assert.equal(main.messages, 4)
      assert.equal(main.cwd, '/work/app')
      assert.equal(main.branch, 'feat/login-2')
      assert.equal(main.model, 'claude-opus-4-5')
      assert.equal(main.startedAt, '2026-10-18T09:00:00.000Z')
      assert.equal(main.updatedAt, '2026-10-18T09:10:00.000Z')
      assert.equal(main.script, false)
      assert.equal(main.parent, undefined)
    })
  })

  it('keeps tool output, tool input, injected context, sidechains and reasoning out', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const text = JSON.stringify((await parsedAll(h)).map((x) => x.s))
      for (const secret of [
        'TOOL_OUTPUT_MARKER',
        'TOOL_INPUT_PATH',
        'INJECTED_REMINDER',
        'META_CONTEXT',
        'LOCAL_STDOUT',
        'SIDECHAIN_PROMPT',
        'REASONING_SECRET',
      ])
        assert.ok(!text.includes(secret), secret)
    })
  })

  it('marks subagents and SDK sessions as Script Sessions; a user title wins; an empty file is no session', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const all = await parsedAll(h)
      const sub = all.find((x) => x.file.parent)?.s
      assert.equal(sub?.script, true)
      assert.equal(sub?.parent, SID)
      assert.equal(sub?.sessionId, 'agent-a1')
      assert.equal(sub?.title, 'Find the login handler')
      assert.equal(sub?.titleFrom, 'prompt')
      const sdk = all.find((x) => x.s?.sessionId === SDK)?.s
      assert.equal(sdk?.script, true)
      assert.equal(sdk?.title, 'My own name')
      assert.equal(sdk?.titleFrom, 'user')
      assert.equal(all.filter((x) => x.s === undefined).length, 1)
    })
  })

  it('cuts a long title at a whole character, never inside an emoji', async () => {
    await withFakeHome(async (h) => {
      const id = '83450e5f-0000-4000-8000-000000000003'
      await h.write(
        `.claude-work/projects/-work-app/${id}.jsonl`,
        jsonl([
          { type: 'custom-title', customTitle: '😀'.repeat(130), sessionId: id },
          {
            type: 'user',
            ...base,
            sessionId: id,
            timestamp: '2026-10-18T09:00:00.000Z',
            message: { content: 'hi' },
          },
        ]),
      )
      const title = (await parsedAll(h)).find((x) => x.s?.sessionId === id)?.s?.title ?? ''
      assert.equal(title, `${'😀'.repeat(119)}…`)
      assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    })
  })

  it('reads messages in order with tool calls as names only', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const path = h.path(`.claude-work/projects/-work-app/${SID}.jsonl`)
      const msgs: HistoryMessage[] = []
      for await (const m of claudeHistory.messages(path)) msgs.push(m)
      assert.deepEqual(
        msgs.filter((m) => m.text !== 'SIDECHAIN_PROMPT').map((m) => [m.role, m.text]),
        [
          ['user', '修一下登录页面 please'],
          ['assistant', 'I will look at the login form.'],
          ['tool', 'Read'],
          ['user', '/review pr 12'],
          ['assistant', 'Done: the form submits now.'],
        ],
      )
      assert.ok(!JSON.stringify(msgs).includes('TOOL_OUTPUT_MARKER'))
      assert.ok(!JSON.stringify(msgs).includes('REASONING_SECRET'))
      assert.ok(!JSON.stringify(msgs).includes('TOOL_INPUT_PATH'))
    })
  })

  // parse() skips sidechain lines of the main file (they belong to a subagent); the viewer must too.
  it('does not show sidechain lines of the main file in the viewer', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const msgs: HistoryMessage[] = []
      for await (const m of claudeHistory.messages(h.path(`.claude-work/projects/-work-app/${SID}.jsonl`)))
        msgs.push(m)
      assert.ok(!msgs.some((m) => m.text === 'SIDECHAIN_PROMPT'))
    })
  })
})
