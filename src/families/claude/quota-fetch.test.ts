import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, readHostLog, snapshot, withFakeHome } from '../../../testing/index.ts'
import { quotaStoreFile } from '../../core/quota-store.ts'
import { createRuntime } from '../../runtime.ts'
import type { Account } from '../../types.ts'
import { claudeFamily, claudePlugin } from './index.ts'
import { claudeQuotaCacheFile } from './quota-cache.ts'
import { CLAUDE_QUOTA_ARGS, claudeUsageAnswer, resetInstant, usageQuota } from './quota-fetch.ts'

const builtins = [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }]
/** Words of the answer's other parts, which must never reach a result, the kept answer or a log. */
const PRIVATE = ['secret-skill-x1', 'secret-agent-x2', 'secret-mcp-x3', '4073 requests', 'Start fresh']

/** The text of `claude -p /usage` as Claude Code 2.1.314 writes it (2026-10-30), with fake names. */
const usageText = (session: string, week: string, extra = '') =>
  [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    `Current session: 16% used · ${session}`,
    `Current week (all models): 90% used · ${week}`,
    `Current week (Fable): 0% used · ${week}`,
    extra,
    "What's contributing to your usage?",
    'Approximate · sessions on this machine only · shares overlap',
    'Last 24h · 4073 requests · 9 sessions',
    '  95%  Start fresh when you switch tasks · run /clear',
    '  Top skills: secret-skill-x1  Top subagents: secret-agent-x2  Top MCP servers: secret-mcp-x3',
  ].join('\n')

const answer = (result: string, more: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  result,
  local_command: 'usage',
  session_id: 'fake-session',
  ...more,
})

const acct = (name: string, kind: Account['kind'] = 'subscription'): Account => ({
  family: 'claude',
  name,
  ref: `claude:${name}`,
  dir: `/fake/.claude-${name}`,
  isMain: name === 'main',
  kind,
})

/** "resets Oct 30 at 8:30pm (UTC)" for `at`, as Claude Code words it. */
function resetText(at: Date): string {
  const mon = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const h = at.getUTCHours()
  const mm = at.getUTCMinutes()
  const time = `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
  return `resets ${mon} ${at.getUTCDate()} at ${time} (UTC)`
}

/** A fake `claude` that records its start and cwd and answers as `<bin>/claude.answer` holds (`hang`: never). */
async function fakeClaude(h: FakeHome, body: unknown): Promise<void> {
  await writeFile(join(h.bin, 'claude.answer'), body === 'hang' ? 'hang' : JSON.stringify(body))
  await fakeHost(h, 'claude', {
    quota: true,
    sleep: body === 'hang' ? 30 : 0,
    onStart: `fs.appendFileSync(${JSON.stringify(join(h.bin, 'claude.cwd'))}, process.cwd() + '\\n')
const a = fs.readFileSync(${JSON.stringify(join(h.bin, 'claude.answer'))}, 'utf8')
if (a !== 'hang') process.stdout.write(a)`,
  })
}

/** A signed-in main Account and `work`, and an API Account. */
async function seed(h: FakeHome): Promise<void> {
  const login = JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } })
  await h.write('.claude/.claude.json', login, 0o600)
  await h.write('.claude/settings.json', '{}\n')
  await h.write('.claude-work/.claude.json', login, 0o600)
  await h.write('.claude-work/settings.json', '{}\n')
  await h.write('.claude-api/proxy.env', 'ANTHROPIC_AUTH_TOKEN=fake\n', 0o600)
}

const live = () => {
  const now = new Date()
  return {
    now,
    session: resetText(new Date(now.getTime() + 2 * 3600_000)),
    week: resetText(new Date(now.getTime() + 3 * 86400_000)),
  }
}

describe('Claude quota from /usage (ADR-0063)', () => {
  // 18:00 in Singapore.
  const NOW = Date.parse('2026-10-30T10:00:00.000Z')

  it('reads the session, the week and a named week, each reset at its next occurrence', () => {
    const text = usageText('resets Oct 30 at 8:30pm (Asia/Singapore)', 'resets Nov 2 at 4am (Asia/Singapore)')
    assert.deepEqual(usageQuota(text, NOW), [
      { label: '5h', windowMinutes: 300, usedPercent: 16, resetsAt: '2026-10-30T12:30:00.000Z' },
      { label: '7d', windowMinutes: 10080, usedPercent: 90, resetsAt: '2026-11-01T20:00:00.000Z' },
      {
        label: '7d',
        name: 'Fable',
        windowMinutes: 10080,
        usedPercent: 0,
        resetsAt: '2026-11-01T20:00:00.000Z',
      },
    ])
  })

  it('rolls a reset over into the next year, and reads a time without a date', () => {
    const dec30 = Date.parse('2026-12-30T12:00:00.000Z')
    assert.equal(
      resetInstant('resets Jan 2 at 4am (Asia/Singapore)', dec30, 10080),
      Date.parse('2027-01-01T20:00:00.000Z'),
    )
    assert.equal(
      resetInstant('resets Dec 30 at 11am (America/New_York)', dec30, 300),
      Date.parse('2026-12-30T16:00:00.000Z'),
    )
    const newYearsEve = Date.parse('2026-12-31T23:00:00.000Z')
    assert.equal(resetInstant('resets 1am (UTC)', newYearsEve, 300), Date.parse('2027-01-01T01:00:00.000Z'))
  })

  it('returns nothing rather than a guess when a line or a reset does not parse', () => {
    const ok = 'resets Nov 2 at 4am (Asia/Singapore)'
    for (const text of [
      usageText('resets Oct 30 at 8:30pm (Asia/Singapore)', ok).replace('16% used', 'lots used'),
      usageText('resets Oct 30 at 8:30pm (Nowhere/Land)', ok),
      // Not within the 5 hours of a session window.
      usageText('resets Nov 3 at 8:30pm (Asia/Singapore)', ok),
      usageText('resets Oct 30 at 13pm (Asia/Singapore)', ok),
      usageText('resets soon', ok),
      'You are currently using your subscription',
    ])
      assert.equal(usageQuota(text, NOW), null, text.split('\n')[2])
    assert.equal(resetInstant('resets Feb 30 at 4am (UTC)', NOW, 10080), null)
  })

  it('explains an answer that is not a local /usage, and never repeats its words', () => {
    const text = usageText('resets Oct 30 at 8:30pm (Asia/Singapore)', 'resets Nov 2 at 4am (Asia/Singapore)')
    const cases: [unknown, RegExp][] = [
      [answer(text, { num_turns: 1 }), /cannot report quota/],
      [answer(text, { local_command: undefined }), /cannot report quota/],
      [
        answer('Not logged in · Please run /login secret-mcp-x3', { is_error: true }),
        /sideby login claude:work/,
      ],
      [answer(`${text.replace('16% used', 'some used')}`), /does not recognise/],
      ['nope', /does not recognise/],
    ]
    for (const [a, expected] of cases) {
      const q = claudeUsageAnswer(a, acct('work'), NOW)
      assert.equal(q.status, 'unavailable')
      if (q.status === 'unavailable') {
        assert.equal(q.reason, 'fetch-failed')
        assert.match(q.detail!, expected)
      }
      for (const p of PRIVATE) assert.ok(!JSON.stringify(q).includes(p), p)
    }
  })

  it('asks each subscription Account without a session and keeps only the Quota', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const { session, week } = live()
      await fakeClaude(h, answer(usageText(session, week)))
      const rt = await createRuntime({
        env: { ...h.env, ANTHROPIC_API_KEY: 'sk-fake', CLAUDE_CONFIG_DIR: '/wrong' },
        builtins,
      })
      const before = await Promise.all(['.claude', '.claude-work'].map((d) => snapshot(h.path(d))))
      for (const ref of ['claude:main', 'claude:work']) {
        const q = await rt.quota(await rt.resolve(ref))
        assert.equal(q.status, 'ok', ref)
        if (q.status !== 'ok') return
        assert.equal(q.fetched, true)
        assert.equal(q.source, 'claude /usage')
        assert.deepEqual(
          q.windows.map((w) => [w.label, w.name, w.usedPercent]),
          [
            ['5h', undefined, 16],
            ['7d', undefined, 90],
            ['7d', 'Fable', 0],
          ],
        )
        for (const p of PRIVATE) assert.ok(!JSON.stringify(q).includes(p), p)
      }
      const runs = await readHostLog(h, 'claude')
      assert.equal(runs.length, 2)
      assert.ok(runs.every((r) => JSON.stringify(r.argv) === JSON.stringify(CLAUDE_QUOTA_ARGS)))
      assert.equal(runs[0]!.env.CLAUDE_CONFIG_DIR, undefined)
      assert.equal(runs[1]!.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.ok(runs.every((r) => r.env.ANTHROPIC_API_KEY === undefined))
      const cwds = (await readFile(join(h.bin, 'claude.cwd'), 'utf8')).trim().split('\n')
      assert.deepEqual([...new Set(cwds)], [join(rt.paths.stateDir, 'quota', 'claude-run')])
      assert.deepEqual(await Promise.all(['.claude', '.claude-work'].map((d) => snapshot(h.path(d)))), before)
      // Nothing of the answer's other parts is kept anywhere in sideby's state.
      for (const name of await readdir(join(rt.paths.stateDir, 'quota', 'claude'))) {
        const kept = await readFile(join(rt.paths.stateDir, 'quota', 'claude', name), 'utf8')
        for (const p of PRIVATE) assert.ok(!kept.includes(p), `${name}: ${p}`)
      }
      // The API Account is never asked.
      const api = await rt.quota(await rt.resolve('claude:api'))
      assert.equal(api.status === 'unavailable' && api.reason, 'api-account')
      assert.equal((await readHostLog(h, 'claude')).length, 2)
      // Asked again only after `everyMinutes`.
      await rt.quota(await rt.resolve('claude:main'))
      assert.equal((await readHostLog(h, 'claude')).length, 2)
    })
  })

  it('shows the newer of the status line reading and the fetched answer', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const { now, session, week } = live()
      await fakeClaude(h, answer(usageText(session, week)))
      const rt = await createRuntime({ env: h.env, builtins })
      const tap = (at: Date) =>
        h.write(
          claudeQuotaCacheFile(rt.paths.stateDir, 'work').slice(h.home.length + 1),
          JSON.stringify({
            version: 1,
            observedAt: at.toISOString(),
            windows: [
              {
                label: '5h',
                windowMinutes: 300,
                usedPercent: 42,
                resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
              },
            ],
          }),
        )
      await tap(new Date(now.getTime() - 3600_000))
      const work = await rt.resolve('claude:work')
      const older = await rt.quota(work)
      assert.equal(older.status === 'ok' && older.fetched, true)
      await tap(new Date(Date.now() + 60_000))
      const newer = await rt.quota(work)
      assert.equal(newer.status === 'ok' && newer.windows[0]!.usedPercent, 42)
      assert.equal(newer.status === 'ok' && newer.fetched, undefined)
    })
  })

  it('does not start Claude Code when turned off or in CI, even for a refresh', async () => {
    for (const ci of [false, true])
      await withFakeHome(async (h) => {
        await seed(h)
        await fakeClaude(h, answer('unused'))
        if (!ci)
          await h.write('.config/sideby/config.json', JSON.stringify({ quota: { check: { claude: false } } }))
        const rt = await createRuntime({ env: { ...h.env, ...(ci ? { CI: '1' } : {}) }, builtins })
        await rt.refreshQuota([await rt.resolve('claude:main')])
        const q = await rt.quota(await rt.resolve('claude:main'))
        assert.equal(q.status === 'unavailable' && q.reason, 'not-enabled')
        assert.deepEqual(await readHostLog(h, 'claude'), [])
        await assert.rejects(readFile(quotaStoreFile(rt.paths.stateDir, 'claude', 'main')))
      })
  })

  it('ends only its own query when the deadline aborts it', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await fakeClaude(h, 'hang')
      const rt = await createRuntime({ env: h.env, builtins })
      const a = await rt.resolve('claude:work')
      assert.ok(claudeFamily.fetchQuota)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 300)
      try {
        const q = await claudeFamily.fetchQuota.fetch(a, {
          ...rt.readContext(),
          hostEnv: { ...h.env, CLAUDE_CONFIG_DIR: a.dir },
          signal: ac.signal,
        })
        assert.equal(q.status === 'unavailable' && q.reason, 'fetch-failed')
        if (q.status === 'unavailable') assert.match(q.detail!, /stopped/)
      } finally {
        clearTimeout(timer)
      }
      const runs = await readHostLog(h, 'claude')
      assert.ok(runs.some((r) => r.signal === 'SIGTERM'))
    })
  })
})
