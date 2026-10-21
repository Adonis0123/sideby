import type { FamilyDef, LoginState, Plugin } from '../../types.ts'
import { BUILTIN_LOGOS } from '../logos.ts'
import { agyQuotaFetch } from './quota.ts'

/** Lets agy run without asking before each tool call; an AI Task must keep those checks (ADR-0031). */
const SKIP_PERMISSIONS = '--dangerously-skip-permissions'

/**
 * Antigravity CLI, a Main-only Family (ADR-0047): agy keeps its data under `$HOME/.gemini/antigravity-cli` and its
 * Google sign-in in one fixed system keychain entry, with no variable that moves either (tried with agy 1.4.4 on
 * 2026-10-21), so sideby knows only its Main Account.
 */
export const agyFamily: FamilyDef = {
  id: 'agy',
  title: 'Antigravity CLI',
  logo: BUILTIN_LOGOS.agy,
  bin: 'agy',
  installUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
  installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  mainOnly: true,
  layout: { main: '.gemini/antigravity-cli' },
  // Variables that would sign agy in with a key or route it elsewhere instead of the Google sign-in. Kept:
  // GOOGLE_CLOUD_PROJECT (other tools use it too) and AGY_ACCOUNT (picks a connected sandbox account, not the login).
  hijackVars: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AGY_ADC_AUTH',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_ENTERPRISE',
    'ANTIGRAVITY_PROJECT_ID',
  ],
  apiVars: [],
  // `-p` is one non-interactive prompt (agy 1.4.4 --help, 2026-10-21).
  probe: { args: ['-p', 'Reply with OK'] },
  // agy reads a prompt only from -p, -i or stdin: "unexpected argument" otherwise (agy 1.4.4, 2026-10-21).
  promptArg: '--prompt-interactive',
  aiTaskArgs: (args) =>
    args.includes(SKIP_PERMISSIONS) ? args.filter((a) => a !== SKIP_PERMISSIONS) : [...args],
  sharedItems: [],
  settingsFile: 'settings.json',
  login: {
    args: null,
    hint: 'Start agy and sign in with your Google account in the browser; agy keeps one sign-in per computer',
  },
  // The sign-in lives in the system keychain, which sideby never reads: the state is unknown. A quota check that
  // fails for want of a sign-in says so in the Quota column.
  async loginState(): Promise<LoginState> {
    return 'unknown'
  },
  fetchQuota: agyQuotaFetch,
}

export const agyPlugin: Plugin = {
  name: 'agy',
  register(api) {
    api.family(agyFamily)
  },
}
