// Start the Panel at login (spec §3.29, ADR-0029): a LaunchAgent on macOS that runs this Node and this sideby's entry
// with `ui --background --no-open`. sideby writes, replaces or removes only a file that carries its marker; any other
// file at that path is reported and left alone. Every program runs through `AutostartContext.exec`, so tests never
// load a real agent.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { UserError } from './errors.ts'
import { fileHash, realpathOrNull, sha256, statOrNull, writeIfUnchanged } from './fs-safe.ts'
import { type AskLauncher, askLauncher, launcherProblem } from './terminal.ts'

export const AUTOSTART_LABEL = 'dev.sideby.panel'
/** Present in every agent sideby writes; a file without it is someone else's. */
export const AUTOSTART_MARKER = 'Written by `sideby autostart`'

export type AutostartState = 'off' | 'on' | 'stale' | 'foreign'

/** Runs a program and resolves with its exit code and output; never rejects. */
export type AutostartExec = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number; output: string }>

export interface AutostartContext {
  home: string
  platform?: NodeJS.Platform
  /** The Node and sideby entry the agent should start; this process's by default. */
  launcher?: AskLauncher
  exec?: AutostartExec
  uid?: number
  /** The home launchd reads LaunchAgents from (the login user's); `launchctl` runs only when `home` is it. */
  loginHome?: string
}

export interface AutostartStatus {
  /** False on a system sideby cannot start at login yet; `reason` says so. */
  supported: boolean
  reason?: string
  state: AutostartState
  path: string
  /** What sideby's agent starts (absent when off or foreign). */
  programArguments?: string[]
  /** The agent starts this sideby with this Node. */
  current: boolean
  /** Recorded paths that no longer exist (state `stale`). */
  missing?: string[]
}

export interface AutostartPlan {
  action: 'on' | 'off'
  status: AutostartStatus
  /** False when nothing needs to change. */
  changed: boolean
  path: string
  /** The file `on` writes. */
  content?: string
  programArguments?: string[]
  /** Programs run after the write (`on`) or before the removal (`off`). */
  commands: string[][]
  /** Why it cannot be done, with what to do instead; nothing is changed then. */
  blocked?: { code: string; message: string }
  /** Hash of the file when planned (null: none); apply refuses when it changed since. */
  hash: string | null
}

export interface AutostartResult {
  changed: boolean
  state: AutostartState
  path: string
  programArguments?: string[]
  /** launchd took the change now (false: it takes effect at the next login, `note` says why). */
  loaded: boolean
  note?: string
}

const defaultExec: AutostartExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, output: `${stdout}${stderr}` })
    })
  })

export const autostartPath = (home: string) =>
  join(home, 'Library', 'LaunchAgents', `${AUTOSTART_LABEL}.plist`)

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export const programArgumentsFor = (l: AskLauncher) => [l.node, l.entry, 'ui', '--background', '--no-open']

/** The agent's file: starts the Panel once at login, never again by itself, and lets it outlive the job. */
export function plistContent(args: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${AUTOSTART_MARKER}: starts the sideby panel in the background at login. Turn it off with \`sideby autostart off\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>AbandonProcessGroup</key>
  <true/>
</dict>
</plist>
`
}

/** The ProgramArguments of a file sideby wrote; null when it holds none. */
export function parseProgramArguments(content: string): string[] | null {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)
  if (!m) return null
  return [...m[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => unxml(s[1]!))
}

const platformOf = (ctx: AutostartContext) => ctx.platform ?? process.platform
const UNSUPPORTED = 'sideby can start at login on macOS only for now; Linux and Windows come later'

async function readAgent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Whether a sideby agent (with the marker) is installed; reads only that one file. */
export async function autostartInstalled(home: string): Promise<boolean> {
  const content = await readAgent(autostartPath(home)).catch(() => null)
  return content?.includes(AUTOSTART_MARKER) ?? false
}

export async function autostartStatus(ctx: AutostartContext): Promise<AutostartStatus> {
  const path = autostartPath(ctx.home)
  const supported = platformOf(ctx) === 'darwin'
  const base = { supported, ...(supported ? {} : { reason: UNSUPPORTED }), path, current: false }
  if (!supported) return { ...base, state: 'off' }
  const content = await readAgent(path)
  if (content === null) return { ...base, state: 'off' }
  const args = content.includes(AUTOSTART_MARKER) ? parseProgramArguments(content) : null
  if (!args) return { ...base, state: 'foreign' }
  const missing: string[] = []
  for (const p of args.slice(0, 2)) if (!(await statOrNull(p))) missing.push(p)
  const launcher = ctx.launcher ?? askLauncher()
  const want = programArgumentsFor(launcher)
  const current = args.length === want.length && args.every((a, i) => a === want[i])
  return {
    ...base,
    state: missing.length ? 'stale' : 'on',
    programArguments: args,
    current,
    ...(missing.length ? { missing } : {}),
  }
}

/** Under the system's temporary folders, which are emptied without asking. */
async function inTempDir(path: string): Promise<boolean> {
  const roots = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']
  const t = await realpathOrNull(tmpdir())
  if (t) roots.push(`${t.replace(/\/+$/, '')}/`)
  return roots.some((r) => path.startsWith(r))
}

/** Why the agent cannot start this launcher, with what to do instead; null when it can. */
export async function autostartLauncherProblem(
  l: AskLauncher,
): Promise<{ code: string; message: string } | null> {
  const p = launcherProblem(l)
  if (p?.reason === 'npx-cache')
    return {
      code: 'npx-cache',
      message:
        'sideby runs from the npx cache, which npm may clear, so it cannot start at login from there; install it with `npm i -g sideby`, then run `sideby autostart on` again',
    }
  if (p)
    return {
      code: 'unsafe-path',
      message:
        'the path of sideby or Node has characters a login item cannot run safely; install sideby with `npm i -g sideby` in an ordinary folder, then run `sideby autostart on` again',
    }
  if ((await inTempDir(l.entry)) || (await inTempDir(l.node)))
    return {
      code: 'temp-dir',
      message:
        'sideby or Node runs from a temporary folder that the system empties, so it cannot start at login from there; install it with `npm i -g sideby`, then run `sideby autostart on` again',
    }
  return null
}

const uidOf = (ctx: AutostartContext) => ctx.uid ?? process.getuid?.() ?? 0
const bootstrap = (ctx: AutostartContext, path: string) => [
  'launchctl',
  'bootstrap',
  `gui/${uidOf(ctx)}`,
  path,
]
const bootout = (ctx: AutostartContext) => ['launchctl', 'bootout', `gui/${uidOf(ctx)}/${AUTOSTART_LABEL}`]

/** What `on` or `off` would change; writes nothing. */
export async function planAutostart(ctx: AutostartContext, action: 'on' | 'off'): Promise<AutostartPlan> {
  const status = await autostartStatus(ctx)
  const path = status.path
  const hash = status.supported ? await fileHash(path) : null
  const plan = (extra: Partial<AutostartPlan>): AutostartPlan => ({
    action,
    status,
    changed: false,
    path,
    commands: [],
    hash,
    ...extra,
  })
  if (!status.supported) return plan({ blocked: { code: 'unsupported', message: UNSUPPORTED } })
  if (status.state === 'foreign')
    return plan({
      blocked: {
        code: 'foreign',
        message: `${path} was not written by sideby, so sideby leaves it alone; look at it, and remove or rename it yourself before \`sideby autostart ${action}\` if it is not needed`,
      },
    })
  if (action === 'off')
    return status.state === 'off' ? plan({}) : plan({ changed: true, commands: [bootout(ctx)] })
  const launcher = ctx.launcher ?? askLauncher()
  const blocked = await autostartLauncherProblem(launcher)
  if (blocked) return plan({ blocked })
  const programArguments = programArgumentsFor(launcher)
  const content = plistContent(programArguments)
  const same = hash !== null && hash === sha256(content)
  return plan({
    changed: !same,
    content,
    programArguments,
    commands: same ? [] : [...(status.state === 'off' ? [] : [bootout(ctx)]), bootstrap(ctx, path)],
  })
}

/** Whether launchctl may run: only for the login user's own LaunchAgents, never for a demo or test HOME. */
function launchctlNote(ctx: AutostartContext): string | null {
  let login = ctx.loginHome
  if (login === undefined)
    try {
      login = userInfo().homedir
    } catch {
      login = ''
    }
  return login === ctx.home
    ? null
    : `HOME (${ctx.home}) is not your login home, so launchd was not told; it reads this file only from your login home`
}

/** Carries out a plan the user confirmed. Refuses, changing nothing, when the file changed since it was planned. */
export async function applyAutostart(ctx: AutostartContext, plan: AutostartPlan): Promise<AutostartResult> {
  if (plan.blocked) throw new UserError(plan.blocked.message, { code: plan.blocked.code })
  const path = plan.path
  if (!plan.changed)
    return {
      changed: false,
      state: plan.status.state,
      path,
      ...(plan.programArguments ? { programArguments: plan.programArguments } : {}),
      loaded: false,
    }
  if ((await fileHash(path)) !== plan.hash)
    throw new UserError(
      `${path} changed since sideby looked at it; nothing was changed. Run the command again`,
      {
        code: 'changed',
      },
    )
  const exec = ctx.exec ?? defaultExec
  const note = launchctlNote(ctx)
  const run = async (cmd: string[]) => (note ? null : exec(cmd[0]!, cmd.slice(1)))
  if (plan.action === 'off') {
    // Not loaded (already out, or never in) is fine: the file is what starts it at the next login.
    await run(bootout(ctx))
    await rm(path, { force: true })
    return { changed: true, state: 'off', path, loaded: note === null, ...(note ? { note } : {}) }
  }
  if (plan.status.state !== 'off') await run(bootout(ctx))
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  // launchd skips an agent that others can write; 644 is what it expects.
  if (!(await writeIfUnchanged(path, plan.hash, plan.content!, 0o644)))
    throw new UserError(
      `${path} changed while sideby was writing it; nothing was changed. Run the command again`,
      {
        code: 'changed',
      },
    )
  const r = await run(bootstrap(ctx, path))
  const result: AutostartResult = {
    changed: true,
    state: 'on',
    path,
    programArguments: plan.programArguments!,
    loaded: r !== null && r.code === 0,
  }
  if (note) result.note = note
  else if (r && r.code !== 0)
    result.note = `launchctl bootstrap failed (exit ${r.code}); the panel starts at your next login, or now with \`sideby ui --background\``
  return result
}

/**
 * After `sideby update` or `pnpm local`: rewrites an existing sideby agent so it starts `launcher`. Never creates one,
 * never touches a foreign file, and never throws; `rewritten` says whether the file changed.
 */
export async function refreshAutostart(
  ctx: AutostartContext,
): Promise<{ rewritten: boolean; state: AutostartState; note?: string }> {
  let state: AutostartState = 'off'
  try {
    const status = await autostartStatus(ctx)
    state = status.state
    if (status.state !== 'on' && status.state !== 'stale') return { rewritten: false, state: status.state }
    const plan = await planAutostart(ctx, 'on')
    if (plan.blocked) return { rewritten: false, state: status.state, note: plan.blocked.message }
    const r = await applyAutostart(ctx, plan)
    return { rewritten: r.changed, state: r.state, ...(r.note ? { note: r.note } : {}) }
  } catch (err) {
    return { rewritten: false, state, note: (err as Error).message }
  }
}
