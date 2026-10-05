// Built-in Family Plugin for pi (spec §3.4, checked against pi 1.0.2). pi keeps each Account one level
// deeper (`~/.pi-<name>/agent`) and signs in inside the app, so there is no login command.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatOrNull } from '../../core/fs-safe.ts'
import type { Account, FamilyDef, LoginState, Plugin } from '../../types.ts'
import { BUILTIN_LOGOS } from '../logos.ts'

/** `auth.json` exists after `/login`; its contents are never read. */
async function loginState(account: Account): Promise<LoginState> {
  return (await lstatOrNull(join(account.dir, 'auth.json'))) ? 'logged-in' : 'logged-out'
}

async function model(account: Account): Promise<string | undefined> {
  try {
    const s = JSON.parse(await readFile(join(account.dir, 'settings.json'), 'utf8')) as {
      defaultProvider?: unknown
      defaultModel?: unknown
    }
    const provider = typeof s?.defaultProvider === 'string' ? s.defaultProvider : ''
    const id = typeof s?.defaultModel === 'string' ? s.defaultModel : ''
    if (!id) return undefined
    return provider ? `${provider}/${id}` : id
  } catch {
    return undefined
  }
}

export const piFamily: FamilyDef = {
  id: 'pi',
  title: 'pi',
  logo: BUILTIN_LOGOS.pi,
  bin: 'pi',
  installUrl: 'https://github.com/earendil-works/pi',
  selectVar: 'PI_CODING_AGENT_DIR',
  secretFileMeansApi: false,
  layout: { main: '.pi/agent', account: '.pi-<name>/agent' },
  hijackVars: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ],
  apiVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  sharedItems: [
    { path: 'AGENTS.md', mode: 'link' },
    { path: 'auth.json', mode: 'info', credential: true },
  ],
  login: { args: null, hint: 'pi signs in inside the app: start it and type /login' },
  loginState,
  model,
}

export const piPlugin: Plugin = {
  name: 'pi',
  register(api) {
    api.family(piFamily)
  },
}
