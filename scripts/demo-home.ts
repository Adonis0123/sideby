// Builds a throwaway HOME with realistic, fake accounts for screenshots and manual testing.
// Usage: node scripts/demo-home.ts <dir> [normal|empty|error|slow]
// Then:  HOME=<dir>/home XDG_CONFIG_HOME=<dir>/home/.config XDG_STATE_HOME=<dir>/home/.local/state \
//        PATH=<dir>/bin:$PATH node src/cli/main.ts ui
import { chmod, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRuntime } from '../src/runtime.ts'

const [root, variant = 'normal'] = process.argv.slice(2)
if (!root || !['normal', 'empty', 'error', 'slow'].includes(variant)) {
  console.error('usage: node scripts/demo-home.ts <dir> [normal|empty|error|slow]')
  process.exit(2)
}
const home = join(root, 'home')
const bin = join(root, 'bin')
const MARKER = '.sideby-demo'
// Only ever delete a directory this script created: refuse anything else that is not empty.
const existing = await readdir(root).catch(() => [] as string[])
if (existing.length > 0 && !existing.includes(MARKER)) {
  console.error(`${root} is not empty and was not made by this script; pick a new directory`)
  process.exit(1)
}
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(join(root, MARKER), 'created by scripts/demo-home.ts\n')
await mkdir(home, { recursive: true })
await mkdir(bin, { recursive: true })

async function write(rel: string, data: string, mode = 0o644) {
  const p = join(home, rel)
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, data, { mode })
  await chmod(p, mode)
}

const now = Date.now()
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString()
const H = 3_600_000

await writeFile(join(bin, 'pi'), '#!/bin/sh\necho "demo host"\n', { mode: 0o755 })
// Claude Code answers sideby's quota check (`claude -p /usage`, ADR-0063) with the same fake numbers as the cached
// status line readings below, so the Panel shows them as it does with the real CLI.
await writeFile(
  join(bin, 'claude'),
  `#!${process.execPath}
if (process.argv[3] !== '/usage') { console.log('demo host'); process.exit(0) }
const work = /claude-work$/.test(process.env.CLAUDE_CONFIG_DIR || '')
const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const reset = (ms) => {
  const d = new Date(Math.ceil(ms / 3600000) * 3600000)
  const h = d.getUTCHours() % 12 || 12
  return 'resets ' + mon[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' at ' + h + (d.getUTCHours() < 12 ? 'am' : 'pm') + ' (UTC)'
}
const result = [
  'Current session: ' + (work ? 23 : 35) + '% used · ' + reset(${Math.round(now + 1.8 * H)}),
  'Current week (all models): ' + (work ? 91 : 44) + '% used · ' + reset(${Math.round(now + 96 * H)}),
].join('\\n')
console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0, local_command: 'usage', result }))
`,
  { mode: 0o755 },
)
// The official Codex quota protocol, with demo numbers only (ADR-0038).
await writeFile(
  join(bin, 'codex'),
  `#!${process.execPath}
if (!process.argv.includes('app-server')) { console.log('demo host'); process.exit(0) }
const team = /codex-team$/.test(process.env.CODEX_HOME || '')
const limits = {
  limitId: 'codex', planType: 'plus',
  primary: { usedPercent: team ? 12 : 38, windowDurationMins: 300, resetsAt: ${Math.round((now + 2.5 * H) / 1000)} },
  secondary: { usedPercent: team ? 27 : 61, windowDurationMins: 10080, resetsAt: ${Math.round((now + 70 * H) / 1000)} }
}
let buf = ''
process.stdin.on('data', d => {
  buf += d
  for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
    const req = JSON.parse(buf.slice(0, i))
    if (req.method === 'initialized') continue
    const result = req.method === 'initialize' ? { userAgent: 'demo' } : { rateLimits: limits, rateLimitsByLimitId: { codex: limits } }
    process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  { mode: 0o755 },
)
// Grok answers sideby's quota check (`grok agent --no-leader stdio`, `_x.ai/billing`, spec §3.26) with fake numbers per
// account, so the Panel shows Grok quota as it does with the real CLI. Nothing here talks to xAI.
await writeFile(
  join(bin, 'grok'),
  `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] !== 'agent') { console.log('demo host'); process.exit(0) }
const pct = /grok-lab$/.test(process.env.GROK_HOME || '') ? 64 : 31
const day = 86400000
const start = new Date(Math.floor(Date.now() / day) * day - 2 * day)
const config = { creditUsagePercent: pct, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: start.toISOString(), end: new Date(start.getTime() + 7 * day).toISOString() } }
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
    const req = JSON.parse(buf.slice(0, i))
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { config, subscription_tier: 'SuperGrok' } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  { mode: 0o755 },
)

/** A Codex auth.json whose id_token carries fake email and ChatGPT user id claims (no real token, no signature). */
function codexAuth(email: string, userId: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_user_id: userId } }
  return JSON.stringify({
    tokens: { id_token: `${part({ alg: 'none' })}.${part(claims)}.demo`, access_token: 'demo' },
  })
}

// Fake ids that tie the demo accounts to the fake Chrome browser users below (spec §3.24).
const CLAUDE_MAIN_ID = '00000000-0000-4000-8000-00000000c1a1'
const CLAUDE_WORK_ID = '00000000-0000-4000-8000-00000000c1a2'
const CODEX_MAIN_ID = 'user-DemoMain00000001'

/**
 * A Chrome Local Storage `.log` holding the given key names (one WriteBatch, values empty), enough for the reader in
 * core/leveldb-keys.ts. Checksums are left zero; the reader does not check them.
 */
function chromeLog(origin: string, names: string[]): Buffer {
  const varint = (n: number) => {
    const out: number[] = []
    for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80)
    out.push(n)
    return out
  }
  const body: number[] = [1, 0, 0, 0, 0, 0, 0, 0, names.length, 0, 0, 0]
  for (const n of names) {
    const key = Buffer.from(`_${origin}\u0000\u0001${n}`, 'latin1')
    body.push(1, ...varint(key.length), ...key, 1, 1)
  }
  return Buffer.from([0, 0, 0, 0, body.length & 0xff, body.length >> 8, 1, ...body])
}

if (variant !== 'empty') {
  // Claude: main + a work subscription + a DeepSeek API account.
  await write('.claude/settings.json', '{\n  "model": "opus"\n}\n')
  await write('.claude/skills/review/SKILL.md', '---\nname: review\n---\n')
  await write('.claude/CLAUDE.md', '# My rules\n')
  await write(
    '.claude.json',
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'me@example.com',
        organizationName: "me@example.com's Organization",
        accountUuid: CLAUDE_MAIN_ID,
      },
      mcpServers: { github: { command: 'gh-mcp' } },
    }),
    0o600,
  )
  // Codex, Grok and pi main accounts.
  await write('.codex/config.toml', 'model = "gpt-5.5"\n')
  await write('.codex/AGENTS.md', '# My rules\n')
  await mkdir(join(home, '.codex/skills'), { recursive: true })
  await write('.codex/auth.json', codexAuth('me@example.com', CODEX_MAIN_ID), 0o600)
  await write('.grok/config.toml', 'model = "grok-code"\n')
  await mkdir(join(home, '.grok/skills'), { recursive: true })
  await mkdir(join(home, '.grok/hooks'), { recursive: true })
  await write('.grok/hooks/notify.sh', '#!/bin/sh\n', 0o755)
  await write(
    '.grok/auth.json',
    JSON.stringify({ 'https://auth.x.ai::00000000-demo': { email: 'me@example.com', access_token: 'demo' } }),
    0o600,
  )
  await write('.pi/agent/AGENTS.md', '# My rules\n')
  await write('.pi/agent/auth.json', '{}', 0o600)
  await write('.pi/agent/settings.json', '{"defaultProvider":"glm","defaultModel":"glm-5"}')

  const rt = await createRuntime({ env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
  await rt.createAccount('claude', 'work')
  await rt.createAccount('claude', 'deepseek', { api: true })
  await rt.createAccount('codex', 'team')
  await rt.createAccount('grok', 'lab')
  await write(
    '.grok-lab/auth.json',
    JSON.stringify({ 'https://auth.x.ai::00000000-lab': { email: 'lab@example.com', access_token: 'demo' } }),
    0o600,
  )
  // Short commands, so the Panel shows them next to the account names as people really use it.
  await rt.addAlias('ccw', 'claude:work')
  await rt.addAlias('ccd', 'claude:deepseek')
  await rt.addAlias('cxt', 'codex:team')
  await write(
    '.claude-work/.claude.json',
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'work@example.com',
        organizationName: 'Example Team',
        accountUuid: CLAUDE_WORK_ID,
      },
      mcpServers: { github: { command: 'gh-mcp' } },
    }),
    0o600,
  )
  await write(
    '.claude-deepseek/proxy.env',
    'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_AUTH_TOKEN=demo\nANTHROPIC_MODEL=deepseek-v4\n',
    0o600,
  )
  await write('.codex-team/auth.json', codexAuth('team@example.com', 'user-DemoTeam00000002'), 0o600)

  // Chrome with three browser users, for "Open in browser" (spec §3.24). Finding sign-ins stays off, as for a new
  // user; turn it on in the Panel to see Personal and Work matched.
  const chrome = 'Library/Application Support/Google/Chrome'
  await write(
    `${chrome}/Local State`,
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal' },
          'Profile 1': { name: 'Work' },
          'Profile 2': { name: 'School' },
        },
      },
    }),
  )
  const ls = (dir: string) => join(home, chrome, dir, 'Local Storage/leveldb')
  for (const dir of ['Default', 'Profile 1', 'Profile 2']) await mkdir(ls(dir), { recursive: true })
  await writeFile(
    join(ls('Default'), '000003.log'),
    Buffer.concat([
      chromeLog('https://claude.ai', [`persisted.ccd-session-presets.${CLAUDE_MAIN_ID}.demo-org`]),
      chromeLog('https://chatgpt.com', [`cache/${CODEX_MAIN_ID}/demo-workspace/models`]),
    ]),
  )
  await writeFile(
    join(ls('Profile 1'), '000003.log'),
    chromeLog('https://claude.ai', [`frame-design-systems:demo-org:${CLAUDE_WORK_ID}`]),
  )
  await writeFile(join(ls('Profile 2'), '000003.log'), chromeLog('https://claude.ai', ['theme']))
  // A fixable issue for the health section: Grok refuses linked hooks.
  await rm(join(home, '.grok-lab/hooks'), { recursive: true, force: true })
  await symlink(join(home, '.grok/hooks'), join(home, '.grok-lab/hooks'))

  // Usage: Claude session records and Codex rollouts.
  const claudeTurn = (id: string, at: number, input: number, output: number, cache: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(-at),
      sessionId: `s-${id.slice(0, 2)}`,
      message: {
        id,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cache,
          cache_creation_input_tokens: 2_000,
        },
      },
    })
  await write(
    '.claude/projects/demo/a.jsonl',
    [
      claudeTurn('m1', 2 * H, 52_000, 9_100, 4_100_000),
      claudeTurn('m2', 26 * H, 31_000, 6_400, 2_800_000),
    ].join('\n'),
  )
  await write(
    '.claude-work/projects/demo/b.jsonl',
    [
      claudeTurn('w1', 1 * H, 88_000, 15_200, 9_600_000),
      claudeTurn('w2', 50 * H, 61_000, 12_000, 7_300_000),
    ].join('\n'),
  )
  // Context tuning (spec §3.18): one long Claude session that compacted twice, and a Codex rollout that compacted once.
  const tuneRows: string[] = []
  for (let i = 0; i < 400; i++) {
    const at = 3 * H - i * 20_000
    if (i > 0 && i % 190 === 0)
      tuneRows.push(
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: iso(-at),
          sessionId: 's-tune',
          compactMetadata: { trigger: 'auto', preTokens: 190_000, postTokens: 20_000 },
        }),
      )
    tuneRows.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: iso(-at),
        sessionId: 's-tune',
        message: {
          id: `tune-${i}`,
          model: 'claude-opus-5-5',
          usage: {
            input_tokens: 10,
            output_tokens: 300,
            cache_read_input_tokens: 19_000 + (i % 190) * 900,
            cache_creation_input_tokens: 900,
            cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
          },
        },
      }),
    )
  }
  await write('.claude/projects/demo/tune.jsonl', tuneRows.join('\n'))
  const tuneCodex = (kind: string, at: number, payload: object) =>
    JSON.stringify({ timestamp: iso(-at), type: kind, payload })
  const codexCount = (at: number, input: number) =>
    tuneCodex('event_msg', at, {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input }, model_context_window: 258_400 },
    })
  await write(
    `.codex/sessions/${new Date(now).toISOString().slice(0, 10).replace(/-/g, '/')}/rollout-demo-tune.jsonl`,
    [
      tuneCodex('turn_context', 2 * H, { model: 'gpt-demo' }),
      codexCount(2 * H - 1000, 120_000),
      codexCount(2 * H - 2000, 232_000),
      tuneCodex('compacted', 2 * H - 3000, { message: 'summary' }),
      codexCount(2 * H - 4000, 36_000),
    ].join('\n'),
  )
  const rollout = (at: number, five: number, seven: number) =>
    JSON.stringify({
      timestamp: iso(-at),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 820_000,
            cached_input_tokens: 610_000,
            output_tokens: 41_000,
            total_tokens: 861_000,
          },
        },
        rate_limits: {
          primary: { used_percent: five, window_minutes: 300, resets_at: Math.round((now + 2.5 * H) / 1000) },
          secondary: {
            used_percent: seven,
            window_minutes: 10080,
            resets_at: Math.round((now + 70 * H) / 1000),
          },
          plan_type: 'plus',
        },
      },
    })
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '/')
  await write(`.codex/sessions/${day}/rollout-demo-1.jsonl`, rollout(0.4 * H, 38, 61))
  await write(`.codex-team/sessions/${day}/rollout-demo-2.jsonl`, rollout(3 * H, 12, 27))

  // Session History (spec §3.33): a few past conversations in two projects, one of them in a folder that is gone.
  // Codex's rollout sits days back, so the quota above still comes from today's files.
  const shop = join(home, 'code/shop')
  await mkdir(join(shop, '.git'), { recursive: true })
  await mkdir(join(shop, 'web'), { recursive: true })
  await mkdir(join(home, 'code/blog'), { recursive: true })
  const D = 24 * H
  const lines = (recs: object[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`
  const claudeTalk = (
    sid: string,
    cwd: string,
    branch: string,
    startAgo: number,
    turns: [string, string][],
  ) =>
    lines(
      turns.flatMap(([q, a], i) => [
        {
          type: 'user',
          sessionId: sid,
          cwd,
          gitBranch: branch,
          entrypoint: 'cli',
          timestamp: iso(-startAgo + i * 240_000),
          message: { role: 'user', content: q },
        },
        {
          type: 'assistant',
          sessionId: sid,
          timestamp: iso(-startAgo + i * 240_000 + 60_000),
          message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: a }] },
        },
      ]),
    )
  await write(
    '.claude/projects/-code-shop/4c1d101f-0000-4000-8000-000000000101.jsonl',
    claudeTalk('4c1d101f-0000-4000-8000-000000000101', shop, 'feat/login', 6 * D, [
      [
        'Redesign the login page: one column, bigger buttons, and show the error under the field.',
        'Done. The form is one column, buttons are 44 px tall, and errors show under each field.',
      ],
      [
        'Also remember the email after a failed sign-in.',
        'The email field now keeps its value after a failed sign-in.',
      ],
    ]),
  )
  await write(
    '.claude/projects/-code-shop/4c1d102f-0000-4000-8000-000000000102.jsonl',
    claudeTalk('4c1d102f-0000-4000-8000-000000000102', join(shop, 'web'), 'main', 0.5 * H, [
      [
        'Why does checkout take 3 seconds on the first load?',
        'The product images are not cached. I added a cache header and lazy loading below the fold.',
      ],
    ]),
  )
  await write(
    '.claude-work/projects/-code-blog/4c1d103f-0000-4000-8000-000000000103.jsonl',
    claudeTalk('4c1d103f-0000-4000-8000-000000000103', join(home, 'code/blog'), 'main', 2 * D, [
      ['Write an RSS feed for the blog.', 'Added /feed.xml with the 20 newest posts.'],
    ]),
  )
  await write(
    '.claude/projects/-code-old-app/4c1d104f-0000-4000-8000-000000000104.jsonl',
    claudeTalk('4c1d104f-0000-4000-8000-000000000104', join(home, 'code/old-app'), 'main', 40 * D, [
      ['Move the old app to the new API.', 'All calls now use /v2; the old client is removed.'],
    ]),
  )
  await write(
    `.pi/agent/sessions/--code-blog--/2026-demo_4c1d401f-0000-4000-8000-000000000401.jsonl`,
    lines([
      {
        type: 'session',
        id: '4c1d401f-0000-4000-8000-000000000401',
        cwd: join(home, 'code/blog'),
        timestamp: iso(-9 * D),
      },
      {
        type: 'message',
        timestamp: iso(-9 * D + 60_000),
        message: { role: 'user', content: [{ type: 'text', text: 'Fix the broken links in old posts.' }] },
      },
      {
        type: 'message',
        timestamp: iso(-9 * D + 120_000),
        message: {
          role: 'assistant',
          model: 'pi-demo',
          content: [
            {
              type: 'text',
              text: 'Fixed 12 links; 3 pages no longer exist, so those links now point to the archive.',
            },
          ],
        },
      },
    ]),
  )
  const codexDay = new Date(now - 3 * D).toISOString().slice(0, 10).replace(/-/g, '/')
  const codexAt = (i: number) => iso(-3 * D + i * 60_000)
  await write(
    `.codex/sessions/${codexDay}/rollout-demo-history-4c1d201f-0000-4000-8000-000000000201.jsonl`,
    lines([
      {
        timestamp: codexAt(0),
        type: 'session_meta',
        payload: {
          id: '4c1d201f-0000-4000-8000-000000000201',
          cwd: shop,
          source: 'cli',
          originator: 'codex_cli_rs',
          git: { branch: 'fix/cart' },
        },
      },
      { timestamp: codexAt(0), type: 'turn_context', payload: { model: 'gpt-demo' } },
      {
        timestamp: codexAt(1),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'The cart total is wrong when a coupon and free shipping are both used.',
            },
          ],
        },
      },
      {
        timestamp: codexAt(2),
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{}' },
      },
      {
        timestamp: codexAt(3),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Fixed: the coupon was applied after shipping. Added a test for both together.',
            },
          ],
        },
      },
    ]),
  )
  await write(
    `.grok/sessions/${encodeURIComponent(join(home, 'code/blog'))}/4c1d301f-0000-4000-8000-000000000301/summary.json`,
    JSON.stringify({
      generated_title: 'Dark mode for the blog',
      git_root_dir: join(home, 'code/blog'),
      head_branch: 'main',
      current_model_id: 'grok-code',
      created_at: iso(-26 * H),
      last_active_at: iso(-25 * H),
    }),
  )
  await write(
    `.grok/sessions/${encodeURIComponent(join(home, 'code/blog'))}/4c1d301f-0000-4000-8000-000000000301/chat_history.jsonl`,
    lines([
      { type: 'user', timestamp: iso(-26 * H), content: 'Add a dark mode that follows the system setting.' },
      {
        type: 'assistant',
        timestamp: iso(-25 * H),
        content: 'Added prefers-color-scheme styles and a toggle in the header.',
      },
    ]),
  )

  // Claude quota as the status line wrapper would have cached it.
  const cache = (five: number, seven: number, at: number) =>
    JSON.stringify({
      observedAt: iso(-at),
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: five, resetsAt: iso(1.8 * H) },
        { label: '7d', windowMinutes: 10080, usedPercent: seven, resetsAt: iso(96 * H) },
      ],
    })
  await write('.local/state/sideby/quota/claude/main.json', cache(35, 44, 0.2 * H))
  await write('.local/state/sideby/quota/claude/work.json', cache(23, 91, 1.1 * H))
  const wrapped = JSON.stringify(
    { model: 'opus', statusLine: { type: 'command', command: 'sideby statusline-tap' } },
    null,
    2,
  )
  await write('.claude/settings.json', `${wrapped}\n`)

  if (variant === 'error' || variant === 'slow') {
    // A local plugin Family that fails (error) or answers slowly (slow), to show those Panel states.
    const dir = '.config/sideby/plugins/demo-states'
    await write(`${dir}/plugin.json`, JSON.stringify({ name: 'demo-states', version: '1.0.0' }))
    await write(
      `${dir}/index.ts`,
      `export default {
  name: 'demo-states',
  register(api) {
    api.family({
      id: 'lab', title: 'Lab CLI', bin: 'lab', installUrl: 'https://example.invalid/lab', selectVar: 'LAB_HOME',
      layout: { main: '.lab', account: '.lab-<name>' }, hijackVars: [], apiVars: [], sharedItems: [],
      login: { args: ['login'], hint: '' },
      async model() { ${variant === 'error' ? "throw new Error('settings.json is not valid JSON')" : "await new Promise((r) => setTimeout(r, 6000)); return 'lab-1'"} },
    })
  },
}
`,
    )
    await chmod(join(home, '.config/sideby/plugins'), 0o755)
    await chmod(join(home, dir), 0o755)
    await mkdir(join(home, '.lab'), { recursive: true })
  }
}
const envs = `HOME=${home} XDG_CONFIG_HOME=${home}/.config XDG_STATE_HOME=${home}/.local/state PATH=${bin}:$PATH`
console.log(`demo HOME (${variant}): ${home}\nstart: ${envs} node src/cli/main.ts ui`)
