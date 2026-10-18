// `sideby plugins check` (spec §3.28 "加一个新宿主"): deterministic checks a Family Plugin must pass before anyone else
// runs it. A plugin the loader would not trust is only read, never run. A trusted one is loaded with the real loader
// in a child Node process whose HOME and XDG folders point at a throwaway HOME. That keeps the check's own writes out
// of the user's Accounts; it is not a sandbox: the plugin runs with the user's full permissions, as it would in sideby.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type FakeHome, fakeHost, withFakeHome } from '../../testing/index.ts'
import { SHARE_MODES } from '../core/share-mode-names.ts'
import { BUILTIN_PLUGINS } from '../families/index.ts'
import { createRuntime } from '../runtime.ts'
import type { Env, FamilyDef, Plugin, PluginApi } from '../types.ts'
import { type BuiltinPlugin, checkTrustedTree, logoProblem, type PluginManifest } from './loader.ts'
import { FAMILY_ID_RE, TODO_MARK } from './scaffold.ts'

export interface PluginProblem {
  /** Stable machine code such as `shared-item.parent`. */
  code: string
  message: string
  /** One sentence saying what to change. */
  fix: string
}

export interface PluginCheckResult {
  ok: boolean
  /** The plugin's name, when its manifest or export could be read. */
  plugin?: string
  /** Family ids the plugin registered. */
  families: string[]
  problems: PluginProblem[]
}

/** Name of the Account the check creates next to the Main Account in its throwaway HOME. */
const CHECK_ACCOUNT = 'check'
const SKIP_DIRS = new Set(['node_modules', '.git'])
/** How long the child process may take to load and check a plugin before its process group is killed. */
const CHECK_TIMEOUT_MS = 20_000
/** The most the child may report; more is treated as a broken check. */
const MAX_REPORT_BYTES = 64 * 1024
const MAX_SCAN_BYTES = 1_000_000
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Checks the Family Plugin in `dir` (the folder holding `plugin.json`): manifest, trust (owner, modes), that it
 * only `import type`s from sideby, and a leak scan for home paths, personal emails and token-shaped strings. When the
 * loader would trust it, also its FamilyDef fields and a discover / launch / doctor round, run by {@link checkRound} in
 * a child process with a throwaway HOME, killed after `timeoutMs` (20 s). An untrusted plugin is never copied,
 * changed or run. Never throws for a broken plugin: every problem is in `problems`, each with a `fix`.
 */
export async function checkPlugin(opts: { dir: string; timeoutMs?: number }): Promise<PluginCheckResult> {
  const { dir } = opts
  const problems: PluginProblem[] = []
  const done = (plugin?: string, families: string[] = []): PluginCheckResult => ({
    ok: problems.length === 0,
    ...(plugin ? { plugin } : {}),
    families,
    problems,
  })
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory')
  } catch {
    problems.push({
      code: 'plugin.missing',
      message: `${dir} is not a plugin directory`,
      fix: 'Create it with `sideby plugins new <id>`, or pass the folder that holds plugin.json.',
    })
    return done()
  }
  let manifest: PluginManifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8')) as PluginManifest
    if (typeof manifest?.name !== 'string' || !manifest.name) throw new Error('no name')
  } catch {
    problems.push({
      code: 'manifest.invalid',
      message: `${join(dir, 'plugin.json')} is missing, not JSON, or has no "name"`,
      fix: 'Write plugin.json as {"name": "<id>", "version": "0.1.0", "main": "index.ts"}.',
    })
    return done()
  }
  const trust = await checkTrustedTree(dir)
  problems.push(...(await scanSources(dir)))
  if (trust) {
    // The loader would refuse it, so the check does not run it either: only the checks above, which read files.
    problems.push({
      code: 'trust',
      message: `the loader would refuse this plugin, so it was not run: ${trust}`,
      fix: `Own every file yourself and keep them private (\`chmod -R go-w "${dir}"\`), then check it again to run the rest.`,
    })
    return done(manifest.name)
  }
  const report = await withFakeHome((h) =>
    runRound(
      { dir, main: manifest.main ?? 'index.ts', home: h.home, bin: h.bin, env: h.env },
      opts.timeoutMs,
    ),
  )
  problems.push(...report.problems)
  return done(manifest.name, report.families)
}

interface RoundJob {
  dir: string
  main: string
  home: string
  bin: string
  env: Env
}

interface RoundReport {
  families: string[]
  problems: PluginProblem[]
}

/**
 * Runs {@link checkRound} in a child Node process with `job.env` (the throwaway HOME) as its whole environment, in
 * its own process group so a timeout kills whatever the plugin started. The report comes back on fd 3, capped at
 * {@link MAX_REPORT_BYTES}; the plugin's own stdout and stderr are discarded.
 */
function runRound(job: RoundJob, timeoutMs = CHECK_TIMEOUT_MS): Promise<RoundReport> {
  const self = import.meta.url
  const code = `const m = await import(${JSON.stringify(self)}); await m.checkRoundMain(process.argv[1])`
  return new Promise((resolve) => {
    const failed = (code: string, message: string, fix: string): RoundReport => ({
      families: [],
      problems: [{ code, message, fix }],
    })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(job)], {
        env: job.env as NodeJS.ProcessEnv,
        cwd: job.home,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve(
        failed(
          'check.crashed',
          `could not start the check: ${(err as Error).message}`,
          'Check that Node can run from this folder, then check the plugin again.',
        ),
      )
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let outcome: RoundReport | null = null
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    const finish = (r: RoundReport) => {
      outcome ??= r
      clearTimeout(timer)
      killGroup()
    }
    const timer = setTimeout(
      () =>
        finish(
          failed(
            'check.timeout',
            `loading and checking the plugin did not finish within ${Math.round(timeoutMs / 1000)} s, so it was stopped`,
            'Keep register() and the readers free of loops and waits at load time (do slow work only when a reader is called), then check it again.',
          ),
        ),
      timeoutMs,
    )
    child.stdout!.resume()
    child.stderr!.resume()
    const report = child.stdio[3] as NodeJS.ReadableStream
    report.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_REPORT_BYTES)
        return finish(
          failed(
            'check.output',
            `the check reported more than ${MAX_REPORT_BYTES / 1024} KiB`,
            'Keep error messages short: a reader should throw one sentence, not a whole file. Then check it again.',
          ),
        )
      chunks.push(d)
    })
    child.on('error', (err) =>
      finish(
        failed(
          'check.crashed',
          `could not start the check: ${err.message}`,
          'Check that Node can run from this folder, then check the plugin again.',
        ),
      ),
    )
    child.on('close', (exit, signal) => {
      if (outcome) return resolve(outcome)
      let parsed: RoundReport | null = null
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RoundReport
        if (Array.isArray(data.families) && Array.isArray(data.problems)) parsed = data
      } catch {
        // no report: the process ended before it wrote one
      }
      finish(
        parsed ??
          failed(
            'check.crashed',
            `the plugin ended the check (${signal ?? `exit code ${exit}`}) before it finished`,
            'Do not call process.exit or end the process in the plugin; run its tests (`node --test` in its folder) to find where, then check it again.',
          ),
      )
      resolve(outcome!)
    })
  })
}

/**
 * The child side of {@link runRound}: reads the job, runs {@link checkRound} and writes its report to fd 3, then
 * exits so a timer or handle the plugin left open cannot keep it alive.
 */
export async function checkRoundMain(arg: string | undefined): Promise<void> {
  const job = JSON.parse(arg ?? '{}') as RoundJob
  const report = await checkRound(job)
  const out = createWriteStream('', { fd: 3 })
  out.end(JSON.stringify(report), () => process.exit(0))
}

/** The FakeHome helpers for a throwaway HOME made by the parent process. */
function fakeHomeAt(home: string, bin: string, env: Env): FakeHome {
  return {
    home,
    bin,
    env,
    path: (...parts) => join(home, ...parts),
    async write(rel, data, mode = 0o644) {
      const p = join(home, rel)
      await mkdir(join(p, '..'), { recursive: true })
      await writeFile(p, data, { mode })
      await chmod(p, mode)
      return p
    },
    async mkdir(rel) {
      const p = join(home, rel)
      await mkdir(p, { recursive: true })
      return p
    },
  }
}

/** Loads the trusted plugin in `job.dir` into a runtime on the throwaway HOME, then its field checks and rounds. */
async function checkRound(job: RoundJob): Promise<RoundReport> {
  const problems: PluginProblem[] = []
  const h = fakeHomeAt(job.home, job.bin, job.env)
  await h.write('.config/sideby/config.json', JSON.stringify({ pluginDirs: [job.dir] }))
  const loaded = await loadedFamilies(h, BUILTIN_PLUGINS, job.dir, (s) => s, problems)
  if (!loaded) return { families: [], problems }
  let mod: { default?: Plugin }
  try {
    mod = (await import(pathToFileURL(join(job.dir, job.main)).href)) as { default?: Plugin }
  } catch {
    return { families: loaded, problems }
  }
  if (mod.default) await checkDefs(mod.default, problems)
  for (const id of loaded) await round(h, BUILTIN_PLUGINS, id, problems)
  return { families: loaded, problems }
}

/**
 * `checkPlugin` for a Plugin that ships inside sideby: `dir` is its source folder, scanned for leaks. The same field
 * checks and discover / launch / doctor round run; it loads as the only built-in.
 */
export async function checkBuiltinPlugin(opts: { plugin: Plugin; dir: string }): Promise<PluginCheckResult> {
  const problems: PluginProblem[] = [...(await scanSources(opts.dir))]
  const builtins: BuiltinPlugin[] = [
    { plugin: opts.plugin, version: '0.0.0-check', description: 'check', defaultEnabled: true },
  ]
  const families = await withFakeHome(async (h) => {
    const loaded = await loadedFamilies(h, builtins, 'builtin', (s) => s, problems)
    if (!loaded) return []
    await checkDefs(opts.plugin, problems)
    for (const id of loaded) await round(h, builtins, id, problems)
    return loaded
  })
  return { ok: problems.length === 0, plugin: opts.plugin.name, families, problems }
}

/** Loads the plugins into a runtime on the fake HOME; the Family ids `source` registered, or null when it failed. */
async function loadedFamilies(
  h: FakeHome,
  builtins: BuiltinPlugin[],
  source: string,
  said: (s: string) => string,
  problems: PluginProblem[],
): Promise<string[] | null> {
  const rt = await createRuntime({ env: h.env, builtins })
  const mine = rt.plugins.find((p) => p.source === source)
  // A dropped logo is reported by defProblems as `logo.invalid`, with its own fix.
  const errors = rt.pluginErrors.filter(
    (e) =>
      (e.where === source || e.where === mine?.name || !mine) &&
      !e.message.endsWith('showing its initials instead'),
  )
  for (const e of errors)
    problems.push({
      code: 'load.failed',
      message: said(e.message),
      fix: 'Fix what the message names in the plugin, then check it again.',
    })
  if (!mine) {
    if (errors.length === 0)
      problems.push({
        code: 'load.failed',
        message: 'sideby did not load the plugin',
        fix: 'Export `{ name, register(api) }` as the default export, with the name plugin.json has.',
      })
    return null
  }
  if (mine.families.length === 0)
    problems.push({
      code: 'family.none',
      message: `plugin ${mine.name} registers no Family`,
      fix: "Call `api.family(def)` in register() with the Host's FamilyDef.",
    })
  return mine.families
}

/** Calls the Plugin's register() with a recording `api`, to see each FamilyDef as written, before the loader cleans it. */
async function checkDefs(plugin: Plugin, problems: PluginProblem[]): Promise<void> {
  const defs: unknown[] = []
  const api: PluginApi = {
    family: (def) => void defs.push(def),
    on: () => {},
    abort: (message) => new Error(message),
    fs: { writeFileAtomic: async () => {} },
  }
  try {
    await plugin.register(api)
  } catch {
    // The loader already reported it.
    return
  }
  for (const def of defs) problems.push(...defProblems(def))
}

const isRelativeInside = (p: string) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..')

/** What is missing or wrong in one FamilyDef, as written by the Plugin. */
export function defProblems(raw: unknown): PluginProblem[] {
  const out: PluginProblem[] = []
  const def = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const id = typeof def.id === 'string' ? def.id : '?'
  const at = `family ${id}`
  const field = (name: string, message: string, fix: string) =>
    out.push({ code: `field.${name}`, message: `${at}: ${message}`, fix })
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''

  if (typeof def.id !== 'string' || !FAMILY_ID_RE.test(def.id))
    field(
      'id',
      'id must be lowercase letters, digits or "-", starting with a letter',
      'Set `id` to a short name such as "mytool".',
    )
  if (!nonEmpty(def.title))
    field('title', 'title is missing', "Set `title` to the Host's name as its docs write it.")
  if (!nonEmpty(def.bin) || /[\\/\s]/.test(def.bin as string))
    field(
      'bin',
      'bin must be the executable name, without a folder',
      'Set `bin` to the command the Host installs on PATH.',
    )
  if (!nonEmpty(def.installUrl) || !/^https?:\/\/\S+$/.test(def.installUrl as string))
    field(
      'installUrl',
      'installUrl must be an http(s) link',
      "Set `installUrl` to the Host's official install page.",
    )
  if (!nonEmpty(def.selectVar))
    out.push({
      code: 'select-var.missing',
      message: `${at}: selectVar is missing, so every Account would share one config directory`,
      fix: "Set `selectVar` to the environment variable that moves the Host's config directory (its docs or --help).",
    })
  else if (!ENV_NAME_RE.test(def.selectVar as string))
    field(
      'selectVar',
      'selectVar is not an environment variable name',
      'Use letters, digits and "_" only, such as MYTOOL_HOME.',
    )

  const layout = (typeof def.layout === 'object' && def.layout !== null ? def.layout : {}) as Record<
    string,
    unknown
  >
  const main = layout.main
  const account = layout.account
  if (!nonEmpty(main) || !isRelativeInside(main as string))
    field(
      'layout',
      'layout.main must be a path relative to HOME, without ".."',
      'Set `layout.main` such as ".mytool".',
    )
  if (
    !nonEmpty(account) ||
    !isRelativeInside(account as string) ||
    !(account as string).split('/')[0]!.includes('<name>')
  )
    field(
      'layout',
      'layout.account must be relative to HOME, without "..", with <name> in its first segment',
      'Set `layout.account` such as ".mytool-<name>".',
    )

  for (const key of ['hijackVars', 'apiVars'] as const) {
    const v = def[key]
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !ENV_NAME_RE.test(x)))
      field(
        key,
        `${key} must be a list of environment variable names`,
        `Set \`${key}\` to a list such as ["MYTOOL_API_KEY"], or [] when there are none.`,
      )
  }

  if (!Array.isArray(def.sharedItems))
    field(
      'sharedItems',
      'sharedItems must be a list',
      'Set `sharedItems` to the files the Accounts share, or [] when there are none.',
    )
  else
    for (const item of def.sharedItems as unknown[]) {
      const it = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
      const path = typeof it.path === 'string' ? it.path : ''
      if (!path) {
        field(
          'sharedItems',
          'a Shared Item has no path',
          'Give every Shared Item a `path` relative to the Account directory.',
        )
        continue
      }
      if (isAbsolute(path))
        out.push({
          code: 'shared-item.absolute',
          message: `${at}: Shared Item ${path} is an absolute path`,
          fix: `Write it relative to the Account directory, such as "${basename(path)}".`,
        })
      else if (path.split(/[\\/]/).includes('..'))
        out.push({
          code: 'shared-item.parent',
          message: `${at}: Shared Item ${path} leaves the Account directory with ".."`,
          fix: 'Keep the path inside the Account directory; a file elsewhere in HOME goes in `mainPath`.',
        })
      if (!(SHARE_MODES as readonly unknown[]).includes(it.mode))
        field(
          'sharedItems',
          `Shared Item ${path} has no valid mode`,
          `Set \`mode\` to one of ${SHARE_MODES.join(', ')}.`,
        )
      if (it.mode === 'json-key' && !nonEmpty(it.key))
        field(
          'sharedItems',
          `Shared Item ${path} is json-key without a key`,
          'Set `key` to the top-level JSON key the Accounts share.',
        )
      if (it.mainPath !== undefined && (typeof it.mainPath !== 'string' || !isRelativeInside(it.mainPath)))
        out.push({
          code: 'shared-item.parent',
          message: `${at}: Shared Item ${path} has a mainPath outside HOME`,
          fix: 'Write `mainPath` relative to HOME, without "..".',
        })
    }

  const login = (typeof def.login === 'object' && def.login !== null ? def.login : null) as Record<
    string,
    unknown
  > | null
  if (
    !login ||
    !nonEmpty(login.hint) ||
    !(login.args === null || (Array.isArray(login.args) && login.args.every((a) => typeof a === 'string')))
  )
    field(
      'login',
      'login must be { args: string[] | null, hint }',
      "Set `login.args` to the Host's sign-in arguments (null when it signs in inside the app) and `login.hint` to one sentence.",
    )

  if (def.logo !== undefined) {
    const problem = logoProblem(def.logo)
    if (problem)
      out.push({
        code: 'logo.invalid',
        message: `${at}: ${problem}`,
        fix: 'Use one 24x24 SVG path from an icon set whose license allows it, or leave `logo` out.',
      })
  }
  return out
}

/** A discover / launch env / doctor round for one Family in the fake HOME: a Main Account and one other Account. */
async function round(
  h: FakeHome,
  builtins: BuiltinPlugin[],
  id: string,
  problems: PluginProblem[],
): Promise<void> {
  const rt = await createRuntime({ env: h.env, builtins })
  const def = rt.families.get(id)
  if (!def) return
  const step = async (code: string, what: string, fn: () => Promise<void>) => {
    try {
      await fn()
      return true
    } catch (err) {
      problems.push({
        code,
        message: `family ${id}: ${what} failed: ${(err as Error)?.message ?? String(err)}`,
        fix: 'Make the reader handle a missing or empty file by returning undefined instead of throwing.',
      })
      return false
    }
  }
  const layoutOk = defProblems(def).every((p) => p.code !== 'field.layout' && p.code !== 'field.bin')
  if (!layoutOk) return
  await fakeHost(h, def.bin)
  await h.mkdir(def.layout.main)
  for (const item of def.sharedItems) await seed(h, def, item.path, item)
  const accountDir = def.layout.account.replace('<name>', CHECK_ACCOUNT)
  await h.mkdir(accountDir)

  let refs: string[] = []
  const found = await step('round.discover', 'finding Accounts', async () => {
    const all = await rt.accounts()
    refs = all.filter((a) => a.family === id).map((a) => a.ref)
    for (const a of all.filter((x) => x.family === id)) {
      const s = await rt.status(a)
      if (s.problems?.length) throw new Error(s.problems.join('; '))
    }
  })
  const ref = `${id}:${CHECK_ACCOUNT}`
  if (found && (!refs.includes(`${id}:main`) || !refs.includes(ref)))
    problems.push({
      code: 'round.discover',
      message: `family ${id}: sideby found ${refs.join(', ') || 'no Accounts'} in ~/${def.layout.main} and ~/${accountDir}, not both`,
      fix: 'Check `layout` and `markers`: an Account directory counts when it holds proxy.env, a marker, or nothing at all.',
    })
  if (refs.includes(ref))
    await step('round.launch', 'preparing a launch', async () => {
      const launch = await rt.prepareLaunch(ref, [], 'run')
      if (launch.env[def.selectVar] !== h.path(accountDir))
        throw new Error(`${def.selectVar} does not point at the Account directory`)
    })
  await step('round.doctor', 'doctor', async () => {
    await rt.doctor({ target: id, persist: false })
  })
}

/** One source per Shared Item in the Main Account, so doctor has something to compare. */
async function seed(h: FakeHome, def: FamilyDef, path: string, item: FamilyDef['sharedItems'][number]) {
  if (!isRelativeInside(path) || (item.mainPath !== undefined && !isRelativeInside(item.mainPath))) return
  const rel = item.mainPath ?? join(def.layout.main, path)
  const mode = item.credential ? 0o600 : 0o644
  if (item.mode === 'json-key') await h.write(rel, `${JSON.stringify({ [item.key ?? 'x']: {} })}\n`, mode)
  // A name with an extension is a file; a bare name (skills, hooks) is a folder.
  else if (/\.[A-Za-z0-9]+$/.test(path)) await h.write(rel, path.endsWith('.json') ? '{}\n' : '\n', mode)
  else await h.mkdir(rel)
}

/** Every text file under `dir` with its path relative to `dir`, skipping dependencies and VCS data. */
async function sourceFiles(dir: string): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = []
  async function walk(d: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        const buf = await readFile(p).catch(() => null)
        if (!buf || buf.length > MAX_SCAN_BYTES || buf.includes(0)) continue
        out.push({ rel: relative(dir, p), text: buf.toString('utf8') })
      }
    }
  }
  await walk(dir)
  return out
}

const isTest = (rel: string) => /\.test\.[cm]?[jt]s$/.test(rel)
const isCode = (rel: string) => /\.[cm]?[jt]sx?$/.test(rel)

// Built from pieces so this file itself does not look like a home path to scripts/leak-check.sh.
const HOME_PATH_RE = new RegExp(
  `/${'Users'}/[A-Za-z0-9._-]+/|/home/[a-z][a-z0-9_-]+/|[A-Za-z]:\\\\Users\\\\[^\\\\]+`,
)
const B = '(?:^|[^A-Za-z0-9_-])'
/** The token shapes scripts/leak-check.sh rejects. */
const TOKEN_RE = new RegExp(
  [
    `${B}sk-[A-Za-z0-9_-]{20,}`,
    'xai-[A-Za-z0-9]{20,}',
    'gh[pousr]_[A-Za-z0-9]{36}',
    'github_pat_[A-Za-z0-9_]{60,}',
    'npm_[A-Za-z0-9]{36}',
    'AKIA[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_-]{35}',
    'xox[abp]-[A-Za-z0-9-]{10,}',
    '-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}',
    'hooks\\.slack\\.com/services/[A-Za-z0-9/]+',
    'open\\.feishu\\.cn/open-apis/bot/v2/hook/[a-f0-9-]{20,}',
  ].join('|'),
)
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
/** Domains reserved for examples (RFC 2606) and placeholder senders. */
const EXAMPLE_DOMAIN_RE = /(?:^|\.)(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i
// `import x from 'sideby'`, `import { type X } from 'sideby/testing'`, `export { x } from 'sideby'`: anything but a
// whole-statement `import type` / `export type` keeps a runtime import of sideby, which a plugin cannot resolve.
const SIDEBY_FROM_RE = /^\s*(import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]sideby(?:\/[^'"]*)?['"]/gm
const SIDEBY_CALL_RE = /\b(?:import|require)\s*\(\s*['"]sideby(?:\/[^'"]*)?['"]\s*\)/g
const SIDE_EFFECT_RE = /^\s*import\s*['"]sideby(?:\/[^'"]*)?['"]/gm

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/**
 * The plugin's sources against the rules that need no loading: value imports from sideby, TODOs left from the
 * skeleton, and the leak scan. Messages give the file and line only, never the matched value.
 */
export async function scanSources(dir: string): Promise<PluginProblem[]> {
  const out: PluginProblem[] = []
  for (const { rel, text } of await sourceFiles(dir)) {
    if (isCode(rel) && !isTest(rel)) {
      for (const re of [SIDEBY_FROM_RE, SIDEBY_CALL_RE, SIDE_EFFECT_RE])
        for (const m of text.matchAll(re))
          out.push({
            code: 'import.value',
            message: `${rel}:${lineOf(text, m.index)} imports a value from sideby`,
            fix: "Use `import type` for sideby's types and take everything else from the `api` register() receives.",
          })
      const todo = text.indexOf(TODO_MARK)
      if (todo !== -1)
        out.push({
          code: 'todo.left',
          message: `${rel}:${lineOf(text, todo)} still has a ${TODO_MARK} from the skeleton`,
          fix: 'Fill it in from the Host\'s docs or --help, note the source as "<tool> <version>, <date>", and delete the TODO line.',
        })
    }
    text.split('\n').forEach((line, i) => {
      const where = `${rel}:${i + 1}`
      if (HOME_PATH_RE.test(line))
        out.push({
          code: 'leak.home-path',
          message: `${where} has a path inside someone's home folder`,
          fix: 'Write it relative to HOME (`join(home, ...)`, `~/...`) or use a placeholder such as <home>.',
        })
      if (TOKEN_RE.test(line))
        out.push({
          code: 'leak.token',
          message: `${where} has a string shaped like a key or token`,
          fix: 'Delete it and revoke it if it was real; tests use a fake value that does not match a real key format.',
        })
      for (const m of line.matchAll(EMAIL_RE))
        if (m[1] !== 'git' && !EXAMPLE_DOMAIN_RE.test(m[2]!))
          out.push({
            code: 'leak.email',
            message: `${where} has an email address`,
            fix: 'Use a placeholder such as me@example.com.',
          })
    })
  }
  return out
}
