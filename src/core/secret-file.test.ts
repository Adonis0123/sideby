import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSecretFile, SecretFileError } from './secret-file.ts'

describe('parseSecretFile', () => {
  it('reads the supported dotenv subset without executing anything', () => {
    const text = [
      '# comment',
      '',
      'A=plain',
      'export B="quoted value"',
      "C='single $NOT_EXPANDED'",
      'D=trailing # comment',
      'E="esc \\"q\\" \\\\ \\n"',
      'F=',
      '  G = spaced  ',
    ].join('\n')
    assert.deepEqual(parseSecretFile(text, 'p'), {
      A: 'plain',
      B: 'quoted value',
      C: 'single $NOT_EXPANDED',
      D: 'trailing',
      E: 'esc "q" \\ \n',
      F: '',
      G: 'spaced',
    })
  })

  it('names the line on errors and never echoes its content', () => {
    for (const [text, re] of [
      ['A=1\nnot valid', /p:2: expected KEY=VALUE/],
      ['A="open', /p:1: unterminated quote/],
      ['A="x" y', /p:1: text after closing quote/],
      ['A=$(cat secret)', /p:1: command substitution/],
      ['A=`id`', /p:1: command substitution/],
    ] as const) {
      assert.throws(
        () => parseSecretFile(text, 'p'),
        (e: unknown) => e instanceof SecretFileError && re.test(e.message) && !e.message.includes('secret'),
      )
    }
  })
})
