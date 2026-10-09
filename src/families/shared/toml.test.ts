import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tomlValue, topLevelTomlString } from './toml.ts'

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

describe('tomlValue', () => {
  it('reads a key in a table, a dotted top-level key, and a top-level boolean', () => {
    assert.equal(tomlValue('[sandbox]\nprofile = "strict" # pinned\n', 'sandbox', 'profile'), 'strict')
    assert.equal(tomlValue("sandbox.profile = 'workspace'\n", 'sandbox', 'profile'), 'workspace')
    assert.equal(
      tomlValue(
        'allow_managed_hooks_only = true\n[cli]\nuse_leader = false\n',
        '',
        'allow_managed_hooks_only',
      ),
      true,
    )
    assert.equal(tomlValue('[cli]\nuse_leader = false\n', 'cli', 'use_leader'), false)
  })
  it('does not read a key of another table, an array table, or an unsupported value', () => {
    assert.equal(tomlValue('[other]\nprofile = "strict"\n', 'sandbox', 'profile'), undefined)
    assert.equal(tomlValue('[[sandbox]]\nprofile = "strict"\n', 'sandbox', 'profile'), undefined)
    assert.equal(tomlValue('[sandbox]\nprofile = 3\n', 'sandbox', 'profile'), undefined)
  })
})
