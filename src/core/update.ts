// Update Check, Update Notice, Install Method, Update and Auto Update (spec §3.23, ADR-0021). The Update Check is the
// only network request sideby makes on its own: one GET for the `latest` dist-tag, carrying nothing about the user.
// Everything it learns goes to one state file shared by the CLI and every Panel.
import { spawn } from 'node:child_process'
import { access, constants, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from '../types.ts'
import { writeFileAtomic } from './fs-safe.ts'
import type { Paths } from './paths.ts'
import { gitRootOf, installedSkills, SKILL_INSTALL, SKILL_UPDATE } from './skill-check.ts'
import { localBuild, packageVersion, parseLocalBuild } from './version.ts'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** After a failed check (offline, a mirror without the endpoint) the next one waits this long. */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000
/** A failed Auto Update of one version is tried again after this long (a mirror may not have it yet). */
export const AUTO_RETRY_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
export const RELEASE_NOTES = (v: string) => `https://github.com/Adonis0123/sideby/releases/tag/v${v}`

/** What `update.json` in the state directory holds. Every field is optional; a broken file reads as `{}`. */
export interface UpdateCache {
  /** When the registry last answered. */
  checkedAt?: string
  /** When a check was last tried, answered or not. */
  triedAt?: string
  /** The `latest` dist-tag it answered. */
  latest?: string
  /** When a background check last looked at Auto Update (installed, or waited for a running session). */
  autoTriedAt?: string
  /** The last Update Notice the CLI printed. */
  notified?: { version: string; at: string }
  /** The last Auto Update; `shown` once the CLI has said so. */
  auto?: { from: string; to: string; at: string; ok: boolean; message: string; shown?: boolean }
}

export type InstallKind = 'npm' | 'pnpm' | 'bun' | 'volta' | 'npx' | 'project' | 'source' | 'local'

export interface InstallMethod {
  kind: InstallKind
  /** The installed package folder (real path). */
  packageDir: string
  /** True when sideby can run the Update itself (npm, pnpm or bun global, and npm's folders are writable). */
  canUpdate: boolean
  /** Why it cannot, in a phrase that follows "sideby cannot update itself: ". */
  reason?: string
  /** npm only: the prefix whose `lib/node_modules` holds sideby. */
  prefix?: string
}

/** Swapped in tests through `bindUpdateDeps`; the real machine otherwise. */
export interface UpdateDeps {
  fetch: typeof fetch
  now: () => Date
  /** Real path of the running sideby package. */
  packageDir: () => Promise<string>
  writable: (dir: string) => Promise<boolean>
  alive: (pid: number) => boolean
  /** Runs a program, streaming its output to `onOutput`; resolves with the exit code and the whole output. */
  exec: (
    file: string,
    args: readonly string[],
    opts: { env: Env; onOutput?: (text: string) => void },
  ) => Promise<{ code: number; output: string }>
  /** Starts `sideby ui --background --no-open --port <port>` from the newly installed code, detached; false when it could not start. */
  restartPanel: (env: Env, port: number) => Promise<boolean>
  /** Whether `sideby app install` put a desktop app in this home (its files carry the app marker). */
  appInstalled: (home: string, env: Env) => Promise<boolean>
  /** Runs `sideby app install --json` from the newly installed code and waits; false when it failed. */
  refreshApp: (env: Env) => Promise<boolean>
}

/** The folder of the sideby package this module belongs to: two levels above src/, three above dist/src/. */
async function ownPackageDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const up of ['../..', '../../..']) {
    const dir = join(here, up)
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === 'sideby') return await realpath(dir)
    } catch {
      // try the next layout
    }
  }
  return realpath(join(here, '../..'))
}

const realDeps: UpdateDeps = {
  fetch: (...args) => fetch(...args),
  now: () => new Date(),
  packageDir: ownPackageDir,
  writable: (dir) =>
    access(dir, constants.W_OK).then(
      () => true,
      () => false,
    ),
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  exec: (file, args, opts) =>
    new Promise((resolve) => {
      let output = ''
      const child = spawn(file, args, {
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const take = (b: Buffer) => {
        const text = b.toString('utf8')
        output += text
        opts.onOutput?.(text)
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      child.once('error', (err) => resolve({ code: 127, output: `${output}${err.message}\n` }))
      child.once('close', (code) => resolve({ code: code ?? 1, output }))
    }),
  restartPanel: (env, port) =>
    new Promise((resolve) => {
      // By name, so the new code runs even where the install moved (pnpm keeps each version in its own folder). The
      // new process replaces the old Panel itself: it stops a background Panel of another build before it starts.
      const child = spawn('sideby', ['ui', '--background', '--no-open', '--port', String(port)], {
        env: env as NodeJS.ProcessEnv,
        detached: true,
        stdio: 'ignore',
      })
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
      child.once('error', () => resolve(false))
    }),
  appInstalled: async (home, env) => {
    const { appInstalled } = await import('../desktop/app.ts')
    return appInstalled({ home, env, platform: process.platform })
  },
  refreshApp: (env) =>
    new Promise((resolve) => {
      // By name, like restartPanel: the new code records its own Node and entry and draws the current mark.
      const child = spawn('sideby', ['app', 'install', '--json'], {
        env: env as NodeJS.ProcessEnv,
        stdio: 'ignore',
        timeout: 120_000,
      })
      child.once('error', () => resolve(false))
      child.once('close', (code) => resolve(code === 0))
    }),
}

let override: Partial<UpdateDeps> = {}
/** Internal, for tests: replaces parts of the machine. Not part of the plugin or Portal contract. */
export function bindUpdateDeps(deps: Partial<UpdateDeps>): () => void {
  const before = override
  override = { ...override, ...deps }
  return () => {
    override = before
  }
}
const deps = (): UpdateDeps => ({ ...realDeps, ...override })

// ---- versions

type Parsed = { core: [number, number, number]; pre: string[] }
// Build metadata is limited to what semver allows, so a version never carries a terminal escape into the notice.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
function parseVersion(v: string): Parsed | null {
  const m = VERSION.exec(v.trim())
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/** Semver precedence of two prerelease identifiers: numbers compare as numbers and sort before words. */
function comparePre(a: string, b: string): number {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Math.sign(Number(a) - Number(b))
  if (na !== nb) return na ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1, 0 or 1 like a sort comparator; a prerelease sorts before its release. Null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! < pb.core[i]! ? -1 : 1
  if (!pa.pre.length || !pb.pre.length) return Math.sign(pb.pre.length - pa.pre.length)
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const c = comparePre(pa.pre[i]!, pb.pre[i]!)
    if (c) return c
  }
  return Math.sign(pa.pre.length - pb.pre.length)
}

/** `latest` is newer than `current`. */
export const isNewer = (latest: string | undefined, current: string): latest is string =>
  latest !== undefined && compareVersions(latest, current) === 1

/**
 * The jump keeps the major version (0.11 → 0.12, 1.2 → 1.9). Auto Update only takes these; 0.x → 1.0 or 1.x → 2.0
 * only gets a notice.
 */
export function sameLine(from: string, to: string): boolean {
  const a = parseVersion(from)?.core
  const b = parseVersion(to)?.core
  return Boolean(a && b && a[0] === b[0])
}

// ---- switches

const set = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'

/** True in CI, where a notice is noise and a check is a request nobody reads. */
export const inCi = (env: Env): boolean =>
  set(env.CI) || set(env.CONTINUOUS_INTEGRATION) || set(env.BUILD_NUMBER)

type UpdateSettings = { update?: { check?: boolean; auto?: boolean } }

/** Why Update Checks are off, or null when they are on (spec §3.23). */
export function checksOff(env: Env, config: UpdateSettings, local = localBuild() !== null): string | null {
  // A Local Build (ADR-0024) follows the checkout: a notice or an Auto Update would only replace it with npm's.
  if (local) return 'this is a local build (pnpm local)'
  if (set(env.SIDEBY_NO_UPDATE_NOTIFIER)) return 'SIDEBY_NO_UPDATE_NOTIFIER is set'
  if (set(env.NO_UPDATE_NOTIFIER)) return 'NO_UPDATE_NOTIFIER is set'
  if (config.update?.check === false) return 'config update.check is false'
  if (inCi(env)) return 'running in CI'
  return null
}

// ---- registry

/** The registry checks and installs use: `SIDEBY_UPDATE_REGISTRY` (http or https only), else npm's. */
function registryOf(env: Env): string {
  const base = (env.SIDEBY_UPDATE_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base))
    throw new Error(
      'SIDEBY_UPDATE_REGISTRY must be an http or https URL, such as https://registry.npmmirror.com',
    )
  return base
}

/** The registry as messages show it: without a user name or password a mirror URL may carry. */
function shownRegistry(base: string): string {
  try {
    const u = new URL(base)
    u.username = ''
    u.password = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return 'the registry in SIDEBY_UPDATE_REGISTRY'
  }
}

// ---- cache

const cacheFile = (p: Paths) => join(p.stateDir, 'update.json')
const str = (v: unknown): v is string => typeof v === 'string'

export async function readUpdateCache(paths: Paths): Promise<UpdateCache> {
  try {
    const data = JSON.parse(await readFile(cacheFile(paths), 'utf8')) as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    const d = data as Record<string, unknown>
    const out: UpdateCache = {}
    if (str(d.checkedAt)) out.checkedAt = d.checkedAt
    if (str(d.triedAt)) out.triedAt = d.triedAt
    if (str(d.autoTriedAt)) out.autoTriedAt = d.autoTriedAt
    if (str(d.latest) && parseVersion(d.latest)) out.latest = d.latest
    const n = d.notified as Record<string, unknown> | undefined
    if (n && str(n.version) && str(n.at)) out.notified = { version: n.version, at: n.at }
    const a = d.auto as Record<string, unknown> | undefined
    if (a && str(a.from) && str(a.to) && str(a.at) && typeof a.ok === 'boolean' && str(a.message))
      out.auto = {
        from: a.from,
        to: a.to,
        at: a.at,
        ok: a.ok,
        message: a.message,
        ...(a.shown ? { shown: true } : {}),
      }
    return out
  } catch {
    return {}
  }
}

/**
 * Merges a change into the cache file. The file is read again first, and `change` may be a function of what is there
 * now, so a writer that decides from an older read (the CLI marking an Auto Update shown) never overwrites a newer
 * field another process wrote meanwhile.
 */
export async function updateUpdateCache(
  paths: Paths,
  change: Partial<UpdateCache> | ((now: UpdateCache) => Partial<UpdateCache>),
): Promise<UpdateCache> {
  const cur = await readUpdateCache(paths)
  const next = { ...cur, ...(typeof change === 'function' ? change(cur) : change) }
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  await writeFileAtomic(cacheFile(paths), `${JSON.stringify(next, null, 2)}\n`, 0o600)
  return next
}

const age = (iso: string | undefined, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Number.NaN)

/** A check is due: no answer within a day, and no attempt within the hour (so being offline costs one try an hour). */
export function checkDue(cache: UpdateCache, now: Date): boolean {
  return !(age(cache.checkedAt, now) < CHECK_INTERVAL_MS) && !(age(cache.triedAt, now) < RETRY_INTERVAL_MS)
}

/**
 * Auto Update is on and the cache names a newer version it has not installed: never tried, or a failed try a day
 * ago. Lets the CLI start a background check even when a Panel already ran today's check.
 */
export function autoPending(cache: UpdateCache, current: string, config: UpdateSettings, now: Date): boolean {
  if (config.update?.auto !== true || !isNewer(cache.latest, current)) return false
  // Waiting for a running session: look again within the hour, not after every command.
  if (age(cache.autoTriedAt, now) < RETRY_INTERVAL_MS) return false
  const a = cache.auto
  if (!a || a.to !== cache.latest) return true
  return !a.ok && !(age(a.at, now) < AUTO_RETRY_MS)
}

// ---- the check

/** Asks the registry for the `latest` dist-tag. Throws with a message that names the registry and what to do. */
export async function fetchLatest(env: Env): Promise<string> {
  const base = registryOf(env)
  const shown = shownRegistry(base)
  let res: Response
  try {
    res = await deps().fetch(`${base}/-/package/sideby/dist-tags`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const why = (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message
    throw new Error(
      `could not reach ${shown} (${why}); check the connection, or set SIDEBY_UPDATE_REGISTRY to a mirror`,
    )
  }
  if (!res.ok)
    throw new Error(
      `${shown} answered ${res.status} for sideby's versions; try again later, or set SIDEBY_UPDATE_REGISTRY`,
    )
  const body = (await res.json().catch(() => null)) as { latest?: unknown } | null
  const latest = body?.latest
  if (typeof latest !== 'string' || !parseVersion(latest))
    throw new Error(
      `${shown} did not name a latest sideby version; set SIDEBY_UPDATE_REGISTRY to the npm registry`,
    )
  return latest
}

/** Runs one Update Check and records it, answered or not. Never throws. */
export async function refreshUpdateCheck(paths: Paths, env: Env): Promise<UpdateCache> {
  const at = deps().now().toISOString()
  try {
    const latest = await fetchLatest(env)
    return await updateUpdateCache(paths, { checkedAt: at, triedAt: at, latest })
  } catch {
    return updateUpdateCache(paths, { triedAt: at }).catch(() => readUpdateCache(paths))
  }
}

/** A lock older than this has outlived any install; its pid may since belong to another process. */
const LOCK_MAX_MS = 60 * 60 * 1000
/** A lock file another process has just created and not yet written to. */
const LOCK_WRITE_GRACE_MS = 60 * 1000

/**
 * An exclusive lock file in the state directory holding `<pid> <ms since epoch>`. It is held while that pid runs and
 * the lock is under an hour old, however long an install takes on a slow mirror; an empty or unreadable lock is held
 * for a minute (its owner may still be writing it). Null when held: the second caller fails at once instead of
 * waiting. Release removes the file only while it still names this process.
 */
async function takeLock(paths: Paths, name: string): Promise<(() => Promise<void>) | null> {
  const file = join(paths.stateDir, name)
  const d = deps()
  const me = `${process.pid} ${d.now().getTime()}`
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, 'wx', 0o600)
      await fh.writeFile(me)
      await fh.close()
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === me) await rm(file, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
      const text = await readFile(file, 'utf8').catch(() => '')
      const m = /^(\d+) (\d+)$/.exec(text)
      const held = m
        ? d.alive(Number(m[1])) && d.now().getTime() - Number(m[2]) < LOCK_MAX_MS
        : d.now().getTime() - ((await stat(file).catch(() => null))?.mtimeMs ?? 0) < LOCK_WRITE_GRACE_MS
      if (held) return null
      await rm(file, { force: true })
    }
  }
  return null
}

// ---- the notice

/**
 * The Update Notice line the CLI may print now, or null. Once per new version per day; `current` is the running
 * version.
 */
export function noticeLine(cache: UpdateCache, current: string, now: Date): string | null {
  if (!isNewer(cache.latest, current)) return null
  const n = cache.notified
  if (n && n.version === cache.latest && age(n.at, now) < NOTICE_INTERVAL_MS) return null
  return `sideby ${cache.latest} is available (you have ${current}) · run \`sideby update\``
}

/** What the CLI says once about the last Auto Update, or null. */
export function autoUpdateLine(cache: UpdateCache): string | null {
  const a = cache.auto
  if (!a || a.shown) return null
  return a.ok
    ? `sideby updated itself from ${a.from} to ${a.to} (${RELEASE_NOTES(a.to)})`
    : `sideby could not update itself to ${a.to}: ${a.message}`
}

/** The `_notice` of a `--json` output (spec §3.23): what an agent should mention once its task is done. */
export interface JsonNotice {
  update?: { current: string; latest: string; command: string; message: string }
  skill?: { installed: string | null; current: string; command: string; message: string }
}

/**
 * The `_notice` for a `--json` output, from the cached Update Check and the versions of the installed sideby skills
 * (`null` for one written before skills had a version); null when there is nothing to say or checks are off. It
 * reads no network: an agent sees what the last check found, as a person sees the Update Notice.
 */
export function jsonNotice(
  cache: UpdateCache,
  current: string,
  config: UpdateSettings,
  env: Env,
  skills: readonly (string | null)[],
  skillCommand: string,
): JsonNotice | null {
  if (checksOff(env, config)) return null
  const out: JsonNotice = {}
  if (isNewer(cache.latest, current))
    out.update = {
      current,
      latest: cache.latest,
      command: 'sideby update',
      message: `sideby ${cache.latest} is available (this is ${current}); \`sideby update\` shows what it runs and updates after --yes`,
    }
  const stale = skills.find((v) => v !== current)
  if (stale !== undefined)
    out.skill = {
      installed: stale,
      current,
      command: skillCommand,
      message: `the installed sideby skill is ${stale ? `for sideby ${stale}` : 'from before skills had a version'}; this sideby is ${current}. \`${skillCommand}\` updates it`,
    }
  return out.update || out.skill ? out : null
}

/**
 * What the CLI does after a command (spec §3.23), decided from the cache: the lines to print (the Auto Update result,
 * then the Update Notice), the change that records them, and whether to start a background check. The caller prints,
 * writes `record` with `updateUpdateCache` and starts the check; nothing here touches the machine.
 */
export function afterCommandPlan(
  cache: UpdateCache,
  current: string,
  config: UpdateSettings,
  env: Env,
  now: Date,
): { lines: string[]; record: ((cur: UpdateCache) => Partial<UpdateCache>) | null; startCheck: boolean } {
  if (checksOff(env, config)) return { lines: [], record: null, startCheck: false }
  const lines: string[] = []
  const auto = autoUpdateLine(cache)
  const notice = noticeLine(cache, current, now)
  if (auto) lines.push(auto)
  if (notice) lines.push(notice)
  const shownAuto = cache.auto
  const record = lines.length
    ? (cur: UpdateCache): Partial<UpdateCache> => ({
        // Mark only the Auto Update that was printed; a newer one written meanwhile stays to be said.
        ...(auto && cur.auto && cur.auto.at === shownAuto?.at && cur.auto.to === shownAuto.to
          ? { auto: { ...cur.auto, shown: true } }
          : {}),
        ...(notice ? { notified: { version: cache.latest!, at: now.toISOString() } } : {}),
      })
    : null
  return { lines, record, startCheck: checkDue(cache, now) || autoPending(cache, current, config, now) }
}

// ---- Install Method

/** Where the running copy comes from (spec §3.23 table); reads only paths. */
export async function installMethod(env: Env): Promise<InstallMethod> {
  const d = deps()
  const packageDir = await d.packageDir()
  const p = packageDir.split(sep).join('/')
  const at = (kind: InstallKind, extra: Partial<InstallMethod> = {}): InstallMethod => ({
    kind,
    packageDir,
    canUpdate: false,
    ...extra,
  })
  try {
    if (parseLocalBuild(JSON.parse(await readFile(join(packageDir, 'dist', 'build.json'), 'utf8'))))
      return at('local', {
        reason: 'it is a local build; run `pnpm local --off` in the sideby checkout to go back to npm',
      })
  } catch {
    // no build file: not a Local Build
  }
  if (p.includes('/_npx/'))
    return at('npx', { reason: 'it runs from the npx cache, which fetches a version per call' })
  // Volta keeps a global package under its own npm prefix; installing there behind its back breaks its records.
  if (p.includes('/.volta/')) return at('volta', { reason: 'Volta manages this install' })
  const npm = /^(.*)\/lib\/node_modules\/sideby$/.exec(p)
  if (npm) {
    const prefix = npm[1]!
    const blocked: string[] = []
    for (const dir of [dirname(packageDir), join(prefix, 'bin')])
      if (!(await d.writable(dir))) blocked.push(dir)
    return at('npm', {
      prefix,
      canUpdate: !blocked.length,
      ...(blocked.length
        ? { reason: `${blocked.join(' and ')} ${blocked.length > 1 ? 'are' : 'is'} not writable by you` }
        : {}),
    })
  }
  const pnpmHome = env.PNPM_HOME?.split(sep).join('/')
  if (p.includes('/pnpm/global/') || (pnpmHome && p.startsWith(`${pnpmHome.replace(/\/+$/, '')}/`)))
    return at('pnpm', { canUpdate: true })
  if (p.includes('/.bun/install/global/')) return at('bun', { canUpdate: true })
  if (p.includes('/node_modules/')) return at('project', { reason: 'it is a dependency of a project' })
  return at('source', { reason: 'it runs from a source checkout' })
}

/**
 * The command an Update runs (or that the user runs) for `version`; `run` is set only when sideby may run it. With
 * `SIDEBY_UPDATE_REGISTRY`, installs use that registry too, so the version the check found is the one fetched.
 */
export function updateCommand(
  method: InstallMethod,
  version: string,
  env: Env = {},
): { text: string; run?: { file: string; args: string[] } } {
  const spec = `sideby@${version}`
  const reg = env.SIDEBY_UPDATE_REGISTRY ? ['--registry', registryOf(env)] : []
  const shownReg = reg.length ? ` --registry ${shownRegistry(registryOf(env))}` : ''
  switch (method.kind) {
    case 'npm':
      return {
        text: `npm install -g ${spec}${shownReg}`,
        ...(method.canUpdate
          ? { run: { file: 'npm', args: ['install', '-g', '--prefix', method.prefix!, ...reg, spec] } }
          : {}),
      }
    case 'pnpm':
      return {
        text: `pnpm add -g ${spec}${shownReg}`,
        run: { file: 'pnpm', args: ['add', '-g', ...reg, spec] },
      }
    case 'bun':
      return {
        text: `bun add -g ${spec}${shownReg}`,
        run: { file: 'bun', args: ['add', '-g', ...reg, spec] },
      }
    case 'volta':
      return { text: `volta install ${spec}` }
    case 'npx':
      return { text: 'npx sideby@latest' }
    case 'project':
      return { text: `npm install ${spec}` }
    case 'source':
      return { text: 'git pull && pnpm install' }
    case 'local':
      return { text: 'pnpm local --off' }
  }
}

// ---- running sessions

const runningDir = (p: Paths) => join(p.stateDir, 'running')

/**
 * Records that this process runs a Host (`run`, `login`, `next`, `resume`) so an Auto Update waits for it; returns the
 * function that removes the record. Failing to write the record never stops a Launch.
 */
export async function markRunning(paths: Paths, pid = process.pid): Promise<() => Promise<void>> {
  const file = join(runningDir(paths), String(pid))
  try {
    await mkdir(runningDir(paths), { recursive: true, mode: 0o700 })
    await writeFileAtomic(file, `${deps().now().toISOString()}\n`, 0o600)
  } catch {
    return async () => {}
  }
  return () => rm(file, { force: true })
}

/** Pids of sideby processes that run a Host now; records of processes that ended are removed. */
export async function runningSessions(paths: Paths): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(runningDir(paths))
  } catch {
    return []
  }
  const out: number[] = []
  for (const name of names) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (deps().alive(pid)) out.push(pid)
    else await rm(join(runningDir(paths), name), { force: true })
  }
  return out
}

// ---- Update

export interface UpdatePlan {
  current: string
  latest: string
  available: boolean
  method: InstallMethod
  /** The command for the user to see; `canRun` says whether sideby runs it after a confirmation. */
  command: string
  canRun: boolean
  releaseNotes: string
  /** The installed sideby skill, which an Update brings along (absent when none is installed). */
  skill?: SkillUpdatePlan
}

export function planFrom(method: InstallMethod, current: string, latest: string, env: Env = {}): UpdatePlan {
  const cmd = updateCommand(method, latest, env)
  return {
    current,
    latest,
    available: isNewer(latest, current),
    method,
    command: cmd.text,
    canRun: Boolean(cmd.run),
    releaseNotes: RELEASE_NOTES(latest),
  }
}

/** The Install Method as outputs show it: no folder of this machine. */
export const shownMethod = (m: InstallMethod) => ({
  kind: m.kind,
  canUpdate: m.canUpdate,
  ...(m.reason ? { reason: m.reason } : {}),
})

/** The plan as `sideby update --json` and the Panel show it (schemas/update.json). */
export function shownPlan(plan: UpdatePlan) {
  return {
    current: plan.current,
    latest: plan.latest,
    available: plan.available,
    method: shownMethod(plan.method),
    command: plan.command,
    canRun: plan.canRun,
    releaseNotes: plan.releaseNotes,
    ...(plan.skill ? { skillUpdate: plan.skill } : {}),
  }
}

/** What an Update does to the installed sideby skill (spec §3.23, ADR-0021 amendment 2026-10-17). */
export interface SkillUpdatePlan {
  /** Versions of the installed skills (`null`: one without a version). */
  installed: (string | null)[]
  /** Some installed skill is for another version than the one sideby will run. */
  outdated: boolean
  command: string
  /** False when sideby must not run it; `reason` says why and the user runs `command` where it belongs. */
  canRun: boolean
  reason?: string
}

/** The skill part of an Update toward `target`; null when no sideby skill is installed. Reads two files. */
export async function skillUpdatePlan(home: string, target: string): Promise<SkillUpdatePlan | null> {
  const skills = await installedSkills(home)
  if (!skills.length) return null
  const installed = skills.map((s) => s.version)
  const plan: SkillUpdatePlan = {
    installed,
    outdated: installed.some((v) => v !== target),
    command: SKILL_UPDATE.join(' '),
    canRun: true,
  }
  for (const s of skills) {
    const root = await gitRootOf(s.dir)
    if (root) {
      const at = root.startsWith(home) ? `~${root.slice(home.length)}` : root
      return {
        ...plan,
        command: SKILL_INSTALL,
        canRun: false,
        reason: `the skill is in the git repository ${at}, so sideby leaves it alone; update it where that repository comes from`,
      }
    }
  }
  return plan
}

/** Asks the registry now (whatever the switches say: the user asked) and returns what an Update would do. */
export async function planUpdate(paths: Paths, env: Env): Promise<UpdatePlan> {
  const latest = await fetchLatest(env)
  const at = deps().now().toISOString()
  await updateUpdateCache(paths, { checkedAt: at, triedAt: at, latest }).catch(() => {})
  const plan = planFrom(await installMethod(env), packageVersion(), latest, env)
  const skill = await skillUpdatePlan(paths.home, plan.available ? latest : plan.current).catch(() => null)
  return skill ? { ...plan, skill } : plan
}

/** Updates the installed sideby skill when the plan says it is outdated and sideby may; null when it did nothing. */
export async function applySkillUpdate(
  plan: SkillUpdatePlan | undefined,
  env: Env,
  onOutput?: (text: string) => void,
): Promise<{ ok: boolean; message: string } | null> {
  if (!plan?.outdated || !plan.canRun) return null
  const [file, ...args] = SKILL_UPDATE
  const r = await deps()
    .exec(file, args, { env, ...(onOutput ? { onOutput } : {}) })
    .catch((e: unknown) => ({ code: 1, output: e instanceof Error ? e.message : String(e) }))
  return r.code === 0
    ? { ok: true, message: 'updated the sideby skill' }
    : { ok: false, message: `\`${plan.command}\` failed (exit ${r.code}); run it yourself to see why` }
}

export interface UpdateResult {
  ok: boolean
  /** Exit code of the install command; absent when it did not run. */
  code?: number
  output: string
  message: string
  /** A background Panel was running and is starting again from the new code. */
  restartedPanel: boolean
  /** The desktop app was installed and `sideby app install` ran again from the new code. */
  refreshedApp: boolean
  /** Another Update held the lock; nothing ran. */
  busy?: boolean
  /** The installed sideby skill was updated too (true), or that failed (false); absent when it was not tried. */
  skillUpdated?: boolean
  skillMessage?: string
}

/**
 * Runs the Update the plan names, then starts a running background Panel again from the new code and, when the
 * desktop app is installed, runs `sideby app install` again from the new code. The caller has
 * shown the plan and got a confirmation (or this is an Auto Update). One Update runs at a time on this machine (the
 * CLI, a Panel and an Auto Update share the lock). `panelPort` gives the port of the background Panel to restart, or
 * null when none runs. A successful Update is recorded as said, so no notice for it follows.
 */
export async function applyUpdate(
  paths: Paths,
  plan: UpdatePlan,
  env: Env,
  opts: { onOutput?: (text: string) => void; panelPort?: () => Promise<number | null> } = {},
): Promise<UpdateResult> {
  const cmd = updateCommand(plan.method, plan.latest, env)
  const fail = (message: string, extra: Partial<UpdateResult> = {}): UpdateResult => ({
    ok: false,
    output: '',
    message,
    restartedPanel: false,
    refreshedApp: false,
    ...extra,
  })
  if (!cmd.run)
    return fail(
      `sideby cannot update itself: ${plan.method.reason ?? 'unknown install'}; run \`${cmd.text}\` yourself`,
    )
  const release = await takeLock(paths, 'update-install.lock').catch(() => null)
  if (!release)
    return fail('another sideby update is running; wait for it to finish, then run `sideby update` again', {
      busy: true,
    })
  try {
    const d = deps()
    const r = await d.exec(cmd.run.file, cmd.run.args, {
      env,
      ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    })
    if (r.code !== 0)
      return fail(
        `\`${cmd.text}\` failed (exit ${r.code}); nothing else was changed. Run it yourself to see why${
          env.SIDEBY_UPDATE_REGISTRY ? ' (a mirror may not have this version yet)' : ''
        }`,
        { code: r.code, output: r.output },
      )
    await updateUpdateCache(paths, {
      notified: { version: plan.latest, at: d.now().toISOString() },
    }).catch(() => {})
    const port = opts.panelPort ? await opts.panelPort().catch(() => null) : null
    const restarted = port !== null && (await d.restartPanel(env, port).catch(() => false))
    // The desktop app records the Node and entry it starts and carries the icon of the version that wrote it, so
    // the new code writes it again. Only where one is installed; a failure here never fails the Update.
    const installed = await d.appInstalled(paths.home, env).catch(() => false)
    const refreshed = installed && (await d.refreshApp(env).catch(() => false))
    // The skill teaches agents this version's commands, so it follows the CLI; a failure there keeps the Update.
    const skill = await applySkillUpdate(plan.skill, env, opts.onOutput)
    return {
      ok: true,
      code: 0,
      output: r.output,
      message: `updated sideby from ${plan.current} to ${plan.latest}`,
      restartedPanel: restarted,
      refreshedApp: refreshed,
      ...(skill ? { skillUpdated: skill.ok, skillMessage: skill.message } : {}),
    }
  } finally {
    await release().catch(() => {})
  }
}

/** What keeps an Auto Update from installing `plan` until the user acts (an install it cannot update, a major version). */
export function lastingBlocker(plan: UpdatePlan): string | null {
  if (!plan.available) return 'already up to date'
  if (!plan.canRun)
    return `${plan.method.reason ?? 'this install cannot update itself'}; run \`${plan.command}\` yourself`
  if (!sameLine(plan.current, plan.latest))
    return `${plan.latest} is a new major version; update by hand with \`sideby update\``
  return null
}

/**
 * Whether an Auto Update may install `plan` now (spec §3.23), and if not, why. Running sessions are looked up
 * last because that removes records of ended processes.
 */
export async function autoUpdateBlocker(paths: Paths, plan: UpdatePlan): Promise<string | null> {
  const lasting = lastingBlocker(plan)
  if (lasting) return lasting
  const running = await runningSessions(paths)
  if (running.length) return `a session is running (pid ${running.join(', ')})`
  return null
}

/**
 * Body of the detached `sideby update-check`: an Update Check when one is due, then an Auto Update when config
 * `update.auto` is on and nothing blocks it. Only one runs at a time; it never throws.
 */
export async function backgroundCheck(
  paths: Paths,
  env: Env,
  config: UpdateSettings,
  panelPort: () => Promise<number | null>,
): Promise<void> {
  if (checksOff(env, config)) return
  const release = await takeLock(paths, 'update.lock').catch(() => null)
  if (!release) return
  try {
    const now = deps().now()
    let cache = await readUpdateCache(paths)
    if (checkDue(cache, now)) cache = await refreshUpdateCheck(paths, env)
    const current = packageVersion()
    if (!autoPending(cache, current, config, now)) return
    const plan = planFrom(await installMethod(env), current, cache.latest!, env)
    await updateUpdateCache(paths, { autoTriedAt: now.toISOString() })
    // A blocker only the user can lift is said once and looked at again a day later, like a failed install; a
    // running session only delays it (the next look is within the hour).
    const lasting = lastingBlocker(plan)
    if (lasting) {
      await updateUpdateCache(paths, {
        auto: { from: current, to: plan.latest, at: now.toISOString(), ok: false, message: lasting },
      })
      return
    }
    if (await autoUpdateBlocker(paths, plan)) return
    const r = await applyUpdate(paths, plan, env, { panelPort })
    // A manual Update holding the lock is not a failed Auto Update; the next look comes within the hour.
    if (r.busy) return
    await updateUpdateCache(paths, {
      auto: { from: current, to: plan.latest, at: deps().now().toISOString(), ok: r.ok, message: r.message },
    })
  } catch {
    // a background check is best effort
  } finally {
    await release().catch(() => {})
  }
}
