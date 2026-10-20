// Run Links (spec §3.32 step 2b, ADR-0041): which Run of a local orchestrator a Live Session works for, read from
// the orchestrator's optional Session Index, and its Run Board, a static HTML file in the orchestrator's state
// folder. Read-only and best effort: no index, one too big, of another version or that does not parse, or a board
// file that does not check out, all mean "no Run" and nothing else changes. No network request.
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Runtime } from '../runtime.ts'
import type { Env } from '../types.ts'
import { openWithDefault } from './edit-settings.ts'
import { UserError } from './errors.ts'

/** One Run a Session works for, as the index names it. */
export interface RunEntry {
  title: string
  laneTitle?: string
  role?: string
  /** The Run Board file (absolute path). */
  board: string
  /** `file://<board>`, with `#lane-<id>` for a lane. */
  url: string
}

/** What a Live Session shows of its Run: the first by role, and the other Runs it also works for. */
export interface SessionRun extends RunEntry {
  others?: Pick<RunEntry, 'title' | 'laneTitle' | 'role' | 'board'>[]
}

/** The largest Session Index sideby reads; a bigger one is ignored. */
export const INDEX_MAX_BYTES = 256 * 1024
const MAX_TEXT = 120
// Built from a string: a regex literal with control characters reads as a typo to linters.
// biome-ignore lint/complexity/useRegexLiterals: the literal form is what noControlCharactersInRegex rejects
const CONTROL = new RegExp(String.raw`[\x00-\x1f\x7f-\x9f]+`, 'g')
/** Which entry a Session shows first when it works for several Runs; any other role comes after these. */
export const ROLE_ORDER = ['coordinator', 'write', 'review', 'research']

/** The orchestrator's state folder: `AGENT_DISPATCH_STATE_DIR`, else `$XDG_STATE_HOME/agent-dispatch`, else `~/.local/state/agent-dispatch`. */
export function dispatchStateDir(env: Env, home: string): string {
  const own = env.AGENT_DISPATCH_STATE_DIR
  if (own && isAbsolute(own)) return own
  const xdg = env.XDG_STATE_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'agent-dispatch')
}

export const sessionIndexPath = (env: Env, home: string): string =>
  join(dispatchStateDir(env, home), 'sessions.json')

// Titles come from another program: one line, no control characters, a sane length.
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const one = value.replace(CONTROL, ' ').trim()
  if (!one) return undefined
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one
}

function entry(raw: unknown): RunEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.board !== 'string' || typeof r.url !== 'string') return undefined
  const title = text(r.runTitle) ?? text(r.run)
  if (!title) return undefined
  const laneTitle = text(r.laneTitle) ?? text(r.lane)
  const role = text(r.role)
  return { title, ...(laneTitle ? { laneTitle } : {}), ...(role ? { role } : {}), board: r.board, url: r.url }
}

/**
 * Parses a Session Index: `{ schemaVersion: 1, revision?, generatedAt?, sessions: { <id>: { entries: [...] } } }`,
 * each entry `{ run, runTitle, board, lane, laneTitle, role, url }`. Undefined when it is not version 1; entries
 * without a title, `board` or `url` are left out. The board files are checked by `checkedEntry`.
 */
export function parseSessionIndex(json: string): Map<string, RunEntry[]> | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  const d = doc as Record<string, unknown>
  if (d.schemaVersion !== 1 || !d.sessions || typeof d.sessions !== 'object' || Array.isArray(d.sessions))
    return undefined
  const out = new Map<string, RunEntry[]>()
  for (const [id, value] of Object.entries(d.sessions as Record<string, unknown>)) {
    if (!id || id.length > 200 || !value || typeof value !== 'object') continue
    const list = (value as { entries?: unknown }).entries
    if (!Array.isArray(list)) continue
    const runs = list.map(entry).filter((e): e is RunEntry => e !== undefined)
    if (runs.length) out.set(id, runs)
  }
  return out
}

/** Reads the Session Index; undefined when there is none or it cannot be used. Never follows a link at the file. */
export async function readSessionIndex(path: string): Promise<Map<string, RunEntry[]> | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile() || st.size > INDEX_MAX_BYTES) return undefined
    const buf = Buffer.alloc(INDEX_MAX_BYTES + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (bytesRead > INDEX_MAX_BYTES) return undefined
    return parseSessionIndex(buf.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

export interface BoardCheck {
  /** The real path of `<state>/boards`. */
  boardsDir: string
  uid: number | undefined
  /** The boards folder's device and inode when it was checked. */
  dev: number
  ino: number
}

/** A board file's device and inode when it was checked. */
export interface BoardIdentity {
  dev: number
  ino: number
}

/** The orchestrator's boards folder, when it is a real folder of the current user. */
export async function boardsCheck(
  env: Env,
  home: string,
  uid = process.getuid?.(),
): Promise<BoardCheck | undefined> {
  const dir = join(dispatchStateDir(env, home), 'boards')
  try {
    const st = await lstat(dir)
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return undefined
    return { boardsDir: await realpath(dir), uid, dev: st.dev, ino: st.ino }
  } catch {
    return undefined
  }
}

const LANE = /^#lane-[A-Za-z0-9%._~-]+$/

/**
 * The entry when its board is a regular `.html` file of the current user, not a link, right inside the boards
 * folder, and its `url` is exactly `file://<board>` with an optional `#lane-<id>`; undefined otherwise.
 */
export async function checkedEntry(e: RunEntry, check: BoardCheck): Promise<RunEntry | undefined> {
  return (await inspectEntry(e, check))?.entry
}

/** `checkedEntry`, with the board file's identity at the time of the check. */
async function inspectEntry(
  e: RunEntry,
  check: BoardCheck,
): Promise<{ entry: RunEntry; id: BoardIdentity } | undefined> {
  const name = basename(e.board)
  if (!isAbsolute(e.board) || !name.endsWith('.html') || name === '.html') return undefined
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(e.board)
    if (!st.isFile() || (check.uid !== undefined && st.uid !== check.uid)) return undefined
    if ((await realpath(dirname(e.board))) !== check.boardsDir) return undefined
    if ((await realpath(e.board)) !== join(check.boardsDir, name)) return undefined
    const url = new URL(e.url)
    if (url.protocol !== 'file:' || url.host || url.search || url.username || url.password) return undefined
    if (url.hash && !LANE.test(url.hash)) return undefined
    url.hash = ''
    if (fileURLToPath(url) !== e.board) return undefined
  } catch {
    return undefined
  }
  return { entry: e, id: { dev: st.dev, ino: st.ino } }
}

/**
 * True while `board` and its boards folder are still the files that were checked: neither is a link, both belong to
 * the user, their device and inode are unchanged, and the board's real path is still right inside the folder. Asked
 * right before the board is opened, so a file swapped after the check is not opened.
 */
export async function stillTheBoard(board: string, check: BoardCheck, id: BoardIdentity): Promise<boolean> {
  try {
    const dir = await lstat(dirname(board))
    if (!dir.isDirectory() || dir.dev !== check.dev || dir.ino !== check.ino) return false
    if (check.uid !== undefined && dir.uid !== check.uid) return false
    const st = await lstat(board)
    if (!st.isFile() || st.dev !== id.dev || st.ino !== id.ino) return false
    if (check.uid !== undefined && st.uid !== check.uid) return false
    return (await realpath(board)) === join(check.boardsDir, basename(board))
  } catch {
    return false
  }
}

const rank = (role?: string) => {
  const i = ROLE_ORDER.indexOf(role ?? '')
  return i === -1 ? ROLE_ORDER.length : i
}

/** The entries in the order a Session shows them: coordinator, write, review, research, then any other role. */
export function byRole(list: readonly RunEntry[]): RunEntry[] {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.role) - rank(b.e.role) || a.i - b.i)
    .map(({ e }) => e)
}

/** The checked entries of `sessionId`, in the order it shows them. */
async function checkedRuns(entries: readonly RunEntry[], check: BoardCheck): Promise<RunEntry[]> {
  const ok = await Promise.all(entries.map((e) => checkedEntry(e, check)))
  return byRole(ok.filter((e): e is RunEntry => e !== undefined))
}

/** The Run each of `sessionIds` works for; an empty map when there is no index, no boards folder or no match. */
export async function runsForSessions(
  env: Env,
  home: string,
  sessionIds: readonly string[],
  uid?: number,
): Promise<Map<string, SessionRun>> {
  const out = new Map<string, SessionRun>()
  if (!sessionIds.length) return out
  const index = await readSessionIndex(sessionIndexPath(env, home))
  if (!index) return out
  const wanted = sessionIds.filter((id) => index.has(id))
  if (!wanted.length) return out
  const check = await boardsCheck(env, home, uid)
  if (!check) return out
  for (const id of wanted) {
    const [first, ...rest] = await checkedRuns(index.get(id)!, check)
    if (!first) continue
    const others = rest.map((e) => ({
      title: e.title,
      ...(e.laneTitle ? { laneTitle: e.laneTitle } : {}),
      ...(e.role ? { role: e.role } : {}),
      board: e.board,
    }))
    out.set(id, { ...first, ...(others.length ? { others } : {}) })
  }
  return out
}

/** The same Sessions, each with `run` where the Session Index ties it to a Run. */
export async function withRuns<T extends { sessionId: string }>(
  env: Env,
  home: string,
  sessions: T[],
  uid?: number,
): Promise<(T & { run?: SessionRun })[]> {
  const runs = await runsForSessions(
    env,
    home,
    sessions.map((s) => s.sessionId),
    uid,
  )
  return sessions.map((s) => {
    const run = runs.get(s.sessionId)
    return run ? { ...s, run } : s
  })
}

/**
 * Opens the Run Board of `sessionId` with the system's default program. The path comes only from the Session Index,
 * read and checked again here, and checked once more right before the program starts; returns the board and the
 * command that opened it.
 */
export async function openRunBoard(
  rt: Runtime,
  sessionId: string,
): Promise<{ board: string; command: string[] }> {
  const gone = () =>
    new UserError(
      'This session is not part of a run any more, or its board file is gone; ask the coordinating AI to show the board again',
      { code: 'no-run' },
    )
  const entries = (await readSessionIndex(sessionIndexPath(rt.env, rt.paths.home)))?.get(sessionId)
  const check = entries && (await boardsCheck(rt.env, rt.paths.home))
  if (!entries || !check) throw gone()
  const ok = (await Promise.all(entries.map((e) => inspectEntry(e, check)))).filter((x) => x !== undefined)
  const first = byRole(ok.map((x) => x.entry))[0]
  const id = ok.find((x) => x.entry === first)?.id
  if (!first || !id) throw gone()
  if (!(await stillTheBoard(first.board, check, id)))
    throw new UserError(
      'The board file changed while sideby checked it; ask the coordinating AI to show the board again',
      { code: 'board-changed' },
    )
  return { board: first.board, command: await openWithDefault(rt, first.board, { text: false }) }
}
