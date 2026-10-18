import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claudeAiTaskArgs } from './ai-task.ts'

const AUTO = ['--permission-mode', 'auto']

describe('claude AI Task arguments', () => {
  it('drops every permission bypass and starts in auto mode, other arguments kept in order', () => {
    assert.deepEqual(claudeAiTaskArgs(['--dangerously-skip-permissions']), AUTO)
    assert.deepEqual(
      claudeAiTaskArgs(['--model', 'opus', '--dangerously-skip-permissions', '--effort', 'high', 'fix it']),
      [...AUTO, '--model', 'opus', '--effort', 'high', 'fix it'],
    )
    assert.deepEqual(claudeAiTaskArgs(['--permission-mode', 'bypassPermissions', '--model', 'opus', 'hi']), [
      ...AUTO,
      '--model',
      'opus',
      'hi',
    ])
    assert.deepEqual(claudeAiTaskArgs(['--permission-mode=bypassPermissions', 'hi']), [...AUTO, 'hi'])
    assert.deepEqual(claudeAiTaskArgs(['--allow-dangerously-skip-permissions', '--verbose', 'hi']), [
      ...AUTO,
      '--verbose',
      'hi',
    ])
  })

  it('keeps a permission mode the arguments already pick and adds no auto', () => {
    assert.deepEqual(claudeAiTaskArgs(['--permission-mode', 'plan', 'hi']), [
      '--permission-mode',
      'plan',
      'hi',
    ])
    assert.deepEqual(
      claudeAiTaskArgs(['--dangerously-skip-permissions', '--permission-mode=acceptEdits', 'hi']),
      ['--permission-mode=acceptEdits', 'hi'],
    )
  })

  it('leaves the text after -- alone', () => {
    assert.deepEqual(claudeAiTaskArgs(['--model', 'x', '--', '--dangerously-skip-permissions']), [
      ...AUTO,
      '--model',
      'x',
      '--',
      '--dangerously-skip-permissions',
    ])
  })
})
