// Claude Code's own cross-session channel (spec §3.32 step 2, ADR-0040; tried with Claude Code 2.1.304 on
// 2026-10-20). Each running session names a Unix socket in its `<dir>/sessions/<pid>.json` (`messagingSocketPath`).
// Claude Code binds it under `$XDG_RUNTIME_DIR/cc-socks/` where that variable is set (Linux, WSL), else under the
// system temp directory's `cc-socks/`, and falls back to a per-user `cc-socks-<uid>/` when it cannot accept the shared
// folder (its docs, "The session's inbox socket"). One JSON line written to it reaches that session as "Another
// Claude session sent a message". sideby writes there only after the checks below, sends no token, and never opens
// the `<pid>.<hash>.key` files next to the record.
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { lstatOrNull, realpathOrNull } from '../../core/fs-safe.ts'
import type { ProcessView } from '../../core/live-sessions-procs.ts'
import { readSessionRecord, recordRunsOn, sessionRecordPath, tailLinesWith } from './session-files.ts'

/** How long sideby waits for a session's socket to accept the Message. */
export const DELIVER_TIMEOUT_MS = 3_000

/** The socket path a running session's record names, read from that record only (no other field leaves here). */
export async function claudeSocketOf(
  accountDir: string,
  pid: number,
  sessionId: string,
  procs: ProcessView,
): Promise<{ path: string } | { problem: string }> {
  const rec = await readSessionRecord(sessionRecordPath(accountDir, pid))
  if (!rec) return { problem: 'sideby could not read its session info' }
  if (rec.sessionId !== sessionId) return { problem: 'that terminal is now running a different session' }
  if (!recordRunsOn(rec, await procs.get(pid))) return { problem: 'the session has ended' }
  const path = rec.messagingSocketPath
  if (typeof path !== 'string' || !path)
    return {
      problem: 'this Claude Code version cannot receive messages directly (update to 2.1.304 or newer)',
    }
  return { path }
}

/** What a checked socket and its folder were on disk, to tell later that the path still names the same ones. */
export interface SocketIdentity {
  dev: number
  ino: number
  uid: number
  dirDev: number
  dirIno: number
  dirUid: number
}

/**
 * The folders a Claude Code inbox socket's `cc-socks` directory may sit in: `$XDG_RUNTIME_DIR` when set to an
 * absolute path (Claude Code's first choice on Linux and WSL), then the system temp directories.
 */
export function socketRoots(env: NodeJS.ProcessEnv): string[] {
  const runtime = env.XDG_RUNTIME_DIR
  return [...(runtime && isAbsolute(runtime) ? [runtime] : []), tmpdir(), '/tmp']
}

/**
 * Whether `name` is a socket folder Claude Code creates: `cc-socks`, or the per-user `cc-socks-<uid>` it falls back to.
 * A suffix must be this user's id when it is known, so another user's fallback folder is never accepted.
 */
export function isSocketFolderName(name: string, uid: number | undefined): boolean {
  const m = /^cc-socks(?:-(\d+))?$/.exec(name)
  if (!m) return false
  return m[1] === undefined || uid === undefined || Number(m[1]) === uid
}

/**
 * Checks `path` as a socket sideby may write to: an absolute path whose directory is `cc-socks` (or this user's
 * `cc-socks-<uid>`) right inside one of `tempRoots` (`socketRoots`), that directory a real directory of `uid` that no
 * one else can enter, and `path` itself a socket of `uid`, not a link. Returns why not, or what the socket and its
 * folder are on disk.
 */
export async function checkSocket(
  path: string,
  o: { tempRoots: readonly string[]; uid: number | undefined },
): Promise<{ problem: string } | { identity: SocketIdentity }> {
  const no = (problem: string) => ({ problem })
  if (!isAbsolute(path)) return no('its message channel path is invalid (restart the session to fix it)')
  const dir = dirname(path)
  if (!isSocketFolderName(basename(dir), o.uid))
    return no('its message channel is not in a cc-socks folder (restart the session to fix it)')
  const roots = new Set(
    (await Promise.all(o.tempRoots.map((r) => realpathOrNull(r)))).filter((r): r is string => r !== null),
  )
  const parent = await realpathOrNull(dirname(dir))
  if (!parent || !roots.has(parent))
    return no('its message channel is outside the system temp folder (restart the session to fix it)')
  const d = await lstatOrNull(dir)
  if (!d?.isDirectory())
    return no('its message channel folder is not a real folder (restart the session to fix it)')
  if (o.uid !== undefined && d.uid !== o.uid)
    return no('its message channel folder belongs to another user on this computer')
  if (d.mode & 0o077)
    return no(
      'other users on this computer can access its message channel folder (restart the session to fix it)',
    )
  const s = await lstatOrNull(path)
  if (!s) return no('its message channel is gone (the session may have ended)')
  if (s.isSymbolicLink())
    return no('its message channel is a symlink instead of a live channel (restart the session to fix it)')
  if (!s.isSocket())
    return no('its message channel is not a valid channel file (restart the session to fix it)')
  if (o.uid !== undefined && s.uid !== o.uid)
    return no('its message channel belongs to another user on this computer')
  return {
    identity: { dev: s.dev, ino: s.ino, uid: s.uid, dirDev: d.dev, dirIno: d.ino, dirUid: d.uid },
  }
}

/** `checkSocket` as a reason only: null when sideby may write to `path`. */
export async function socketProblem(
  path: string,
  o: { tempRoots: readonly string[]; uid: number | undefined },
): Promise<string | null> {
  const r = await checkSocket(path, o)
  return 'problem' in r ? r.problem : null
}

/**
 * Why `path` no longer names the socket and folder `id` describes (replaced, made a link, given to another user), or
 * null when it still does. Run after connecting and before writing, so a swap after the check is caught.
 * Node offers no way to ask a Unix socket's peer for its pid without a native module (macOS `LOCAL_PEERPID`, Linux
 * `SO_PEERCRED`), so the peer itself is not compared; the path, its folder and their owners are.
 */
export async function socketChanged(path: string, id: SocketIdentity): Promise<string | null> {
  const d = await lstatOrNull(dirname(path))
  if (!d?.isDirectory() || d.dev !== id.dirDev || d.ino !== id.dirIno || d.uid !== id.dirUid)
    return 'its message channel folder changed while sending (send again)'
  const s = await lstatOrNull(path)
  if (!s?.isSocket() || s.dev !== id.dev || s.ino !== id.ino || s.uid !== id.uid)
    return 'its message channel changed while sending (send again)'
  return null
}

/** The one line Claude Code reads from its socket as a user message. */
export const messageLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`

/**
 * The line was handed to the socket and its end sent, but the flush was never confirmed (a timeout or an error after
 * that point): the session may have read it, so the outcome is unknown (ADR-0065), unlike a failure before writing.
 */
export class UnconfirmedWrite extends Error {}

/**
 * Connects to `path`, runs `verify` (a reason rejects before anything is written), writes `line`, and closes the
 * connection as soon as the line is flushed, also when the peer keeps its end open. Rejects on a refused connection
 * or after `timeoutMs`; with `UnconfirmedWrite` once the line was written and the flush did not come.
 */
export function writeToSocket(
  path: string,
  line: string,
  timeoutMs = DELIVER_TIMEOUT_MS,
  verify?: () => Promise<string | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    let written = false
    const sock = createConnection({ path })
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(written ? new UnconfirmedWrite(err.message) : err)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error(`it did not answer within ${timeoutMs / 1000} s`)),
      timeoutMs,
    )
    sock.once('connect', async () => {
      const changed = verify ? await verify().catch((e: Error) => e.message) : null
      if (changed) return finish(new Error(changed))
      if (done) return
      written = true
      sock.end(line, () => finish(null))
    })
    sock.once('error', (err: NodeJS.ErrnoException) =>
      finish(
        new Error(err.code === 'ECONNREFUSED' ? 'it refused the connection' : (err.code ?? err.message)),
      ),
    )
  })
}

/** Whether Host arguments start Claude Code in bypass permission mode. */
export function argsBypass(args: readonly string[]): boolean {
  return args.some(
    (a, i) =>
      a === '--dangerously-skip-permissions' ||
      a === '--permission-mode=bypassPermissions' ||
      (a === '--permission-mode' && args[i + 1] === 'bypassPermissions'),
  )
}

/**
 * Whether a running session is in bypass permission mode: the last `permission-mode` record near the end of its
 * transcript (it follows Shift+Tab), else its process arguments. Only those records are parsed.
 */
export async function sessionBypass(
  transcript: string | undefined,
  args: readonly string[],
): Promise<boolean> {
  if (transcript) {
    const lines = await tailLinesWith(transcript, '"permission-mode"').catch(() => [])
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]!) as Record<string, unknown>
        if (rec.type === 'permission-mode' && typeof rec.permissionMode === 'string')
          return rec.permissionMode === 'bypassPermissions'
      } catch {
        // a line still being written
      }
    }
  }
  return argsBypass(args)
}
