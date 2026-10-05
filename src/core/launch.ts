import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { delimiter, join } from 'node:path'
import type { HookBus } from '../plugins/bus.ts'
import type { Account, Env, FamilyDef } from '../types.ts'
import { readSecretFile } from './secret-file.ts'

export interface PreparedLaunch {
  account: Account
  family: FamilyDef
  bin: string
  args: string[]
  env: Env
  /** Printed before launching when sign-in happens inside the Host. */
  notice?: string
}

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
}): Promise<PreparedLaunch> {
  const { account, family } = opts
  const env: Env = { ...opts.baseEnv }
  for (const v of family.hijackVars) delete env[v]
  delete env[family.selectVar]
  if (account.secretFile) Object.assign(env, await readSecretFile(account.secretFile, opts.baseEnv))
  if (!account.isMain) env[family.selectVar] = account.dir

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
    args = [...(family.defaultArgs?.(account, opts.userArgs) ?? []), ...opts.accountArgs, ...opts.userArgs]
  }

  await opts.bus.run('launch.before', family.id, {
    account,
    family,
    env,
    args,
    config: {},
    command: opts.command,
  })
  return { account, family, bin: family.bin, args, env, ...(notice ? { notice } : {}) }
}

/**
 * Runs the Host with the terminal attached and returns sideby's exit code (spec §3.5):
 * the Host's own code, 128 + signal number when a signal ended it, 1 when it could not start.
 * While the Host runs, sideby ignores SIGINT/SIGQUIT (the terminal delivers them to the whole foreground
 * process group, so the Host receives them directly) and forwards SIGTERM/SIGHUP once. SIGTSTP keeps its
 * default action so Ctrl-Z suspends sideby together with the Host and `fg` resumes both.
 */
export function runHost(p: PreparedLaunch): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(p.bin, p.args, { stdio: 'inherit', env: p.env as NodeJS.ProcessEnv })
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
}
