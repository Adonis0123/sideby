// Claude Code's own cross-session channel (spec §3.32 step 2, ADR-0040; tried with Claude Code 2.1.304 on
// 2026-10-20). Each running session names a Unix socket in its `<dir>/sessions/<pid>.json` (`messagingSocketPath`,
// under `cc-socks` in the system temp directory); one JSON line written to it reaches that session as "Another
// Claude session sent a message". sideby writes there only after the checks below, sends no token, and never opens
// the `<pid>.<hash>.key` files next to the record.
import { open, readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { lstatOrNull, realpathOrNull, statOrNull } from '../../core/fs-safe.ts'
import { type ProcessView, parseLstart, sameStart } from '../../core/live-sessions-procs.ts'

/** How long sideby waits for a session's socket to accept the Message. */
export const DELIVER_TIMEOUT_MS = 3_000

/** The socket path a running session's record names, read from that record only (no other field leaves here). */
export async function claudeSocketOf(
  accountDir: string,
  pid: number,
  sessionId: string,
  procs: ProcessView,
): Promise<{ path: string } | { problem: string }> {
  let rec: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readFile(join(accountDir, 'sessions', `${pid}.json`), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    rec = parsed as Record<string, unknown>
  } catch {
    return { problem: 'its session record could not be read' }
  }
  if (rec.sessionId !== sessionId) return { problem: 'the process now runs another session' }
  const proc = await procs.get(pid)
  const started = parseLstart(typeof rec.procStart === 'string' ? rec.procStart : '')
  if (!proc || Number.isNaN(started) || !sameStart(proc, started)) return { problem: 'the session has ended' }
  const path = rec.messagingSocketPath
  if (typeof path !== 'string' || !path)
    return {
      problem: 'this version of Claude Code names no message socket (Claude Code 2.1.304 or newer has one)',
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
 * Checks `path` as a socket sideby may write to: an absolute path whose directory is `cc-socks` right inside one of
 * `tempRoots` (the system temp directories), that directory a real directory of `uid` that no one else can enter, and
 * `path` itself a socket of `uid`, not a link. Returns why not, or what the socket and its folder are on disk.
 */
export async function checkSocket(
  path: string,
  o: { tempRoots: readonly string[]; uid: number | undefined },
): Promise<{ problem: string } | { identity: SocketIdentity }> {
  const no = (problem: string) => ({ problem })
  if (!isAbsolute(path)) return no('its socket path is not absolute')
  const dir = dirname(path)
  if (basename(dir) !== 'cc-socks') return no('its socket is not in a cc-socks folder')
  const roots = new Set(
    (await Promise.all(o.tempRoots.map((r) => realpathOrNull(r)))).filter((r): r is string => r !== null),
  )
  const parent = await realpathOrNull(dirname(dir))
  if (!parent || !roots.has(parent)) return no('its socket is not in the system temp folder')
  const d = await lstatOrNull(dir)
  if (!d?.isDirectory()) return no('its socket folder is not a real folder')
  if (o.uid !== undefined && d.uid !== o.uid) return no('its socket folder belongs to another user')
  if (d.mode & 0o077) return no('others can enter its socket folder')
  const s = await lstatOrNull(path)
  if (!s) return no('its socket does not exist')
  if (s.isSymbolicLink()) return no('its socket is a link')
  if (!s.isSocket()) return no('its socket path is not a socket')
  if (o.uid !== undefined && s.uid !== o.uid) return no('its socket belongs to another user')
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
    return 'its socket folder was replaced after sideby checked it'
  const s = await lstatOrNull(path)
  if (!s?.isSocket() || s.dev !== id.dev || s.ino !== id.ino || s.uid !== id.uid)
    return 'its socket was replaced after sideby checked it'
  return null
}

/** The one line Claude Code reads from its socket as a user message. */
export const messageLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`

/**
 * Connects to `path`, runs `verify` (a reason rejects before anything is written), writes `line`, and closes the
 * connection as soon as the line is flushed, also when the peer keeps its end open. Rejects on a refused connection
 * or after `timeoutMs`.
 */
export function writeToSocket(
  path: string,
  line: string,
  timeoutMs = DELIVER_TIMEOUT_MS,
  verify?: () => Promise<string | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false
    const sock = createConnection({ path })
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
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

const TAIL_BYTES = 256 * 1024

/** The lines of the last `TAIL_BYTES` of a file that contain `needle` (the first, maybe cut, line is dropped). */
export async function tailLinesWith(file: string, needle: string): Promise<string[]> {
  const st = await statOrNull(file)
  if (!st?.isFile()) return []
  const fh = await open(file, 'r')
  try {
    const len = Math.min(st.size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    const lines = buf.toString('utf8').split('\n')
    if (len < st.size) lines.shift()
    return lines.filter((l) => l.includes(needle))
  } finally {
    await fh.close()
  }
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
