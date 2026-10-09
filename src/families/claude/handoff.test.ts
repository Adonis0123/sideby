// Claude Code in a Handoff (spec §3.17): arguments for the next session, eligibility, hooks and the fallback Brief.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import { claudeHandoff } from './handoff.ts'

const account = (dir: string): Account =>
  ({ family: 'claude', name: '001', ref: 'claude:001', dir, isMain: false, kind: 'subscription' }) as Account

describe('claude handoff', () => {
  it('carries options with their values and drops resume, continue, name and the old prompt', () => {
    const args = [
      '--model',
      'opus',
      '--resume',
      '0b6f1a5e-1111-4222-8333-944445555666',
      '-c',
      '--dangerously-skip-permissions',
      '--add-dir',
      'a',
      'b',
      '-n',
      'old',
      'fix the bug',
    ]
    assert.deepEqual(claudeHandoff.continueArgs(args), [
      '--model',
      'opus',
      '--dangerously-skip-permissions',
      '--add-dir',
      'a',
      'b',
    ])
    assert.deepEqual(claudeHandoff.continueArgs(['-r', '--model', 'x', '--', 'prompt']), ['--model', 'x'])
  })

  it('puts the first prompt after -- so --add-dir cannot swallow it', () => {
    assert.deepEqual(
      [...claudeHandoff.dirArgs!('/c'), ...claudeHandoff.promptArgs('read /c/1.md')],
      ['--add-dir', '/c', '--', 'read /c/1.md'],
    )
  })

  it('takes no part in a headless run, and only receives when --settings is already given', async () => {
    assert.equal((await claudeHandoff.eligibility(['-p', 'x'], account('/a'), {})).receive, false)
    const own = await claudeHandoff.eligibility(['--settings', 'mine.json'], account('/a'), {})
    assert.deepEqual([own.start, own.receive], [false, true])
    assert.deepEqual(await claudeHandoff.eligibility(['--model', 'opus'], account('/a'), {}), {
      start: true,
      receive: true,
    })
  })

  it('writes its hooks to a settings file in the state directory, mode 600', async () => {
    await withFakeHome(async (h) => {
      const args = await claudeHandoff.hookArgs!((e) => `sideby handoff-hook claude ${e}`, h.path('state'))
      assert.equal(args[0], '--settings')
      assert.equal((await stat(args[1]!)).mode & 0o777, 0o600)
      const s = JSON.parse(await readFile(args[1]!, 'utf8'))
      assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'sideby handoff-hook claude PostToolUse')
      assert.equal(s.hooks.StopFailure[0].matcher, 'rate_limit')
    })
  })

  it('puts a Brief together from the session file: first request, last messages, edited files', async () => {
    await withFakeHome(async (h) => {
      const lines = [
        { type: 'user', message: { content: 'Add a dark mode toggle' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Looking at the settings page.' },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/settings.tsx' } },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET TOOL OUTPUT' }] } },
        { type: 'user', isMeta: true, message: { content: 'meta' } },
      ]
      await h.write(
        '.claude-001/projects/-repo/s1.jsonl',
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      )
      const brief = await claudeHandoff.briefFromSession!(account(h.path('.claude-001')), { id: 's1' })
      assert.match(brief!, /Add a dark mode toggle/)
      assert.match(brief!, /\/repo\/settings\.tsx/)
      assert.doesNotMatch(brief!, /SECRET TOOL OUTPUT|meta/)
      assert.equal(
        await claudeHandoff.briefFromSession!(account(h.path('.claude-001')), { id: 'nope' }),
        undefined,
      )
    })
  })
})
