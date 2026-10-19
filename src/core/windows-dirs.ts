// Windows' own folders as WSL sees them (spec §3.24, §3.28): one `cmd.exe` call names the current Windows user's
// `%LOCALAPPDATA%` and the Program Files folders, so sideby never guesses between the users under `C:\Users`.
import { join } from 'node:path'

export interface WindowsDir {
  win: string
  unix: string
}

export interface WindowsDirs {
  localAppData?: WindowsDir
  programs: WindowsDir[]
}

export type WindowsExec = (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>

/** A Windows drive path (`C:\Windows`) as WSL mounts it (`/mnt/c/Windows`); undefined for anything else. */
export function toUnix(win: string, mount: string): string | undefined {
  const m = /^([A-Za-z]):\\(.*)$/.exec(win.trim())
  if (!m) return undefined
  return join(mount, (m[1] as string).toLowerCase(), ...(m[2] as string).split('\\').filter(Boolean))
}

const memo = new Map<string, WindowsDirs>()

/**
 * The current Windows user's folders, from one `cmd.exe` call, remembered for the process; null when cmd.exe does not
 * answer (WSL interop off, or no C: drive), for the caller to fall back without guessing between users.
 */
export async function askWindowsDirs(exec: WindowsExec, mount: string): Promise<WindowsDirs | null> {
  const hit = memo.get(mount)
  if (hit) return hit
  const r = await exec(join(mount, 'c', 'Windows', 'System32', 'cmd.exe'), [
    '/d',
    '/c',
    'echo %LOCALAPPDATA%^|%ProgramFiles%^|%ProgramFiles(x86)%',
  ]).catch(() => null)
  const parts = r?.code === 0 ? r.stdout.trim().split('|') : []
  const dir = (win: string | undefined) => {
    const unix = win ? toUnix(win, mount) : undefined
    return win && unix ? { win: win.trim(), unix } : undefined
  }
  const local = dir(parts[0])
  if (!local) return null
  const found: WindowsDirs = {
    localAppData: local,
    programs: [dir(parts[1]), dir(parts[2])].filter((d) => d !== undefined),
  }
  memo.set(mount, found)
  return found
}
