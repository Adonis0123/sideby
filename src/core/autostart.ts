// Start the Panel at login (spec §3.29, ADR-0029): a LaunchAgent on macOS that runs this Node and this sideby's entry
// with `ui --background --no-open`. sideby writes, replaces or removes only a file that carries its marker; any other
// file at that path is reported and left alone. Every program runs through `AutostartContext.exec`, so tests never
// load a real agent.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { Env } from '../types.ts'
import { UserError } from './errors.ts'
import { fileHash, realpathOrNull, sha256, statOrNull, writeIfUnchanged } from './fs-safe.ts'
import { type AskLauncher, askLauncher, launcherProblem } from './terminal.ts'

export const AUTOSTART_LABEL = 'dev.sideby.panel'
/** Present in every agent sideby writes; a file without it is someone else's. */
export const AUTOSTART_MARKER = 'Written by `sideby autostart`'

/** One LaunchAgent sideby can write: the Panel's (`autostart`) or the menu bar item's (`menubar`, ADR-0034). */
export interface LoginAgent {
  label: string
  /** Present in every file of this agent sideby writes; a file without it is someone else's. */
  marker: string
  /** The sideby subcommand that turns it on and off, for messages. */
  command: string
  /** The comment after the marker: what the agent starts. */
  comment: string
  programArguments: (l: AskLauncher) => string[]
  /** The recorded paths that must still exist (state `stale` otherwise). */
  launcherPaths: (args: readonly string[]) => string[]
  /** What starts at the next login when launchd could not be told now. */
  later: string
  /** Restarted by launchd when it exits with an error (a long-running process); a clean exit stays out. */
  restartOnCrash?: boolean
  /**
   * Variables the agent's process gets, taken from the environment that turns it on: launchd starts jobs with only
   * `/usr/bin:/bin:/usr/sbin:/sbin`, so Hosts installed elsewhere would not be found.
   */
  environment?: (env: Env) => Record<string, string>
}

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
  /** The environment an agent's `environment` takes its variables from; this process's by default. */
  env?: Env
  /** Waits between launchctl calls; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>
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
  /**
   * Whether launchd holds the agent now, for an agent that keeps running (`restartOnCrash`) while it is on: false means
   * the file is there but nothing runs it until the next login, and `sideby <command> on` starts it again. Absent when
   * launchd cannot be asked (another HOME than the login one).
   */
  loaded?: boolean
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

export const defaultExec: AutostartExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, output: `${stdout}${stderr}` })
    })
  })

export const PANEL_AGENT: LoginAgent = {
  label: AUTOSTART_LABEL,
  marker: AUTOSTART_MARKER,
  command: 'autostart',
  comment: 'starts the sideby panel in the background at login',
  programArguments: (l) => programArgumentsFor(l),
  launcherPaths: (args) => args.slice(0, 2),
  later: 'the panel starts at your next login, or now with `sideby ui --background`',
}

export const agentPath = (home: string, agent: LoginAgent) =>
  join(home, 'Library', 'LaunchAgents', `${agent.label}.plist`)
export const autostartPath = (home: string) => agentPath(home, PANEL_AGENT)

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export const programArgumentsFor = (l: AskLauncher) => [l.node, l.entry, 'ui', '--background', '--no-open']

/**
 * The agent's file. The Panel's starts once at login, never again by itself, and outlives the job; an agent with
 * `restartOnCrash` is the long-running process itself, which launchd starts again only after a failed exit.
 */
export function plistContent(
  args: readonly string[],
  agent: LoginAgent = PANEL_AGENT,
  environment: Record<string, string> = {},
): string {
  const vars = Object.entries(environment)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${agent.marker}: ${agent.comment}. Turn it off with \`sideby ${agent.command} off\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
${
  vars.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${vars.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n')}
  </dict>
`
    : ''
}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
${
  agent.restartOnCrash
    ? `  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>`
    : `  <false/>
  <key>AbandonProcessGroup</key>
  <true/>`
}
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
export async function autostartInstalled(home: string, agent: LoginAgent = PANEL_AGENT): Promise<boolean> {
  const content = await readAgent(agentPath(home, agent)).catch(() => null)
  return content?.includes(agent.marker) ?? false
}

export async function autostartStatus(
  ctx: AutostartContext,
  agent: LoginAgent = PANEL_AGENT,
): Promise<AutostartStatus> {
  const path = agentPath(ctx.home, agent)
  const supported = platformOf(ctx) === 'darwin'
  const base = { supported, ...(supported ? {} : { reason: UNSUPPORTED }), path, current: false }
  if (!supported) return { ...base, state: 'off' }
  const content = await readAgent(path)
  if (content === null) return { ...base, state: 'off' }
  const args = content.includes(agent.marker) ? parseProgramArguments(content) : null
  if (!args) return { ...base, state: 'foreign' }
  const missing: string[] = []
  for (const p of agent.launcherPaths(args)) if (!(await statOrNull(p))) missing.push(p)
  const launcher = ctx.launcher ?? askLauncher()
  const want = agent.programArguments(launcher)
  const current = args.length === want.length && args.every((a, i) => a === want[i])
  const loaded = agent.restartOnCrash && !launchctlNote(ctx) ? await agentLoaded(ctx, agent) : undefined
  return {
    ...base,
    state: missing.length ? 'stale' : 'on',
    programArguments: args,
    current,
    ...(missing.length ? { missing } : {}),
    ...(loaded === undefined ? {} : { loaded }),
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
  command = 'autostart',
): Promise<{ code: string; message: string } | null> {
  const p = launcherProblem(l)
  if (p?.reason === 'npx-cache')
    return {
      code: 'npx-cache',
      message: `sideby runs from the npx cache, which npm may clear, so it cannot start at login from there; install it with \`npm i -g sideby\`, then run \`sideby ${command} on\` again`,
    }
  if (p)
    return {
      code: 'unsafe-path',
      message: `the path of sideby or Node has characters a login item cannot run safely; install sideby with \`npm i -g sideby\` in an ordinary folder, then run \`sideby ${command} on\` again`,
    }
  if ((await inTempDir(l.entry)) || (await inTempDir(l.node)))
    return {
      code: 'temp-dir',
      message: `sideby or Node runs from a temporary folder that the system empties, so it cannot start at login from there; install it with \`npm i -g sideby\`, then run \`sideby ${command} on\` again`,
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
const bootout = (ctx: AutostartContext, agent: LoginAgent) => [
  'launchctl',
  'bootout',
  `gui/${uidOf(ctx)}/${agent.label}`,
]

/** What `on` or `off` would change; writes nothing. */
export async function planAutostart(
  ctx: AutostartContext,
  action: 'on' | 'off',
  agent: LoginAgent = PANEL_AGENT,
): Promise<AutostartPlan> {
  const status = await autostartStatus(ctx, agent)
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
        message: `${path} was not written by sideby, so sideby leaves it alone; look at it, and remove or rename it yourself before \`sideby ${agent.command} ${action}\` if it is not needed`,
      },
    })
  if (action === 'off')
    return status.state === 'off' ? plan({}) : plan({ changed: true, commands: [bootout(ctx, agent)] })
  const launcher = ctx.launcher ?? askLauncher()
  const blocked = await autostartLauncherProblem(launcher, agent.command)
  if (blocked) return plan({ blocked })
  const programArguments = agent.programArguments(launcher)
  const content = plistContent(programArguments, agent, agent.environment?.(ctx.env ?? process.env))
  const same = hash !== null && hash === sha256(content)
  // The file alone does not start it: launchd may have let it go (a `launchctl bootout`, a failed start), and then
  // only loading it again brings it back.
  const loaded = !same || (status.loaded ?? (await agentLoaded(ctx, agent)))
  return plan({
    changed: !same || !loaded,
    content,
    programArguments,
    commands: same
      ? loaded
        ? []
        : [bootstrap(ctx, path)]
      : [...(status.state === 'off' ? [] : [bootout(ctx, agent)]), bootstrap(ctx, path)],
  })
}

/** Whether launchd holds the agent now; asks only for the login home, and counts any other HOME as loaded. */
async function agentLoaded(ctx: AutostartContext, agent: LoginAgent): Promise<boolean> {
  if (launchctlNote(ctx)) return true
  const r = await (ctx.exec ?? defaultExec)('launchctl', ['print', `gui/${uidOf(ctx)}/${agent.label}`]).catch(
    () => null,
  )
  return r === null || r.code === 0
}

const BOOTSTRAP_RETRIES = 3
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Waits, up to 10 s, until launchd no longer holds the agent: `launchctl bootout` returns while the job is still being
 * torn down, and a bootstrap then fails. (`bootout --wait` exists on newer macOS but may block for ever.)
 */
async function untilUnloaded(ctx: AutostartContext, agent: LoginAgent): Promise<void> {
  const exec = ctx.exec ?? defaultExec
  for (let i = 0; i < 50; i++) {
    const r = await exec('launchctl', ['print', `gui/${uidOf(ctx)}/${agent.label}`]).catch(() => null)
    if (r?.code !== 0) return
    await (ctx.sleep ?? sleep)(200)
  }
}

/** Whether launchctl may run: only for the login user's own LaunchAgents, never for a demo or test HOME. */
export function launchctlNote(ctx: AutostartContext): string | null {
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
export async function applyAutostart(
  ctx: AutostartContext,
  plan: AutostartPlan,
  agent: LoginAgent = PANEL_AGENT,
): Promise<AutostartResult> {
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
    // The file goes first: bootout ends the job's whole process group, which holds this process when the menu bar
    // item's own "Hide" runs it. Not loaded (already out, or never in) is fine: the file starts it at the next login.
    await rm(path, { force: true })
    await run(bootout(ctx, agent))
    return { changed: true, state: 'off', path, loaded: note === null, ...(note ? { note } : {}) }
  }
  if (plan.status.state !== 'off') {
    await run(bootout(ctx, agent))
    if (!note) await untilUnloaded(ctx, agent)
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  // launchd skips an agent that others can write; 644 is what it expects.
  if (!(await writeIfUnchanged(path, plan.hash, plan.content!, 0o644)))
    throw new UserError(
      `${path} changed while sideby was writing it; nothing was changed. Run the command again`,
      {
        code: 'changed',
      },
    )
  let r = await run(bootstrap(ctx, path))
  // Error 5 (Input/output error): launchd is still tearing down the job a bootout let go (a bootout returns before it
  // is done). Wait until it is gone and try again, a few times.
  for (let i = 0; r && r.code === 5 && i < BOOTSTRAP_RETRIES; i++) {
    await untilUnloaded(ctx, agent)
    await (ctx.sleep ?? sleep)(500)
    r = await run(bootstrap(ctx, path))
  }
  const result: AutostartResult = {
    changed: true,
    state: 'on',
    path,
    programArguments: plan.programArguments!,
    loaded: r !== null && r.code === 0,
  }
  if (note) result.note = note
  else if (r && r.code !== 0) result.note = `launchctl bootstrap failed (exit ${r.code}); ${agent.later}`
  return result
}

/**
 * After `sideby update` or `pnpm local`: rewrites an existing sideby agent so it starts `launcher`. Never creates one,
 * never touches a foreign file, and never throws; `rewritten` says whether the file changed.
 */
export async function refreshAutostart(
  ctx: AutostartContext,
  agent: LoginAgent = PANEL_AGENT,
): Promise<{ rewritten: boolean; state: AutostartState; note?: string }> {
  let state: AutostartState = 'off'
  try {
    const status = await autostartStatus(ctx, agent)
    state = status.state
    if (status.state !== 'on' && status.state !== 'stale') return { rewritten: false, state: status.state }
    const plan = await planAutostart(ctx, 'on', agent)
    if (plan.blocked) return { rewritten: false, state: status.state, note: plan.blocked.message }
    const r = await applyAutostart(ctx, plan, agent)
    return { rewritten: r.changed, state: r.state, ...(r.note ? { note: r.note } : {}) }
  } catch (err) {
    return { rewritten: false, state, note: (err as Error).message }
  }
}
