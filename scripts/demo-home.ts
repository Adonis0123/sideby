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

for (const host of ['claude', 'codex', 'grok', 'pi'])
  await writeFile(join(bin, host), '#!/bin/sh\necho "demo host"\n', { mode: 0o755 })

if (variant !== 'empty') {
  // Claude: main + a work subscription + a DeepSeek API account.
  await write('.claude/settings.json', '{\n  "model": "opus"\n}\n')
  await write('.claude/skills/review/SKILL.md', '---\nname: review\n---\n')
  await write('.claude/CLAUDE.md', '# My rules\n')
  await write(
    '.claude.json',
    JSON.stringify({ oauthAccount: { emailAddress: 'demo' }, mcpServers: { github: { command: 'gh-mcp' } } }),
    0o600,
  )
  // Codex, Grok and pi main accounts.
  await write('.codex/config.toml', 'model = "gpt-5.5"\n')
  await write('.codex/AGENTS.md', '# My rules\n')
  await mkdir(join(home, '.codex/skills'), { recursive: true })
  await write('.codex/auth.json', '{}', 0o600)
  await write('.grok/config.toml', 'model = "grok-code"\n')
  await mkdir(join(home, '.grok/skills'), { recursive: true })
  await mkdir(join(home, '.grok/hooks'), { recursive: true })
  await write('.grok/hooks/notify.sh', '#!/bin/sh\n', 0o755)
  await write('.grok/auth.json', '{}', 0o600)
  await write('.pi/agent/AGENTS.md', '# My rules\n')
  await write('.pi/agent/auth.json', '{}', 0o600)
  await write('.pi/agent/settings.json', '{"defaultProvider":"glm","defaultModel":"glm-5"}')

  const rt = await createRuntime({ env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } })
  await rt.createAccount('claude', 'work')
  await rt.createAccount('claude', 'deepseek', { api: true })
  await rt.createAccount('codex', 'team')
  await rt.createAccount('grok', 'lab')
  await write(
    '.claude-work/.claude.json',
    JSON.stringify({ oauthAccount: { emailAddress: 'demo' }, mcpServers: { github: { command: 'gh-mcp' } } }),
    0o600,
  )
  await write(
    '.claude-deepseek/proxy.env',
    'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_AUTH_TOKEN=demo\nANTHROPIC_MODEL=deepseek-v4\n',
    0o600,
  )
  await write('.codex-team/auth.json', '{}', 0o600)
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

  // Claude quota as the status line wrapper would have cached it.
  const cache = (five: number, seven: number, at: number) =>
    JSON.stringify({
      observedAt: iso(-at),
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: five, resetsAt: iso(1.8 * H) },
        { label: '7d', windowMinutes: 10080, usedPercent: seven, resetsAt: iso(96 * H) },
      ],
    })
  await write('.local/state/sideby/quota/claude/main.json', cache(72, 44, 0.2 * H))
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
