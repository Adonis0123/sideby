// What sideby tells about a prompt from its text (spec §3.35, §3.37 "有人在的会话", ADR-0075).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deliveredText, pasteLine } from './messages.ts'
import {
  hostMade,
  LAUNCH_PROMPTS_ENV,
  launchPrompt,
  launchPromptMarks,
  sidebyMessage,
} from './prompt-origin.ts'

describe('prompt origin', () => {
  it('tells a prompt Claude Code made itself', () => {
    assert.equal(hostMade('<task-notification>\n<task-id>b1</task-id>'), true)
    assert.equal(hostMade('  \n<task-notification><summary>Stop hook feedback</summary>'), true)
    assert.equal(hostMade('what does <task-notification> mean?'), false)
  })

  it('tells every Message `sideby send` delivers, and the line it asks the user to paste', () => {
    assert.equal(sidebyMessage(deliveredText('0a47374f', 'claude:work · 12ab34cd', 'hi', ['/x.png'])), true)
    assert.equal(sidebyMessage(deliveredText('0a47374f', undefined, '', [])), true)
    assert.equal(sidebyMessage(pasteLine('0a47374f', '/s/m.md', 1, 'en')), true)
    assert.equal(sidebyMessage(pasteLine('0a47374f', '/s/m.md', 0, 'zh')), true)
    assert.equal(sidebyMessage('send a sideby message to claude:work'), false)
  })

  it('marks every argument that may be a prompt, and finds a prompt among them however its spaces were tidied', () => {
    const marks = launchPromptMarks([
      '--model',
      'opus',
      '--settings=/s/x.json',
      '-p',
      '',
      'Read the brief\nat /b.md',
    ])
    assert.equal(marks.split(',').length, 3)
    const env = { [LAUNCH_PROMPTS_ENV]: marks }
    assert.equal(launchPrompt('Read the brief at /b.md', env), true)
    assert.equal(launchPrompt('  Read the brief   at /b.md\n', env), true)
    assert.equal(launchPrompt('/s/x.json', env), true)
    assert.equal(launchPrompt('Read the brief', env), false)
    assert.equal(launchPrompt('typed', { [LAUNCH_PROMPTS_ENV]: '' }), false)
    // At most 64 marks.
    assert.equal(launchPromptMarks(Array.from({ length: 100 }, (_, i) => `p${i}`)).split(',').length, 64)
  })

  it('cannot tell, and so counts every prompt as a launch prompt, when the launch did not say', () => {
    assert.equal(launchPrompt('typed', {}), true)
    assert.equal(launchPrompt('typed', { [LAUNCH_PROMPTS_ENV]: '?' }), true)
    assert.equal(launchPrompt('typed', { [LAUNCH_PROMPTS_ENV]: 'abc' }), true)
    assert.equal(launchPrompt('typed', { [LAUNCH_PROMPTS_ENV]: `${'0'.repeat(16)},` }), true)
  })
})
