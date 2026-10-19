// What the hook tells the model (spec §3.17): the 80% message asks for a Brief and must not promise the user a switch.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareMessage, thresholdMessage, windowText } from './messages.ts'

describe('hook messages', () => {
  it('the preparing message asks for the Brief and keeps the model from announcing a switch', () => {
    const m = prepareMessage('/x/1-claude-001.md', {
      label: '5h',
      usedPercent: 81.6,
      resetsAt: '2026-10-09T15:00:00Z',
    })
    assert.match(m, /5-hour \(5h\) quota is at 82%, back at /)
    assert.match(m, /Write a handoff brief to \/x\/1-claude-001\.md/)
    assert.match(m, /Do not tell the user that the work will move to another account/)
    assert.doesNotMatch(m, /take over/)
  })

  it('the threshold message still says sideby starts the next account', () => {
    const m = thresholdMessage('/x/1.md', { label: '7d', usedPercent: 96, resetsAt: '2026-10-12T20:00:00Z' })
    assert.match(m, /sideby will start the next account/)
    assert.match(m, /<!-- handoff brief complete -->/)
  })

  it('names the window, so the weekly window is not taken for the 5-hour one', () => {
    assert.match(
      windowText({ label: '7d', usedPercent: 95, resetsAt: '2026-10-12T20:00:00Z' }),
      /^weekly \(7d\) quota is at 95%/,
    )
    assert.match(
      windowText({ label: '300m', usedPercent: 50, resetsAt: 'bad' }),
      /^300m quota is at 50%, back at an unknown time$/,
    )
  })
})
