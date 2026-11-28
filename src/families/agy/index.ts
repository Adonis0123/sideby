import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatOrNull } from '../../core/fs-safe.ts'
import type { Account, FamilyDef, LoginState, Plugin } from '../../types.ts'
import { BUILTIN_LOGOS } from '../logos.ts'
import { resumeFlagSession, withoutResumeFlag } from '../shared/sessions.ts'
import {
  AGY_ACCOUNT_LAYOUT,
  AGY_FORCE_FILE_TOKEN_VAR,
  AGY_MAIN_DIR,
  AGY_OAUTH_TOKEN_FILE,
  agyOAuthTokenPath,
  agySelectArgs,
  findAgyDirFlag,
} from './layout.ts'
import { AGY_SKIP_VALUE_FLAGS } from './mod.ts'
import { AGY_DEFAULT_PICK_GROUP, agyQuotaFetch } from './quota.ts'

export { AGY_FORCE_FILE_TOKEN_VAR, AGY_OAUTH_TOKEN_FILE, agyAppDataRelDir, agySelectArgs } from './layout.ts'
export { AGY_DEFAULT_PICK_GROUP } from './quota.ts'

const AGY_RESUME_FLAGS = ['--conversation', '--resume', '-r'] as const

const agyResumedSession = (args: readonly string[]) => resumeFlagSession(args, AGY_RESUME_FLAGS)
const agyWithoutResume = (args: readonly string[]) => withoutResumeFlag(args, AGY_RESUME_FLAGS)

async function agySessionWrittenAt(account: Account, sessionId: string): Promise<number | undefined> {
  try {
    const st = await stat(join(account.dir, 'conversations', `${sessionId}.db`))
    return st.isFile() ? st.mtimeMs : undefined
  } catch {
    return undefined
  }
}

/** Lets agy run without asking before each tool call; an AI Task must keep those checks (ADR-0031). */
const SKIP_PERMISSIONS = '--dangerously-skip-permissions'

/** WHY: shared verification that a prepared agy launch retains sideby's own directory selection (ADR-0090). */
export function agyLaunchDirProblem(
  account: Pick<Account, 'isMain' | 'name' | 'ref'>,
  args: readonly string[],
): string | undefined {
  const expected = agySelectArgs(account)
  if (expected.length > args.length || expected.some((v, i) => args[i] !== v)) {
    return `sideby manages the Antigravity CLI account directory (${account.ref}); keep ${expected[0] ?? 'no directory override'}`
  }
  const bad = findAgyDirFlag(args.slice(expected.length), AGY_SKIP_VALUE_FLAGS)
  if (bad) {
    return `sideby manages the Antigravity CLI account directory (${account.ref}); remove ${bad} and run \`sideby run agy:<name>\` instead`
  }
  return undefined
}

/**
 * Antigravity CLI (ADR-0090, superseding ADR-0047): the Main Account stays at `~/.gemini/antigravity-cli` with its
 * OS keyring login shared with the desktop app/IDE, while extra Accounts live at `~/.gemini/antigravity-cli-<name>`
 * selected via `--app_data_dir` and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` (tried with agy 1.5.18 on 2026-11-27).
 */
export const agyFamily: FamilyDef = {
  id: 'agy',
  title: 'Antigravity CLI',
  logo: BUILTIN_LOGOS.agy,
  bin: 'agy',
  installUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
  installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  noApi: true,
  defaultQuotaGroup: AGY_DEFAULT_PICK_GROUP,
  layout: { main: AGY_MAIN_DIR, account: AGY_ACCOUNT_LAYOUT },
  selectArgs: agySelectArgs,
  selectEnv: (account: Account) => (account.isMain ? {} : { [AGY_FORCE_FILE_TOKEN_VAR]: '1' }),
  // Variables that would sign agy in with a key, route it elsewhere, or force file token storage onto Main. Kept:
  // GOOGLE_CLOUD_PROJECT (other tools use it too) and AGY_ACCOUNT (picks a connected sandbox account, not the login).
  hijackVars: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AGY_ADC_AUTH',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'ANTIGRAVITY_PROJECT_ID',
    AGY_FORCE_FILE_TOKEN_VAR,
  ],
  apiVars: [],
  // `-p` is one non-interactive prompt (agy 1.4.4 --help, 2026-10-21).
  probe: {
    args: ['-p', 'Reply with OK'],
    model: { flags: ['--model'], args: (m) => ['--model', m, '-p', 'Reply with OK'] },
  },
  // agy reads a prompt only from -p, -i or stdin: "unexpected argument" otherwise (agy 1.4.4, 2026-10-21).
  promptArg: '--prompt-interactive',
  aiTaskArgs: (args) =>
    args.includes(SKIP_PERMISSIONS) ? args.filter((a) => a !== SKIP_PERMISSIONS) : [...args],
  markers: [
    'settings.json',
    'skills',
    AGY_OAUTH_TOKEN_FILE,
    'conversations',
    'brain',
    'conversation_summaries.db',
  ],
  sharedItems: [
    { path: 'settings.json', mode: 'link-or-local' },
    { path: 'skills', mode: 'link' },
    { path: AGY_OAUTH_TOKEN_FILE, mode: 'info', credential: true, noSymlink: true },
  ],
  settingsFile: 'settings.json',
  login: {
    args: null,
    hint: 'Start agy and sign in with your Google account in the browser (the main account uses the system keychain; extra accounts store their login in their account directory)',
  },
  // Main's sign-in lives in the system keychain, which sideby never reads (`unknown`); extra Accounts store a regular
  // mode-600 `antigravity-oauth-token` file whose existence tells logged-in vs logged-out without reading it (ADR-0090).
  async loginState(account: Account): Promise<LoginState> {
    if (account.isMain) return 'unknown'
    const st = await lstatOrNull(agyOAuthTokenPath(account.dir))
    if (!st) return 'logged-out'
    return st.isFile() && !st.isSymbolicLink() ? 'logged-in' : 'unknown'
  },
  // agy keeps no record sideby reads for this: only a quota check that met agy's sign-in page marks the login
  // expired (`loginExpired`, ADR-0082), and a later good answer clears it.
  async readLoginEvents() {
    return {}
  },
  fetchQuota: agyQuotaFetch,
  resumedSession: agyResumedSession,
  sessionWrittenAt: agySessionWrittenAt,
  withoutResume: agyWithoutResume,
}

export const agyPlugin: Plugin = {
  name: 'agy',
  register(api) {
    api.family(agyFamily)
    api.on('account.create.before', { family: 'agy' }, (ctx) => {
      if (ctx.api)
        throw api.abort(
          'Antigravity CLI API key accounts are not supported yet: agy requires setting modelProvider in settings.json alongside GEMINI_API_KEY. Create a Google subscription account without --api instead.',
        )
    })
    api.on('launch.before', { family: 'agy' }, (ctx) => {
      const problem = agyLaunchDirProblem(ctx.account, ctx.args)
      if (problem) throw api.abort(problem)
    })
    api.on('doctor.check', { family: 'agy' }, async (ctx) => {
      if (await lstatOrNull(join(ctx.account.dir, 'proxy.env'))) {
        return [
          {
            level: 'warn',
            item: 'proxy.env',
            code: 'secret.unsupported',
            message: 'proxy.env is ignored because Antigravity CLI API key accounts are not supported',
            hint: `move "${join(ctx.account.dir, 'proxy.env')}" aside`,
          },
        ]
      }
      return []
    })
  },
}
