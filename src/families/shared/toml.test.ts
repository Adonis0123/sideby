import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { topLevelTomlString } from './toml.ts'

describe('topLevelTomlString', () => {
  it('reads top-level keys and stops at the first table header', () => {
    assert.equal(topLevelTomlString('model = "a"\n[profiles.x]\nmodel = "b"\n', 'model'), 'a')
    assert.equal(topLevelTomlString("[x]\nmodel = 'b'\n", 'model'), undefined)
    assert.equal(topLevelTomlString('[[servers]]\nmodel = "b"\n', 'model'), undefined)
  })
  it('does not treat a multi-line array line as a header', () => {
    assert.equal(topLevelTomlString('dirs = [\n  ["a"],\n  [1],\n]\nmodel = "m"\n', 'model'), 'm')
  })
})
