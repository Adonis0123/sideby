// The shell functions `sideby shell-init` prints, and the optional files (config `shellInitFile`) sideby keeps
// in sync with them whenever it adds an Account or an alias.
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Account } from '../types.ts'
import { ALIAS_NAME, aliasProblem, RESERVED_ALIASES } from './config.ts'
import { realpathOrNull, statOrNull, writeFileAtomic } from './fs-safe.ts'
import { expandUserPath } from './paths.ts'

export const SHELLS = ['zsh', 'bash'] as const
export type Shell = (typeof SHELLS)[number]

/** First line of every generated script; an existing file without it is never overwritten. */
export const SHELL_INIT_HEADER =
  '# sideby shell-init: one function per account, plus aliases from the sideby config'

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** A Family whose bare Host command `shell-init` routes through `sideby resume` (config `resumeRouting`). */
export interface ResumeRouteFunction {
  family: string
  bin: string
  selectVar: string
}

const SHELL_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A shell `case` pattern for a session id: 36 characters with dashes where a UUID has them. */
const SESSION_ID_GLOB = '????????-????-????-????-????????????'

/**
 * The Host-named function for one routed Family, or null when its names are not safe in a shell (spec §3.15). It
 * starts sideby only when an argument looks like a session id, so a plain Host command costs nothing extra.
 * `function name {` because zsh expands an alias of the same name in `name() {`.
 */
function resumeRouteFunction(r: ResumeRouteFunction): string | null {
  if (!ALIAS_NAME.test(r.bin) || RESERVED_ALIASES.has(r.bin) || !SHELL_VAR.test(r.selectVar)) return null
  const id = SESSION_ID_GLOB
  return [
    `function ${r.bin} { local a; if [ -z "\${${r.selectVar}-}" ]; then for a in "$@"; do case $a in ${id}|--resume=${id})`,
    ` command sideby resume ${quote(r.family)} -- "$@"; return;; esac; done; fi; command ${r.bin} "$@"; }`,
  ].join('')
}

/** The function lines `shell-init` defines and their names, without the header or the reload hook. */
function functionLines(
  accounts: readonly Account[],
  aliases: Readonly<Record<string, unknown>> | undefined,
  routes: readonly ResumeRouteFunction[],
): { lines: string[]; names: string[] } {
  const lines: string[] = []
  const names: string[] = []
  for (const acc of accounts) {
    const name = `sideby-${acc.family}-${acc.name}`
    lines.push(`${name}() { command sideby run ${quote(acc.ref)} -- "$@"; }`)
    names.push(name)
  }
  // An alias function runs the alias itself, so `sideby run` reads its Account and arguments from the config.
  // `function name {`: zsh expands a shell alias of the same name in `name() {` and rejects the whole script, so a
  // user's own `alias cc=…` would leave every function undefined. With this form their alias still wins.
  for (const alias of Object.keys(aliases ?? {}))
    if (!aliasProblem(alias)) {
      lines.push(`function ${alias} { command sideby run ${quote(alias)} -- "$@"; }`)
      names.push(alias)
    }
  // An Alias with the Host's name wins: it already starts a chosen Account.
  for (const r of routes) {
    const fn = aliases && Object.hasOwn(aliases, r.bin) ? null : resumeRouteFunction(r)
    if (fn) {
      lines.push(fn)
      names.push(r.bin)
    }
  }
  return { lines, names }
}

/**
 * A short hash of the functions `shell-init` defines for these inputs. sideby writes it to the Shell Init Stamp
 * whenever the short commands change, and a terminal whose script carries another one reloads (spec §3.13).
 */
export function shellInitGeneration(
  accounts: readonly Account[],
  aliases: Readonly<Record<string, unknown>> | undefined,
  routes: readonly ResumeRouteFunction[] = [],
): string {
  const { lines } = functionLines(accounts, aliases, routes)
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12)
}

/** Where a terminal looks for the Shell Init Stamp, and which shell it is. */
export interface ShellInitReload {
  shell: Shell
  stampFile: string
}

/**
 * The reload hook: before each prompt the shell reads the stamp with a builtin (no process starts) and, only when it
 * holds a generation this terminal has not loaded, drops the functions it defined and evaluates `sideby shell-init`
 * again. `__sideby_seen` keeps a stamp that matches no script (a config edited by hand) to one reload.
 */
function reloadHook(r: ShellInitReload, gen: string, names: readonly string[]): string[] {
  const hook =
    r.shell === 'zsh'
      ? 'autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __sideby_reload'
      : `case ";\${PROMPT_COMMAND-};" in *";__sideby_reload;"*) ;; *) PROMPT_COMMAND="__sideby_reload\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac`
  return [
    `__sideby_gen=${quote(gen)}; __sideby_seen=${quote(gen)}; __sideby_fns=${quote(names.join(' '))}`,
    [
      `__sideby_reload() { local g f; { read -r g < ${quote(r.stampFile)}; } 2>/dev/null || return 0;`,
      ` [ -z "$g" ] || [ "$g" = "$__sideby_gen" ] || [ "$g" = "$__sideby_seen" ] && return 0;`,
      ` __sideby_seen=$g; for f in ${r.shell === 'zsh' ? `\${=__sideby_fns}` : '$__sideby_fns'}; do unset -f "$f" 2>/dev/null; done;`,
      ` eval "$(command sideby shell-init ${r.shell} 2>/dev/null)"; __sideby_seen=$g; }`,
    ].join(''),
    hook,
  ]
}

/**
 * The script for one shell, ending in a newline: exactly what `sideby shell-init <shell>` prints. zsh and bash
 * read the same function syntax; with `reload` the script also carries that shell's reload hook.
 */
export function shellInitScript(
  accounts: readonly Account[],
  aliases: Readonly<Record<string, unknown>> | undefined,
  routes: readonly ResumeRouteFunction[] = [],
  reload?: ShellInitReload,
): string {
  const { lines, names } = functionLines(accounts, aliases, routes)
  const out = [SHELL_INIT_HEADER, ...lines]
  if (reload) out.push(...reloadHook(reload, shellInitGeneration(accounts, aliases, routes), names))
  return `${out.join('\n')}\n`
}

/** The Shell Init Stamp: one line, the generation of the short commands sideby wrote last. */
export const shellInitStampFile = (stateDir: string) => join(stateDir, 'shell-init.stamp')

/** Writes the Shell Init Stamp atomically (mode 644): the generation every open terminal compares with its own. */
export async function writeShellInitStamp(stampFile: string, gen: string): Promise<void> {
  await mkdir(dirname(stampFile), { recursive: true })
  const current = await readFile(stampFile, 'utf8').catch(() => null)
  if (current === `${gen}\n`) return
  await writeFileAtomic(stampFile, `${gen}\n`, 0o644)
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
