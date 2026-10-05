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

  it('expands references to keys defined earlier in the same file, never the process environment', () => {
    const text = [
      'KEY=abc',
      'export TOKEN="$KEY"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Secret File syntax, not a template
      'BRACED=${KEY}-x',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Secret File syntax, not a template
      'MIXED="pre ${KEY} $KEY post"',
      "LITERAL='$KEY'",
      'ESCAPED="\\$KEY costs $5"',
      'KEY=changed',
      'LATER=$KEY',
    ].join('\n')
    assert.deepEqual(parseSecretFile(text, 'p'), {
      KEY: 'changed',
      TOKEN: 'abc',
      BRACED: 'abc-x',
      MIXED: 'pre abc abc post',
      LITERAL: '$KEY',
      ESCAPED: '$KEY costs $5',
      LATER: 'changed',
    })
    process.env.SIDEBY_TEST_FROM_ENV = 'leak'
    try {
      assert.throws(
        () => parseSecretFile('A="$SIDEBY_TEST_FROM_ENV"', 'p'),
        (e: unknown) =>
          e instanceof SecretFileError &&
          /p:1: \$SIDEBY_TEST_FROM_ENV is not defined earlier/.test(e.message),
      )
    } finally {
      delete process.env.SIDEBY_TEST_FROM_ENV
    }
  })

  it('names the line on errors and never echoes its content', () => {
    for (const [text, re] of [
      ['A=1\nnot valid', /p:2: expected KEY=VALUE/],
      ['A="open', /p:1: unterminated quote/],
      ['A="x" y', /p:1: text after closing quote/],
      ['A=$(cat secret)', /p:1: command substitution/],
      ['A=`id`', /p:1: command substitution/],
      ['A=${secret', /p:1: unterminated \$\{/],
      ['A=$LATER\nLATER=secret', /p:1: \$LATER is not defined earlier/],
    ] as const) {
      assert.throws(
        () => parseSecretFile(text, 'p'),
        (e: unknown) => e instanceof SecretFileError && re.test(e.message) && !e.message.includes('secret'),
      )
    }
  })
})
