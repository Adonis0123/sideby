import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countComments, countSpawns, countTests, countWaits } from './budget.ts'

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

describe('pnpm budget subprocess and wait counters', () => {
  it('counts node subprocess starts, a local wrapper by its call sites, not ones in strings or comments', () => {
    const wrapped = src(
      'function cli(h, args) {',
      '  return new Promise((resolve) => {',
      '    const child = spawn(',
      '      process.execPath,',
      '      [MAIN, ...args],',
      '    )',
      '  })',
      '}',
      "it('a', async () => {",
      "  await cli(h, ['list'])",
      "  await cli(h, ['doctor'])",
      "  await sidebySpawn(h, ['quota'])",
      '  // spawn(process.execPath)',
      "  await write('bin/x', `spawn(process.execPath, ['-e', ''])`)",
      '  assert.match(out, /run `sideby/)',
      '  await sidebySpawn(h, [])',
      '})',
    )
    assert.equal(countSpawns(wrapped), 4)
  })

  it('counts awaited waits of 1 s or more, not shorter ones, timeouts or timers in fake Host scripts', () => {
    const waits = src(
      'await new Promise((r) => setTimeout(r, 1500))',
      'await sleep(1_000)',
      'await new Promise((r) => setTimeout(r, 999))',
      'await takeLock(file, { timeoutMs: 2000 })',
      "await write('host', `setTimeout(answer, 60000)`)",
      'setTimeout(() => child.kill(), 5000)',
    )
    assert.equal(countWaits(waits), 2)
  })
})
