// Delivering a Message into a running Codex session (spec §3.32 step 4, ADR-0040): Codex's own `codex queue`, which
// queues text for an existing session; the session takes it as its next turn once the current one ends, or within
// about 10 s when it is idle (codex-cli 0.163.0). Codex reads its own login; sideby reads no credential. Only the
// paste line goes on the command line, never the Message's text: other users on the machine can see arguments.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { accountEnv } from '../../core/launch.ts'
import type { Delivery, DeliveryRequest } from '../messaging.ts'

export const QUEUE_TIMEOUT_MS = 20_000
/** How long the queue process gets to end after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 2_000

/**
 * `codex queue` started but did not finish in time: it may already have queued the line, so the outcome is unknown
 * (ADR-0065), unlike a start failure or a non-zero exit, which mean it did not.
 */
export class CodexQueueTimeout extends Error {}

/**
 * Runs `codex <args>` and resolves to its exit code; its output is ignored, as it may hold account details. Rejects
 * with `CodexQueueTimeout` when the process started and did not end within `timeoutMs`, else with a plain Error.
 */
export function runCodex(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: tmpdir(), env, stdio: 'ignore' })
    let started = false
    child.once('spawn', () => {
      started = true
    })
    const timer = setTimeout(() => {
      // Only this short-lived queue process is ended (by its own pid), never a Codex session.
      child.kill('SIGTERM')
      const pid = child.pid
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && pid !== undefined)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
      }, KILL_GRACE_MS).unref()
      const why = 'Codex did not answer in time'
      reject(started ? new CodexQueueTimeout(why) : new Error(why))
    }, timeoutMs)
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ENOENT' ? 'Codex is not on PATH' : 'Codex could not start'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

export async function deliverCodex(req: DeliveryRequest): Promise<Delivery> {
  const { rt, to, acct, pid, procs, deps } = req
  const family = rt.families.get('codex')
  if (!family)
    return { status: 'paste-needed', note: 'the Codex plugin is not loaded; paste the line into its tab' }
  // Looked at again right before queueing: the session may have ended, or its process moved on to another one.
  if (!(await procs.get(pid)) || (to.transcript && !(await procs.openFiles(pid)).includes(to.transcript)))
    return {
      status: 'paste-needed',
      note: `${to.label} stopped running; start it again, then paste this line into its terminal tab`,
    }
  const args = [
    ...(family.defaultArgs?.(acct, []) ?? []),
    'queue',
    '--thread',
    to.sessionId,
    '--message',
    req.pasteText,
  ]
  let code: number
  try {
    code = await (deps.runCodex ?? runCodex)(
      args,
      accountEnv(family, acct, rt.env),
      deps.timeoutMs ?? QUEUE_TIMEOUT_MS,
    )
  } catch (err) {
    if (err instanceof CodexQueueTimeout) {
      // It may have queued the line already; a paste on top of it could reach the session twice.
      const ended = await req.ended()
      return {
        status: 'unknown',
        note: `sideby could not confirm that ${to.label} got it: \`codex queue\` did not finish within ${(deps.timeoutMs ?? QUEUE_TIMEOUT_MS) / 1000} s.${ended ? ' The session has ended since.' : ''} It may still show up; check the session before you send it again`,
      }
    }
    return {
      status: 'paste-needed',
      note: `sideby could not send it to ${to.label} (${(err as Error).message}); paste the line into its terminal tab`,
    }
  }
  if (code !== 0)
    return {
      status: 'paste-needed',
      note: `Codex could not take the message (\`codex queue\` exited with ${code}; requires Codex 0.163+ and a saved session). Paste the line into its terminal tab`,
    }
  return {
    status: 'delivered',
    note: `sent to ${to.label}; Codex reads it when its current turn ends`,
  }
}
