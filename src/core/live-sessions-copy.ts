// `sideby sessions copy` (spec §3.32): which Session a target names, and the system clipboard.
import { spawn } from 'node:child_process'
import type { Env } from '../types.ts'
import { UserError } from './errors.ts'
import { which } from './launch.ts'
import { type LiveSession, shortId } from './live-sessions.ts'

/** The clipboard programs to try, in order, on this system. */
export function clipboardPrograms(platform: NodeJS.Platform, env: Env): [string, string[]][] {
  if (platform === 'darwin') return [['pbcopy', []]]
  const wayland: [string, string[]] = ['wl-copy', []]
  const x11: [string, string[]] = ['xclip', ['-selection', 'clipboard']]
  return env.WAYLAND_DISPLAY ? [wayland, x11] : [x11, wayland]
}

/** Writes `text` to the clipboard; returns the program used, or null when none is installed or each one failed. */
export async function copyToClipboard(
  text: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 3000,
): Promise<string | null> {
  for (const [name, args] of clipboardPrograms(platform, env)) {
    const bin = await which(name, env)
    if (!bin) continue
    if (await writeTo(bin, args, text, env, timeoutMs)) return name
  }
  return null
}

/**
 * Runs one clipboard program with `text` on its stdin. Every way it can fail resolves false: it cannot start, it
 * closes its input early (EPIPE), it exits non-zero, or it is still running after `timeoutMs` (then it is ended).
 */
function writeTo(bin: string, args: string[], text: string, env: Env, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], env: env as NodeJS.ProcessEnv })
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!ok && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('error', () => finish(false))
    child.stdin.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    child.stdin.end(text)
  })
}

/**
 * The one Session `target` names: a session id (or its first 8 or more characters), else an Account whose single
 * Live Session it is. Several Sessions, or none, are a UserError that says what to run next.
 */
export function pickSession(
  target: string,
  sessions: readonly LiveSession[],
  account: { ref: string; label: string } | undefined,
): LiveSession {
  const byId = sessions.filter(
    (s) => s.sessionId === target || (target.length >= 8 && s.sessionId.startsWith(target)),
  )
  if (byId.length === 1) return byId[0]!
  const list = byId.length ? byId : account ? sessions.filter((s) => s.account === account.ref) : []
  if (list.length === 1) return list[0]!
  if (!list.length) {
    if (account)
      throw new UserError(
        `${account.label} has no running session now; start one with \`sideby run ${account.label}\`, or run \`sideby sessions\` to see the others`,
        { code: 'no-session' },
      )
    throw new UserError(
      `no running session or account named ${target}; run \`sideby sessions\` to see the running sessions`,
      { code: 'no-session' },
    )
  }
  const who = account && !byId.length ? account.label : target
  const rows = list.map((s) => `  sideby sessions copy ${shortId(s.sessionId)}    ${s.label}`).join('\n')
  throw new UserError(`${who} runs ${list.length} sessions now; copy one by its id:\n${rows}`, {
    code: 'several-sessions',
  })
}
