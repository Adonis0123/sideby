// Per-Host hook readers (spec §3.17): a used-up Quota is told apart from a transient rate limit, and a half-written
// rollout line does not hide the last good one.
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { claudeHookReader } from '../families/claude/handoff-hook.ts'
import { codexHookReader } from '../families/codex/handoff-hook.ts'
import { grokHookReader } from '../families/grok/handoff-hook.ts'

const NOW = new Date('2026-10-09T12:00:00Z')

describe('Claude hook reader', () => {
  const hit = (input: Record<string, unknown>, pressure: number | null) =>
    claudeHookReader.limitHit!(input, pressure, 95)
  it('needs rate_limit plus a full window or used-up wording', () => {
    assert.equal(hit({ error: 'rate_limit', error_details: '529 Overloaded' }, 40), false)
    assert.equal(hit({ error: 'rate_limit', error_details: '529 Overloaded' }, 96), true)
    assert.equal(
      hit({ error: 'rate_limit', last_assistant_message: '5-hour limit reached ∙ resets 3pm' }, null),
      true,
    )
    assert.equal(hit({ error: 'server_error', error_details: 'usage limit reached' }, 99), false)
  })
})

describe('Grok hook reader', () => {
  const hit = (input: Record<string, unknown>) => grokHookReader.limitHit!(input, null, 95)
  it('matches used-up wording whatever the error class, and nothing transient', () => {
    assert.equal(hit({ error: 'unknown', errorDetails: 'status 402: You hit your weekly limit.' }), true)
    assert.equal(
      hit({
        error: 'rate_limit',
        lastAssistantMessage: 'You’ve reached your free Grok Build usage limit for now… try again later',
      }),
      true,
    )
    assert.equal(hit({ error: 'unknown', errorDetails: 'status 403 Forbidden' }), false)
    assert.equal(
      hit({
        error: 'rate_limit',
        errorDetails: 'You’ve hit the rate limit for your plan. Upgrade your account or try again later.',
      }),
      false,
    )
    assert.equal(
      hit({
        error: 'rate_limit',
        errorDetails:
          'You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later.',
      }),
      false,
    )
    assert.equal(hit({ error: 'unknown', errorDetails: 'out of credits', subagentType: 'explore' }), false)
  })
})

describe('Codex hook reader', () => {
  const event = (used: number) =>
    `${JSON.stringify({
      timestamp: NOW.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: used, window_minutes: 300, resets_at: NOW.getTime() / 1000 + 3600 },
        },
      },
    })}\n`

  it('reads the last good rate_limits and skips a half-written line', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('rollout.jsonl', event(70) + event(91))
      await appendFile(file, event(99).slice(0, 40))
      assert.equal(await codexHookReader.pressure!({ transcript_path: file }, {}, NOW), 91)
    })
  })

  it('returns null without a transcript or rate_limits', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('rollout.jsonl', '{"type":"session_meta"}\n')
      assert.equal(await codexHookReader.pressure!({ transcript_path: file }, {}, NOW), null)
      assert.equal(await codexHookReader.pressure!({}, {}, NOW), null)
    })
  })
})
