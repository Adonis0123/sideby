import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countComments, countTests } from './budget.ts'

const src = (...lines: string[]) => lines.join('\n')

describe('pnpm budget counter', () => {
  it('counts full comment lines, not trailing comments or // inside strings', () => {
    assert.equal(countComments(src('// a', 'const u = "https://x" // b', "const g = 'src/**/*.ts'")), 1)
  })

  it('counts every non-blank line of a block comment, but not one followed by code', () => {
    assert.equal(countComments(src('/**', ' * a', '', ' */', 'code()')), 3)
    assert.equal(countComments(src('/* a */ code()', '/* b */')), 1)
  })

  it('exempts a whole contiguous block when one line carries a marker', () => {
    assert.equal(countComments(src('// a', '// WHY: b', 'x', '// c', '/* ADR-0001 */')), 0)
    assert.equal(countComments(src('// a', '// b', 'x', '// HACK(#1) c')), 2)
  })

  it('counts # lines in shell scripts except the shebang', () => {
    assert.equal(countComments(src('#!/bin/sh', '# a', 'echo "#"'), true), 1)
  })

  it('counts test calls at any indentation, not describe or commented ones', () => {
    assert.equal(
      countTests(
        src("describe('d', () => {", "  it('a', () => {})", "  test.skip('b')", "  // it('c')", "  hit('d')"),
      ),
      2,
    )
  })
})
