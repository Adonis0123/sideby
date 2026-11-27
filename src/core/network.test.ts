// Network Guard at Launch and in sessions sideby starts (spec §3.35, ADR-0053). Requests go through the Runtime's
// internal fake fetcher; Host directories are snapshotted to show nothing is written into them.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { takeIgnoreNetwork } from '../cli/commands.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { createRuntime } from '../runtime.ts'
import { NETWORK_ENV, RETRY_BUDGET_MS, redactedProxy } from './egress.ts'
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
      probe: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
      system: { platform: 'win32' },
    },
  })
  return { rt, asked }
}

describe('networkTarget', () => {
  it("checks the vendor's own domain, nothing for a third-party endpoint, and never an API Account", () => {
    assert.deepEqual(networkTarget({ family: 'claude', kind: 'subscription' }, {}), { url: TRACE.anthropic })
    assert.deepEqual(
      networkTarget(
        { family: 'claude', kind: 'subscription' },
        { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
      ),
      { skip: 'third-party' },
    )
    // API Accounts are never checked (ADR-0079), on the official endpoint too.
    for (const ANTHROPIC_BASE_URL of ['https://api.anthropic.com', 'https://api.deepseek.com/anthropic'])
      assert.deepEqual(networkTarget({ family: 'claude', kind: 'api' }, { ANTHROPIC_BASE_URL }), {
        skip: 'api',
      })
    assert.deepEqual(networkTarget({ family: 'claude', kind: 'api' }, {}), { skip: 'api' })
    assert.deepEqual(networkTarget({ family: 'codex', kind: 'subscription' }, {}), { url: TRACE.chatgpt })
    assert.deepEqual(networkTarget({ family: 'codex', kind: 'api' }, {}), { skip: 'api' })
    assert.deepEqual(networkTarget({ family: 'grok', kind: 'subscription' }, {}), { skip: 'not-covered' })
  })
})

describe('Launch', () => {
  it('redacts proxy credentials and reports direct explicitly', () => {
    assert.equal(
      redactedProxy('http://user:password@127.0.0.1:10809/path?token=secret#fragment'),
      'http://127.0.0.1:10809',
    )
    assert.equal(redactedProxy('socks5://user:password@127.0.0.1:10808/private'), 'socks5://127.0.0.1:10808')
    assert.equal(redactedProxy(null), 'direct')
    assert.equal(redactedProxy('http://user:password@not a host'), 'invalid')
  })

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
      assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'UserPromptSubmit'])
      assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /network-hook claude UserPromptSubmit$/)
      // Claude Code's own 30-second default for prompts is shorter than the check's retries, and lets the prompt through.
      assert.equal(hooks.UserPromptSubmit[0].hooks[0].timeout, 60)
      assert.ok(hooks.UserPromptSubmit[0].hooks[0].timeout * 1000 >= 2 * RETRY_BUDGET_MS)
      assert.equal(hooks.PreToolUse[0].hooks[0].timeout, 60)
      // A prompt Claude Code made itself is held while it is blocked, by a background hook that can wake the session.
      const held = hooks.UserPromptSubmit[0].hooks[1]
      assert.match(held.command, /network-hook claude Held$/)
      assert.equal(held.asyncRewake, true)
      assert.equal(held.timeout, 18000)
      assert.equal(hooks.PreToolUse[0].hooks.length, 1)
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
      // Codex has no background hook that can wake a session: nothing is held there.
      assert.ok(!p.args.some((a) => a.includes('Held') || a.includes('asyncRewake')))
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
        assert.match(err.message, /direct/)
        assert.match(err.message, /--ignore-network/)
        return true
      })
      const p = await rt.prepareLaunch('claude:001', [], 'run', { ignoreNetwork: true })
      assert.equal(p.networkArgs, undefined)
    })
  })

  it('shows the redacted selected proxy on connection refusal and never persists it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.config/sideby/config.json', JSON.stringify({ network: { guard: true, allow: ['US'] } }))
      const rt = await createRuntime({
        env: {
          ...h.env,
          LANG: 'en_US.UTF-8',
          HTTPS_PROXY: 'http://user:password@127.0.0.1:10809/private?token=secret',
        },
        builtins,
        network: {
          fetcher: async () => {
            const e = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException
            e.code = 'ECONNREFUSED'
            throw e
          },
          print: 'p',
        },
      })
      await assert.rejects(rt.prepareLaunch('claude:main', [], 'run'), (err: unknown) => {
        const message = (err as UserError).message
        assert.match(message, /http:\/\/127\.0\.0\.1:10809/)
        assert.match(message, /connection was refused/)
        assert.doesNotMatch(message, /user|password|private|token|secret/)
        return true
      })
      const dir = `${rt.paths.stateDir}/network`
      for (const file of await readdir(dir)) {
        const text = await readFile(`${dir}/${file}`, 'utf8')
        assert.doesNotMatch(text, /user|password|private|token|secret|10809/)
      }
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

  it('does not check an API Account, on any endpoint, nor in CI', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] }, 'HK')
      await rt.prepareLaunch('claude:api', [], 'run')
      // On the official endpoint too (ADR-0079): no request, no session hooks, no variables for them.
      await h.write('.claude-official/proxy.env', 'ANTHROPIC_BASE_URL=https://api.anthropic.com\n', 0o600)
      const official = await rt.prepareLaunch('claude:official', [], 'run')
      assert.deepEqual(asked, [])
      assert.equal(official.networkArgs, undefined)
      const officialAt = official.args.indexOf('--settings')
      assert.deepEqual(
        officialAt >= 0
          ? Object.keys(JSON.parse(await readFile(official.args[officialAt + 1]!, 'utf8')).hooks)
          : [],
        ['SessionStart'],
      )
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
        JSON.stringify({
          hooks: {
            PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'w', asyncRewake: true, timeout: 18000 }] }],
          },
        }),
      )
      const args = await withClaudeNetworkHooks(['--settings', file], h.path('state'))
      const merged = JSON.parse(await readFile(args[1]!, 'utf8')).hooks
      assert.deepEqual(Object.keys(merged).sort(), ['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit'])
      // Auto Handoff's background Stop hook keeps its options (ADR-0056).
      assert.deepEqual(merged.Stop, [
        { hooks: [{ type: 'command', command: 'w', asyncRewake: true, timeout: 18000 }] },
      ])
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
        { ref: 'claude:api', skip: 'api' },
      )
      const s = await rt.networkStatus({ check: true })
      assert.deepEqual(asked.sort(), [TRACE.anthropic, TRACE.chatgpt].sort())
      assert.ok(s.targets.every((t) => t.status === 'ok' && t.loc === 'US'))
      assert.ok(Value.Check(OUTPUT_SCHEMAS.network!, { schemaVersion: 1, ...s }))
    })
  })

  it('diagnoses cached Guard state and TCP listeners without an online trace', async () => {
    await withFakeHome(async (h) => {
      const { rt, asked } = await setup(h, { guard: true, allow: ['US'] })
      await rt.networkStatus({ check: true })
      asked.length = 0
      const d = await rt.networkDiagnose()
      assert.deepEqual(asked, [])
      assert.equal(d.targets.length, 2)
      assert.deepEqual(
        d.targets.map((t) => t.url),
        [TRACE.anthropic, TRACE.chatgpt],
      )
      assert.ok(
        d.targets.every((t) => t.proxy === 'direct' && t.listener === null && t.guardSupport === 'direct'),
      )
      assert.ok(d.targets.every((t) => t.guard.status === 'ok' && t.guard.checkedAt))
      assert.ok(Value.Check(OUTPUT_SCHEMAS['network-diagnose']!, { schemaVersion: 1, ...d }))
      const diagnosisWith = (proxy: object) => ({
        schemaVersion: 1,
        ...d,
        system: { ...d.system, proxy },
      })
      for (const proxy of [
        d.system.proxy,
        { ...d.system.proxy, status: 'available' as const, autoDiscoveryEnabled: false },
        { ...d.system.proxy, status: 'available' as const, autoDiscoveryEnabled: true },
      ])
        assert.ok(
          Value.Check(OUTPUT_SCHEMAS['network-diagnose']!, diagnosisWith(proxy)),
          JSON.stringify(proxy),
        )
      const { autoDiscoveryEnabled: _, ...withoutAutoDiscovery } = d.system.proxy
      assert.equal(
        Value.Check(OUTPUT_SCHEMAS['network-diagnose']!, diagnosisWith(withoutAutoDiscovery)),
        false,
      )

      const proxied = await createRuntime({
        env: { ...h.env, HTTPS_PROXY: 'socks5://user:password@127.0.0.1:10808/private' },
        builtins,
        network: {
          fetcher: async () => assert.fail('diagnose must not trace'),
          print: 'p',
          probe: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
          system: { platform: 'win32' },
        },
      })
      const p = await proxied.networkDiagnose()
      assert.ok(p.targets.every((t) => t.proxy === 'socks5://127.0.0.1:10808'))
      assert.ok(p.targets.every((t) => t.guardSupport === 'unsupported'))
      assert.deepEqual(p.targets[0]!.listener, {
        host: '127.0.0.1',
        port: 10808,
        reachable: false,
        error: 'ECONNREFUSED',
      })
      assert.doesNotMatch(JSON.stringify(p), /user|password|private/)
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
