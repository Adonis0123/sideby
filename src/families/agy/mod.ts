// WHY: ADR-0088 terminal `agy` Launch Mod. Writes a session-scoped `--settings` JSON under `<state>/agy-launch/`
// (never into `~/.gemini/antigravity-cli/`) to wire `sideby agy-statusline` and `sideby agy-title`.
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGY_LAUNCH_PID_VAR, AGY_LIVE_DIR, AGY_ORIG_FLAG } from '../../agy/statusline.ts'
import { linksTo, lstatOrNull, ownedFolder, readSmallFile, writeFileAtomic } from '../../core/fs-safe.ts'
import type { Env } from '../../types.ts'
import { AGY_DIR_FLAGS } from './layout.ts'

export const AGY_LAUNCH_DIR = 'agy-launch'
const SETTINGS_MAX_BYTES = 1024 * 1024
const STALE_LAUNCH_MS = 24 * 60 * 60 * 1000
const LAUNCH_PID_FILE = /^launch-(\d+)-[0-9a-f]+\.json$/
const LIVE_PID_FILE = /^(\d+)\.json$/

export const AGY_VALUED_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--app_data_dir',
  '-app_data_dir',
  '--app-data-dir',
  '-app-data-dir',
  '--conversation',
  '--effort',
  '--gemini_dir',
  '-gemini_dir',
  '--gemini-dir',
  '-gemini-dir',
  '-i',
  '--prompt-interactive',
  '--input-format',
  '--json-schema',
  '--log-file',
  '--mode',
  '--model',
  '--output-format',
  '--print-timeout',
  '--project',
  '-r',
  '--resume',
  '--settings',
])

export const AGY_HEADLESS_FLAGS = new Set(['-p', '--print', '--prompt'])
/** WHY: valued options (and headless flags taking an inline prompt) whose argument must be skipped when scanning for directory flags (ADR-0090). */
export const AGY_SKIP_VALUE_FLAGS = new Set(
  [...AGY_VALUED_FLAGS, ...AGY_HEADLESS_FLAGS].filter(
    (f) => !(AGY_DIR_FLAGS as readonly string[]).includes(f),
  ),
)
export const AGY_NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'acp',
  'agentapi',
  'mcp',
  'plugin',
  'plugins',
  'update',
  'install',
  'models',
  'agent',
  'agents',
  'changelog',
  'remote-control',
  'mic-serve',
  'help',
])

export interface AgyArgInfo {
  headless: boolean
  helpOrVersion: boolean
  hasSettings: boolean
  subcommand?: string
}

/**
 * WHY: shared arg classifier for both Launch Mod (`mod.ts`) and Live Session discovery (`live-sessions.ts`) so
 * headless runs, `--settings`, and subcommands are detected identically (ADR-0088).
 */
export function classifyAgyArgs(argv: readonly string[]): AgyArgInfo {
  let headless = false
  let helpOrVersion = false
  let hasSettings = false
  let subcommand: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') break
    if (a === '-h' || a === '--help' || a === '-v' || a === '--version') {
      helpOrVersion = true
      continue
    }
    if (a === '--settings' || a.startsWith('--settings=')) {
      hasSettings = true
      if (a === '--settings') i++
      continue
    }
    if (
      AGY_HEADLESS_FLAGS.has(a) ||
      a.startsWith('-p=') ||
      a.startsWith('--print=') ||
      a.startsWith('--prompt=')
    ) {
      headless = true
      if (AGY_HEADLESS_FLAGS.has(a)) i++
      continue
    }
    if (a.startsWith('-')) {
      if (AGY_VALUED_FLAGS.has(a)) i++
      continue
    }
    if (subcommand === undefined) subcommand = a
  }
  return {
    headless,
    helpOrVersion,
    hasSettings,
    ...(subcommand ? { subcommand } : {}),
  }
}

export function sidebyAgyHelperCommand(
  entry: 'agy-statusline' | 'agy-title',
  origCmd?: string,
  argv1: string | undefined = process.argv[1],
): string {
  const real = fileURLToPath(
    new URL(`../../cli/main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  )
  let main = real
  try {
    if (argv1 && realpathSync(argv1) === realpathSync(real)) main = argv1
  } catch {
    // WHY: fall back to the resolved entry path when argv[1] cannot be resolved (ADR-0088).
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const safe = (s: string) => !/["\\\n]/.test(s)
  const bin = safe(process.execPath) && safe(main) ? `${q(process.execPath)} ${q(main)}` : 'sideby'
  const orig = origCmd?.trim() ? ` ${AGY_ORIG_FLAG} ${Buffer.from(origCmd, 'utf8').toString('base64')}` : ''
  return `${bin} ${entry}${orig}`
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function pidGone(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function pruneStaleFiles(stateDir: string, nowMs: number): Promise<void> {
  const launchDir = await ownedFolder(stateDir, [AGY_LAUNCH_DIR], { create: false }).catch(() => null)
  if (launchDir) {
    for (const name of await readdir(launchDir).catch(() => [] as string[])) {
      const m = LAUNCH_PID_FILE.exec(name)
      if (!m) continue
      const file = join(launchDir, name)
      const st = await lstatOrNull(file)
      if (!st || st.isSymbolicLink() || !st.isFile()) continue
      if (pidGone(Number(m[1])) || nowMs - st.mtimeMs > STALE_LAUNCH_MS) {
        await rm(file, { force: true }).catch(() => {})
      }
    }
  }
  const liveDir = await ownedFolder(stateDir, [AGY_LIVE_DIR], { create: false }).catch(() => null)
  if (liveDir) {
    for (const name of await readdir(liveDir).catch(() => [] as string[])) {
      const m = LIVE_PID_FILE.exec(name)
      if (!m) continue
      const file = join(liveDir, name)
      const st = await lstatOrNull(file)
      if (!st || st.isSymbolicLink() || !st.isFile()) continue
      if (pidGone(Number(m[1]))) await rm(file, { force: true }).catch(() => {})
    }
  }
}

async function readUserSettings(accountDir: string, mainDir?: string): Promise<Record<string, unknown>> {
  const file = join(accountDir, 'settings.json')
  const st = await lstatOrNull(file)
  let raw: string | undefined
  if (st?.isFile() && !st.isSymbolicLink()) {
    raw = await readSmallFile(file, SETTINGS_MAX_BYTES)
  } else if (st?.isSymbolicLink() && mainDir) {
    // WHY: newly created agy extra Accounts link settings.json to Main (link-or-local); follow only that verified link (ADR-0090).
    const mainFile = join(mainDir, 'settings.json')
    if (await linksTo(file, mainFile)) raw = await readSmallFile(mainFile, SETTINGS_MAX_BYTES)
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function unwrapSelfCmd(cmd: unknown, entry: 'agy-statusline' | 'agy-title'): string | undefined {
  if (typeof cmd !== 'string') return undefined
  const trimmed = cmd.trim()
  if (!trimmed) return undefined
  // WHY: avoid double-wrapping if the user already configured sideby's helper in settings.json (ADR-0088).
  if (trimmed.includes(` ${entry}`) || trimmed.startsWith(entry)) return undefined
  return trimmed
}

export interface AgyModResult {
  args: string[]
  env?: Env
  settingsFile?: string
  cleanup?: (hostPid?: number) => Promise<void>
}

export async function withAgyMod(
  args: readonly string[],
  opts: {
    accountDir: string
    mainDir?: string
    stateDir: string
    accountTitle?: boolean
    now?: Date
    argv1?: string
    warn?: (message: string) => void
  },
): Promise<AgyModResult> {
  const info = classifyAgyArgs(args)
  if (
    info.headless ||
    info.helpOrVersion ||
    info.hasSettings ||
    (info.subcommand && AGY_NON_INTERACTIVE_SUBCOMMANDS.has(info.subcommand))
  ) {
    return { args: [...args] }
  }

  const user = await readUserSettings(opts.accountDir, opts.mainDir)
  const userStatus = isPlainObject(user.statusLine) ? user.statusLine : undefined
  const userTitle = isPlainObject(user.title) ? user.title : undefined
  const settings: Record<string, unknown> = {}

  if (userStatus?.enabled !== false) {
    const origStatus = unwrapSelfCmd(userStatus?.command, 'agy-statusline')
    const statusLine: Record<string, unknown> = {
      type: typeof userStatus?.type === 'string' ? userStatus.type : 'command',
      command: sidebyAgyHelperCommand('agy-statusline', origStatus, opts.argv1),
    }
    if (typeof userStatus?.padding === 'number') statusLine.padding = userStatus.padding
    if (typeof userStatus?.stack_with_default === 'boolean') {
      statusLine.stack_with_default = userStatus.stack_with_default
    } else if (!origStatus) {
      statusLine.stack_with_default = true
    }
    settings.statusLine = statusLine
  }

  // WHY: coordinate with config `accountTitle` so sideby's OSC 0 title loop does not fight agy's title hook (ADR-0088).
  if (!opts.accountTitle && userTitle?.enabled !== false) {
    const origTitle = unwrapSelfCmd(userTitle?.command, 'agy-title')
    settings.title = {
      type: typeof userTitle?.type === 'string' ? userTitle.type : 'command',
      command: sidebyAgyHelperCommand('agy-title', origTitle, opts.argv1),
    }
  }

  if (!Object.keys(settings).length) return { args: [...args] }

  const warn =
    opts.warn ??
    ((msg: string) => {
      process.stderr.write(`${msg}\n`)
    })
  let settingsFile: string
  try {
    const nowMs = (opts.now ?? new Date()).getTime()
    await pruneStaleFiles(opts.stateDir, nowMs)

    const dir = await ownedFolder(opts.stateDir, [AGY_LAUNCH_DIR], { create: true, private: true })
    if (!dir) return { args: [...args] }
    settingsFile = join(dir, `launch-${process.pid}-${randomBytes(6).toString('hex')}.json`)
    await writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 0o600)
  } catch (err) {
    // WHY: optional statusLine/title mod must never block `sideby run agy` when stateDir is unwritable or unsafe (ADR-0088).
    const detail = (err as NodeJS.ErrnoException).code ?? (err as Error).message
    warn(`sideby: skipped agy status line setup (${detail}); starting agy with original arguments`)
    return { args: [...args] }
  }

  const cleanup = async (hostPid?: number) => {
    const st = await lstatOrNull(settingsFile)
    if (st && !st.isSymbolicLink() && st.isFile()) {
      await rm(settingsFile, { force: true }).catch(() => {})
    }
    if (hostPid !== undefined && Number.isInteger(hostPid) && hostPid > 0) {
      const liveDir = await ownedFolder(opts.stateDir, [AGY_LIVE_DIR], { create: false }).catch(() => null)
      if (liveDir) {
        const liveFile = join(liveDir, `${hostPid}.json`)
        const lst = await lstatOrNull(liveFile)
        if (lst && !lst.isSymbolicLink() && lst.isFile()) {
          await rm(liveFile, { force: true }).catch(() => {})
        }
      }
    }
  }

  return {
    args: ['--settings', settingsFile, ...args],
    env: { [AGY_LAUNCH_PID_VAR]: String(process.pid) },
    settingsFile,
    cleanup,
  }
}
