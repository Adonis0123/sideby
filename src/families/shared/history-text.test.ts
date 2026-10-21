// The text helpers every History reader uses: cutting injected blocks, and streaming lines of a file.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import { fileLines, jsonText, MAX_LINE_BYTES, SessionText, stripInjected, typedText } from './history-text.ts'

describe('history text', () => {
  it('cuts nested injected blocks whole, and an unclosed one to the end', () => {
    assert.equal(stripInjected('a <system-reminder>x</system-reminder> b'), 'a  b')
    assert.equal(
      stripInjected('a <system-reminder>1 <system-reminder>2</system-reminder> 3</system-reminder> b'),
      'a  b',
    )
    assert.equal(stripInjected('keep <system-reminder>never closed SECRET'), 'keep ')
    assert.equal(stripInjected('stray </system-reminder> ok'), 'stray </system-reminder> ok')
  })

  it('streams lines and skips one longer than the limit', async () => {
    await withFakeHome(async (h) => {
      const path = await h.write('big.jsonl', `first\n${'x'.repeat(MAX_LINE_BYTES + 10)}\n\nlast`)
      const lines: string[] = []
      for await (const l of fileLines(path)) lines.push(l)
      assert.deepEqual(lines, ['first', 'last'])
    })
  })

  it('cuts injected blocks before it reads a command or a shell escape', () => {
    assert.equal(
      typedText('<system-reminder><command-name>/SECRET_MARKER</command-name></system-reminder>hello'),
      'hello',
    )
    assert.equal(typedText('<system-reminder><bash-input>SECRET_CMD</bash-input></system-reminder>hi'), 'hi')
    assert.equal(
      typedText('<command-name>/review</command-name><command-args>now</command-args>'),
      '/review now',
    )
    assert.equal(typedText('<bash-input>ls</bash-input>'), '!ls')
    assert.equal(
      typedText('<image name=[Image #1] path="/tmp/a.png">\n</image>\nfix the header'),
      'fix the header',
    )
  })

  it('keeps at most the limit of a Session’s text, and still counts every message', () => {
    const t = new SessionText(10)
    t.prompt('123456')
    t.reply('abcdef')
    t.reply('more')
    assert.deepEqual(t.prompts, ['123456'])
    assert.deepEqual(t.replies, ['abcd'])
    assert.equal(t.count, 3)
    assert.equal(t.first, '123456')
    assert.equal(t.cut, true)
    const small = new SessionText(10)
    small.prompt('ok')
    assert.equal(small.cut, false)
  })

  it('takes every string, number and boolean of a JSON value', () => {
    assert.equal(jsonText({ a: 'x', b: [1, true, { c: 'y' }], d: null }), 'x\n1\ntrue\ny')
    assert.equal(jsonText('plain'), 'plain')
    assert.equal(jsonText([{ type: 'text', text: 'out' }]), 'out')
  })
})
