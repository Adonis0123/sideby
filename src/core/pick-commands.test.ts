import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HandoffPlan } from './handoff.ts'
import { choosePick, suggestPickName } from './pick-commands.ts'

test('the offered name follows the Family’s numbered short commands, else the built-in default', () => {
  assert.equal(suggestPickName('claude', 'claude', ['cc001', 'cc008']), 'cc')
  assert.equal(suggestPickName('claude', 'claude', ['work-1', 'work-2']), 'work')
  assert.equal(suggestPickName('claude', 'claude', []), 'cc')
  assert.equal(suggestPickName('codex', 'codex', []), 'cx')
  assert.equal(suggestPickName('grok', 'grok', ['fast']), 'gk')
  // Two patterns: no guess, the default.
  assert.equal(suggestPickName('codex', 'codex', ['cx001', 'codex2']), 'cx')
  // Never the Host's own command: `pi` would hide pi itself.
  assert.equal(suggestPickName('pi', 'pi', ['pi001', 'pi002']), null)
  assert.equal(suggestPickName('pi', 'pi', []), null)
})

const plan = (accounts: HandoffPlan['accounts'], pick: string | null, hasQuota: boolean): HandoffPlan => ({
  family: 'claude',
  pick,
  accounts,
  hasQuota,
})
const e = (
  ref: string,
  state: HandoffPlan['accounts'][number]['state'],
  pressure: number | null = null,
  window?: { label: string; usedPercent: number; limit: number },
) => ({
  ref,
  kind: state === 'api' ? ('api' as const) : ('subscription' as const),
  state,
  pressure,
  limitUse: window ? (window.usedPercent / window.limit) * 100 : pressure,
  ...(window ? { window } : {}),
})
const w5 = (usedPercent: number) => ({ label: '5h', usedPercent, limit: 85 })

test('the pick: most room with data, the main account without any data, nothing when none can start', () => {
  assert.deepEqual(
    choosePick(
      plan([e('claude:lab', 'ready', 10, w5(10)), e('claude:main', 'full', 99)], 'claude:lab', true),
      'claude:main',
    ),
    { ref: 'claude:lab', reason: 'most-room', pressure: 10, window: '5h' },
  )
  // The window that decides is the one closest to its own limit, which a weekly one may be at a lower percent.
  assert.deepEqual(
    choosePick(
      plan([e('claude:lab', 'ready', 87, { label: '7d', usedPercent: 87, limit: 95 })], 'claude:lab', true),
      'claude:main',
    ),
    { ref: 'claude:lab', reason: 'most-room', pressure: 87, window: '7d' },
  )
  // No data anywhere: the main account, not the first in the list.
  assert.deepEqual(
    choosePick(
      plan([e('claude:work', 'unknown'), e('claude:main', 'unknown')], 'claude:work', false),
      'claude:main',
    ),
    { ref: 'claude:main', reason: 'no-quota-data' },
  )
  // A signed-out main is not started: the pick instead, still said to have no data.
  assert.deepEqual(
    choosePick(
      plan([e('claude:work', 'unknown'), e('claude:main', 'logged-out')], 'claude:work', false),
      'claude:main',
    ),
    { ref: 'claude:work', reason: 'no-quota-data' },
  )
  // The pick has no data while the others are full: never shown as 0% used.
  assert.deepEqual(
    choosePick(
      plan([e('claude:work', 'unknown'), e('claude:main', 'full', 95)], 'claude:work', true),
      'claude:main',
    ),
    { ref: 'claude:work', reason: 'others-full' },
  )
  // Every account past the Takeover Limit: the least used one under 100%, said to be a Last Resort.
  assert.deepEqual(
    choosePick(
      {
        ...plan(
          [e('claude:work', 'full', 87.4, w5(87)), e('claude:main', 'full', 92, w5(92))],
          'claude:work',
          true,
        ),
        tight: { limit: 85, longLimit: 95 },
      },
      'claude:main',
    ),
    { ref: 'claude:work', reason: 'tight', pressure: 87, window: '5h', limit: 85, longLimit: 95 },
  )
  // Everyone signed out, with or without data: nothing starts, and it says who to sign in.
  const out = choosePick(plan([e('claude:main', 'logged-out', 20)], null, false), 'claude:main')
  assert.deepEqual(out, { ref: null, reason: 'none-usable', signIn: ['claude:main'] })
  // No subscription main (the main directory is an API account): no fallback to it, and never an API pick.
  assert.equal(choosePick(plan([e('claude:main', 'api')], 'claude:main', false), null).ref, null)
})
