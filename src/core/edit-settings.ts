// Opens an Account's Host settings file in the user's editor (spec §3.30, ADR-0033). sideby reads none of the file:
// it checks that the file is there and, for a link, where it really is and which Accounts share it. Every program
// it runs goes through `DesktopDeps.exec`, so tests start nothing.
import { access, constants, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Runtime } from '../runtime.ts'
import type { FamilyDef } from '../types.ts'
import { EDITORS, type EditorChoice } from './config.ts'
import { depsFor } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { lstatOrNull } from './fs-safe.ts'
import { which } from './launch.ts'

export interface EditSettingsResult {
  schemaVersion: 1
  ref: string
  family: string
  /** The file as the Family names it, such as `settings.json`. */
  file: string
  /** The file inside the account directory. */
  path: string
  /** Where the file really is, only when `path` is a link. */
  target?: string
  /** Other Accounts of the Family whose settings file is this same file. */
  sharedWith: string[]
  /** False with `--path`, which only says where the file is. */
  opened: boolean
  /** The program and arguments that opened it. */
  command?: string[]
  /** What opened it: `system` (the default program) or the editor from config `editor` or `--with`. */
  editor?: EditorChoice
}

/**
 * How sideby starts each editor (ADR-0033 amendment): on macOS the command line inside its app bundle, then the
 * command on PATH, then `open -a <app>`; elsewhere the command on PATH, then the system's default program.
 */
export const EDITOR_APPS: Record<
  Exclude<EditorChoice, 'system'>,
  {
    title: string
    app: string
    command: string
    bundled: string
    /** The command line's arguments; without it just the file. */
    args?: (file: string) => string[]
  }
> = {
  // Cursor 3.x opens a lone file in its Agent Window and shows nothing of it; `--classic` with the file's folder
  // opens a classic editor window on that file.
  cursor: {
    title: 'Cursor',
    app: 'Cursor',
    command: 'cursor',
    bundled: 'Contents/Resources/app/bin/cursor',
    args: (file) => ['--classic', dirname(file), file],
  },
  vscode: {
    title: 'VS Code',
    app: 'Visual Studio Code',
    command: 'code',
    bundled: 'Contents/Resources/app/bin/code',
  },
  windsurf: {
    title: 'Windsurf',
    app: 'Windsurf',
    command: 'windsurf',
    bundled: 'Contents/Resources/app/bin/windsurf',
  },
  zed: { title: 'Zed', app: 'Zed', command: 'zed', bundled: 'Contents/MacOS/cli' },
}

export const isEditor = (v: unknown): v is EditorChoice =>
  typeof v === 'string' && (EDITORS as readonly string[]).includes(v)

/** The Family's settings file when it names a relative path that stays inside the account directory. */
export function hostSettingsFile(def: Pick<FamilyDef, 'settingsFile'> | undefined): string | undefined {
  const f = def?.settingsFile
  if (typeof f !== 'string' || !f || isAbsolute(f) || f.split(/[\\/]/).includes('..')) return undefined
  return f
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

export async function editSettings(
  rt: Runtime,
  ref: string,
  /** `editor` is a one-off choice (`--with`); without it config `editor`, else `system`. */
  opts: { open?: boolean; editor?: EditorChoice } = {},
): Promise<EditSettingsResult> {
  if (opts.editor !== undefined && !isEditor(opts.editor))
    throw new UserError(`the editor must be one of ${EDITORS.join(', ')}`, { code: 'bad-editor' })
  const account = await rt.resolve(ref)
  const def = rt.families.get(account.family)
  const file = hostSettingsFile(def)
  if (!file)
    throw new UserError(
      `${account.ref}: ${def?.title ?? account.family} names no settings file; its folder is ${account.dir}`,
      { code: 'no-settings-file' },
    )
  const path = join(account.dir, file)
  const real = await realOrNull(path)
  if (!real) {
    const link = await lstatOrNull(path)
    throw new UserError(
      link?.isSymbolicLink()
        ? `${path} links to a file that is not there; run \`sideby doctor ${account.ref}\` to see what it should point to`
        : `${account.ref} has no ${file} yet (${path}); \`sideby doctor ${account.ref} --fix\` links the main account's when they share it, or create the file in your editor`,
      { code: 'settings-missing' },
    )
  }
  const sharedWith: string[] = []
  for (const other of await rt.accounts()) {
    if (other.family !== account.family || other.ref === account.ref) continue
    if ((await realOrNull(join(other.dir, file))) === real) sharedWith.push(other.ref)
  }
  const base = {
    schemaVersion: 1 as const,
    ref: account.ref,
    family: account.family,
    file,
    path,
    ...(real !== path && (await lstatOrNull(path))?.isSymbolicLink() ? { target: real } : {}),
    sharedWith,
  }
  if (opts.open === false) return { ...base, opened: false }
  const configured = rt.config.editor
  const editor = opts.editor ?? (isEditor(configured) ? configured : 'system')
  const command = await openWithEditor(rt, real, editor)
  // On Linux and WSL an editor that is not on PATH falls back to the default program: say so.
  const fellBack = command[0] === 'xdg-open' || command[0]?.endsWith('/cmd.exe')
  return { ...base, opened: true, command, editor: fellBack ? 'system' : editor }
}

const executable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

/**
 * Opens `file` with `editor` (ADR-0033 amendment); `system` is `openWithDefault`. Each way is tried in turn until one
 * exits 0: on macOS the editor's own command line in its app bundle (in `DesktopDeps.appDirs`), then the command on
 * PATH, then `open -a <app> <file>`; elsewhere the command on PATH, then the system's default program. Returns the
 * command that opened it, or throws what to do instead.
 */
export async function openWithEditor(rt: Runtime, file: string, editor: EditorChoice): Promise<string[]> {
  if (editor === 'system') return openWithDefault(rt, file)
  const e = EDITOR_APPS[editor]
  const deps = depsFor(rt)
  const tries: string[] = []
  if (deps.platform === 'darwin')
    for (const dir of deps.appDirs) {
      const cli = join(dir, `${e.app}.app`, e.bundled)
      if (await executable(cli)) tries.push(cli)
    }
  const onPath = await which(e.command, rt.env)
  if (onPath && !tries.includes(onPath)) tries.push(onPath)
  const cliArgs = e.args ? e.args(file) : [file]
  for (const cmd of tries) if ((await deps.exec(cmd, cliArgs)).code === 0) return [cmd, ...cliArgs]
  if (deps.platform === 'darwin') {
    const args = ['-a', e.app, file]
    if ((await deps.exec('/usr/bin/open', args)).code === 0) return ['/usr/bin/open', ...args]
    throw new UserError(
      `${e.title} could not open the file; install ${e.title}, choose another editor (\`sideby config set editor system\`), or open ${file} yourself`,
      { code: 'open-failed' },
    )
  }
  return openWithDefault(rt, file)
}

/**
 * Opens `file` with the system's default program (on macOS its default text editor, unless `text` is false);
 * returns the command, or throws what to do instead.
 */
export async function openWithDefault(
  rt: Runtime,
  file: string,
  opts: { text?: boolean } = {},
): Promise<string[]> {
  const deps = depsFor(rt)
  const text = opts.text !== false
  const yourself = text ? `open ${file} in your editor yourself` : `open ${file} in your browser yourself`
  if (deps.platform === 'darwin') {
    const args = text ? ['-t', file] : [file]
    const r = await deps.exec('/usr/bin/open', args)
    if (r.code !== 0)
      throw new UserError(`macOS could not open the file; ${yourself}`, { code: 'open-failed' })
    return ['/usr/bin/open', ...args]
  }
  if (deps.platform === 'linux' && deps.wslMount) {
    const w = await deps.exec('wslpath', ['-w', file])
    const win = w.stdout.trim()
    if (w.code !== 0 || !win)
      throw new UserError(`wslpath could not name the file for Windows; ${yourself}`, { code: 'open-failed' })
    // `start` hands the file to its Windows default program; explorer.exe opens one only now and then. cmd reads
    // these characters itself, so a path with one is left to the user.
    if (/[&|<>^%"]/.test(win))
      throw new UserError(`the path has a character cmd.exe reads itself; ${yourself}`, {
        code: 'open-failed',
      })
    const cmd = `${deps.wslMount}/c/Windows/System32/cmd.exe`
    const args = ['/c', 'start', '', win]
    const r = await deps.exec(cmd, args)
    if (r.code !== 0)
      throw new UserError(`Windows could not open the file; ${yourself}`, { code: 'open-failed' })
    return [cmd, ...args]
  }
  if (deps.platform === 'linux') {
    const r = await deps.exec('xdg-open', [file])
    if (r.code !== 0)
      throw new UserError(`xdg-open could not open the file; install xdg-utils, or ${yourself}`, {
        code: 'open-failed',
      })
    return ['xdg-open', file]
  }
  throw new UserError(`sideby cannot open files on ${deps.platform} yet; ${yourself}`, {
    code: 'open-failed',
  })
}
