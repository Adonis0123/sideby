import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import { checkSchema, sideby } from './cli-test-helpers.ts'

describe('remote-control (spec §3.22)', () => {
  it('shows the state, previews turning it off with exit 10, writes only with --yes, and undoes it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet","remoteControlAtStartup":true}\n')
      await fakeHost(h, 'claude')
      const status = checkSchema('remote-control', (await sideby(h, ['remote-control', '--json'])).out)
      assert.deepEqual(
        (status.groups as { state: string; accounts: string[] }[]).map((g) => [g.state, g.accounts]),
        [['on', ['claude:main']]],
      )
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['remote-control', 'off'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /remoteControlAtStartup true -> false/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const done = await sideby(h, ['remote-control', 'off', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('remote-control', done.out).applied, true)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
        remoteControlAtStartup: false,
      })
      assert.equal((await sideby(h, ['remote-control', 'undo'])).code, 10)
      assert.equal((await sideby(h, ['remote-control', 'undo', '--yes'])).code, 0)
      assert.equal(
        JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')).remoteControlAtStartup,
        true,
      )
      assert.equal((await sideby(h, ['remote-control', 'undo', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['remote-control', 'nope'])).code, 2)
    })
  })
  it('turns it on the same way: a preview with exit 10, then --yes', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet","remoteControlAtStartup":false}\n')
      await fakeHost(h, 'claude')
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['remote-control', 'on'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /remoteControlAtStartup false -> true/)
      assert.match(preview.out, /every device signed in/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      const done = await sideby(h, ['remote-control', 'on', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('remote-control', done.out).action, 'on')
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
        remoteControlAtStartup: true,
      })
      // Already on: nothing to change, exit 1 (spec §3.22).
      assert.equal((await sideby(h, ['remote-control', 'on', '--yes'])).code, 1)
    })
  })
})

describe('advisor (spec §3.41)', () => {
  it('shows the state, previews a model with exit 10, writes it and the unlock only with --yes, and undoes it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{"model":"sonnet"}\n')
      await fakeHost(h, 'claude')
      const status = checkSchema('advisor', (await sideby(h, ['advisor', '--json'])).out)
      assert.deepEqual(
        [
          status.unlock,
          (status.groups as { state: string; accounts: string[] }[]).map((g) => [g.state, g.accounts]),
        ],
        [false, [['off', ['claude:main']]]],
      )
      const before = await snapshot(h.home)
      const preview = await sideby(h, ['advisor', 'opus'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /advisorModel not set -> "opus"/)
      assert.match(preview.out, /advisor\.unlock false -> true/)
      assert.match(preview.out, /more quota/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      assert.equal(checkSchema('advisor', (await sideby(h, ['advisor', 'opus', '--json'])).out).unlocks, true)
      const done = await sideby(h, ['advisor', 'opus', '--yes', '--json'])
      assert.equal(done.code, 0)
      const r = checkSchema('advisor', done.out)
      assert.deepEqual([r.applied, r.unlocked, r.unlock], [true, true, true])
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
        advisorModel: 'opus',
      })
      assert.deepEqual(JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8')).advisor, {
        unlock: true,
      })
      // Already that model and unlocked: nothing to change, exit 1.
      assert.equal((await sideby(h, ['advisor', 'opus', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['advisor', 'undo'])).code, 10)
      assert.equal((await sideby(h, ['advisor', 'undo', '--yes'])).code, 0)
      assert.deepEqual(JSON.parse(await readFile(h.path('.claude/settings.json'), 'utf8')), {
        model: 'sonnet',
      })
      assert.equal((await sideby(h, ['advisor', 'undo', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['advisor', 'nope'])).code, 2)
      assert.equal((await sideby(h, ['advisor', 'undo', '--account', 'main'])).code, 2)
    })
  })
  it('turns the unlocking on and off with a preview, and refuses an API account', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-api/settings.json', '{}\n')
      await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://example.com\n', 0o600)
      await fakeHost(h, 'claude')
      const preview = await sideby(h, ['advisor', 'unlock', 'on'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1/)
      const on = await sideby(h, ['advisor', 'unlock', 'on', '--yes', '--json'])
      assert.deepEqual([on.code, checkSchema('advisor', on.out).unlock], [0, true])
      assert.equal((await sideby(h, ['advisor', 'unlock', 'on', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['advisor', 'unlock', 'off', '--yes'])).code, 0)
      const api = await sideby(h, ['advisor', 'opus', '--account', 'claude:api', '--json'])
      assert.equal(api.code, 1)
      assert.match(JSON.parse(api.out).error, /API account.*subscription account/)
    })
  })
})

describe('tune (spec §3.18)', () => {
  /** A Claude main Account with one session of 210 turns and an auto compaction, dated just now. */
  async function withSession(h: FakeHome): Promise<void> {
    await h.write('.claude/settings.json', '{"autoCompactWindow":190000}\n')
    await h.write('.claude.json', JSON.stringify({ oauthAccount: { id: 'x' } }), 0o600)
    await fakeHost(h, 'claude')
    const start = Date.now() - 3_600_000
    const rows: object[] = []
    for (let i = 0; i < 210; i++)
      rows.push({
        type: 'assistant',
        timestamp: new Date(start + i * 1000).toISOString(),
        sessionId: 's1',
        message: {
          id: `m${i}`,
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 10_000 + i * 900,
            cache_creation_input_tokens: 900,
            output_tokens: 200,
          },
        },
      })
    rows.push({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: new Date(start + 5000).toISOString(),
      sessionId: 's1',
      compactMetadata: { trigger: 'auto', preTokens: 190_000, postTokens: 20_000 },
    })
    await h.write('.claude/projects/p/s1.jsonl', `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
  }

  it('prints a JSON result that matches the schema, for one account, a family and all accounts', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      for (const args of [
        ['tune', '--json'],
        ['tune', 'claude', '--json'],
        ['tune', 'claude:main', '--json'],
      ]) {
        const r = await sideby(h, args)
        assert.equal(r.code, 0, args.join(' '))
        const data = checkSchema('tune', r.out)
        assert.equal(data.schemaVersion, 1)
        const accounts = data.accounts as { ref: string; tuning: { status: string; estimate?: boolean } }[]
        assert.equal(accounts[0]?.ref, 'claude:main')
        assert.equal(accounts[0]?.tuning.status, 'ok')
        assert.equal(accounts[0]?.tuning.estimate, true)
      }
    })
  })

  it('prints a readable table and leaves the Host directory untouched', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const before = await snapshot(h.path('.claude'))
      const r = await sideby(h, ['tune'])
      assert.equal(r.code, 0)
      assert.match(r.out, /claude:main/)
      assert.match(r.out, /claude-opus-5-5/)
      assert.match(r.out, /Estimates/)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
    })
  })

  it('exits 1 for an unknown account, 2 for extra arguments, and gives a JSON error', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const missing = await sideby(h, ['tune', 'claude:nope', '--json'])
      assert.equal(missing.code, 1)
      assert.equal((JSON.parse(missing.out) as { schemaVersion: number }).schemaVersion, 1)
      assert.equal((await sideby(h, ['tune', 'a', 'b'])).code, 2)
      assert.equal((await sideby(h, ['tune', '--nope'])).code, 2)
    })
  })

  it('says a known family has no accounts yet instead of reporting an unknown account', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const human = await sideby(h, ['tune', 'codex'])
      assert.equal(human.code, 0)
      assert.match(human.out, /No codex accounts yet.*sideby new codex/s)
      const data = checkSchema('tune', (await sideby(h, ['tune', 'codex', '--json'])).out)
      assert.deepEqual(data.accounts, [])
    })
  })

  it('applies a suggestion only after the change is shown and --yes is given, and undoes it', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const settings = h.path('.claude/settings.json')
      const before = await readFile(settings, 'utf8')
      const preview = await sideby(h, ['tune', 'apply', 'claude:main', '120000'])
      assert.equal(preview.code, 10)
      assert.match(preview.out, /Use 120K for claude:main/)
      assert.match(preview.out, /~\/\.claude\/settings\.json/)
      assert.equal(await readFile(settings, 'utf8'), before)
      const shown = checkSchema(
        'tune-change',
        (await sideby(h, ['tune', 'apply', 'claude:main', '120000', '--json'])).out,
      )
      assert.equal(shown.applied, false)
      const done = await sideby(h, ['tune', 'apply', 'claude:main', '120k', '--yes', '--json'])
      assert.equal(done.code, 0)
      assert.equal(checkSchema('tune-change', done.out).applied, true)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 120_000)
      const undo = await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])
      assert.equal(undo.code, 0)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 190_000)
    })
  })

  it('does not take --yes on the read-only listing', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      assert.equal((await sideby(h, ['tune', '--yes'])).code, 2)
    })
  })

  it('goes back to the default with the word default', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const settings = h.path('.claude/settings.json')
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'default'])).code, 10)
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'default', '--yes'])).code, 0)
      assert.equal('autoCompactWindow' in JSON.parse(await readFile(settings, 'utf8')), false)
      assert.equal((await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])).code, 0)
      assert.equal(JSON.parse(await readFile(settings, 'utf8')).autoCompactWindow, 190_000)
    })
  })

  it('uses the suggestion when no size is given, and refuses where there is none', async () => {
    await withFakeHome(async (h) => {
      await withSession(h)
      const r = await sideby(h, ['tune', 'apply', 'claude:main', '--json'])
      assert.equal(r.code, 10)
      const plan = checkSchema('tune-change', r.out).plan as { next: number }
      assert.ok(plan.next >= 10_000)
      assert.equal((await sideby(h, ['tune', 'apply', 'claude:main', 'lots', '--yes'])).code, 1)
      assert.equal((await sideby(h, ['tune', 'apply'])).code, 2)
      assert.equal((await sideby(h, ['tune', 'undo', 'claude:main', '--yes'])).code, 1)
    })
  })

  it('marks Grok and pi as having no public source', async () => {
    await withFakeHome(async (h) => {
      await h.write('.grok/auth.json', JSON.stringify({ a: { email: 'g@example.com' } }), 0o600)
      await h.mkdir('.grok/skills')
      await fakeHost(h, 'grok')
      const r = await sideby(h, ['tune', '--json'])
      const data = checkSchema('tune', r.out)
      const grok = (data.accounts as { ref: string; tuning: { reason?: string } }[]).find((a) =>
        a.ref.startsWith('grok'),
      )
      assert.equal(grok?.tuning.reason, 'no-source')
    })
  })
})
