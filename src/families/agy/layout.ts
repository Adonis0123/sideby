import { join } from 'node:path'
import type { Account } from '../../types.ts'

// WHY: leaf constants and path/flag helpers shared across agy family modules without circular imports (ADR-0090).
export const AGY_MAIN_DIR = '.gemini/antigravity-cli'
export const AGY_ACCOUNT_LAYOUT = '.gemini/antigravity-cli-<name>'
export const AGY_APP_DATA_PREFIX = 'antigravity-cli-'
export const AGY_FORCE_FILE_TOKEN_VAR = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE'
export const AGY_OAUTH_TOKEN_FILE = 'antigravity-oauth-token'
export const AGY_GEMINI_DIR_FLAGS = ['--gemini_dir', '-gemini_dir', '--gemini-dir', '-gemini-dir'] as const
export const AGY_APP_DATA_DIR_FLAGS = [
  '--app_data_dir',
  '-app_data_dir',
  '--app-data-dir',
  '-app-data-dir',
] as const
export const AGY_DIR_FLAGS = [...AGY_GEMINI_DIR_FLAGS, ...AGY_APP_DATA_DIR_FLAGS] as const

export const agyAppDataRelDir = (name: string): string => `${AGY_APP_DATA_PREFIX}${name}`

export const agySelectArgs = (account: Pick<Account, 'isMain' | 'name'>): string[] =>
  account.isMain ? [] : [`--app_data_dir=${agyAppDataRelDir(account.name)}`]

export const agyOAuthTokenPath = (accountDir: string): string => join(accountDir, AGY_OAUTH_TOKEN_FILE)

/** WHY: detect user/config directory flags that would bypass sideby's registered agy account dir (ADR-0090). */
export function findAgyDirFlag(
  argv: readonly string[],
  skipValueFlags: ReadonlySet<string>,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') break
    for (const flag of AGY_DIR_FLAGS) {
      if (a === flag || a.startsWith(`${flag}=`)) return flag
    }
    if (skipValueFlags.has(a)) i++
  }
  return undefined
}
