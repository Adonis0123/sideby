// App Profiles (spec §3.20 "Grok Bot 窗口", ADR-0019): named windows of a desktop app that signs in apart from every
// Account, each with its own App Data under ~/Library/Application Support/sideby/<app>/<name>/. Opening and focusing
// work as for a Family's Desktop App (core/desktop-app.ts); every program still goes through `DesktopDeps.exec`.
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PROFILE_APPS, type ProfileAppDef } from '../families/desktop.ts'
import type { Runtime } from '../runtime.ts'
import { ACCOUNT_NAME } from './account-name.ts'
import {
  activate,
  cleanEnv,
  type DesktopDeps,
  type DesktopOpenResult,
  depsFor,
  type FoundApp,
  findApp,
  instanceOf,
  mainArgs,
  notInstalled,
  notMac,
  type Proc,
  processes,
} from './desktop-app.ts'
import { UserError } from './errors.ts'
import { lstatOrNull } from './fs-safe.ts'

export interface AppProfileStatus {
  /** `grok-bot:<name>`; the Main Profile is `grok-bot:main`. */
  ref: string
  /** The app as messages name it, for example `Grok Bot`. */
  app: string
  name: string
  isMain: boolean
  /** The Profile's app data folder; absent for the Main Profile, which uses the app's default. */
  appData?: string
  installed: boolean
  /** That Profile's own window runs now. */
  running: boolean
  /** What the app last wrote about its sign-in; absent when unknown. */
  signedIn?: boolean
}

export interface AppProfileRemoveResult {
  ref: string
  app: string
  appData: string
  /** False when only the plan was shown (no `--yes`). */
  removed: boolean
}

const MAIN = 'main'

/** The app and Profile name a ref names, or undefined when it is not an App Profile ref. */
export function parseProfileRef(ref: string): { def: ProfileAppDef; name: string } | undefined {
  for (const def of PROFILE_APPS) {
    if (ref === def.id) return { def, name: MAIN }
    if (ref.startsWith(`${def.id}:`)) return { def, name: ref.slice(def.id.length + 1) }
  }
  return undefined
}

/** Where the App Profiles of an app live: `~/Library/Application Support/sideby/<app>`. */
export function profilesRoot(home: string, def: ProfileAppDef): string {
  return join(home, 'Library', 'Application Support', 'sideby', def.id)
}

function appDataOf(home: string, def: ProfileAppDef, name: string): string | null {
  return name === MAIN ? null : join(profilesRoot(home, def), name)
}

/** `signedIn` from the app's own status file: a boolean next to a version, a pid and a start time, not a credential. */
async function signedIn(file: string): Promise<boolean | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(file, 'utf8'))
    const s = v && typeof v === 'object' ? (v as Record<string, unknown>).signedIn : undefined
    return typeof s === 'boolean' ? s : undefined
  } catch {
    return undefined
  }
}

/** Profile names: the real folders under the app's root with a valid name, sorted. Links and files are skipped. */
async function profileNames(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries)
    if (e !== MAIN && ACCOUNT_NAME.test(e) && (await lstatOrNull(join(root, e)))?.isDirectory()) out.push(e)
  return out.sort()
}

function checkName(def: ProfileAppDef, name: string): void {
  if (name !== MAIN && !ACCOUNT_NAME.test(name))
    throw new UserError(
      `"${name}" is not a valid ${def.title} window name; use lowercase letters, digits and dashes, starting with a letter or digit (for example \`sideby desktop ${def.id}:work\`)`,
      { code: 'invalid-name' },
    )
}

/**
 * Every App Profile with its state, for `sideby list` and the Panel: only on macOS, and per app only when it is
 * installed or has Profiles. The Main Profile first. Never throws.
 */
export async function listAppProfiles(rt: Runtime): Promise<AppProfileStatus[]> {
  const deps = depsFor(rt)
  if (deps.platform !== 'darwin') return []
  const home = rt.paths.home
  const out: AppProfileStatus[] = []
  try {
    let procs: Proc[] | null = null
    for (const def of PROFILE_APPS) {
      const app = await findApp(def, deps)
      const names = await profileNames(profilesRoot(home, def))
      if (!app && !names.length) continue
      if (app && !procs) procs = (await processes(deps)) ?? []
      for (const name of [MAIN, ...names]) {
        const appData = appDataOf(home, def, name)
        const status = join(appData ?? join(home, def.mainUserData), def.statusFile)
        const s = await signedIn(status)
        out.push({
          ref: `${def.id}:${name}`,
          app: def.title,
          name,
          isMain: name === MAIN,
          ...(appData ? { appData } : {}),
          installed: app !== null,
          running: app ? Boolean(instanceOf(app, appData, procs ?? [])) : false,
          ...(s === undefined ? {} : { signedIn: s }),
        })
      }
    }
  } catch {
    // A display nicety: a failure shows no Profiles.
  }
  return out
}

async function located(
  rt: Runtime,
  ref: string,
): Promise<{ deps: DesktopDeps; def: ProfileAppDef; name: string; app: FoundApp; appData: string | null }> {
  const parsed = parseProfileRef(ref)
  if (!parsed) throw new UserError(`${ref} is not an app window; use \`sideby desktop grok-bot:<name>\``)
  const { def, name } = parsed
  checkName(def, name)
  const deps = depsFor(rt)
  if (deps.platform !== 'darwin') throw notMac(deps.platform)
  const app = await findApp(def, deps, { spotlight: true })
  if (!app) throw notInstalled(def, deps)
  return { deps, def, name, app, appData: appDataOf(rt.paths.home, def, name) }
}

/**
 * Opens an App Profile's window, creating its folder first when it is new, or brings its running window to the front.
 * Never starts a second window for the same Profile and never ends a process.
 */
export async function openAppProfile(rt: Runtime, ref: string): Promise<DesktopOpenResult> {
  const { deps, def, name, app, appData } = await located(rt, ref)
  const listed = await processes(deps)
  const procs = listed ?? []
  const base = {
    ref: `${def.id}:${name}`,
    family: def.id,
    app: def.title,
    appPath: app.path,
    ...(appData ? { appData } : {}),
    createdAppData: false,
    linked: [] as string[],
    notices: [] as string[],
  }
  const running = instanceOf(app, appData, procs)
  if (running) {
    const focused = await activate(deps, running.pid)
    return {
      ...base,
      action: focused ? 'focused' : 'already-running',
      notices: focused
        ? []
        : [
            `${def.title} is already open as ${base.ref}; switch to it from the Dock (sideby does not start a second one)`,
          ],
    }
  }

  let created = false
  const notices: string[] = []
  if (appData) {
    const st = await lstatOrNull(appData)
    if (st && !st.isDirectory())
      throw new UserError(
        `${appData} is not a folder; move it away, then try again (sideby keeps the ${def.title} window ${base.ref} there)`,
        { code: 'app-data-invalid' },
      )
    if (!st) {
      await mkdir(appData, { recursive: true, mode: 0o700 })
      await chmod(appData, 0o700)
      created = true
    }
    if (created || !(await readdir(appData)).length) {
      const others = procs.some((p) => mainArgs(app, p) !== null)
      notices.push(
        `New ${def.title} window ${base.ref}: sign in inside it with the account you want for this window.${others ? ` Close the other ${def.title} windows while you sign in, because the browser may send the sign-in back to one of them.` : ''}`,
      )
    }
  }

  // As for a Desktop App: `-n` also for the Main Profile, unless a running one cannot be ruled out.
  const args = appData ? def.openArgs(app.path, appData) : listed ? ['-n', '-a', app.path] : ['-a', app.path]
  const r = await deps.exec('/usr/bin/open', args, cleanEnv(rt.env, def.clearVars))
  if (r.code !== 0)
    throw new UserError(
      `could not open ${def.title} as ${base.ref}: ${r.stderr.trim() || `open exited with ${r.code}`}; try opening ${app.path} once by hand, then try again`,
      { code: 'open-failed' },
    )
  return { ...base, action: 'started', createdAppData: created, command: ['/usr/bin/open', ...args], notices }
}

/**
 * Removes a non-main App Profile's folder, which signs that window out and deletes its local data. Without `yes` it
 * only returns what would go. Refuses the Main Profile, a running window, a missing folder and anything that is not a
 * real folder inside sideby's own; never follows a link.
 */
export async function removeAppProfile(
  rt: Runtime,
  ref: string,
  opts: { yes: boolean },
): Promise<AppProfileRemoveResult> {
  const parsed = parseProfileRef(ref)
  if (!parsed)
    throw new UserError(`${ref} is not an app window; use \`sideby desktop grok-bot:<name> --remove\``)
  const { def, name } = parsed
  checkName(def, name)
  const full = `${def.id}:${name}`
  if (name === MAIN)
    throw new UserError(
      `${full} is ${def.title}'s own data, which sideby does not remove; sign out inside ${def.title} instead`,
      { code: 'main-profile' },
    )
  const deps = depsFor(rt)
  if (deps.platform !== 'darwin') throw notMac(deps.platform)
  const appData = appDataOf(rt.paths.home, def, name)!
  const st = await lstatOrNull(appData)
  if (!st)
    throw new UserError(`there is no ${def.title} window ${full}; \`sideby list\` shows the ones there are`, {
      code: 'no-profile',
    })
  if (!st.isDirectory())
    throw new UserError(`${appData} is not a folder sideby made; it was left alone, move it away by hand`, {
      code: 'app-data-invalid',
    })
  const app = await findApp(def, deps, { spotlight: true })
  // Without a process list an open window cannot be ruled out, and deleting under a running app breaks it.
  const procs = app ? await processes(deps) : []
  if (procs === null || (app && instanceOf(app, appData, procs)))
    throw new UserError(
      procs === null
        ? `could not check whether ${def.title} is open as ${full}; quit that window, then try again`
        : `${def.title} is open as ${full}; quit that window first, then remove it`,
      { code: 'app-running' },
    )
  if (!opts.yes) return { ref: full, app: def.title, appData, removed: false }
  await rm(appData, { recursive: true, force: true })
  return { ref: full, app: def.title, appData, removed: true }
}
