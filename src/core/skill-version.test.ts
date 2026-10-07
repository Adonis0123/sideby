// The shipped Agent Skill (spec §3.11): its version follows the package, and its routing table and the
// reference files match, so an agent never reads a missing file and no reference is unreachable.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { skillVersionOf } from './skill-check.ts'
import { packageVersion } from './version.ts'

const dir = new URL('../../skills/sideby/', import.meta.url)

describe('shipped skill', () => {
  it('carries the package version (npm version runs scripts/sync-skill-version.ts)', async () => {
    const text = await readFile(new URL('SKILL.md', dir), 'utf8')
    assert.equal(
      skillVersionOf(text),
      packageVersion(),
      'run `node scripts/sync-skill-version.ts` to set metadata.version in skills/sideby/SKILL.md',
    )
  })

  it('links every reference file, and every link points at one that exists', async () => {
    const text = await readFile(new URL('SKILL.md', dir), 'utf8')
    const linked = new Set([...text.matchAll(/`references\/([a-z-]+\.md)`/g)].map((m) => m[1]))
    const files = new Set((await readdir(new URL('references/', dir))).filter((f) => f.endsWith('.md')))
    assert.deepEqual([...linked].sort(), [...files].sort(), 'SKILL.md and skills/sideby/references/ disagree')
  })
})
