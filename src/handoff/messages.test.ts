// What the hook tells the model (spec §3.17): the 80% message asks for a Brief and must not promise the user a switch.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareMessage, thresholdMessage } from './messages.ts'

describe('hook messages', () => {
  it('the preparing message asks for the Brief and keeps the model from announcing a switch', () => {
    const m = prepareMessage('/x/1-claude-001.md', 81.6)
    assert.match(m, /quota is at 82%/)
    assert.match(m, /Write a handoff brief to \/x\/1-claude-001\.md/)
    assert.match(m, /Do not tell the user that the work will move to another account/)
    assert.doesNotMatch(m, /take over/)
  })

  it('the threshold message still says sideby starts the next account', () => {
    assert.match(thresholdMessage('/x/1.md', 96), /sideby will start the next account/)
  })
})
