import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { releaseProblem } from './release.ts'

describe('pnpm release', () => {
  it('releases only a clean main that has every commit of origin/main', () => {
    assert.equal(releaseProblem({ branch: 'main', dirty: '', behind: 0 }), null)
    assert.match(releaseProblem({ branch: 'feat/x', dirty: '', behind: 0 }) ?? '', /switch to main/)
    assert.match(releaseProblem({ branch: 'main', dirty: ' M a.ts', behind: 0 }) ?? '', /commit or stash/)
    assert.match(releaseProblem({ branch: 'main', dirty: '', behind: 2 }) ?? '', /pull first/)
  })
})
