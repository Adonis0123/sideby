import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Env } from '../types.ts'

export interface Paths {
  home: string
  configDir: string
  stateDir: string
  configFile: string
  userPluginsDir: string
}

export function resolvePaths(env: Env = process.env): Paths {
  const home = env.HOME || homedir()
  const configBase = absOr(env.XDG_CONFIG_HOME, join(home, '.config'))
  const stateBase = absOr(env.XDG_STATE_HOME, join(home, '.local', 'state'))
  const configDir = join(configBase, 'sideby')
  return {
    home,
    configDir,
    stateDir: join(stateBase, 'sideby'),
    configFile: join(configDir, 'config.json'),
    userPluginsDir: join(configDir, 'plugins'),
  }
}

/** Expands a leading `~` or `~/`; returns undefined for relative paths so callers can reject them. */
export function expandUserPath(p: string, home: string): string | undefined {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return isAbsolute(p) ? p : undefined
}

/** Replaces the HOME prefix with `~` for user-facing output. */
export function tildify(p: string, home: string): string {
  if (p === home) return '~'
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

function absOr(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback
}
