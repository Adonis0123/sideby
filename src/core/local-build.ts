// Switching the global `sideby` between a Local Build and the npm package (ADR-0024). `pnpm local` builds and calls
// these; `sideby local` and the Panel's version popover switch between the newest Local Build and npm without the
// checkout. Only an npm global install is handled: `<prefix>/lib/node_modules/sideby` is the folder every caller
// resolves, a link to `<dev>/pkg` while a Local Build runs.
import { lstat, mkdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { Env } from '../types.ts'
import type { Paths } from './paths.ts'
import {
  compareVersions,
  fetchLatest,
  restartPanelByName,
  runProgram,
  startDetached,
  takeInstallLock,
} from './update.ts'
import { type LocalBuild, parseLocalBuild } from './version.ts'

const BIN = 'dist/src/cli/main.js'

export interface LocalDirs {
  /** `$XDG_DATA_HOME/sideby-dev`: `pkg` (the running build), `old/<id>`, `npm` (the package it replaced). */
  dev: string
  /** npm's global prefix: `<prefix>/lib/node_modules/sideby` and `<prefix>/bin/sideby`. */
  prefix: string
}

export const pkgDir = (d: LocalDirs) => join(d.dev, 'pkg')
export const globalPkg = (d: LocalDirs) => join(d.prefix, 'lib', 'node_modules', 'sideby')
const globalBin = (d: LocalDirs) => join(d.prefix, 'bin', 'sideby')

export const devDir = (env: Env) =>
  join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'sideby-dev')

/** Where the switch works, with npm's global prefix from `npm prefix -g`; null when npm cannot be asked. */
export async function localDirs(env: Env): Promise<LocalDirs | null> {
  const r = await runProgram('npm', ['prefix', '-g'], { env }).catch(() => null)
  const prefix = r && r.code === 0 ? r.output.trim().split('\n').at(-1)?.trim() : ''
  return prefix ? { dev: devDir(env), prefix } : null
}

export async function kind(p: string): Promise<'link' | 'dir' | 'file' | null> {
  try {
    const s = await lstat(p)
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

/**
 * Points the global npm package at `pkg`. A real npm install moves to `<dev>/npm` first, so going back needs no
 * network; a link elsewhere (npm link) is replaced. Returns what it did, for the summary.
 */
export async function linkGlobal(d: LocalDirs): Promise<string> {
  const target = globalPkg(d)
  const pkg = pkgDir(d)
  let did = 'the global sideby already runs the local build'
  const k = await kind(target)
  if (k !== 'link' || (await readlink(target)) !== pkg) {
    if (k === 'dir') {
      await rm(join(d.dev, 'npm'), { recursive: true, force: true })
      await rename(target, join(d.dev, 'npm'))
      did = `the npm package moved to ${join(d.dev, 'npm')}; the global sideby now runs the local build`
    } else {
      if (k) await rm(target, { force: true })
      did = 'the global sideby now runs the local build'
    }
    await mkdir(dirname(target), { recursive: true })
    await symlink(pkg, target, 'dir')
  }
  const bin = globalBin(d)
  const want = relative(dirname(bin), join(target, BIN))
  if ((await kind(bin)) !== 'link' || (await readlink(bin)) !== want) {
    await rm(bin, { force: true })
    await mkdir(dirname(bin), { recursive: true })
    await symlink(want, bin)
  }
  return did
}

/** Undoes linkGlobal: the npm package it moved comes back; false when there is none to restore (install it). */
export async function unlinkGlobal(d: LocalDirs): Promise<boolean> {
  const target = globalPkg(d)
  if ((await kind(target)) === 'link') await rm(target, { force: true })
  else if (await kind(target)) return true // a real package is already there
  if (!(await kind(join(d.dev, 'npm')))) return false
  await rename(join(d.dev, 'npm'), target)
  return true
}

async function versionOf(dir: string): Promise<string | null> {
  try {
    const v = (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** The version of the npm package kept aside by linkGlobal, or null when none was kept or it cannot be read. */
export const keptVersion = (d: LocalDirs) => versionOf(join(d.dev, 'npm'))

/**
 * Going back to npm: put the kept package back when it is the newest published one (or the registry cannot be
 * asked), else install `latest`. After a release the kept copy is the version before it.
 */
export function offPlan(kept: string | null, latest: string | null): 'restore' | 'install' {
  if (!kept) return 'install'
  if (!latest) return 'restore'
  return (compareVersions(kept, latest) ?? -1) >= 0 ? 'restore' : 'install'
}

export interface LocalStatus {
  /** What the global `sideby` runs: the Local Build in `pkg`, an npm package, or neither (not installed, a link elsewhere). */
  running: 'local' | 'npm' | null
  /** The newest Local Build, the one `on` switches to; null when `pnpm local` never ran here. */
  local: (LocalBuild & { version: string }) | null
  /** The npm package kept aside while a Local Build runs; null when none is. */
  kept: string | null
}

export async function localStatus(d: LocalDirs): Promise<LocalStatus> {
  const k = await kind(globalPkg(d))
  const running =
    k === 'link'
      ? (await readlink(globalPkg(d))) === pkgDir(d)
        ? 'local'
        : null
      : k === 'dir'
        ? 'npm'
        : null
  let local: LocalStatus['local'] = null
  try {
    const b = parseLocalBuild(JSON.parse(await readFile(join(pkgDir(d), 'dist', 'build.json'), 'utf8')))
    const version = await versionOf(pkgDir(d))
    if (b && version) local = { ...b, version }
  } catch {
    // no Local Build here
  }
  return { running, local, kept: await keptVersion(d) }
}

export type LocalTarget = 'local' | 'npm'

/** Why `to` cannot run from this status, or null when it can. Every reason says what to do. */
export function switchBlocker(s: LocalStatus, to: LocalTarget): string | null {
  if (s.running === null)
    return 'the global sideby is not an npm global install; switching supports `npm install -g sideby` only'
  if (to === 'local' && !s.local)
    return 'there is no local build yet; run `pnpm local` in the sideby checkout'
  return null
}

export interface SwitchResult {
  ok: boolean
  message: string
  /** What the global `sideby` runs afterwards. */
  running: LocalStatus['running']
  /** True when it already ran `to`, and nothing changed. */
  unchanged?: boolean
  restartedPanel: boolean
  /**
   * Back on npm, `sideby update --yes` of the npm code brought the skill agents read to its version (true), or that
   * failed (false); absent for a switch to the Local Build, which has no skill of its own to bring.
   */
  skillSynced?: boolean
  /** With `skillSync: 'background'`: that `sideby update --yes` started on its own and is not waited for. */
  skillSyncStarted?: boolean
  /** Another install held the lock; nothing ran. */
  busy?: boolean
}

/**
 * Puts `to` behind the global `sideby`. `local` links the newest Local Build; `npm` restores the kept package or
 * installs `latest` (a failed install links the Local Build back, so `sideby` never goes missing). Afterwards a
 * background Panel on `panelPort` starts again from the new code. One install at a time (the Update lock).
 */
export async function switchLocal(
  paths: Paths,
  d: LocalDirs,
  to: LocalTarget,
  env: Env,
  opts: {
    panelPort?: () => Promise<number | null>
    onOutput?: (text: string) => void
    /**
     * Back on npm, wait for the skill (a terminal shows its progress) or start it on its own: it fetches from the
     * network and can take minutes, longer than a Portal waits for an answer (`background`, the Panel).
     */
    skillSync?: 'wait' | 'background'
  } = {},
): Promise<SwitchResult> {
  const before = await localStatus(d)
  const fail = (message: string, extra: Partial<SwitchResult> = {}): SwitchResult => ({
    ok: false,
    message,
    running: before.running,
    restartedPanel: false,
    ...extra,
  })
  const blocked = switchBlocker(before, to)
  if (blocked) return fail(blocked)
  if (before.running === to)
    return {
      ok: true,
      unchanged: true,
      message:
        to === 'local'
          ? 'the global sideby already runs the local build'
          : 'the global sideby already runs the npm package',
      running: to,
      restartedPanel: false,
    }
  const release = await takeInstallLock(paths)
  if (!release)
    return fail('a sideby update is running; wait for it to finish, then switch again', { busy: true })
  let message: string
  try {
    if (to === 'local') {
      await linkGlobal(d)
      message = `the global sideby runs the local build ${before.local?.commit ?? ''}`.trim()
    } else {
      const latest = await fetchLatest(env).catch(() => null)
      if (offPlan(before.kept, latest) === 'restore') {
        await unlinkGlobal(d)
        message = `the global sideby runs the npm package ${before.kept} again`
      } else {
        const want = latest ?? 'latest'
        await rm(globalPkg(d), { force: true })
        const r = await runProgram('npm', ['install', '-g', `sideby@${want}`], {
          env,
          ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
        })
        if (r.code !== 0) {
          await linkGlobal(d)
          return fail(
            `\`npm install -g sideby@${want}\` failed (exit ${r.code}); the local build stays. Run it yourself to see why`,
          )
        }
        await rm(join(d.dev, 'npm'), { recursive: true, force: true })
        message = `the global sideby runs the npm package ${want}`
      }
    }
  } finally {
    await release().catch(() => {})
  }
  const port = opts.panelPort ? await opts.panelPort().catch(() => null) : null
  const restartedPanel = port !== null && (await restartPanelByName(env, port))
  if (to === 'local') return { ok: true, message, running: to, restartedPanel }
  // The skill is part of the version (spec §3.23): the npm code updates it as `sideby update --yes` does for anyone,
  // by name so the new code runs, after the lock above is free. A failure keeps the switch.
  if (opts.skillSync === 'background')
    return {
      ok: true,
      message,
      running: to,
      restartedPanel,
      skillSyncStarted: await startDetached('sideby', ['update', '--yes'], env),
    }
  const u = await runProgram('sideby', ['update', '--yes'], {
    env,
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
  }).catch(() => ({ code: 1, output: '' }))
  return { ok: true, message, running: to, restartedPanel, skillSynced: u.code === 0 }
}
