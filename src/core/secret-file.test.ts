import assert from 'node:assert/strict'
import { lstat, readFile, readlink, realpath, stat, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { parseSecretFile, SECRET_VAR_NAME, SecretFileError, secretVarFor, setSecret } from './secret-file.ts'

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

describe('setSecret', () => {
  it('replaces the assignment in place and leaves every other line byte for byte', async () => {
    await withFakeHome(async (h) => {
      const original =
        '# café\r\n  OTHER = spaced  \r\nexport ANTHROPIC_AUTH_TOKEN=old-value\r\nANTHROPIC_AUTH_TOKEN_EXTRA=keep\r\nTAIL=end\r\n'
      const file = await h.write('acct/proxy.env', original, 0o644)
      const value = 'new-token-value'
      const result = await setSecret(file, 'ANTHROPIC_AUTH_TOKEN', value)
      const next = await readFile(file, 'utf8')
      assert.equal(
        next,
        original.replace('export ANTHROPIC_AUTH_TOKEN=old-value\r\n', `ANTHROPIC_AUTH_TOKEN=${value}\r\n`),
      )
      assert.equal(result.action, 'replaced')
      assert.equal(result.viaLink, false)
      assert.equal(result.path, file)
      assert.equal(result.name, 'ANTHROPIC_AUTH_TOKEN')
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal(JSON.stringify(result).includes(value), false)
    })
  })

  it('appends when the variable is missing, including a commented template line', async () => {
    await withFakeHome(async (h) => {
      const original = '# ANTHROPIC_AUTH_TOKEN=\nOTHER=1'
      const file = await h.write('acct/proxy.env', original, 0o644)
      const value = 'appended-token'
      const result = await setSecret(file, 'ANTHROPIC_AUTH_TOKEN', value)
      assert.equal(result.action, 'appended')
      assert.equal(await readFile(file, 'utf8'), `${original}\nANTHROPIC_AUTH_TOKEN=${value}\n`)
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    })
  })

  it('replaces every assignment of that name so an earlier value cannot remain', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write(
        'acct/proxy.env',
        'OPENAI_API_KEY=old-one\nOTHER=1\nOPENAI_API_KEY=old-two\n',
        0o600,
      )
      await setSecret(file, 'OPENAI_API_KEY', 'fresh-token')
      assert.equal(
        await readFile(file, 'utf8'),
        'OPENAI_API_KEY=fresh-token\nOTHER=1\nOPENAI_API_KEY=fresh-token\n',
      )
    })
  })

  it('writes a quoted value that parseSecretFile reads back unchanged', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('acct/proxy.env', 'OTHER=1\n', 0o600)
      const value = "it's $5 and a # hash"
      await setSecret(file, 'OPENAI_API_KEY', value)
      const parsed = parseSecretFile(await readFile(file, 'utf8'), file)
      assert.equal(parsed.OPENAI_API_KEY, value)
      assert.equal(parsed.OTHER, '1')
    })
  })

  it('writes through to a symlink target and leaves the link itself unchanged', async () => {
    await withFakeHome(async (h) => {
      const real = await h.write('acct/proxy.env', 'OTHER=1\nANTHROPIC_AUTH_TOKEN=old\n', 0o644)
      await h.mkdir('link')
      const link = h.path('link/proxy.env')
      await symlink(real, link)
      const pointed = await readlink(link)
      const value = 'via-link-token'
      const result = await setSecret(link, 'ANTHROPIC_AUTH_TOKEN', value)
      assert.equal(await readlink(link), pointed)
      assert.equal((await lstat(link)).isSymbolicLink(), true)
      assert.equal(result.viaLink, true)
      assert.equal(result.path, await realpath(link))
      assert.equal(result.action, 'replaced')
      assert.equal(await readFile(real, 'utf8'), `OTHER=1\nANTHROPIC_AUTH_TOKEN=${value}\n`)
      assert.equal((await stat(real)).mode & 0o777, 0o600)
      assert.equal(JSON.stringify(result).includes(value), false)
    })
  })

  it('rejects an invalid name and a newline value without echoing the value or writing', async () => {
    await withFakeHome(async (h) => {
      const original = 'OTHER=1\n'
      const file = await h.write('acct/proxy.env', original, 0o644)
      const value = 'fake-token-value'
      for (const name of ['bad-name', 'lower', 'A-B', '1ABC', '']) {
        await assert.rejects(
          () => setSecret(file, name, value),
          (err: unknown) => {
            assert.ok(err instanceof SecretFileError)
            assert.match(err.message, /sideby key/)
            assert.equal(err.message.includes(value), false)
            return true
          },
        )
      }
      const multiline = 'line-one-secret\nline-two-secret'
      await assert.rejects(
        () => setSecret(file, 'ANTHROPIC_AUTH_TOKEN', multiline),
        (err: unknown) => {
          assert.ok(err instanceof SecretFileError)
          assert.match(err.message, /single line/)
          assert.equal(err.message.includes('line-one-secret'), false)
          assert.equal(err.message.includes('line-two-secret'), false)
          return true
        },
      )
      await assert.rejects(
        () => setSecret(file, 'ANTHROPIC_AUTH_TOKEN', 'left\rright-secret'),
        (err: unknown) =>
          err instanceof SecretFileError &&
          !err.message.includes('right-secret') &&
          !err.message.includes('left'),
      )
      assert.equal(await readFile(file, 'utf8'), original)
      assert.equal((await stat(file)).mode & 0o777, 0o644)
    })
  })
})

describe('secretVarFor', () => {
  it('uses the family field, else the first key-like apiVar, else says to pass --var', () => {
    assert.equal(SECRET_VAR_NAME.test('ANTHROPIC_AUTH_TOKEN'), true)
    assert.equal(
      secretVarFor({
        title: 'Claude Code',
        apiVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
        secretVar: 'ANTHROPIC_AUTH_TOKEN',
      }),
      'ANTHROPIC_AUTH_TOKEN',
    )
    assert.equal(
      secretVarFor({ title: 'Codex', apiVars: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'] }),
      'OPENAI_API_KEY',
    )
    assert.throws(
      () => secretVarFor({ title: 'Lab', apiVars: ['LAB_BASE_URL'] }),
      (err: unknown) => err instanceof SecretFileError && /--var/.test(err.message),
    )
  })
})
