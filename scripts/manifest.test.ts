import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { manifestText } from './manifest.ts'

const file = join(resolve(import.meta.dirname, '..'), 'docs/assets/manifest.json')

describe('docs/assets/manifest.json as readme-assets --mark writes it', () => {
  it('is what biome wants (2 spaces, a final newline), also when run from another directory', () => {
    const committed = readFileSync(file, 'utf8')
    const before = process.cwd()
    process.chdir(tmpdir())
    try {
      const text = manifestText(JSON.parse(committed))
      assert.equal(text, committed)
      assert.match(text, /^\{\n {2}"/)
      assert.ok(!text.includes('\t'))
      assert.ok(text.endsWith('}\n'))
    } finally {
      process.chdir(before)
    }
  })
})
