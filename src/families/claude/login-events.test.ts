// Expired Login (ADR-0071): what Claude Code's transcripts say about an Account's login.
import assert from 'node:assert/strict'
import { utimes } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import { LOGIN_SCAN_SESSIONS, readClaudeLoginEvents, saysLoginExpired } from './login-events.ts'
import { TAIL_BYTES } from './session-files.ts'

const EXPIRED_TEXT = 'Login reached its time limit · Please run /login'

const expiredRecord = (at: string, text = EXPIRED_TEXT) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    isApiErrorMessage: true,
    error: 'authentication_failed',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  })

const turnRecord = (at: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { model: 'claude-fable-5-1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  })

const account = (h: FakeHome, kind: Account['kind'] = 'subscription'): Account => ({
  family: 'claude',
  name: 'work',
  ref: 'claude:work',
  dir: h.path('.claude-work'),
  isMain: false,
  kind,
})

const transcript = (h: FakeHome, session: string, lines: string[]) =>
  h.write(`.claude-work/projects/-demo/${session}.jsonl`, `${lines.join('\n')}\n`)

describe('saysLoginExpired', () => {
  it('matches the known phrase whatever the case, spacing or punctuation', () => {
    assert.equal(saysLoginExpired(EXPIRED_TEXT), true)
    assert.equal(saysLoginExpired('LOGIN  reached its time-limit!'), true)
    assert.equal(saysLoginExpired('Please run /login'), false)
    assert.equal(saysLoginExpired('Invalid API key · Please run /login'), false)
  })
})

describe('readClaudeLoginEvents', () => {
  it('reports the expiry record and no working turn after it', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [
        turnRecord('2026-11-08T09:00:00.000Z'),
        expiredRecord('2026-11-08T10:00:00.000Z'),
      ])
      const e = await readClaudeLoginEvents(account(h))
      assert.deepEqual(e, { expiredAt: '2026-11-08T10:00:00.000Z', workingAt: '2026-11-08T09:00:00.000Z' })
    })
  })

  it('sees a later successful turn, in the same or another session', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [expiredRecord('2026-11-08T10:00:00.000Z')])
      await transcript(h, 's2', [turnRecord('2026-11-08T11:00:00.000Z')])
      const e = await readClaudeLoginEvents(account(h))
      assert.equal(e.expiredAt, '2026-11-08T10:00:00.000Z')
      assert.equal(e.workingAt, '2026-11-08T11:00:00.000Z')
    })
  })

  it('does not count an invalid API key or a bare /login hint as expired', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [
        expiredRecord('2026-11-08T10:00:00.000Z', 'Invalid API key · Please run /login'),
        expiredRecord('2026-11-08T10:01:00.000Z', 'Please run /login'),
        // The phrase alone, without the structured fields, is not enough either.
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-08T10:02:00.000Z',
          message: { model: '<synthetic>', content: [{ type: 'text', text: EXPIRED_TEXT }] },
        }),
      ])
      assert.deepEqual(await readClaudeLoginEvents(account(h)), {})
    })
  })

  it('never checks an API Account', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [expiredRecord('2026-11-08T10:00:00.000Z')])
      assert.deepEqual(await readClaudeLoginEvents(account(h, 'api')), {})
    })
  })

  it('reads only the last 256 KiB of a transcript', async () => {
    await withFakeHome(async (h) => {
      const filler = turnRecord('2026-11-08T09:00:00.000Z').replace('Done.', 'x'.repeat(TAIL_BYTES))
      await transcript(h, 's1', [expiredRecord('2026-11-08T10:00:00.000Z'), filler])
      // The expiry record is outside the window; the long turn is cut by it, so nothing is seen.
      assert.deepEqual(await readClaudeLoginEvents(account(h)), {})
    })
  })

  it('reads only the newest main transcripts, not subagent ones', async () => {
    await withFakeHome(async (h) => {
      const old = await h.write(
        '.claude-work/projects/-demo/old.jsonl',
        `${expiredRecord('2026-11-01T10:00:00.000Z')}\n`,
      )
      await utimes(old, new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'))
      for (let i = 0; i < LOGIN_SCAN_SESSIONS; i++)
        await transcript(h, `n${i}`, [turnRecord('2026-11-08T09:00:00.000Z')])
      await h.write(
        '.claude-work/projects/-demo/n0/subagents/agent-1.jsonl',
        `${expiredRecord('2026-11-08T12:00:00.000Z')}\n`,
      )
      assert.deepEqual(await readClaudeLoginEvents(account(h)), { workingAt: '2026-11-08T09:00:00.000Z' })
    })
  })
})

describe('readClaudeLoginEvents listing', () => {
  it('sees a new record in a kept transcript and a new transcript without waiting for the next full listing', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [turnRecord('2026-11-08T09:00:00.000Z')])
      assert.deepEqual(await readClaudeLoginEvents(account(h)), { workingAt: '2026-11-08T09:00:00.000Z' })
      // Appended to a transcript already among the newest: no new listing is needed.
      await transcript(h, 's1', [
        turnRecord('2026-11-08T09:00:00.000Z'),
        expiredRecord('2026-11-08T10:00:00.000Z'),
      ])
      assert.equal((await readClaudeLoginEvents(account(h))).expiredAt, '2026-11-08T10:00:00.000Z')
      // A new session file changes its project folder, so the listing is redone.
      await transcript(h, 's2', [turnRecord('2026-11-08T11:00:00.000Z')])
      assert.equal((await readClaudeLoginEvents(account(h))).workingAt, '2026-11-08T11:00:00.000Z')
    })
  })
})

describe('readClaudeLoginEvents and sub-agent records', () => {
  const side = (rec: string) => JSON.stringify({ ...JSON.parse(rec), isSidechain: true })
  it('a later sidechain success does not clear a main-chain expiry', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [
        expiredRecord('2026-11-08T10:00:00.000Z'),
        side(turnRecord('2026-11-08T11:00:00.000Z')),
      ])
      assert.deepEqual(await readClaudeLoginEvents(account(h)), { expiredAt: '2026-11-08T10:00:00.000Z' })
    })
  })
  it('a sidechain-only expiry does not mark the account', async () => {
    await withFakeHome(async (h) => {
      await transcript(h, 's1', [
        turnRecord('2026-11-08T09:00:00.000Z'),
        side(expiredRecord('2026-11-08T10:00:00.000Z')),
      ])
      assert.deepEqual(await readClaudeLoginEvents(account(h)), { workingAt: '2026-11-08T09:00:00.000Z' })
    })
  })
})
