// Opens a Family's Desktop App for one Account (spec §3.20, ADR-0015): macOS only, built-in claude and codex only.
// The app bundle is started unchanged with `open`; another Account's instance gets its own App Data folder. Every
// program sideby runs here (`open`, `ps`, `osascript`, `plutil`, `mdfind`) goes through `DesktopDeps.exec`, so
// tests never start a real app.
import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type DesktopAppDef, desktopDef } from '../families/desktop.ts'
import type { LoadedPlugin } from '../plugins/loader.ts'
import type { Runtime } from '../runtime.ts'
import type { Account, CheckResult, Env, FamilyDef, SharedItemDef } from '../types.ts'
import { UserError } from './errors.ts'
import { lstatOrNull, statOrNull } from './fs-safe.ts'
import { checkItem } from './share-modes.ts'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** What opening a Desktop App needs from the machine; tests replace all of it. */
export interface DesktopDeps {
  platform: NodeJS.Platform
  /** Folders searched for the app, in order (normally /Applications and ~/Applications). */
  appDirs: readonly string[]
  /** Runs a program and resolves with its exit code and output; never rejects. */
  exec(cmd: string, args: readonly string[], env?: Env): Promise<ExecResult>
}

const OPEN = '/usr/bin/open'
const PS = '/bin/ps'
const OSASCRIPT = '/usr/bin/osascript'
const PLUTIL = '/usr/bin/plutil'
const MDFIND = '/usr/bin/mdfind'

function defaultExec(cmd: string, args: readonly string[], env?: Env): Promise<ExecResult> {
  return new Promise((resolve) =>
    execFile(
      cmd,
      [...args],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: env as NodeJS.ProcessEnv } : {}) },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    ),
  )
}

const overrides = new WeakMap<object, Partial<DesktopDeps>>()

/**
 * Internal: makes every Desktop App call made with this Runtime use `deps` instead of the machine. Only
 * `createRuntime` calls it, from its `desktop` option, which is the one way to replace the machine (tests).
 */
export function bindDesktopDeps(rt: Runtime, deps: Partial<DesktopDeps>): void {
  overrides.set(rt, deps)
}

function depsFor(rt: Runtime): DesktopDeps {
  const o = overrides.get(rt) ?? {}
  return {
    platform: o.platform ?? process.platform,
    appDirs: o.appDirs ?? ['/Applications', join(rt.paths.home, 'Applications')],
    exec: o.exec ?? defaultExec,
  }
}

/** The Desktop App of a Family, only when a built-in Plugin provides that Family (a plugin may not claim one). */
export function desktopAppOf(plugins: readonly LoadedPlugin[], familyId: string): DesktopAppDef | undefined {
  const builtin = plugins.some((p) => p.source === 'builtin' && p.families.includes(familyId))
  return builtin ? desktopDef(familyId) : undefined
}

/** Where a non-main Account's App Data lives: `~/Library/Application Support/sideby/<family>/<name>`. */
export function appDataDir(home: string, account: Pick<Account, 'family' | 'name'>): string {
  return join(home, 'Library', 'Application Support', 'sideby', account.family, account.name)
}

const plistString = (xml: string, key: string): string | undefined => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m?.[1]
}

/** Reads string keys of an app's Info.plist: XML directly, a binary plist through `plutil`. */
async function bundleInfo(
  deps: DesktopDeps,
  app: string,
): Promise<{ id?: string | undefined; exe?: string | undefined }> {
  const file = join(app, 'Contents', 'Info.plist')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  if (text.startsWith('<?xml') || text.includes('<plist'))
    return { id: plistString(text, 'CFBundleIdentifier'), exe: plistString(text, 'CFBundleExecutable') }
  const read = async (key: string) => {
    const r = await deps.exec(PLUTIL, ['-extract', key, 'raw', '-o', '-', file])
    return r.code === 0 ? r.stdout.trim() || undefined : undefined
  }
  return { id: await read('CFBundleIdentifier'), exe: await read('CFBundleExecutable') }
}

export interface FoundApp {
  path: string
  /** `Contents/MacOS/<executable>`: the app's main process runs this. */
  executable: string
}

/**
 * Finds the app by bundle id: the usual names in the app folders first, then (with `spotlight`) Spotlight. Listing
 * Accounts leaves Spotlight out to stay fast; opening one asks it too.
 */
export async function findApp(
  def: DesktopAppDef,
  deps: DesktopDeps,
  opts: { spotlight?: boolean } = {},
): Promise<FoundApp | null> {
  const check = async (path: string): Promise<FoundApp | null> => {
    if (!(await statOrNull(path))?.isDirectory()) return null
    const info = await bundleInfo(deps, path)
    if (info.id !== def.bundleId) return null
    return { path, executable: info.exe || basename(path, '.app') }
  }
  for (const dir of deps.appDirs)
    for (const name of def.bundleNames) {
      const found = await check(join(dir, name))
      if (found) return found
    }
  if (!opts.spotlight) return null
  const r = await deps.exec(MDFIND, [`kMDItemCFBundleIdentifier == "${def.bundleId}"`])
  if (r.code !== 0) return null
  for (const line of r.stdout.split('\n')) {
    const p = line.trim()
    if (!p.endsWith('.app') || p.includes('/.Trash/')) continue
    const found = await check(p)
    if (found) return found
  }
  return null
}

export interface Proc {
  pid: number
  command: string
}

/** Every process with its command line, or null when `ps` failed (then nothing is known to run). */
async function processes(deps: DesktopDeps): Promise<Proc[] | null> {
  const r = await deps.exec(PS, ['-axo', 'pid=,command='])
  if (r.code !== 0) return null
  const out: Proc[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), command: m[2]!.trimEnd() })
  }
  return out
}

/** The arguments after the app's own executable, when `p` is the app's main process (not a helper). */
function mainArgs(app: FoundApp, p: Proc): string | null {
  const exe = `/${basename(app.path)}/Contents/MacOS/${app.executable}`
  const at = p.command.indexOf(exe)
  if (at === -1) return null
  const rest = p.command.slice(at + exe.length)
  return rest === '' || rest.startsWith(' ') ? rest : null
}

/** The running instance of this Account: the one with its App Data, or for the Main Account the one without any. */
export function instanceOf(app: FoundApp, appData: string | null, procs: readonly Proc[]): Proc | undefined {
  return procs.find((p) => {
    const args = mainArgs(app, p)
    if (args === null) return false
    if (appData === null) return !args.includes('--user-data-dir=')
    const flag = ` --user-data-dir=${appData}`
    const at = args.indexOf(flag)
    if (at === -1) return false
    const after = args.slice(at + flag.length)
    return after === '' || after.startsWith(' ') || after === '/' || after.startsWith('/ ')
  })
}

/** Brings a running app to the front through NSRunningApplication (no Automation permission needed). */
async function activate(deps: DesktopDeps, pid: number): Promise<boolean> {
  const script = [
    "ObjC.import('AppKit');",
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Math.trunc(pid)});`,
    "app.isNil() ? 'missing' : (app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps) ? 'ok' : 'refused')",
  ].join(' ')
  const r = await deps.exec(OSASCRIPT, ['-l', 'JavaScript', '-e', script])
  return r.code === 0 && r.stdout.trim() === 'ok'
}

/** The environment `open` runs with: the caller's, without anything that would pick another Account (spec §3.5). */
function openEnv(base: Env, family: FamilyDef, def: DesktopAppDef): Env {
  const env: Env = { ...base }
  for (const v of family.hijackVars) delete env[v]
  delete env[family.selectVar]
  for (const v of def.clearVars) delete env[v]
  for (const k of Object.keys(env)) if (k.startsWith('SIDEBY_') || isSessionVar(k)) delete env[k]
  return env
}

/**
 * Variables an agent session sets for its own children; a Desktop App started from that session must not inherit
 * them. Named one by one, so a user setting such as `CLAUDE_CODE_USE_BEDROCK` still reaches the app.
 */
const SESSION_PREFIXES = ['CODEX_COMPANION_', 'CODEX_SANDBOX']
const SESSION_VARS = new Set([
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_PID',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDECODE',
  'CODEX_THREAD_ID',
])
function isSessionVar(k: string): boolean {
  return SESSION_VARS.has(k) || SESSION_PREFIXES.some((p) => k.startsWith(p))
}

export interface DesktopOpenResult {
  ref: string
  family: string
  /** The app as messages name it, for example `Claude Desktop`. */
  app: string
  appPath: string
  /** `started`: a new instance; `focused`: the running one is in front; `already-running`: it runs but stayed behind. */
  action: 'started' | 'focused' | 'already-running'
  /** The Account's App Data; absent for the Main Account, which uses the app's default. */
  appData?: string
  /** True when this call created the App Data folder. */
  createdAppData: boolean
  /** Files linked into a new App Data from the Main Account's default one. */
  linked: string[]
  /** The `open` arguments, when sideby started the app. */
  command?: string[]
  /** What the user should know: sign in first, close other windows while signing in. */
  notices: string[]
}

function notMac(platform: string): UserError {
  return new UserError(
    `opening a desktop app per account works on macOS only for now (this is ${platform}); use \`sideby run <account>\` for the terminal`,
    { code: 'not-macos' },
  )
}

function notInstalled(def: DesktopAppDef, deps: DesktopDeps): UserError {
  return new UserError(
    `${def.title} is not installed (looked in ${deps.appDirs.join(' and ')}); install it from ${def.installUrl}, then try again`,
    { code: 'app-not-installed' },
  )
}

/**
 * Opens the Account's Desktop App, or brings its running instance to the front. Never starts a second instance of the
 * same Account, never ends a process, never touches the app bundle or the Host account directory.
 */
export async function openDesktopApp(rt: Runtime, ref: string): Promise<DesktopOpenResult> {
  const deps = depsFor(rt)
  const account = await rt.resolve(ref)
  const family = rt.families.get(account.family)
  const def = family ? desktopAppOf(rt.plugins, account.family) : undefined
  if (!family || !def) {
    const have = [...rt.families.keys()].filter((id) => desktopAppOf(rt.plugins, id))
    throw new UserError(
      `${account.ref}: ${family?.title ?? account.family} has no desktop app sideby can open${have.length ? ` (only ${have.join(' and ')} accounts do)` : ''}; use \`sideby run ${account.ref}\``,
      { code: 'no-desktop-app' },
    )
  }
  if (account.kind === 'api')
    throw new UserError(
      `${account.ref} is an API account; ${def.title} signs in with a subscription only, so open it for a subscription account, or use \`sideby run ${account.ref}\``,
      { code: 'api-account' },
    )
  if (deps.platform !== 'darwin') throw notMac(deps.platform)
  const app = await findApp(def, deps, { spotlight: true })
  if (!app) throw notInstalled(def, deps)

  const home = rt.paths.home
  const appData = account.isMain ? null : appDataDir(home, account)
  const listed = await processes(deps)
  const procs = listed ?? []
  const base = {
    ref: account.ref,
    family: account.family,
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
            `${def.title} is already open for ${account.ref}; switch to it from the Dock (sideby does not start a second one)`,
          ],
    }
  }

  let created = false
  let fresh = false
  const linked: string[] = []
  if (appData) {
    const st = await lstatOrNull(appData)
    if (st && !st.isDirectory())
      throw new UserError(
        `${appData} is not a folder; move it away, then try again (sideby keeps ${def.title}'s data for ${account.ref} there)`,
        { code: 'app-data-invalid' },
      )
    if (!st) {
      await mkdir(appData, { recursive: true, mode: 0o700 })
      await chmod(appData, 0o700)
      created = true
    }
    const shared = new Set(def.sharedFiles.map((f) => f.path))
    fresh = created || (await readdir(appData)).every((e) => shared.has(e))
    if (fresh)
      for (const f of def.sharedFiles) {
        const target = join(appData, f.path)
        const main = join(home, f.mainPath)
        // Never replace anything: link only where nothing is, and only to a file the Main Account has.
        if ((await lstatOrNull(target)) || !(await statOrNull(main))?.isFile()) continue
        await symlink(main, target)
        linked.push(f.path)
      }
  }

  const notices: string[] = []
  if (!account.isMain && def.signInInApp && fresh) {
    const others = procs.some((p) => mainArgs(app, p) !== null)
    notices.push(
      others
        ? `First time for ${account.ref}: sign in inside ${def.title} with the account you use for ${account.ref}, not one it suggests from another window. Close the other ${def.title} windows while you sign in, because the browser may send the sign-in back to one of them`
        : `First time for ${account.ref}: sign in inside ${def.title} with the account you use for ${account.ref}, not one it suggests from another window`,
    )
  }
  if (!def.signInInApp) {
    const login = await Promise.resolve()
      .then(() => family.loginState?.(account))
      .catch(() => undefined)
    if (login === 'logged-out')
      notices.push(
        `${account.ref} is not signed in yet; run \`sideby login ${account.ref}\` first. If ${def.title} offers "Welcome back" with your main account's email, do not pick it: that signs this account in as the main one. Choose to use another account`,
      )
  }

  // The Main Account needs `-n` too: without it, `open` brings forward whichever instance runs, often another
  // Account's window. A second Main instance cannot start here, since a running one was found above.
  // Without a process list a running Main instance cannot be ruled out, so plain `open -a` (no second instance).
  const mainArgsList = listed ? ['-n', '-a', app.path] : ['-a', app.path]
  const args = appData ? def.openArgs(app.path, account.dir, appData) : mainArgsList
  const r = await deps.exec(OPEN, args, openEnv(rt.env, family, def))
  if (r.code !== 0)
    throw new UserError(
      `could not open ${def.title} for ${account.ref}: ${r.stderr.trim() || `open exited with ${r.code}`}; try opening ${app.path} once by hand, then try again`,
      { code: 'open-failed' },
    )
  return { ...base, action: 'started', createdAppData: created, linked, command: [OPEN, ...args], notices }
}

export interface DesktopAppStatus {
  /** The app as messages name it. */
  app: string
  installed: boolean
  /** That Account's own instance runs now. */
  running: boolean
}

/**
 * Desktop App state per Account ref for `sideby list` and the Panel: only on macOS, only Subscription Accounts of a
 * Family that has one. One process listing for all of them; never throws.
 */
export async function desktopStatuses(
  rt: Runtime,
  accounts: readonly Account[],
): Promise<Map<string, DesktopAppStatus>> {
  const out = new Map<string, DesktopAppStatus>()
  const deps = depsFor(rt)
  if (deps.platform !== 'darwin') return out
  try {
    const eligible = accounts.filter((a) => a.kind !== 'api' && desktopAppOf(rt.plugins, a.family))
    if (!eligible.length) return out
    const apps = new Map<string, FoundApp | null>()
    for (const id of new Set(eligible.map((a) => a.family)))
      apps.set(id, await findApp(desktopDef(id)!, deps))
    const procs = [...apps.values()].some(Boolean) ? ((await processes(deps)) ?? []) : []
    for (const a of eligible) {
      const app = apps.get(a.family) ?? null
      out.set(a.ref, {
        app: desktopDef(a.family)!.title,
        installed: app !== null,
        running: app
          ? Boolean(instanceOf(app, a.isMain ? null : appDataDir(rt.paths.home, a), procs))
          : false,
      })
    }
  } catch {
    // A display nicety: a failure leaves the field out.
  }
  return out
}

/**
 * Adds `desktopApp` to each status whose Account has one, for `sideby list` and the Panel. The process listing runs
 * while `statuses` is still being built; the order of the statuses is kept.
 */
export async function withDesktopApps<T extends { ref: string }>(
  rt: Runtime,
  accounts: readonly Account[],
  statuses: Promise<readonly T[]>,
): Promise<(T & { desktopApp?: DesktopAppStatus })[]> {
  const [list, desktop] = await Promise.all([statuses, desktopStatuses(rt, accounts)])
  return list.map((s) => {
    const d = desktop.get(s.ref)
    return d ? { ...s, desktopApp: d } : s
  })
}

/**
 * Doctor's extra checks for an Account's App Data (spec §3.20): the Desktop App's shared files under `link` rules,
 * only when that Account's App Data folder exists, never for the Main Account (it uses the app's default) or an API
 * Account. Results are named `app-data/<path>` and are not counted in `shared`. The App Data is the repair boundary:
 * a fix may only add a missing link inside it, never replace a real file.
 */
export async function checkAppData(
  plugins: readonly LoadedPlugin[],
  home: string,
  account: Account,
): Promise<CheckResult[]> {
  if (account.isMain || account.kind === 'api') return []
  const def = desktopAppOf(plugins, account.family)
  if (!def?.sharedFiles.length) return []
  const dir = appDataDir(home, account)
  if (!(await lstatOrNull(dir))?.isDirectory()) return []
  const out: CheckResult[] = []
  for (const f of def.sharedFiles) {
    const item: SharedItemDef = { path: f.path, mode: 'link' }
    const mainPath = join(home, f.mainPath)
    const p = join(dir, item.path)
    const res = await checkItem({ account, item, mainPath, accountPath: p, accountDir: dir, force: false })
    for (const r of res.results) {
      if (r.level === 'ok') continue
      // The Desktop App writes its own file when the Main Account had none at first open, and may replace the link
      // later: not the user's doing, so a warning with the way to share, never a failure and never replaced.
      const own: Partial<CheckResult> =
        r.code === 'link.real-file'
          ? {
              level: 'warn',
              message: `${item.path} is ${def.title}'s own copy for this account, not a link to the main account's`,
              hint: `${def.title} made it itself; that is fine. To share the main account's instead, quit that window, then: mv "${p}" "${p}.local" && ln -s "${mainPath}" "${p}"`,
            }
          : {}
      out.push({
        ...r,
        ...own,
        item: `app-data/${item.path}`,
        message: `${def.title} data: ${own.message ?? r.message}`,
      })
    }
  }
  return out
}
