import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildId, localBuild, packageVersion, parseLocalBuild } from './version.ts'

describe('buildId', () => {
  it('is the version plus a build id: `source` from source, or the override tests use', () => {
    assert.equal(buildId({}), `${packageVersion()}+source`)
    assert.equal(buildId({ SIDEBY_BUILD_ID: 'abc' }), `${packageVersion()}+abc`)
  })
})

describe('Local Build', () => {
  it('reads the fields pnpm local writes, and nothing from a published build', () => {
    assert.deepEqual(
      parseLocalBuild({
        id: 'x',
        local: true,
        commit: 'abc1234',
        dirty: true,
        builtAt: '2026-10-16T12:00:00Z',
      }),
      {
        commit: 'abc1234',
        dirty: true,
        builtAt: '2026-10-16T12:00:00Z',
      },
    )
    assert.deepEqual(parseLocalBuild({ local: true }), { commit: '', dirty: false, builtAt: '' })
    for (const v of [{ id: 'x' }, { local: 'true' }, null, 'local', []])
      assert.equal(parseLocalBuild(v), null)
  })
  it('is none from source', () => {
    assert.equal(localBuild(), null)
  })
})
