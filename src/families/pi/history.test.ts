// pi's Session History reader (spec §3.33): the `session` header and `message` records; tool results and thinking stay
// out; the first prompt is the Session Title.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import type { HistoryMessage } from '../history.ts'
import { piHistory } from './history.ts'

const SID = 'b2c3d4e5-0000-4000-8000-000000000001'
const jsonl = (recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`
const FILE = `.pi/agent/sessions/--work-app--/2026-10-18T06-00-00-000Z_${SID}.jsonl`

const account = (h: FakeHome): Account => ({
  family: 'pi',
  name: 'main',
  ref: 'pi:main',
  dir: h.path('.pi/agent'),
  isMain: true,
  kind: 'subscription',
})

const msg = (at: string, message: Record<string, unknown>) => ({ type: 'message', timestamp: at, message })

async function seed(h: FakeHome) {
  await h.write(
    FILE,
    jsonl([
      { type: 'session', id: SID, cwd: '/work/app', timestamp: '2026-10-18T06:00:00.000Z' },
      { type: 'model_change', timestamp: '2026-10-18T06:00:00.100Z', modelId: 'glm-5' },
      msg('2026-10-18T06:00:01.000Z', {
        role: 'user',
        content: [{ type: 'text', text: 'Rename the login route\nto /signin' }],
      }),
      msg('2026-10-18T06:00:02.000Z', {
        role: 'assistant',
        model: 'glm-5',
        content: [
          { type: 'thinking', thinking: 'REASONING_SECRET' },
          { type: 'text', text: 'Renaming it.' },
          { type: 'toolCall', name: 'bash', arguments: { command: 'TOOL_ARGS_SECRET' } },
        ],
      }),
      msg('2026-10-18T06:00:03.000Z', {
        role: 'toolResult',
        content: [{ type: 'text', text: 'TOOL_OUTPUT_MARKER' }],
      }),
      msg('2026-10-18T06:00:04.000Z', {
        role: 'assistant',
        model: 'glm-5',
        content: [{ type: 'text', text: 'Done.' }],
      }),
    ]),
  )
  await h.write(
    '.pi/agent/sessions/--work-app--/2026-10-18T07-00-00-000Z_empty.jsonl',
    jsonl([{ type: 'session', id: 'empty', cwd: '/work/app', timestamp: '2026-10-18T07:00:00.000Z' }]),
  )
}

describe('pi history reader', () => {
  it('lists session files and parses the header, prompts, replies and model', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(await piHistory.list(account(h), []), [])
      await seed(h)
      const a = account(h)
      const files = await piHistory.list(a, [])
      assert.equal(files.length, 2)
      const parsed = await Promise.all(files.map((f) => piHistory.parse(f, a)))
      assert.equal(parsed.filter((x) => x === undefined).length, 1)
      const s = parsed.find((x) => x?.sessionId === SID)
      assert.ok(s)
      assert.equal(s.cwd, '/work/app')
      assert.equal(s.title, 'Rename the login route')
      assert.equal(s.titleFrom, 'prompt')
      assert.deepEqual(s.prompts, ['Rename the login route\nto /signin'])
      assert.deepEqual(s.replies, ['Renaming it.', 'Done.'])
      assert.equal(s.model, 'glm-5')
      assert.equal(s.startedAt, '2026-10-18T06:00:00.000Z')
      assert.equal(s.updatedAt, '2026-10-18T06:00:04.000Z')
      assert.equal(s.messages, 3)
      assert.equal(s.script, false)
      const text = JSON.stringify(parsed)
      for (const secret of ['REASONING_SECRET', 'TOOL_ARGS_SECRET', 'TOOL_OUTPUT_MARKER'])
        assert.ok(!text.includes(secret), secret)
    })
  })

  it('reads messages with tool calls as names only', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const msgs: HistoryMessage[] = []
      for await (const m of piHistory.messages(h.path(FILE))) msgs.push(m)
      assert.deepEqual(
        msgs.map((m) => [m.role, m.text]),
        [
          ['user', 'Rename the login route\nto /signin'],
          ['assistant', 'Renaming it.'],
          ['tool', 'bash'],
          ['assistant', 'Done.'],
        ],
      )
      assert.ok(!JSON.stringify(msgs).includes('TOOL_OUTPUT_MARKER'))
    })
  })

  it('gives tool call arguments and tool results as tool text, not the replies', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const out: string[] = []
      for await (const t of piHistory.toolText(h.path(FILE))) out.push(t)
      assert.deepEqual(out, ['TOOL_ARGS_SECRET', 'TOOL_OUTPUT_MARKER'])
    })
  })
})
