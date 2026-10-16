// Browser Sign-ins (spec §3.24, ADR-0023): which Browser Profile of Google Chrome signed in to each Account's vendor
// website, from Chrome's local data on this computer only. Read-only: `Local State` gives each profile's folder,
// display name and the email of the Google account it is signed in to Chrome with, `Local Storage/leveldb` the key
// names of claude.ai and chatgpt.com (core/leveldb-keys.ts). Never Cookies, Login Data, IndexedDB or the Keychain,
// never a value, never the network. The Host-side id each match needs (families/browser.ts) is compared in memory
// and never leaves this module. Opening a website starts Chrome unchanged with `open`, through `DesktopDeps.exec`,
// so tests never start a real browser. On WSL the Chrome is the one installed on Windows: its folders come from one
// `cmd.exe` call, and it is started with `cmd.exe /c start` (spec §3.24, WSL).
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { matchedOrigins, websiteDef } from '../families/browser.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { type BrowserConfig, editConfigBrowser } from './config.ts'
import { type DesktopDeps, depsFor, findApp } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { localStorageKeys } from './leveldb-keys.ts'

const OPEN = '/usr/bin/open'
export const CHROME = {
  title: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  bundleNames: ['Google Chrome.app'],
}
export const CHROME_DOWNLOAD = 'https://www.google.com/chrome/'
const MAX_LOCAL_STATE = 16 * 1024 * 1024

/** Chrome's user data folder on macOS. */
export function chromeUserData(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
}

/** Windows folders sideby needs on WSL, each as a Windows path and as the WSL path it is mounted at. */
interface WindowsDirs {
  localAppData?: { win: string; unix: string }
  programs: { win: string; unix: string }[]
}

/** A Windows drive path (`C:\Windows`) as WSL mounts it (`/mnt/c/Windows`); undefined for anything else. */
function toUnix(win: string, mount: string): string | undefined {
  const m = /^([A-Za-z]):\\(.*)$/.exec(win.trim())
  if (!m) return undefined
  return join(mount, (m[1] as string).toLowerCase(), ...(m[2] as string).split('\\').filter(Boolean))
}

const windowsMemo = new Map<string, WindowsDirs>()

/**
 * `%LOCALAPPDATA%` and the Program Files folders, from one `cmd.exe` call, remembered for the process. When cmd.exe
 * fails, the only Windows user with Chrome data under `<mount>/c/Users`; several are not guessed between.
 */
async function windowsDirs(deps: DesktopDeps, mount: string, problems: string[]): Promise<WindowsDirs> {
  const hit = windowsMemo.get(mount)
  if (hit) return hit
  const r = await deps.exec(join(mount, 'c', 'Windows', 'System32', 'cmd.exe'), [
    '/d',
    '/c',
    'echo %LOCALAPPDATA%^|%ProgramFiles%^|%ProgramFiles(x86)%',
  ])
  const parts = r.code === 0 ? r.stdout.trim().split('|') : []
  const dir = (win: string | undefined) => {
    const unix = win ? toUnix(win, mount) : undefined
    return win && unix ? { win: win.trim(), unix } : undefined
  }
  const local = dir(parts[0])
  if (local) {
    const found: WindowsDirs = {
      localAppData: local,
      programs: [dir(parts[1]), dir(parts[2])].filter((d) => d !== undefined),
    }
    windowsMemo.set(mount, found)
    return found
  }
  // cmd.exe did not answer (interop off, or no C: drive): look for the one Windows user that has Chrome.
  const users = join(mount, 'c', 'Users')
  const withChrome: string[] = []
  for (const u of await readdir(users).catch(() => [] as string[])) {
    const st = await stat(
      join(users, u, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State'),
    ).catch(() => null)
    if (st?.isFile()) withChrome.push(u)
  }
  if (withChrome.length > 1)
    problems.push(
      `several Windows users have Chrome data (${withChrome.join(', ')}) and cmd.exe did not say which is yours; check that WSL can run Windows programs (\`cmd.exe /c ver\`)`,
    )
  const only = withChrome.length === 1 ? withChrome[0] : undefined
  return {
    ...(only
      ? {
          localAppData: {
            win: `C:\\Users\\${only}\\AppData\\Local`,
            unix: join(users, only, 'AppData', 'Local'),
          },
        }
      : {}),
    programs: [],
  }
}

/** Where Chrome keeps its data: under the home folder on macOS, in Windows' own folder on WSL; null elsewhere. */
async function userDataFor(rt: Runtime, deps: DesktopDeps, problems: string[]): Promise<string | null> {
  if (deps.platform === 'darwin') return chromeUserData(rt.paths.home)
  if (!deps.wslMount) return null
  const win = await windowsDirs(deps, deps.wslMount, problems)
  return win.localAppData ? join(win.localAppData.unix, 'Google', 'Chrome', 'User Data') : null
}

/** Characters cmd.exe would treat as more than a path, even inside quotes. */
const CMD_UNSAFE = /["%&|<>^\r\n]/

export interface BrowserProfile {
  /** The profile's folder inside Chrome's user data, such as `Default` or `Profile 7`. */
  dir: string
  /** The name Chrome shows for it. May be an email; the Panel masks it with identities. */
  name: string
  /** The Google account this browser user is signed in to Chrome with, if any. */
  email?: string
  /** Refs of the Accounts this profile signed in to, as far as its local data shows. */
  signIns: string[]
  /** When its Local Storage last changed (ISO 8601), if known. */
  changedAt?: string
}

export interface BrowserReport {
  /** config `browser.signIns`; when false nothing of the browser was read. */
  enabled: boolean
  browser: string
  /** Chrome's user data folder exists (macOS, and Windows' Chrome on WSL). */
  found: boolean
  /** Newest change first. */
  profiles: BrowserProfile[]
  /** Families whose Accounts can be matched, and those that can only be opened in a profile the user picks. */
  families: { matched: string[]; openOnly: string[] }
  /** Problems met while reading, without file contents. */
  problems: string[]
}

interface ProfileEntry {
  dir: string
  name: string
  email?: string
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/

/**
 * Each profile's folder, display name and Google account email (`user_name`, kept only when it is an email) from
 * `Local State`; nothing else of the file is kept.
 */
async function profileEntries(userData: string, problems: string[]): Promise<ProfileEntry[] | null> {
  const file = join(userData, 'Local State')
  let text: string
  try {
    const st = await stat(file)
    if (!st.isFile() || st.size > MAX_LOCAL_STATE) {
      problems.push(`${file} is not a readable file`)
      return []
    }
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    problems.push(`${file} could not be read`)
    return []
  }
  let cache: unknown
  try {
    cache = (JSON.parse(text) as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache
  } catch {
    problems.push(`${file} is not valid JSON`)
    return []
  }
  if (typeof cache !== 'object' || cache === null) return []
  const out: ProfileEntry[] = []
  for (const [dir, info] of Object.entries(cache)) {
    if (!/^[\w .-]{1,64}$/.test(dir) || dir.startsWith('.')) continue
    const n = (info as { name?: unknown } | null)?.name
    const name = typeof n === 'string' && n.trim() && !/\p{Cc}/u.test(n) ? n.trim().slice(0, 80) : dir
    const u = (info as { user_name?: unknown } | null)?.user_name
    const email = typeof u === 'string' && EMAIL.test(u.trim()) ? u.trim() : undefined
    out.push({ dir, name, ...(email ? { email } : {}) })
  }
  return out
}

/** Key names per profile folder, remembered while none of its LevelDB files changed. */
const keyMemo = new Map<string, { sig: string; value: Awaited<ReturnType<typeof localStorageKeys>> }>()

async function profileKeys(dir: string, origins: readonly string[]) {
  let sig = origins.join(',')
  try {
    for (const n of (await readdir(dir)).sort()) {
      const st = await stat(join(dir, n)).catch(() => null)
      if (st) sig += `|${n}:${st.size}:${st.mtimeMs}:${st.ino}`
    }
  } catch {
    return { keys: new Map<string, Set<string>>(), problems: [] as string[] }
  }
  const hit = keyMemo.get(dir)
  if (hit?.sig === sig) return hit.value
  const value = await localStorageKeys(dir, origins)
  keyMemo.set(dir, { sig, value })
  return value
}

const BOUNDARY = /[A-Za-z0-9_]/

/** `id` appears in `key` as a whole segment: not glued to another letter, digit or underscore. */
export function keyHasId(key: string, id: string): boolean {
  const k = key.toLowerCase()
  const i0 = id.toLowerCase()
  for (let i = k.indexOf(i0); i >= 0; i = k.indexOf(i0, i + 1)) {
    const before = k[i - 1]
    const after = k[i + i0.length]
    if ((before === undefined || !BOUNDARY.test(before)) && (after === undefined || !BOUNDARY.test(after)))
      return true
  }
  return false
}

/** Accounts that a Browser Sign-in can apply to: Subscription Accounts of built-in Families with a website. */
function eligible(rt: Runtime, accounts: readonly Account[]): Account[] {
  return accounts.filter(
    (a) =>
      a.kind !== 'api' &&
      websiteDef(a.family) &&
      rt.plugins.some((p) => p.source === 'builtin' && p.families.includes(a.family)),
  )
}

/** The Browser Report for `sideby browser` and the Panel. Reads nothing of the browser while it is off. */
export async function browserReport(rt: Runtime, accounts: readonly Account[]): Promise<BrowserReport> {
  const enabled = rt.config.browser?.signIns === true
  const list = eligible(rt, accounts)
  const fams = [...new Set(list.map((a) => a.family))]
  const families = {
    matched: fams.filter((f) => websiteDef(f)?.match),
    openOnly: fams.filter((f) => !websiteDef(f)?.match),
  }
  const base = { enabled, browser: CHROME.title, families }
  if (!enabled) return { ...base, found: false, profiles: [], problems: [] }
  const problems: string[] = []
  const userData = await userDataFor(rt, depsFor(rt), problems)
  if (userData === null) return { ...base, found: false, profiles: [], problems }
  const entries = await profileEntries(userData, problems)
  if (entries === null) return { ...base, found: false, profiles: [], problems }
  const ids: { ref: string; origin: string; id: string }[] = []
  for (const a of list) {
    const m = websiteDef(a.family)?.match
    const id = m ? await m.signInId(a) : undefined
    if (m && id) ids.push({ ref: a.ref, origin: m.origin, id })
  }
  const origins = matchedOrigins()
  const read: { e: ProfileEntry; counts: number[]; changedAt?: string }[] = []
  for (const e of entries) {
    const r = await profileKeys(join(userData, e.dir, 'Local Storage', 'leveldb'), origins)
    for (const p of r.problems) problems.push(`${e.name}: ${p}`)
    const counts = ids.map(
      ({ origin, id }) => [...(r.keys.get(origin) ?? [])].filter((k) => keyHasId(k, id)).length,
    )
    const changedAt = 'changedAt' in r && r.changedAt ? new Date(r.changedAt).toISOString() : undefined
    read.push({ e, counts, ...(changedAt ? { changedAt } : {}) })
  }
  // A site keeps a few keys for whoever is signed in, and may leave one behind after a sign-out or a switch. So a
  // trace counts only when it is at least half as strong as the strongest one of the same id (across profiles) and of
  // the same website in the same profile (across ids).
  const bestOfId = ids.map((_, i) => Math.max(0, ...read.map((x) => x.counts[i] as number)))
  const profiles: BrowserProfile[] = read.map(({ e, counts, changedAt }) => {
    const bestOfSite = (origin: string) =>
      Math.max(0, ...ids.map((x, i) => (x.origin === origin ? (counts[i] as number) : 0)))
    const signIns = ids
      .filter((x, i) => {
        const n = counts[i] as number
        return n > 0 && n * 2 >= (bestOfId[i] as number) && n * 2 >= bestOfSite(x.origin)
      })
      .map((x) => x.ref)
    return {
      dir: e.dir,
      name: e.name,
      ...(e.email ? { email: e.email } : {}),
      signIns,
      ...(changedAt ? { changedAt } : {}),
    }
  })
  profiles.sort((a, b) => (b.changedAt ?? '').localeCompare(a.changedAt ?? '') || a.dir.localeCompare(b.dir))
  return { ...base, found: true, profiles, problems }
}

export interface BrowserOpenResult {
  ref: string
  url: string
  profile: { dir: string; name: string }
  command: string[]
}

/**
 * Opens an Account's vendor website in one Browser Profile: the one given (folder or name), else the only profile
 * that signed in to it. Several or none: refuses with the choices, so the caller can ask. `profile` must be a folder
 * Chrome lists in `Local State`.
 */
export async function openInBrowser(
  rt: Runtime,
  account: Account,
  profile?: string,
): Promise<BrowserOpenResult> {
  const deps = depsFor(rt)
  if (deps.platform !== 'darwin' && !deps.wslMount)
    throw new UserError(
      `opening a browser user works on macOS and WSL only for now (this is ${deps.platform}); open ${websiteDef(account.family)?.url ?? 'the website'} yourself`,
      { code: 'unsupported' },
    )
  const site = websiteDef(account.family)
  if (!site || account.kind === 'api' || !eligible(rt, [account]).length)
    throw new UserError(
      `${account.ref} has no website to open; only Claude, Codex and Grok subscription accounts do`,
      {
        code: 'no-website',
      },
    )
  const problems: string[] = []
  const launch = await chromeLauncher(deps, problems)
  if (!launch)
    throw new UserError(`${CHROME.title} is not installed; get it from ${CHROME_DOWNLOAD}`, {
      code: 'not-installed',
    })
  const entries = (await profileEntries(launch.userData ?? chromeUserData(rt.paths.home), problems)) ?? []
  if (!entries.length)
    throw new UserError(`${CHROME.title} has no browser users yet; open it once, then try again`, {
      code: 'no-profiles',
    })
  let pick: ProfileEntry | undefined
  if (profile) {
    pick = entries.find((e) => e.dir === profile)
    if (!pick) {
      const p = profile.toLowerCase()
      const byName = entries.filter((e) => e.name.toLowerCase() === p)
      if (!byName.length) byName.push(...entries.filter((e) => e.email?.toLowerCase() === p))
      if (byName.length > 1)
        throw new UserError(
          `several browser users are named "${profile}"; pass the folder instead: ${byName.map((e) => e.dir).join(', ')}`,
          { code: 'profile-ambiguous' },
        )
      pick = byName[0]
    }
    if (!pick)
      throw new UserError(
        `no browser user "${profile}"; choose one of: ${entries.map((e) => `${e.name} (${e.dir})`).join(', ')}`,
        { code: 'profile-unknown' },
      )
  } else {
    const report = rt.config.browser?.signIns === true ? await browserReport(rt, [account]) : undefined
    const found = report?.profiles.filter((p) => p.signIns.includes(account.ref)) ?? []
    if (found.length !== 1) {
      const why = !site.match
        ? `${site.url.replace('https://', '')} keeps nothing sideby can compare, so name the browser user`
        : !report
          ? `finding it is off (turn it on with \`sideby browser --enable\`)`
          : found.length
            ? `${found.length} browser users signed in to ${account.ref}`
            : `no browser user signed in to ${account.ref}`
      const choices = (found.length ? found : entries).map((e) => `${e.name} (${e.dir})`).join(', ')
      throw new UserError(`${why}; pass --profile with one of: ${choices}`, { code: 'profile-needed' })
    }
    pick = entries.find((e) => e.dir === found[0]?.dir)
    if (!pick)
      throw new UserError('that browser user is gone; run `sideby browser` again', {
        code: 'profile-unknown',
      })
  }
  const [cmd, ...args] = launch.command(`--profile-directory=${pick.dir}`, site.url)
  const r = await deps.exec(cmd as string, args)
  if (r.code !== 0)
    throw new UserError(
      `could not open ${CHROME.title}: ${launch.windows ? `cmd.exe exited with ${r.code}` : r.stderr.trim() || `open exited with ${r.code}`}; open it once by hand, then try again`,
      { code: 'open-failed' },
    )
  return {
    ref: account.ref,
    url: site.url,
    profile: { dir: pick.dir, name: pick.name },
    command: [cmd as string, ...args],
  }
}

interface ChromeLauncher {
  /** Chrome's data folder when it is not the macOS one under the home folder. */
  userData?: string
  windows: boolean
  /** The program and arguments that open Chrome with these arguments. */
  command(...chromeArgs: string[]): string[]
}

/** How to start Chrome here: `open` on macOS, `cmd.exe /c start` with Windows' chrome.exe on WSL; null when absent. */
async function chromeLauncher(deps: DesktopDeps, problems: string[]): Promise<ChromeLauncher | null> {
  if (deps.platform === 'darwin') {
    const app = await findApp(CHROME, deps, { spotlight: true })
    return app && { windows: false, command: (...a) => [OPEN, '-na', app.path, '--args', ...a] }
  }
  const mount = deps.wslMount as string
  const win = await windowsDirs(deps, mount, problems)
  const local = win.localAppData
  if (!local) return null
  for (const d of [...win.programs, local]) {
    const exe = join(d.unix, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (!(await stat(exe).catch(() => null))?.isFile()) continue
    const winExe = win32.join(d.win, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (CMD_UNSAFE.test(winExe)) continue
    const cmd = join(mount, 'c', 'Windows', 'System32', 'cmd.exe')
    return {
      userData: join(local.unix, 'Google', 'Chrome', 'User Data'),
      windows: true,
      command: (...a) => [cmd, '/d', '/c', 'start', '', winExe, ...a],
    }
  }
  return null
}

/** What turning Browser Sign-ins on reads, for the confirmation in the CLI and the Panel. */
export const BROWSER_READS = [
  "the name of each Google Chrome browser user and the Google account email it uses in Chrome (from Chrome's Local State)",
  'the key names claude.ai and chatgpt.com keep in each browser user’s Local Storage, never their values',
  'the account id in each Claude and Codex login file, only to compare; it is never shown or saved',
] as const

export interface BrowserSwitch {
  enabled: boolean
  changed: boolean
  applied: boolean
  file: string
  /** What is read while it is on. */
  reads: readonly string[]
}

/** Turns Browser Sign-ins on or off in config `browser.signIns`; without `apply`, shows the change only. */
export async function setBrowserSignIns(
  rt: Runtime,
  on: boolean,
  opts: { apply: boolean },
): Promise<BrowserSwitch> {
  const r = await editConfigBrowser(
    rt.paths.configFile,
    (cur) => {
      const next: BrowserConfig = { ...cur }
      if (on) next.signIns = true
      else delete next.signIns
      return next
    },
    { dryRun: !opts.apply },
  )
  return {
    enabled: on,
    changed: r.changed,
    applied: opts.apply && r.changed,
    file: rt.paths.configFile,
    reads: BROWSER_READS,
  }
}
