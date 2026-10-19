import { constants, realpathSync } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from '../types.ts'
import type { DesktopDeps } from './desktop-app.ts'

export type TerminalId =
  | 'terminal'
  | 'iterm2'
  | 'ghostty'
  | 'orca'
  | 'wezterm'
  | 'kitty'
  | 'alacritty'
  | 'windows-terminal'
  | 'custom'

export interface TerminalDef {
  id: TerminalId
  name: string
  bundleId: string | null
  app: string | null
  termPrograms: readonly string[]
  marker?: string
  binary?: string
}

/** Supported terminals: macOS apps, and Windows Terminal on WSL; custom templates have no app bundle or environment marker. */
export const TERMINALS: readonly TerminalDef[] = [
  {
    id: 'terminal',
    name: 'Terminal',
    bundleId: 'com.apple.Terminal',
    app: 'Terminal.app',
    termPrograms: ['Apple_Terminal'],
  },
  {
    id: 'iterm2',
    name: 'iTerm2',
    bundleId: 'com.googlecode.iterm2',
    app: 'iTerm.app',
    termPrograms: ['iTerm.app'],
  },
  {
    id: 'ghostty',
    name: 'Ghostty',
    bundleId: 'com.mitchellh.ghostty',
    app: 'Ghostty.app',
    termPrograms: ['ghostty'],
  },
  {
    id: 'orca',
    name: 'Orca',
    bundleId: 'com.stablyai.orca',
    app: 'Orca.app',
    termPrograms: ['Orca'],
    binary: 'orca',
  },
  {
    id: 'wezterm',
    name: 'WezTerm',
    bundleId: 'com.github.wez.wezterm',
    app: 'WezTerm.app',
    termPrograms: ['WezTerm'],
    binary: 'wezterm',
  },
  {
    id: 'kitty',
    name: 'kitty',
    bundleId: 'net.kovidgoyal.kitty',
    app: 'kitty.app',
    termPrograms: [],
    marker: 'KITTY_WINDOW_ID',
    binary: 'kitty',
  },
  {
    id: 'alacritty',
    name: 'Alacritty',
    bundleId: 'org.alacritty',
    app: 'Alacritty.app',
    termPrograms: [],
    marker: 'ALACRITTY_WINDOW_ID',
  },
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    bundleId: null,
    app: null,
    termPrograms: [],
    marker: 'WT_SESSION',
    binary: 'wt.exe',
  },
  { id: 'custom', name: 'Custom', bundleId: null, app: null, termPrograms: [] },
]

export interface InstalledTerminal {
  id: TerminalId
  appPath?: string
  executable?: string
}

export interface TerminalDeps {
  home: string
  env: Env
  platform?: NodeJS.Platform
  appDirs?: readonly string[]
  fs?: { stat: typeof stat; access: typeof access; readdir?: typeof readdir }
  /** On WSL, where Windows drives are mounted (normally `/mnt`); undefined elsewhere. */
  wslMount?: string
}

const isExecutable = async (fs: NonNullable<TerminalDeps['fs']>, path: string) =>
  (await fs.stat(path).then(
    (s) => s.isFile(),
    () => false,
  )) &&
  (await fs.access(path, constants.X_OK).then(
    () => true,
    () => false,
  ))

/**
 * The Windows terminals sideby can open from WSL: Windows Terminal (`wt.exe`) and Orca's Windows CLI (`orca.exe`), each
 * on PATH or else in a Windows user's folder (a background service's PATH has no Windows folders).
 */
async function wslTerminals(deps: TerminalDeps, mount: string): Promise<InstalledTerminal[]> {
  const fs = { stat, access, readdir, ...deps.fs }
  const users = join(mount, 'c', 'Users')
  const names = await fs.readdir(users).catch(() => [] as string[])
  const find = async (exe: string, inUser: readonly string[]) => {
    for (const dir of (deps.env.PATH ?? '').split(':').filter(Boolean)) {
      const path = join(dir, exe)
      if (await isExecutable(fs, path)) return path
    }
    for (const user of names) {
      const path = join(users, user, ...inUser, exe)
      if (await isExecutable(fs, path)) return path
    }
    return undefined
  }
  const found: InstalledTerminal[] = []
  const wt = await find('wt.exe', ['AppData', 'Local', 'Microsoft', 'WindowsApps'])
  if (wt) found.push({ id: 'windows-terminal', executable: wt })
  const orca = await find('orca.exe', ['AppData', 'Local', 'Programs', 'orca', 'resources', 'bin'])
  if (orca) found.push({ id: 'orca', executable: orca })
  return found
}

/** Finds bundles and command line launchers without opening apps or reading user files. */
export async function installedTerminals(deps: TerminalDeps): Promise<InstalledTerminal[]> {
  const platform = deps.platform ?? process.platform
  if (platform === 'linux' && deps.wslMount) return wslTerminals(deps, deps.wslMount)
  if (platform !== 'darwin') return []
  const fs = deps.fs ?? { stat, access }
  const dirs = deps.appDirs ?? [
    '/Applications',
    join(deps.home, 'Applications'),
    '/System/Applications/Utilities',
    '/Applications/Utilities',
  ]
  const found: InstalledTerminal[] = []
  for (const terminal of TERMINALS) {
    if (!terminal.app) continue
    let appPath: string | undefined
    for (const dir of dirs) {
      const path = join(dir, terminal.app)
      if (
        await fs.stat(path).then(
          (s) => s.isDirectory(),
          () => false,
        )
      ) {
        appPath = path
        break
      }
    }
    let executable: string | undefined
    if (terminal.binary) {
      for (const dir of (deps.env.PATH ?? '').split(':').filter(Boolean)) {
        const path = join(dir, terminal.binary)
        if (await isExecutable(fs, path)) {
          executable = path
          break
        }
      }
      if (!executable && appPath)
        executable = join(
          appPath,
          terminal.id === 'orca' ? 'Contents/Resources/bin' : 'Contents/MacOS',
          terminal.binary,
        )
    }
    if (appPath || (terminal.id === 'orca' && executable))
      found.push({ id: terminal.id, ...(appPath ? { appPath } : {}), ...(executable ? { executable } : {}) })
  }
  return found
}

/** Chooses an installed preference, then the launching environment, then macOS Terminal (Windows Terminal on WSL). */
export function guessTerminal(opts: {
  preferred?: string
  env: Env
  installed: readonly InstalledTerminal[]
}): { id: TerminalId; source: 'config' | 'env' | 'default' } {
  const has = (id: string) => opts.installed.some((t) => t.id === id)
  if (opts.preferred && has(opts.preferred)) return { id: opts.preferred as TerminalId, source: 'config' }
  const match = TERMINALS.find(
    (t) =>
      has(t.id) &&
      (t.termPrograms.includes(opts.env.TERM_PROGRAM ?? '') || Boolean(t.marker && opts.env[t.marker])),
  )
  if (match) return { id: match.id, source: 'env' }
  return { id: has('windows-terminal') ? 'windows-terminal' : 'terminal', source: 'default' }
}

/** What the terminal runs: this Node and this sideby's CLI entry, so neither PATH nor the login shell matters. */
export interface AskLauncher {
  node: string
  entry: string
}

/** This process's Node and the real path of the CLI entry next to this module (`main.ts` from source, `main.js` from dist). */
export function askLauncher(): AskLauncher {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const entry = fileURLToPath(new URL(`../cli/main.${ext}`, import.meta.url))
  let real = entry
  try {
    real = realpathSync(entry)
  } catch {
    // Keep the unresolved path; the terminal reports it if it is missing.
  }
  return { node: process.execPath, entry: real }
}

// A path the terminal's shell reads exactly: absolute, and no control character, newline or backslash
// (fish treats a backslash inside single quotes as an escape).
// Built from a string: a regex literal with control characters reads as a typo to linters.
const CONTROL = new RegExp(String.raw`[\x00-\x1f\x7f]`)
const safePath = (path: string) => path.startsWith('/') && !path.includes('\\') && !CONTROL.test(path)

/** Why the terminal cannot run this launcher, or null when it can. */
export function launcherProblem(
  launcher: AskLauncher,
  stateDir?: string,
): { ok: false; reason: 'npx-cache' | 'unsafe-path'; detail: string } | null {
  if (
    !safePath(launcher.node) ||
    !safePath(launcher.entry) ||
    (stateDir !== undefined && !safePath(stateDir))
  )
    return {
      ok: false,
      reason: 'unsafe-path',
      detail:
        'sideby, Node or its state folder is in a folder whose name a terminal cannot run safely; install sideby with `npm i -g sideby`, or paste the task command into your terminal.',
    }
  if (launcher.entry.includes('/_npx/'))
    return {
      ok: false,
      reason: 'npx-cache',
      detail:
        'sideby runs from the npx cache, which can disappear; install it with `npm i -g sideby` and try again, or paste the task command into your terminal now.',
    }
  return null
}

/**
 * Builds the only shell command accepted by the AI Task terminal launcher: the quoted Node and CLI entry, or
 * `sideby` by name when `launcher` is null (a command for the user to paste where sideby is on PATH). It carries the
 * state folder the task was written to, so a terminal whose environment differs from the Panel's still finds it.
 */
export function askRunCommand(
  taskId: string,
  stateDir: string,
  launcher: AskLauncher | null = askLauncher(),
): string {
  if (!/^[a-f0-9]{16}$/.test(taskId)) throw new Error('Invalid task id; create the AI task again.')
  if (!launcher)
    // Pasted by hand: a state folder a shell cannot take safely is left out, and `ask --run` uses the environment's.
    return `sideby ask --run '${taskId}'${safePath(stateDir) ? ` --state-dir ${quote(stateDir)}` : ''}`
  if (!safePath(launcher.node) || !safePath(launcher.entry) || !safePath(stateDir))
    throw new Error('Unsafe sideby path; install sideby with `npm i -g sideby` and try again.')
  return `${quote(launcher.node)} ${quote(launcher.entry)} ask --run '${taskId}' --state-dir ${quote(stateDir)}`
}

export interface TerminalLaunchOptions {
  cwd: string
  command: string
  custom?: string
  appPath?: string
  executable?: string
  /** Windows Terminal: the WSL distribution the tab returns to; the default distribution when absent. */
  wslDistro?: string
  /** Windows Terminal: the user's login shell; zsh and bash run the task interactively, so their rc files apply. */
  shell?: string
  /** Orca's Windows CLI from WSL: the worktree selector to open in; it also gets a WSL shell instead of its default. */
  orcaWorktree?: string
}

export interface TerminalCommand {
  file: string
  args: string[]
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
// AppleScript string literals know only \\ and \" as escapes; a control character is refused, not encoded.
function appleString(value: string): string {
  if (CONTROL.test(value)) throw new Error('Invalid task command; create the AI task again.')
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

// The quoted launcher and state paths, as askRunCommand writes them: single-quoted runs joined by \' (an escaped quote).
const QUOTED = String.raw`(?:'[^'\\\x00-\x1f\x7f]*'|\\')+`
const TASK_COMMAND = new RegExp(`^${QUOTED} ${QUOTED} ask --run '[a-f0-9]{16}' --state-dir ${QUOTED}$`)

/** For `sh -c`: when the command fails, the window waits for Return instead of closing on its error. */
function holdOnFailure(command: string): string {
  return `${command} || { echo; echo "sideby: press Return to close"; read _; }`
}

// Tokenize before substitution: paths and commands remain one argument, even with quotes or newlines.
function customArgs(template: string): string[] {
  const args: string[] = []
  let word = '',
    quoted = '',
    started = false
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!
    if (c === '\\' && quoted !== "'") {
      if (++i === template.length) throw new Error('Incomplete escape; fix the custom terminal template.')
      word += template[i]
      started = true
    } else if (quoted) {
      if (c === quoted) quoted = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quoted = c
      started = true
    } else if (/\s/.test(c)) {
      if (started) {
        args.push(word)
        word = ''
        started = false
      }
    } else {
      word += c
      started = true
    }
  }
  if (quoted) throw new Error('Unclosed quote; fix the custom terminal template.')
  if (started) args.push(word)
  return args
}

/**
 * Splits a custom terminal template into argv, throwing unless it names a program first and has both `{cmd}` and
 * `{cwd}` in its arguments.
 */
export function validateCustomTemplate(template: string): [string, ...string[]] {
  const args = customArgs(template)
  const file = args[0]
  const rest = args.slice(1)
  if (
    !file ||
    file.includes('{') ||
    !rest.some((a) => a.includes('{cmd}')) ||
    !rest.some((a) => a.includes('{cwd}')) ||
    template.includes('\0')
  )
    throw new Error(
      "Set a custom terminal executable and both {cmd} and {cwd} placeholders, such as `sideby terminal --custom 'my-term --cwd {cwd} -e {cmd}'`.",
    )
  return [file, ...rest]
}

/** Builds argv only. The caller supplies discovered bundle/binary paths when available. */
export function launchArgs(id: TerminalId, opts: TerminalLaunchOptions): TerminalCommand {
  if (!TASK_COMMAND.test(opts.command)) throw new Error('Invalid task command; create the AI task again.')
  if (opts.cwd.includes('\0')) throw new Error('Invalid working directory; choose another folder.')
  // `ask --run` changes to the task's directory itself, so cwd goes only where a terminal takes it as an argument.
  const { cwd, command } = opts
  const held = holdOnFailure(command)
  switch (id) {
    case 'terminal':
      return {
        file: '/usr/bin/osascript',
        args: [
          '-e',
          `tell application id "com.apple.Terminal"
if not running then launch
do script ${appleString(command)}
activate
end tell`,
        ],
      }
    case 'iterm2':
      return {
        file: '/usr/bin/osascript',
        args: [
          '-e',
          // Always a new window of its own: "current window" can be iTerm2's updater or settings window, and a
          // just-started iTerm2 may open no window at all.
          `tell application id "com.googlecode.iterm2"
activate
set taskWindow to (create window with default profile)
tell current session of taskWindow to write text ${appleString(command)}
end tell`,
        ],
      }
    // Use the CLI for both running and stopped Ghostty; AppleScript new window needs newer versions.
    case 'ghostty':
      return {
        file: '/usr/bin/open',
        args: [
          '-na',
          opts.appPath ?? 'Ghostty',
          '--args',
          `--working-directory=${cwd}`,
          '-e',
          '/bin/sh',
          '-lc',
          held,
        ],
      }
    case 'orca':
      return {
        file: opts.executable ?? 'orca',
        args: [
          'terminal',
          'create',
          '--worktree',
          opts.orcaWorktree ?? 'active',
          ...(opts.orcaWorktree ? ['--shell', 'wsl.exe'] : []),
          '--command',
          command,
          '--title',
          'sideby',
          '--focus',
          '--json',
        ],
      }
    case 'wezterm':
      return {
        file: opts.executable ?? join(opts.appPath ?? '/Applications/WezTerm.app', 'Contents/MacOS/wezterm'),
        args: ['start', '--cwd', cwd, '--', '/bin/sh', '-lc', held],
      }
    case 'kitty':
      return {
        file: opts.executable ?? join(opts.appPath ?? '/Applications/kitty.app', 'Contents/MacOS/kitty'),
        args: ['--single-instance', '--directory', cwd, '/bin/sh', '-lc', held],
      }
    case 'alacritty':
      return {
        file: '/usr/bin/open',
        args: [
          '-na',
          opts.appPath ?? 'Alacritty',
          '--args',
          '--working-directory',
          cwd,
          '-e',
          '/bin/sh',
          '-lc',
          held,
        ],
      }
    // wt.exe splits its command line at `;`, and a `"` would be unquoted again on the way through wsl.exe; refuse
    // both rather than guess at three layers of quoting. The hold therefore uses `&&` instead of `;`.
    case 'windows-terminal': {
      if (/[;"]/.test(command) || /[;"]/.test(cwd))
        throw new Error(
          'The task folder or command has ; or " in it; paste the task command into your terminal.',
        )
      const tabHeld = `${command} || (echo && echo sideby: press Return to close && read _)`
      // Like Terminal.app, run it in the user's own interactive shell: on WSL, version managers such as nvm put
      // sideby on PATH only in ~/.zshrc or ~/.bashrc, and the Host runs `sideby` by name for Auto Handoff.
      const shell = opts.shell && /\/(zsh|bash)$/.test(opts.shell) ? [opts.shell, '-lic'] : ['/bin/sh', '-lc']
      return {
        file: opts.executable ?? 'wt.exe',
        args: [
          '-w',
          '0',
          'new-tab',
          '--title',
          'sideby',
          'wsl.exe',
          ...(opts.wslDistro ? ['-d', opts.wslDistro] : []),
          '--cd',
          cwd,
          '-e',
          ...shell,
          tabHeld,
        ],
      }
    }
    case 'custom': {
      const [file, ...args] = validateCustomTemplate(opts.custom ?? '')
      return {
        file,
        args: args.map((a) => a.replace(/\{(cmd|cwd)\}/g, (_, key) => (key === 'cmd' ? command : cwd))),
      }
    }
    default:
      throw new Error('Unknown terminal; choose an installed terminal in Settings.')
  }
}

export type TerminalOpenResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported-platform' }
  | {
      ok: false
      reason: 'not-installed' | 'automation-denied' | 'failed' | 'npx-cache' | 'unsafe-path'
      detail: string
    }

/** Opens through the injected Desktop exec boundary, returning safe, actionable failures only. */
export async function openTerminal(
  id: TerminalId,
  opts: TerminalLaunchOptions & { platform?: NodeJS.Platform; installed: readonly InstalledTerminal[] },
  exec: DesktopDeps['exec'],
): Promise<TerminalOpenResult> {
  const platform = opts.platform ?? process.platform
  const opensHere =
    platform === 'darwin' ||
    (platform === 'linux' && (id === 'windows-terminal' || id === 'orca' || id === 'custom'))
  if (!opensHere) return { ok: false, reason: 'unsupported-platform' }
  const installed = opts.installed.find((t) => t.id === id)
  if (!installed && id !== 'custom')
    return {
      ok: false,
      reason: 'not-installed',
      detail:
        'Install this terminal or choose another in Settings; paste the task command into your terminal.',
    }
  if (platform === 'linux' && id === 'orca') {
    const worktree = await orcaWslWorktree(installed?.executable ?? 'orca.exe', opts.wslDistro, exec)
    if (!worktree)
      return {
        ok: false,
        reason: 'failed',
        detail:
          'Orca has no project open from this WSL distribution; open one in Orca, or choose another terminal in Settings.',
      }
    opts = { ...opts, orcaWorktree: worktree }
  }
  try {
    const launch = launchArgs(id, { ...opts, ...installed })
    const result = await exec(launch.file, launch.args)
    if (result.code === 0) {
      // `orca terminal create --focus` only switches tabs inside Orca; bring its window to the front too.
      const bundleId = id === 'orca' ? TERMINALS.find((t) => t.id === 'orca')?.bundleId : null
      if (bundleId) await exec('/usr/bin/open', ['-b', bundleId]).catch(() => undefined)
      return { ok: true }
    }
    if (
      launch.file === '/usr/bin/osascript' &&
      (result.code === -1743 || /-1743|Not authorized to send Apple events/i.test(result.stderr))
    )
      return {
        ok: false,
        reason: 'automation-denied',
        detail:
          'Allow Automation in System Settings > Privacy & Security > Automation, then try again; or paste the task command into your terminal.',
      }
  } catch {
    // Never expose process output or thrown messages: they may contain private data.
  }
  return {
    ok: false,
    reason: 'failed',
    detail: 'Could not open the terminal; check its settings or paste the task command into your terminal.',
  }
}

/**
 * The WSL distribution this runs in: `WSL_DISTRO_NAME`, which a background service lacks, else the name in
 * `wslpath -w /` (`\\wsl.localhost\Ubuntu\`). Undefined when neither says.
 */
export async function wslDistro(env: Env, exec: DesktopDeps['exec']): Promise<string | undefined> {
  if (env.WSL_DISTRO_NAME) return env.WSL_DISTRO_NAME
  try {
    const r = await exec('wslpath', ['-w', '/'])
    return r.code === 0 ? /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/.exec(r.stdout.trim())?.[1] : undefined
  } catch {
    return undefined
  }
}

/**
 * Orca's Windows CLI resolves `--worktree active` from its current folder only, so from WSL sideby picks the worktree
 * of this distribution (`\\wsl.localhost\<distribution>\…`) that Orca used last. Undefined when there is none.
 */
async function orcaWslWorktree(
  orca: string,
  distro: string | undefined,
  exec: DesktopDeps['exec'],
): Promise<string | undefined> {
  if (!distro) return undefined
  try {
    const r = await exec(orca, ['worktree', 'list', '--json'])
    if (r.code !== 0) return undefined
    const list = (JSON.parse(r.stdout)?.result?.worktrees ?? []) as {
      id?: unknown
      path?: unknown
      lastActivityAt?: unknown
    }[]
    const prefixes = [`\\\\wsl.localhost\\${distro}\\`, `\\\\wsl$\\${distro}\\`].map((p) => p.toLowerCase())
    let best: { id: string; at: number } | undefined
    for (const w of list) {
      if (typeof w.id !== 'string' || typeof w.path !== 'string') continue
      const path = w.path.toLowerCase()
      if (!prefixes.some((p) => path.startsWith(p))) continue
      const at = typeof w.lastActivityAt === 'number' ? w.lastActivityAt : 0
      if (!best || at > best.at) best = { id: w.id, at }
    }
    return best && `id:${best.id}`
  } catch {
    return undefined
  }
}
