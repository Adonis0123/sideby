// Codex in a Handoff (spec §3.17): arguments, eligibility, hooks through -c and the fallback Brief.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import type { Account } from '../../types.ts'
import { codexHandoff } from './handoff.ts'

const account = {
  family: 'codex',
  name: 'main',
  ref: 'codex:main',
  dir: '/c',
  isMain: true,
  kind: 'subscription',
} as Account

describe('codex handoff', () => {
  it('keeps -c config overrides and drops the resume subcommand, its id, --last and images', () => {
    const args = [
      '-c',
      'model="o3"',
      'resume',
      '--last',
      '-i',
      'a.png',
      'b.png',
      '-s',
      'workspace-write',
      'old prompt',
    ]
    assert.deepEqual(codexHandoff.continueArgs(args), ['-c', 'model="o3"', '-s', 'workspace-write'])
  })

  it('takes part only in interactive sessions without --remote; read-only means sideby writes the Brief', async () => {
    assert.equal((await codexHandoff.eligibility(['exec', 'do it'], account, {})).start, false)
    assert.equal((await codexHandoff.eligibility(['-m', 'o3', 'review'], account, {})).receive, false)
    assert.equal((await codexHandoff.eligibility(['--remote', 'ws://x'], account, {})).receive, false)
    assert.deepEqual(await codexHandoff.eligibility(['resume', 'abc'], account, {}), {
      start: true,
      receive: true,
    })
    assert.deepEqual(await codexHandoff.eligibility(['-s', 'read-only'], account, {}), {
      start: true,
      receive: true,
      agentBrief: false,
    })
    // A prompt that happens to be a word is not a subcommand when it comes after an option's value.
    assert.equal(
      (await codexHandoff.eligibility(['-m', 'o3', 'fix the review comments'], account, {})).start,
      true,
    )
  })

  it('also reads a read-only sandbox from -c sandbox_mode and from the account’s config.toml', async () => {
    await withFakeHome(async (h) => {
      const acct = { ...account, dir: h.path('.codex') } as Account
      assert.equal(
        (await codexHandoff.eligibility(['-c', 'sandbox_mode="read-only"'], acct, {})).agentBrief,
        false,
      )
      await h.write('.codex/config.toml', 'sandbox_mode = "read-only"\n')
      assert.equal((await codexHandoff.eligibility([], acct, {})).agentBrief, false)
      assert.equal(
        (await codexHandoff.eligibility(['-s', 'workspace-write'], acct, {})).agentBrief,
        undefined,
      )
    })
  })

  it('adds PostToolUse and Stop hooks with -c, with a fixed command so each account trusts them once', async () => {
    const args = await codexHandoff.hookArgs!((e) => `sideby handoff-hook codex ${e}`, '/state')
    assert.deepEqual(args, [
      '-c',
      'hooks.PostToolUse=[{hooks=[{type="command",command="sideby handoff-hook codex PostToolUse"}]}]',
      '-c',
      'hooks.Stop=[{hooks=[{type="command",command="sideby handoff-hook codex Stop"}]}]',
    ])
  })

  it('puts a Brief together from the rollout, skipping injected context', async () => {
    await withFakeHome(async (h) => {
      const item = (payload: object) => JSON.stringify({ type: 'response_item', payload })
      const file = await h.write(
        'rollout.jsonl',
        `${[
          item({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
          }),
          item({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Rename the config key' }],
          }),
          item({
            type: 'custom_tool_call',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Update File: src/config.ts\n@@\n',
          }),
          item({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Renamed it.' }],
          }),
        ].join('\n')}\n`,
      )
      const brief = await codexHandoff.briefFromSession!(account, { transcriptPath: file })
      assert.match(brief!, /Rename the config key/)
      assert.match(brief!, /src\/config\.ts/)
      assert.doesNotMatch(brief!, /AGENTS\.md instructions/)
    })
  })
})
