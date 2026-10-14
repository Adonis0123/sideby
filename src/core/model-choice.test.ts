// Model and effort per Account (spec §3.19, ADR-0014): what is shown and where it comes from, and the one change
// sideby makes, to the model and effort arguments in its own config.
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { codexModelChoice } from '../families/codex/model.ts'
import { readCodexUsage } from '../families/codex/rollout.ts'
import { createRuntime } from '../runtime.ts'
import { accountModel, setAccountModel } from './model-choice.ts'

const builtins = [claudePlugin, codexPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString()

async function setup(h: FakeHome, accounts: object = {}) {
  await h.write(
    '.claude/settings.json',
    JSON.stringify({
      model: 'sonnet',
      effortLevel: 'high',
      modelSettings: { sonnet: { effortLevel: 'low' } },
      apiKeyHelper: 'SHOULD-NOT-LEAK',
    }),
  )
  const row = (model: string, effort: string, ago: number, id: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(ago),
      sessionId: 's1',
      effort,
      message: { id, model, usage: { input_tokens: 10, output_tokens: 5 } },
    })
  await h.write(
    '.claude-001/projects/p/s1.jsonl',
    [row('claude-sonnet-5-5', 'low', 60_000, 'a'), row('claude-opus-5-5', 'medium', 1_000, 'b')].join('\n'),
  )
  await h.write(
    '.claude-api/proxy.env',
    'ANTHROPIC_BASE_URL=https://example.invalid\nANTHROPIC_MODEL=m1\n',
    0o600,
  )
  await h.write('.codex/auth.json', '{}', 0o600)
  await h.write('.codex/config.toml', 'model = "gpt-x"\nmodel_reasoning_effort = "low"\n')
  await h.write('.config/sideby/config.json', JSON.stringify({ accounts }))
  return createRuntime({ env: h.env, builtins })
}

describe('accountModel', () => {
  it('takes each value from sideby, else the host config, else the last session, and says which', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { 'claude:main': { args: ['--effort', 'xhigh'] } })
      const main = await accountModel(rt, await rt.resolve('claude:main'))
      assert.deepEqual(main.model, { value: 'sonnet', from: 'host' })
      assert.deepEqual(main.effort, { value: 'xhigh', from: 'sideby' })
      // The per-model level wins over the top-level one in the same file.
      assert.deepEqual(main.host, { model: 'sonnet', effort: 'low' })
      const one = await accountModel(rt, await rt.resolve('claude:001'))
      assert.deepEqual(one.model, { value: 'claude-opus-5-5', from: 'last' })
      assert.deepEqual(one.effort, { value: 'medium', from: 'last' })
      assert.ok(one.models.includes('claude-opus-5-5') && one.models.includes('opus'))
      const codex = await accountModel(rt, await rt.resolve('codex:main'))
      assert.deepEqual(codex.model, { value: 'gpt-x', from: 'host' })
      assert.deepEqual(codex.effort, { value: 'low', from: 'host' })
      const api = await accountModel(rt, await rt.resolve('claude:api'))
      assert.equal(api.settable, false)
      assert.deepEqual(api.model, { value: 'm1', from: 'host' })
      assert.ok(!JSON.stringify([main, one, codex, api]).includes('SHOULD-NOT-LEAK'))
    })
  })
})

describe('per-model effort', () => {
  it('is looked up for the model sideby starts the account with', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { 'claude:main': { args: ['--model', 'opus'] } })
      await h.write(
        '.claude/settings.json',
        JSON.stringify({
          model: 'sonnet',
          modelSettings: { sonnet: { effortLevel: 'low' }, opus: { effortLevel: 'high' } },
        }),
      )
      const main = await accountModel(rt, await rt.resolve('claude:main'))
      assert.deepEqual(main.effort, { value: 'high', from: 'host' })
    })
  })
})

describe('setAccountModel', () => {
  it('shows the change first, then swaps only the model and effort arguments; default removes them', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { 'claude:001': { args: ['--verbose', '--model=old', '--', 'hi'] } })
      const config = h.path('.config/sideby/config.json')
      const before = await snapshot(h.home)
      const plan = await setAccountModel(
        rt,
        await rt.resolve('claude:001'),
        { model: 'opus', effort: 'high' },
        { apply: false },
      )
      assert.equal(plan.changed, true)
      assert.match(plan.diff, /\+ {7}"opus"/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      await setAccountModel(
        rt,
        await rt.resolve('claude:001'),
        { model: 'opus', effort: 'high' },
        { apply: true },
      )
      const read = async () => JSON.parse(await readFile(config, 'utf8')).accounts
      assert.deepEqual((await read())['claude:001'].args, [
        '--verbose',
        '--model',
        'opus',
        '--effort',
        'high',
        '--',
        'hi',
      ])
      // Only sideby's config changed; no Host directory did.
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.config/sideby/config.json'])
      const rt2 = await createRuntime({ env: h.env, builtins })
      const launch = await rt2.prepareLaunch('claude:001', [], 'run')
      const i = launch.args.indexOf('--model')
      assert.deepEqual(launch.args.slice(i, i + 4), ['--model', 'opus', '--effort', 'high'])
      await setAccountModel(rt2, await rt2.resolve('claude:001'), { model: null }, { apply: true })
      assert.deepEqual((await read())['claude:001'].args, ['--verbose', '--effort', 'high', '--', 'hi'])
    })
  })

  it('writes nothing when there is nothing to change, not even an empty accounts key', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h)
      await rm(h.path('.config/sideby/config.json'))
      const r = await setAccountModel(
        rt,
        await rt.resolve('claude:main'),
        { model: null, effort: null },
        { apply: true },
      )
      assert.equal(r.changed, false)
      await assert.rejects(readFile(h.path('.config/sideby/config.json'), 'utf8'))
    })
  })

  it('drops the account entry when no argument is left, and refuses bad values and API accounts', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { 'codex:main': { args: ['-m', 'gpt-y'] } })
      await setAccountModel(rt, await rt.resolve('codex:main'), { model: null }, { apply: true })
      const accounts = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')).accounts
      assert.deepEqual(accounts, {})
      const codex = await rt.resolve('codex:main')
      await assert.rejects(
        setAccountModel(rt, codex, { effort: 'huge' }, { apply: false }),
        /minimal, low, medium/,
      )
      await assert.rejects(setAccountModel(rt, codex, { model: 'a b' }, { apply: false }), /not a model name/)
      await assert.rejects(
        setAccountModel(rt, await rt.resolve('claude:api'), { model: 'x' }, { apply: false }),
        /proxy\.env/,
      )
    })
  })
})

describe('model arguments and last session', () => {
  it('takes only the effort override out of several -c options', () => {
    const r = codexModelChoice.fromArgs([
      '-c',
      'foo=1',
      '--config=model_reasoning_effort="high"',
      '-m',
      'x',
      '--',
      '-m',
    ])
    assert.deepEqual(r.choice, { model: 'x', effort: 'high' })
    assert.deepEqual(r.rest, ['-c', 'foo=1', '--', '-m'])
    assert.deepEqual(codexModelChoice.toArgs({ model: 'x', effort: 'low' }), [
      '-m',
      'x',
      '-c',
      'model_reasoning_effort="low"',
    ])
  })

  it('Codex usage reports the model and effort of the newest turn_context', async () => {
    await withFakeHome(async (h) => {
      const ctx = (at: number, model: string, effort: string) =>
        JSON.stringify({ timestamp: iso(at), type: 'turn_context', payload: { model, effort } })
      const tokens = (at: number) =>
        JSON.stringify({
          timestamp: iso(at),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
          },
        })
      await h.write(
        join('.codex', 'sessions', '2026', '10', '14', 'rollout-a.jsonl'),
        [ctx(60_000, 'gpt-a', 'low'), tokens(50_000), ctx(2_000, 'gpt-b', 'high'), tokens(1_000)].join('\n'),
      )
      const r = await readCodexUsage(h.path('.codex'), new Date())
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.equal(r.lastModel, 'gpt-b')
      assert.equal(r.lastEffort, 'high')
    })
  })
})
