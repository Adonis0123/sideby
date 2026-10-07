import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildId, packageVersion } from './version.ts'

describe('buildId', () => {
  it('is the version plus a build id: `source` from source, or the override tests use', () => {
    assert.equal(buildId({}), `${packageVersion()}+source`)
    assert.equal(buildId({ SIDEBY_BUILD_ID: 'abc' }), `${packageVersion()}+abc`)
  })
})
