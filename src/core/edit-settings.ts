// Opens an Account's Host settings file in the user's editor (spec §3.30, ADR-0033). sideby reads none of the file:
// it checks that the file is there and, for a link, where it really is and which Accounts share it. Every program
// it runs goes through `DesktopDeps.exec`, so tests start nothing.
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Runtime } from '../runtime.ts'
import type { FamilyDef } from '../types.ts'
import { depsFor } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { lstatOrNull } from './fs-safe.ts'

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
}

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
  opts: { open?: boolean } = {},
): Promise<EditSettingsResult> {
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
  return { ...base, opened: true, command: await openWithDefault(rt, real) }
}

/** Opens `file` with the system's default program; returns the command, or throws what to do instead. */
async function openWithDefault(rt: Runtime, file: string): Promise<string[]> {
  const deps = depsFor(rt)
  const yourself = `open ${file} in your editor yourself`
  if (deps.platform === 'darwin') {
    const r = await deps.exec('/usr/bin/open', ['-t', file])
    if (r.code !== 0)
      throw new UserError(`macOS could not open the file; ${yourself}`, { code: 'open-failed' })
    return ['/usr/bin/open', '-t', file]
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
