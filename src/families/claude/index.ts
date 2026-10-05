// Built-in Family Plugin for Claude Code (spec §3.4, checked against Claude Code 2.1.289).
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readSecretFile } from '../../core/secret-file.ts'
import { claudeStatusline } from '../../quota/claude-statusline.ts'
import type { Account, FamilyDef, LoginState, Plugin, SharedItemDef } from '../../types.ts'
import { BUILTIN_LOGOS } from '../logos.ts'
import { CLAUDE_LAYOUT } from './layout.ts'
import { readClaudeQuota } from './quota.ts'
import { readClaudeUsage } from './usage.ts'

const LINKED = [
  'settings.json',
  'settings.local.json',
  'skills',
  'commands',
  'plugins',
  'hooks',
  'themes',
  'CLAUDE.md',
]

/** The Main Account keeps `.claude.json` in HOME; other Accounts keep it inside their directory. */
export function claudeJsonOf(account: Account): string {
  return account.isMain ? join(dirname(account.dir), '.claude.json') : join(account.dir, '.claude.json')
}

/** Only checks whether `oauthAccount` is present; the parsed content is dropped immediately. */
async function loginState(account: Account): Promise<LoginState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(claudeJsonOf(account), 'utf8'))
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown'
  return (parsed as Record<string, unknown>).oauthAccount != null ? 'logged-in' : 'logged-out'
}

async function model(account: Account): Promise<string | undefined> {
  if (account.kind === 'api') {
    if (!account.secretFile) return undefined
    try {
      return (await readSecretFile(account.secretFile)).ANTHROPIC_MODEL || undefined
    } catch {
      return undefined
    }
  }
  try {
    const s = JSON.parse(await readFile(join(account.dir, 'settings.json'), 'utf8')) as { model?: unknown }
    return typeof s?.model === 'string' && s.model ? s.model : undefined
  } catch {
    return undefined
  }
}

export const claudeFamily: FamilyDef = {
  id: 'claude',
  title: 'Claude Code',
  logo: BUILTIN_LOGOS.claude,
  bin: 'claude',
  installUrl: 'https://code.claude.com/docs/en/setup',
  selectVar: 'CLAUDE_CONFIG_DIR',
  layout: CLAUDE_LAYOUT,
  // `plugins` alone is too generic: claude-code-router keeps `~/.claude-code-router/plugins`.
  markers: [
    '.claude.json',
    'settings.json',
    'settings.local.json',
    'skills',
    'commands',
    'hooks',
    'themes',
    'CLAUDE.md',
    'projects',
  ],
  hijackVars: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ],
  apiVars: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
  sharedItems: [
    ...LINKED.map((path): SharedItemDef => ({ path, mode: 'link' })),
    { path: '.claude.json', mode: 'json-key', key: 'mcpServers', mainPath: '.claude.json', credential: true },
  ],
  login: {
    args: ['auth', 'login'],
    hint: 'Opens the browser to sign this account in to Claude (`claude auth login`).',
  },
  loginState,
  model,
  readQuota: readClaudeQuota,
  readUsage: readClaudeUsage,
  quotaSetup: claudeStatusline,
}

export const claudePlugin: Plugin = {
  name: 'claude',
  register(api) {
    api.family(claudeFamily)
  },
}
