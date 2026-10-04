import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyDef, LoginState, Plugin } from '../../types.ts'
import { topLevelTomlString } from '../shared/toml.ts'

// Grok's sandbox rejects these paths when they are symlinks; doctor quotes the Host's own words.
const HOOKS_DIR_MESSAGE = 'Grok hooks directory has wrong type (expected real directory)'
const REAL_FILE_MESSAGE = 'Grok hooks-paths registry has wrong type (expected real file)'
const AUTH_MESSAGE = 'the policy lock file under ~/.grok-00x is not accessible'

/** `model = "..."` before the first `[table]` of config.toml. */
async function readModel(account: Account): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(join(account.dir, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
  return topLevelTomlString(text, 'model')
}

export const grokFamily: FamilyDef = {
  id: 'grok',
  title: 'Grok Build',
  bin: 'grok',
  installUrl: 'https://docs.x.ai/build/overview',
  selectVar: 'GROK_HOME',
  layout: { main: '.grok', account: '.grok-<name>' },
  hijackVars: ['XAI_API_KEY', 'GROK_MODELS_BASE_URL'],
  apiVars: ['GROK_MODELS_BASE_URL', 'XAI_API_KEY'],
  sharedItems: [
    { path: 'skills', mode: 'link' },
    { path: 'installed-plugins', mode: 'link' },
    { path: 'hooks', mode: 'copy', hostMessage: HOOKS_DIR_MESSAGE },
    { path: 'hooks-paths', mode: 'copy', hostMessage: REAL_FILE_MESSAGE },
    { path: 'trusted_folders.toml', mode: 'local', hostMessage: REAL_FILE_MESSAGE },
    { path: 'config.toml', mode: 'local-if-api', noSymlink: true, hostMessage: REAL_FILE_MESSAGE },
    { path: 'auth.json', mode: 'info', noSymlink: true, credential: true, hostMessage: AUTH_MESSAGE },
  ],
  login: {
    args: ['login'],
    hint: "Sign in to your xAI account in the browser; the login is saved to this account's auth.json",
  },
  async loginState(account): Promise<LoginState> {
    try {
      const st = await lstat(join(account.dir, 'auth.json'))
      return st.isFile() ? 'logged-in' : 'unknown'
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'logged-out' : 'unknown'
    }
  },
  model: readModel,
}

export const grokPlugin: Plugin = {
  name: 'grok',
  register(api) {
    api.family(grokFamily)
  },
}
