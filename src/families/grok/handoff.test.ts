// Grok Build in a Handoff (spec §3.17): the sandbox decides start and receive, arguments, the hook file setup and
// the fallback Brief.
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, snapshot, withFakeHome } from '../../../testing/index.ts'
import type { Account, ReadContext } from '../../types.ts'
import { type GrokLayers, grokEligibility, grokHandoff, grokHookFileText, grokPolicy } from './handoff.ts'

const none: GrokLayers = {
  etcRequirements: null,
  homeRequirements: null,
  config: null,
  homeManaged: null,
  etcManaged: null,
}
const profile = (p: string) => `[sandbox]\nprofile = "${p}"\n`

describe('grok policy', () => {
  it('follows Grok’s precedence: requirements pin, then flag, env, config, managed', () => {
    assert.equal(grokPolicy(none, [], {}).profile, 'off')
    assert.equal(grokPolicy({ ...none, etcManaged: profile('workspace') }, [], {}).profile, 'workspace')
    assert.equal(
      grokPolicy({ ...none, homeManaged: profile('devbox'), etcManaged: profile('workspace') }, [], {})
        .profile,
      'devbox',
    )
    assert.equal(
      grokPolicy({ ...none, config: profile('read-only'), homeManaged: profile('devbox') }, [], {}).profile,
      'read-only',
    )
    assert.equal(
      grokPolicy({ ...none, config: profile('read-only') }, [], { GROK_SANDBOX: 'strict' }).profile,
      'strict',
    )
    assert.equal(
      grokPolicy(none, ['--sandbox', 'workspace'], { GROK_SANDBOX: 'strict' }).profile,
      'workspace',
    )
    assert.equal(
      grokPolicy(
        { ...none, homeRequirements: profile('strict'), etcRequirements: profile('off') },
        ['--sandbox', 'devbox'],
        {},
      ).profile,
      'off',
    )
  })

  it('reads the leader setting with the flags first, and the managed-hooks pin from any policy file', () => {
    assert.equal(grokPolicy({ ...none, config: '[cli]\nuse_leader = true\n' }, [], {}).leader, true)
    assert.equal(
      grokPolicy({ ...none, config: '[cli]\nuse_leader = true\n' }, ['--no-leader'], {}).leader,
      false,
    )
    assert.equal(
      grokPolicy({ ...none, etcRequirements: 'allow_managed_hooks_only = true\n' }, [], {}).managedHooksOnly,
      true,
    )
  })
})

describe('grok eligibility', () => {
  const at = (layers: Partial<GrokLayers>, args: string[] = []) =>
    grokEligibility(grokPolicy({ ...none, ...layers }, args, {}), args, '/g')
  it('starts under off or devbox, only receives under workspace or read-only, neither under strict or custom', () => {
    assert.deepEqual(at({}), { start: true, receive: true })
    assert.deepEqual(
      [at({ config: profile('devbox') }).start, at({ config: profile('workspace') }).start],
      [true, false],
    )
    assert.equal(at({ config: profile('read-only') }).receive, true)
    assert.deepEqual(
      [at({ config: profile('strict') }).receive, at({ config: profile('mine') }).receive],
      [false, false],
    )
    assert.equal(at({ etcRequirements: 'allow_managed_hooks_only = true\n' }).start, false)
    assert.equal(at({}, ['-p', 'x']).receive, false)
  })
  it('gives each account its own leader socket when the leader is on', () => {
    assert.deepEqual(at({ config: '[cli]\nuse_leader = true\n' }).args, ['--leader-socket', '/g/leader.sock'])
    assert.equal(at({}, ['--leader']).args?.[1], '/g/leader.sock')
    assert.equal(at({}).args, undefined)
  })
})

describe('grok handoff arguments', () => {
  it('drops --resume with or without its title, --session-id with its id, and continue flags', () => {
    assert.deepEqual(
      grokHandoff.continueArgs([
        '-r',
        'my title',
        '-m',
        'grok-4',
        '--resume',
        '-c',
        '-s',
        'abc',
        '--always-approve',
        'old',
      ]),
      ['-m', 'grok-4', '--always-approve'],
    )
  })
})

describe('grok hook setup', () => {
  const ctx = (home: string, bin: string): ReadContext => ({
    home,
    now: new Date(),
    stateDir: join(home, 'state'),
    env: { PATH: bin },
  })

  it('shows the file, writes only it on apply, and teardown restores the directory exactly', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/hooks/notify.sh', '#!/bin/sh\n', 0o755)
      const bin = h.path('bin')
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, 'sideby'), '#!/bin/sh\n')
      await chmod(join(bin, 'sideby'), 0o755)
      const setup = grokHandoff.hookSetup!
      const before = await snapshot(h.home)
      const p = await setup.plan(ctx(h.home, bin))
      assert.equal(p.status, 'ready')
      assert.match(p.message, /sideby doctor grok --fix/)
      assert.equal((await setup.apply(ctx(h.home, bin))).status, 'enabled')
      assert.equal(await readFile(h.path('.grok/hooks/sideby-handoff.json'), 'utf8'), grokHookFileText())
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.grok/hooks/sideby-handoff.json'])
      assert.equal((await setup.plan(ctx(h.home, bin))).status, 'enabled')
      assert.equal((await setup.teardown(ctx(h.home, bin))).ok, true)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('refuses without sideby on PATH, and leaves a changed or foreign file alone', async () => {
    await withFakeHome(async (h) => {
      const setup = grokHandoff.hookSetup!
      assert.equal((await setup.plan(ctx(h.home, h.path('nobin')))).status, 'blocked')
      await h.write('.grok/hooks/sideby-handoff.json', '{"hooks":{}}\n')
      assert.equal((await setup.plan(ctx(h.home, h.path('nobin')))).status, 'blocked')
      const t = await setup.teardown(ctx(h.home, h.path('nobin')))
      assert.equal(t.ok, false)
      assert.equal(await readFile(h.path('.grok/hooks/sideby-handoff.json'), 'utf8'), '{"hooks":{}}\n')
    })
  })
})

describe('grok fallback Brief', () => {
  it('reads chat_history.jsonl by session id: user text, assistant text and edited paths', async () => {
    await withFakeHome(async (h) => {
      const lines = [
        { type: 'system', content: 'system prompt' },
        { type: 'user', content: [{ type: 'text', text: 'Port the parser' }] },
        {
          type: 'assistant',
          content: 'Starting with the lexer.',
          tool_calls: [{ id: '1', name: 'edit_file', arguments: '{"path":"src/lexer.rs"}' }],
        },
        { type: 'tool_result', tool_call_id: '1', content: 'TOOL OUTPUT' },
      ]
      await h.write(
        '.grok-lab/sessions/%2Frepo/s9/chat_history.jsonl',
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      )
      const account = {
        family: 'grok',
        name: 'lab',
        ref: 'grok:lab',
        dir: h.path('.grok-lab'),
        isMain: false,
        kind: 'subscription',
      } as Account
      const brief = await grokHandoff.briefFromSession!(account, { id: 's9' })
      assert.match(brief!, /Port the parser/)
      assert.match(brief!, /src\/lexer\.rs/)
      assert.doesNotMatch(brief!, /TOOL OUTPUT|system prompt/)
    })
  })
})
