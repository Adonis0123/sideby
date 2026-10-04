import assert from 'node:assert/strict'
import { copyFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account, ReadContext } from '../../types.ts'
import { readClaudeUsage } from './usage.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const FIXTURE = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url))

function account(dir: string): Account {
  return { family: 'claude', name: 'work', ref: 'claude:work', dir, isMain: false, kind: 'subscription' }
}

function ctx(h: FakeHome): ReadContext {
  return { home: h.home, now: NOW, stateDir: h.path('.local/state/sideby'), env: h.env }
}

async function touch(p: string, at: Date): Promise<void> {
  await utimes(p, at, at)
}

describe('claude usage', () => {
  it('dedupes by message.id (last line wins), skips bad lines and rows outside the window', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.claude-work')
      const proj = join(dir, 'projects', '-tmp-fake-project')
      await mkdir(proj, { recursive: true })
      const file = join(proj, 'sess-1.jsonl')
      await copyFile(FIXTURE, file)
      await touch(file, new Date(NOW.getTime() - 3_600_000))
      const r = await readClaudeUsage(account(dir), ctx(h))
      assert.deepEqual(r, {
        status: 'ok',
        days: 7,
        sessions: 2,
        inputTokens: 15,
        outputTokens: 55,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        totalTokens: 190,
      })
    })
  })

  it('ignores files not modified within the window, even with recent timestamps inside', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.claude-work')
      const nested = join(dir, 'projects', 'p', 'subagents')
      await mkdir(nested, { recursive: true })
      const recent = join(nested, 'agent.jsonl')
      await writeFile(
        recent,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-05T10:00:00.000Z',
          sessionId: 'nested',
          message: { id: 'msg_fake_nested', usage: { input_tokens: 7, output_tokens: 3 } },
        })}\n`,
      )
      await touch(recent, new Date(NOW.getTime() - 60_000))
      const stale = join(dir, 'projects', 'p', 'stale.jsonl')
      await copyFile(FIXTURE, stale)
      await touch(stale, new Date(NOW.getTime() - 30 * 86_400_000))
      const r = await readClaudeUsage(account(dir), ctx(h))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.inputTokens, 7)
      assert.equal(r.outputTokens, 3)
      assert.equal(r.sessions, 1)
      assert.equal(r.totalTokens, 10)
    })
  })

  it('reports no-session when there are no session files', async () => {
    await withFakeHome(async (h) => {
      const dir = await h.mkdir('.claude-work/projects/empty')
      const r = await readClaudeUsage(account(join(dir, '..', '..')), ctx(h))
      assert.equal(r.status, 'unavailable')
      if (r.status === 'unavailable') assert.equal(r.reason, 'no-session')
      const none = await readClaudeUsage(account(h.path('.claude-none')), ctx(h))
      assert.equal(none.status === 'unavailable' && none.reason, 'no-session')
    })
  })

  it('reports unrecognized when recent logs contain no JSON at all', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('.claude-work')
      const file = await h.write('.claude-work/projects/p/s.jsonl', 'garbage\nmore garbage\n')
      await touch(file, NOW)
      const r = await readClaudeUsage(account(dir), ctx(h))
      assert.equal(r.status === 'unavailable' && r.reason, 'unrecognized')
    })
  })
})
