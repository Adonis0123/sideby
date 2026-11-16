// What sideby tells about a prompt from its text (spec §3.35, §3.37 "有人在的会话", §3.42, ADR-0075, ADR-0076).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deliveredText, pasteLine } from './messages.ts'
import {
  hookWakeUp,
  hostMade,
  LAUNCH_PROMPTS_ENV,
  launchPrompt,
  launchPromptMarks,
  PROGRESS_MARK,
  progressWakeUp,
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

describe('a background hook’s wake-up', () => {
  // How Claude Code 2.1.325 hands a background Stop hook's exit 2 to the session (seen on 2026-11-16).
  const wrap = (stderr: string) =>
    `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": ${stderr}\n\n</system-reminder>`
  const reminder = wrap(
    `${PROGRESS_MARK} you are waiting on background work (1 task: command "build"), since 11:40.`,
  )

  it('is host-made, and a Progress Reminder only when it is the reminder alone', () => {
    assert.equal(hostMade(reminder), true)
    assert.equal(hookWakeUp(reminder), true)
    assert.equal(progressWakeUp(reminder), true)
    assert.equal(progressWakeUp(`  ${reminder}`), true)
    // Another hook's wake-up, a task's notification, or two wake-ups joined in one prompt are not.
    assert.equal(progressWakeUp(wrap('sideby: this is sideby Auto Handoff')), false)
    assert.equal(hookWakeUp('<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>'), false)
    assert.equal(progressWakeUp(`${reminder}\n${wrap('sideby: this is sideby Auto Handoff')}`), false)
    // Typed text that quotes the reminder is not one.
    assert.equal(progressWakeUp(`please explain: ${reminder}`), false)
  })
})
