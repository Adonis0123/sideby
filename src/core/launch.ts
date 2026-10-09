import { type ChildProcess, spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { delimiter, join } from 'node:path'
import type { HookBus } from '../plugins/bus.ts'
import type { Account, Env, FamilyDef } from '../types.ts'
import { realpathOrNull } from './fs-safe.ts'
import { readSecretFile } from './secret-file.ts'

export interface PreparedLaunch {
  account: Account
  family: FamilyDef
  bin: string
  args: string[]
  env: Env
  /** Printed before launching when sign-in happens inside the Host. */
  notice?: string
  /** Terminal title set before the Host starts (config `accountTitle`), for example `[codex002]`. */
  title?: string
}

/** What `runHost` needs: a prepared Account launch, or the Host run unchanged (`sideby resume`). */
export type HostLaunch = Pick<PreparedLaunch, 'family' | 'bin' | 'args' | 'env' | 'title'>

/** Finds an executable on PATH; returns null when the Host is not installed. */
export async function which(bin: string, env: Env): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, bin)
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * Why a Host could not run `sideby` by name, or null when it can: something the Host runs on its own (the status line
 * tap, the handoff hook) needs sideby installed on PATH, not the npx cache, which can disappear. `why` completes
 * "sideby is not on PATH, and …".
 */
export async function sidebyBinProblem(env: Env, why: string): Promise<string | null> {
  const bin = await which('sideby', env)
  if (!bin) return `sideby is not on PATH, and ${why}; install it with \`npm i -g sideby\` and retry`
  const real = (await realpathOrNull(bin)) ?? bin
  if (bin.includes('/_npx/') || real.includes('/_npx/'))
    return `sideby on PATH comes from the npx cache (${bin}), which can disappear; install it with \`npm i -g sideby\` and retry`
  return null
}

/**
 * Builds the Host's environment and arguments (spec §3.5):
 * copy the current env, clear Hijack Variables, merge the Secret File, set the select variable,
 * then let `launch.before` hooks adjust or abort. Never touches the caller's environment.
 */
export async function prepareLaunch(opts: {
  account: Account
  family: FamilyDef
  baseEnv: Env
  accountArgs: readonly string[]
  userArgs: readonly string[]
  command: 'run' | 'login'
  bus: HookBus
  /** What the Host may show as the Account (`SIDEBY_LABEL`): the short command, else the ref. */
  label?: string
  /** Config `accountTitle`: set the terminal title to `[<label>]` and keep the Host from replacing it. */
  title?: boolean
}): Promise<PreparedLaunch> {
  const { account, family } = opts
  const env: Env = { ...opts.baseEnv }
  for (const v of family.hijackVars) delete env[v]
  delete env[family.selectVar]
  if (account.secretFile) Object.assign(env, await readSecretFile(account.secretFile, opts.baseEnv))
  if (!account.isMain) env[family.selectVar] = account.dir
  // Which Account this is, for a status line, prompt or hook to show (spec §3.5); set for every Launch, so a value
  // inherited from another sideby Launch never leaks through.
  env.SIDEBY_ACCOUNT = account.ref
  env.SIDEBY_LABEL = opts.label || account.ref

  let args: string[]
  let notice: string | undefined
  if (opts.command === 'login') {
    // Family arguments still apply: Codex must store a non-main login in the Account's own file.
    const base = family.defaultArgs?.(account, []) ?? []
    if (family.login.args) args = [...base, ...family.login.args]
    else {
      args = base
      notice = family.login.hint
    }
  } else {
    const keep =
      opts.title && family.keepTitle && !opts.userArgs.some((a) => a.includes(family.keepTitle!.key))
        ? family.keepTitle.args
        : []
    args = [
      ...(family.defaultArgs?.(account, opts.userArgs) ?? []),
      ...keep,
      ...opts.accountArgs,
      ...opts.userArgs,
    ]
  }

  await opts.bus.run('launch.before', family.id, {
    account,
    family,
    env,
    args,
    config: {},
    command: opts.command,
  })
  // Control characters would end the escape sequence early; labels are shell-safe names, so this is a guard only.
  const title = opts.title
    ? [...`[${env.SIDEBY_LABEL ?? account.ref}]`].filter((ch) => ch >= ' ' && ch !== '\x7f').join('')
    : undefined
  return {
    account,
    family,
    bin: family.bin,
    args,
    env,
    ...(notice ? { notice } : {}),
    ...(title ? { title } : {}),
  }
}

/**
 * Runs the Host with the terminal attached and returns sideby's exit code (spec §3.5):
 * the Host's own code, 128 + signal number when a signal ended it, 1 when it could not start.
 * While the Host runs, sideby ignores SIGINT/SIGQUIT (the terminal delivers them to the whole foreground
 * process group, so the Host receives them directly) and forwards SIGTERM/SIGHUP once. SIGTSTP keeps its
 * default action so Ctrl-Z suspends sideby together with the Host and `fg` resumes both.
 */
export function runHost(p: HostLaunch): Promise<number> {
  return spawnHost(p).exited
}

/**
 * `runHost` with the child process exposed, so the Auto Handoff (spec §3.17) can end the Host and start the next
 * Account in the same terminal. Same signal handling, exit codes and title as `runHost`.
 */
export function spawnHost(p: HostLaunch): { child: ChildProcess; exited: Promise<number> } {
  // OSC 0 sets the terminal's tab and window title; only on a terminal, never into a pipe.
  if (p.title && process.stdout.isTTY) process.stdout.write(`\x1b]0;${p.title}\x07`)
  const child = spawn(p.bin, p.args, { stdio: 'inherit', env: p.env as NodeJS.ProcessEnv })
  const exited = new Promise<number>((resolve) => {
    const ignore = () => {}
    const forwarded = new Set<NodeJS.Signals>()
    const forward = (sig: NodeJS.Signals) => () => {
      if (forwarded.has(sig) || child.exitCode !== null || child.signalCode !== null) return
      forwarded.add(sig)
      child.kill(sig)
    }
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', ignore],
      ['SIGQUIT', ignore],
      ['SIGTERM', forward('SIGTERM')],
      ['SIGHUP', forward('SIGHUP')],
    ]
    for (const [s, h] of handlers) process.on(s, h)
    const cleanup = () => {
      for (const [s, h] of handlers) process.off(s, h)
    }
    child.once('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      const msg =
        err.code === 'ENOENT'
          ? `${p.family.title} is not installed (\`${p.bin}\` not found on PATH); install it: ${p.family.installUrl}`
          : `could not start ${p.bin}: ${err.message}`
      process.stderr.write(`sideby: ${msg}\n`)
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (signal) resolve(128 + (osConstants.signals[signal] ?? 0))
      else resolve(code ?? 1)
    })
  })
  return { child, exited }
}
