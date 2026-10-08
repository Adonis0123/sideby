import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { identityFromJsonFile, identityOf, jwtEmail } from '../../core/identity.ts'
import type { Account, FamilyDef, LoginState, Plugin } from '../../types.ts'
import { BUILTIN_LOGOS } from '../logos.ts'
import { nestedFileWrittenAt, resumeSubcommandSession } from '../shared/sessions.ts'
import { topLevelTomlString } from '../shared/toml.ts'
import { readCodexQuota, readCodexUsage } from './rollout.ts'

const FILE_STORE_KEY = 'cli_auth_credentials_store'

async function readModel(account: Account): Promise<string | undefined> {
  try {
    return topLevelTomlString(await readFile(join(account.dir, 'config.toml'), 'utf8'), 'model')
  } catch {
    return undefined
  }
}

/** The email claim of `tokens.id_token` in auth.json; the token and every other claim are dropped. */
export function codexIdentity(account: Account) {
  return identityFromJsonFile(join(account.dir, 'auth.json'), (data) =>
    identityOf(jwtEmail((data as { tokens?: { id_token?: unknown } } | null)?.tokens?.id_token)),
  )
}

export const codexFamily: FamilyDef = {
  id: 'codex',
  title: 'Codex',
  logo: BUILTIN_LOGOS.codex,
  bin: 'codex',
  installUrl: 'https://github.com/openai/codex',
  selectVar: 'CODEX_HOME',
  layout: { main: '.codex', account: '.codex-<name>' },
  hijackVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_BASE_URL'],
  apiVars: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
  sharedItems: [
    { path: 'AGENTS.md', mode: 'link' },
    { path: 'hooks.json', mode: 'link' },
    { path: 'plugins', mode: 'link' },
    { path: 'rules', mode: 'link' },
    { path: 'skills', mode: 'link' },
    { path: 'config.toml', mode: 'local-if-api' },
    { path: 'auth.json', mode: 'info', credential: true },
  ],
  login: {
    args: ['login'],
    hint: "Sign in with ChatGPT in the browser; the login is saved to this account's auth.json",
  },
  // A non-main Account keeps its login in its own auth.json instead of the shared OS keyring.
  defaultArgs(account, userArgs) {
    if (account.isMain || userArgs.some((a) => a.includes(FILE_STORE_KEY))) return []
    return ['-c', `${FILE_STORE_KEY}="file"`]
  },
  // `tui.terminal_title` takes only built-in items; an empty list leaves the title sideby set alone.
  keepTitle: { key: 'tui.terminal_title', args: ['-c', 'tui.terminal_title=[]'] },
  async loginState(account): Promise<LoginState> {
    try {
      return (await stat(join(account.dir, 'auth.json'))).isFile() ? 'logged-in' : 'unknown'
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'logged-out' : 'unknown'
    }
  },
  model: readModel,
  identity: codexIdentity,
  readQuota: (account) => readCodexQuota(account.dir),
  readUsage: (account, ctx) => readCodexUsage(account.dir, ctx.now),
  resumedSession: resumeSubcommandSession,
  sessionWrittenAt: (account, id) => nestedFileWrittenAt(join(account.dir, 'sessions'), `-${id}.jsonl`),
}

export const codexPlugin: Plugin = {
  name: 'codex',
  register(api) {
    api.family(codexFamily)
  },
}
