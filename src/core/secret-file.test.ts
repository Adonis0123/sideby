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
  })

  it('reads only non-secret locations such as HOME from the environment it is given', () => {
    const env = { HOME: '/fake-home', OPENAI_API_KEY: 'leak' }
    assert.deepEqual(parseSecretFile('NOTIFY="$HOME/bin/notify"\nHOME=/own\nAGAIN=$HOME', 'p', env), {
      NOTIFY: '/fake-home/bin/notify',
      HOME: '/own',
      AGAIN: '/own',
    })
    process.env.SIDEBY_TEST_FROM_ENV = 'leak'
    try {
      for (const text of ['A="$OPENAI_API_KEY"', 'A=$SIDEBY_TEST_FROM_ENV', 'A=$USER'])
        assert.throws(
          () => parseSecretFile(text, 'p', env),
          (e: unknown) =>
            e instanceof SecretFileError &&
            /p:1: \$\w+ is not defined earlier in this file; from the environment only HOME/.test(
              e.message,
            ) &&
            !e.message.includes('leak'),
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
