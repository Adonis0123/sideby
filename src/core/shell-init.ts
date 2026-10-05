// The shell functions `sideby shell-init` prints, and the optional files (config `shellInitFile`) sideby keeps
// in sync with them whenever it adds an Account or an alias.
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Account } from '../types.ts'
import { aliasProblem } from './config.ts'
import { realpathOrNull, statOrNull, writeFileAtomic } from './fs-safe.ts'
import { expandUserPath } from './paths.ts'

export const SHELLS = ['zsh', 'bash'] as const
export type Shell = (typeof SHELLS)[number]

/** First line of every generated script; an existing file without it is never overwritten. */
export const SHELL_INIT_HEADER =
  '# sideby shell-init: one function per account, plus aliases from the sideby config'

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The script for one shell, ending in a newline: exactly what `sideby shell-init <shell>` prints. zsh and bash
 * read the same function syntax, so the shell only names the file it goes to.
 */
export function shellInitScript(
  accounts: readonly Account[],
  aliases: Readonly<Record<string, string>> | undefined,
): string {
  const lines = [SHELL_INIT_HEADER]
  for (const acc of accounts)
    lines.push(`sideby-${acc.family}-${acc.name}() { command sideby run ${quote(acc.ref)} -- "$@"; }`)
  for (const [alias, ref] of Object.entries(aliases ?? {}))
    if (!aliasProblem(alias)) lines.push(`${alias}() { command sideby run ${quote(ref)} -- "$@"; }`)
  return `${lines.join('\n')}\n`
}

export interface ShellInitWrite {
  shell: Shell
  /** The configured path, as written in the config (`~/…` kept). */
  path: string
  ok: boolean
  /** `written`, or `unchanged` when the file already had this content. */
  action?: 'written' | 'unchanged'
  message?: string
}

/**
 * Writes `content` to the configured file atomically (temp file in the same directory, then rename), keeping its
 * mode (0644 for a new file). Refuses a relative path and an existing file that sideby did not generate, so a
 * mistyped `shellInitFile` can never replace a shell rc file.
 */
export async function writeShellInitFile(
  shell: Shell,
  configured: string,
  home: string,
  content: string,
): Promise<ShellInitWrite> {
  const base = { shell, path: configured }
  const expanded = expandUserPath(configured, home)
  if (!expanded)
    return { ...base, ok: false, message: `shellInitFile.${shell} must be an absolute or ~/ path` }
  try {
    // Follow a link (a dotfiles manager may link the file) and replace the real file.
    const target = (await realpathOrNull(expanded)) ?? expanded
    const st = await statOrNull(target)
    if (st && !st.isFile()) return { ...base, ok: false, message: `${configured} is not a regular file` }
    if (st) {
      const current = await readFile(target, 'utf8')
      if (current === content) return { ...base, ok: true, action: 'unchanged' }
      if (current.trim() && !current.startsWith(SHELL_INIT_HEADER))
        return {
          ...base,
          ok: false,
          message: `${configured} was not written by sideby shell-init; move it aside or point shellInitFile.${shell} at another file`,
        }
    } else await mkdir(dirname(target), { recursive: true })
    await writeFileAtomic(target, content, st ? st.mode & 0o777 : 0o644)
    return { ...base, ok: true, action: 'written' }
  } catch (err) {
    return { ...base, ok: false, message: `cannot write ${configured}: ${(err as Error).message}` }
  }
}
