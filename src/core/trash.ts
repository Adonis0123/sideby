import { realpath, rename } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Env } from '../types.ts'
import { lstatOrNull, ownedFolder } from './fs-safe.ts'

export type TrashResult = { ok: true; to: string } | { ok: false; why: string }

export type Trash = (path: string) => Promise<TrashResult>

export function systemTrash(
  env: Env,
  stateDir: string,
  now: () => Date,
  folder: readonly string[] = ['trash'],
): Trash {
  return async (path) => {
    const own = await Promise.all([
      realpath(env.HOME ?? '').catch(() => ''),
      realpath(userHome()).catch(() => ''),
    ])
    if (own[0] && own[0] === own[1]) {
      const { which } = await import('./launch.ts')
      const bin = await which('trash', env)
      if (bin) {
        const { execFile } = await import('node:child_process')
        const ok = await new Promise<boolean>((resolve) =>
          execFile(bin, [path], { env: env as NodeJS.ProcessEnv, timeout: 30_000 }, (err) => resolve(!err)),
        )
        if (ok && !(await lstatOrNull(path))) return { ok: true, to: 'the trash' }
      }
    }
    return keepInState(path, stateDir, now(), folder)
  }
}

function userHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return ''
  }
}

export async function keepInState(
  path: string,
  stateDir: string,
  at: Date,
  folder: readonly string[] = ['trash'],
): Promise<TrashResult> {
  try {
    const dir = await ownedFolder(stateDir, folder, { create: true, private: true })
    if (!dir) return { ok: false, why: "sideby's state folder cannot be used" }
    const stamp = at.toISOString().replace(/[:.]/g, '-')
    const parts = path.split(/[\\/]+/).filter(Boolean)
    const label = parts
      .slice(-4)
      .join('_')
      .replace(/[^A-Za-z0-9._-]/g, '-')
    const to = join(dir, `${stamp}-${label}`)
    await rename(path, to)
    return { ok: true, to }
  } catch (err) {
    return {
      ok: false,
      why: `${path} could not be moved (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    }
  }
}
