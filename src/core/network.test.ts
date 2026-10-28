// Network Guard at Launch and in sessions sideby starts (spec §3.35, ADR-0053). Requests go through the Runtime's
// internal fake fetcher; Host directories are snapshotted to show nothing is written into them.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { takeIgnoreNetwork } from '../cli/commands.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { createRuntime } from '../runtime.ts'
import { NETWORK_ENV } from './egress.ts'
import { UserError } from './errors.ts'
import {
  networkTarget,
  normalizeAllow,
  setNetwork,
  TRACE,
  withClaudeNetworkHooks,
  withoutArgs,
} from './network.ts'

const builtins = [claudePlugin, codexPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

const trace = (loc: string) => async () => `ip=203.0.113.7\nloc=${loc}\n`

async function setup(h: FakeHome, network: object | undefined, loc = 'US') {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-001/settings.json', '{}')
  await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
  await h.write('.codex/auth.json', '{}', 0o600)
  await h.write('.codex/config.toml', '')
  await h.write('.config/sideby/config.json', JSON.stringify(network ? { network } : {}))
  const asked: string[] = []
  const rt = await createRuntime({
    env: { ...h.env, LANG: 'en_US.UTF-8' },
    builtins,
    network: {
      fetcher: async (url) => {
        asked.push(url)
        return trace(loc)()
      },
      print: 'p',
    },
  })
  return { rt, asked }
}

describe('networkTarget', () => {
  it("checks the vendor's own domain, and nothing for a third-party endpoint", () => {
    assert.deepEqual(networkTarget({ family: 'claude', kind: 'subscription' }, {}), { url: TRACE.anthropic })
    assert.deepEqual(
      networkTarget({ family: 'claude', kind: 'api' }, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
      { url: TRACE.anthropic },
    )
    assert.deepEqual(
      networkTarget(
        { family: 'claude', kind: 'api' },
        { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      ),
      { skip: 'third-party' },
    )
    assert.deepEqual(networkTarget({ family: 'codex', kind: 'subscription' }, {}), { url: TRACE.chatgpt })
    assert.deepEqual(networkTarget({ family: 'codex', kind: 'api' }, {}), { url: TRACE.openai })
    assert.deepEqual(networkTarget({ family: 'grok', kind: 'subscription' }, {}), { skip: 'not-covered' })
  })
})

describe('Launch', () => {
  it('asks nothing while off', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, undefined)
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      assert.deepEqual(asked, [])
      assert.equal(p.networkArgs, undefined)
    })
  })

  it('adds the session hooks for Claude through a settings file of its own, writing nothing into a Host directory', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] })
      const before = await snapshot(h.path('.claude-001'))
      const p = await rt.prepareLaunch('claude:001', ['--', 'hi'], 'run')
      assert.deepEqual(asked, [TRACE.anthropic])
      assert.equal(p.env[NETWORK_ENV.allow], 'US')
      assert.equal(p.env[NETWORK_ENV.url], TRACE.anthropic)
      const at = p.args.indexOf('--settings')
      assert.ok(at >= 0 && at < p.args.indexOf('--'), 'before the user’s own --')
      const file = p.args[at + 1]!
      assert.ok(file.startsWith(rt.paths.stateDir))
      const hooks = JSON.parse(await readFile(file, 'utf8')).hooks
      assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'UserPromptSubmit'])
      assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /network-hook claude UserPromptSubmit$/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude-001'))), [])
    })
  })

  it('adds Codex hooks with -c, and the trust note once', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] })
      const p = await rt.prepareLaunch('codex:main', [], 'run')
      assert.deepEqual(asked, [TRACE.chatgpt])
      assert.ok(p.args.some((a) => a.startsWith('hooks.UserPromptSubmit=')))
      assert.ok(p.args.some((a) => a.startsWith('hooks.PreToolUse=')))
      assert.match(p.notice ?? '', /\/hooks/)
      const again = await rt.prepareLaunch('codex:main', [], 'run')
      assert.doesNotMatch(again.notice ?? '', /\/hooks/)
    })
  })

  it('refuses a Launch from another country, says what to do, and --ignore-network skips it', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, { guard: true, allow: ['US', 'JP'] }, 'HK')
      await assert.rejects(rt.prepareLaunch('claude:001', [], 'run'), (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'network-blocked')
        assert.match(err.message, /exits in HK/)
        assert.match(err.message, /--ignore-network/)
        return true
      })
      const p = await rt.prepareLaunch('claude:001', [], 'run', { ignoreNetwork: true })
      assert.equal(p.networkArgs, undefined)
    })
  })

  it('refuses when it cannot tell', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.config/sideby/config.json', JSON.stringify({ network: { guard: true, allow: ['US'] } }))
      const rt = await createRuntime({
        env: h.env,
        builtins,
        network: {
          fetcher: async () => {
            throw new Error('timeout')
          },
          print: 'p',
        },
      })
      await assert.rejects(rt.prepareLaunch('claude:main', [], 'run'), (err: unknown) => {
        assert.equal((err as UserError).code, 'network-unknown')
        return true
      })
    })
  })

  it("checks before starting but adds no hooks next to the user's own --settings", async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] })
      const p = await rt.prepareLaunch('claude:001', ['--settings', 'mine.json'], 'run')
      assert.equal(asked.length, 1)
      assert.equal(p.networkArgs, undefined)
      assert.equal(p.args.filter((a) => a === '--settings').length, 1)
      assert.match(p.notice ?? '', /--settings/)
    })
  })

  it('does not check an API Account on a third-party endpoint, nor in CI', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] }, 'HK')
      await rt.prepareLaunch('claude:api', [], 'run')
      assert.deepEqual(asked, [])
      const ci = await createRuntime({
        env: { ...h.env, CI: '1' },
        builtins,
        network: { fetcher: async () => assert.fail('no request in CI') },
      })
      await ci.prepareLaunch('claude:001', [], 'run')
    })
  })
})

describe('the Host run unchanged (`sideby resume`)', () => {
  it('is checked as the Main Account, and left as it is while off', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, { guard: true, allow: ['US'] }, 'HK')
      await assert.rejects(rt.resumeLaunch('claude', []), /exits in HK/)
      const skipped = await rt.resumeLaunch('claude', [], { ignoreNetwork: true })
      assert.equal(skipped.launch.env, rt.env)
    })
  })
})

describe('Auto Handoff and Claude settings', () => {
  it("merges Network Guard's hooks into Auto Handoff's settings file", async () => {
    await withFakeHome(async (h) => {
      const file = await h.write(
        'state/handoff.json',
        JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
      )
      const args = await withClaudeNetworkHooks(['--settings', file], h.path('state'))
      const merged = JSON.parse(await readFile(args[1]!, 'utf8')).hooks
      assert.deepEqual(Object.keys(merged).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit'])
      assert.notEqual(args[1], file)
    })
  })
  it('withoutArgs drops one run of arguments', () => {
    assert.deepEqual(withoutArgs(['a', '--settings', 'f', 'b'], ['--settings', 'f']), ['a', 'b'])
    assert.deepEqual(withoutArgs(['a'], []), ['a'])
  })
})

describe('settings', () => {
  it('normalizes country codes and refuses others', () => {
    assert.deepEqual(normalizeAllow(['us', 'JP', 'us']), ['US', 'JP'])
    assert.throws(() => normalizeAllow(['USA']), /not a country code/)
  })

  it('shows first, writes with apply, and refuses on with no country', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('.config/sideby/config.json', '{}')
      await assert.rejects(setNetwork(file, { guard: true }, { apply: true }), /Choose the countries first/)
      const preview = await setNetwork(file, { allow: ['us', 'jp'] }, { apply: false })
      assert.equal(preview.changed, true)
      assert.equal(preview.applied, false)
      assert.equal(await readFile(file, 'utf8'), '{}')
      await setNetwork(file, { allow: ['us', 'jp'] }, { apply: true })
      const on = await setNetwork(file, { guard: true }, { apply: true })
      assert.deepEqual(on.after, { guard: true, allow: ['US', 'JP'] })
      assert.ok(Value.Check(OUTPUT_SCHEMAS['network-set']!, { schemaVersion: 1, ...on }))
      await assert.rejects(setNetwork(file, { allow: [] }, { apply: true }), /turn it off first/)
      const off = await setNetwork(file, { guard: false }, { apply: true })
      assert.deepEqual(off.after, { guard: false, allow: ['US', 'JP'] })
    })
  })

  it('the status reads the cache, and check asks each address once', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] })
      const cold = await rt.networkStatus()
      assert.deepEqual(asked, [])
      assert.ok(cold.targets.every((t) => t.status === 'not-checked'))
      assert.deepEqual(
        cold.accounts.find((a) => a.ref === 'claude:api'),
        { ref: 'claude:api', skip: 'at-launch' },
      )
      const s = await rt.networkStatus({ check: true })
      assert.deepEqual(asked.sort(), [TRACE.anthropic, TRACE.chatgpt].sort())
      assert.ok(s.targets.every((t) => t.status === 'ok' && t.loc === 'US'))
      assert.ok(Value.Check(OUTPUT_SCHEMAS.network!, { schemaVersion: 1, ...s }))
    })
  })
})

describe('--ignore-network on the command line', () => {
  it('is taken out before `--` only', () => {
    assert.deepEqual(takeIgnoreNetwork(['--ignore-network', '--model', 'x']), {
      args: ['--model', 'x'],
      ignoreNetwork: true,
    })
    assert.deepEqual(takeIgnoreNetwork(['--', '--ignore-network']), {
      args: ['--', '--ignore-network'],
      ignoreNetwork: false,
    })
  })
})
