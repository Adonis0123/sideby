// `sideby shell-init setup` (spec §3.13, ADR-0036): adds the one line that loads sideby's short commands to the
// user's shell rc file, after a preview, the way mise, Starship and zoxide ask users to add theirs; `--undo` takes out
// exactly what it added.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Env } from '../types.ts'
import { UserError } from './errors.ts'
import { lstatOrNull, realpathOrNull, sha256, statOrNull, writeIfUnchanged } from './fs-safe.ts'
import { SHELLS, type Shell } from './shell-init.ts'

const START = '# >>> sideby shell-init >>>'
const END = '# <<< sideby shell-init <<<'

/** The block setup appends; `--undo` removes only this exact text. */
export const setupBlock = (shell: Shell) =>
  `${START}\n# Short commands such as cc and cc008. Remove with: sideby shell-init setup --undo\neval "$(sideby shell-init ${shell})"\n${END}\n`

/** The user's shell, from `$SHELL`; zsh when it is neither zsh nor bash (the macOS default). */
export function userShell(env: Env): Shell {
  const name = basename(env.SHELL ?? '')
  return (SHELLS as readonly string[]).includes(name) ? (name as Shell) : 'zsh'
}

/** The rc file an interactive shell reads: `$ZDOTDIR/.zshrc` (else `~/.zshrc`), or `~/.bashrc`. */
export const rcFile = (shell: Shell, home: string, env: Env) =>
  shell === 'zsh' ? join(env.ZDOTDIR || home, '.zshrc') : join(home, '.bashrc')

export interface ShellSetupStatus {
  shell: Shell
  /** The rc file, as found (a link is not followed here). */
  rc: string
  /**
   * Whether new terminals load the short commands: the rc file names `sideby shell-init`, or the config has a
   * `shellInitFile` for this shell (the user sources it themselves).
   */
  loaded: boolean
  /** Set when sideby's own block is in the rc file, so `--undo` can take it out. */
  added: boolean
}

export async function shellSetupStatus(
  shell: Shell,
  home: string,
  env: Env,
  shellInitFile: Partial<Record<Shell, string>> | undefined,
): Promise<ShellSetupStatus> {
  const rc = rcFile(shell, home, env)
  const text = await readFile(rc, 'utf8').catch(() => '')
  return {
    shell,
    rc,
    loaded: text.includes('sideby shell-init') || Boolean(shellInitFile?.[shell]),
    added: text.includes(setupBlock(shell)),
  }
}

export type ShellSetupResult =
  | { status: 'added' | 'removed'; shell: Shell; rc: string; target: string }
  | { status: 'unchanged'; shell: Shell; rc: string; reason: 'already-loaded' | 'not-added' }

/**
 * Appends the block to the rc file (`undo`: removes it). A link is written at its real target, never replaced; a
 * missing file is created (mode 644); every other line stays as it was; nothing is written when the file changed
 * while sideby read it. Refuses a path that exists but is not a regular file.
 */
export async function applyShellSetup(
  shell: Shell,
  home: string,
  env: Env,
  shellInitFile: Partial<Record<Shell, string>> | undefined,
  opts: { undo?: boolean } = {},
): Promise<ShellSetupResult> {
  const st = await shellSetupStatus(shell, home, env, shellInitFile)
  const block = setupBlock(shell)
  if (opts.undo ? !st.added : st.loaded)
    return { status: 'unchanged', shell, rc: st.rc, reason: opts.undo ? 'not-added' : 'already-loaded' }
  const target = (await lstatOrNull(st.rc))?.isSymbolicLink()
    ? ((await realpathOrNull(st.rc)) ?? st.rc)
    : st.rc
  const info = await statOrNull(target)
  if (info && !info.isFile())
    throw new UserError(`${st.rc} is not a regular file; add the line yourself: ${block}`)
  const before = info ? await readFile(target, 'utf8') : null
  const after = opts.undo
    ? before!.replace(`\n${block}`, '').replace(block, '')
    : `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}`
  const ok = await writeIfUnchanged(
    target,
    before === null ? null : sha256(before),
    after,
    info ? info.mode & 0o777 : 0o644,
  )
  if (!ok) throw new UserError(`${st.rc} changed while sideby was writing it; nothing was changed. Try again`)
  return { status: opts.undo ? 'removed' : 'added', shell, rc: st.rc, target }
}
