// Attended Sessions (spec §3.37 "有人在的会话", ADR-0075): a Claude session someone typed into within the last 30 minutes
// asks as usual while Unattended Mode stays on for every other session. A leaf module (Node built-ins and leaf modules
// only): `unattended-hook` imports it.
//
// Only `unattended-hook`'s background `UserPromptSubmit` entry writes a record, and only after the session's own
// transcript (`ownTranscript`) said the prompt was typed by a person (`promptOrigin`). One file per session under `<state>/unattended/attended/`,
// named by a hash of the session id; every level must be a real folder of the user that nobody else can write to
// (`ownedFolder`, as for Pending Decisions). Nothing of the prompt is kept. A record is read and written back under a lock
// of its own (`<hash>.lock` beside it), so a told mark never puts back an older `at` a prompt has just renewed.
import { constants } from 'node:fs'
import { type FileHandle, open, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic } from './fs-safe.ts'
import { takeFileLock } from './lock.ts'
import {
  readUnattendedConfig,
  readUnattendedOverride,
  type UnattendedState,
  unattendedState,
} from './unattended-state.ts'

/** How long a session counts as attended after each prompt someone typed into it. */
export const ATTENDED_MS = 30 * 60_000
/** The `timeout` of the hook entry: the longest wait for the transcript (`ORIGIN_WAIT_MS`) with room to spare. */
export const ATTENDED_HOOK_TIMEOUT_S = 30
/** How long the hook waits for Claude Code to write the prompt into the transcript (70–180 ms with Claude Code 2.1.325). */
export const ORIGIN_WAIT_MS = 10_000
const ORIGIN_POLL_MS = 50
/**
 * How far before the transcript's end at the start the prompt's line is looked for (a queued prompt is written early).
 * Reading starts at the beginning of the line that holds this point, so a line longer than it (a prompt with a
 * picture) is read whole.
 */
const ORIGIN_BACK_BYTES = 256 * 1024
/** The most of a transcript read while waiting, and the longest line held: past either, the prompt does not count. */
const ORIGIN_READ_MAX = 32 * 1024 * 1024
const LINE_MAX = 8 * 1024 * 1024
/** A record that ran out more than this long ago is removed. */
const KEEP_EXPIRED_MS = 60 * 60_000

const PARTS = ['unattended', 'attended'] as const

/** One Attended Session as kept on disk. */
export interface AttendedRecord {
  sessionId: string
  family: string
  account?: string
  cwd?: string
  /** The last prompt someone typed. */
  at: string
  /** When this stretch of being attended began: `at` of the first prompt after the last one ran out. */
  since: string
  /** When the user was told in the session, during this stretch. */
  toldAt?: string
}

/** An Attended Session as `sideby unattended --json` and the Panel show it. */
export interface AttendedSession {
  sessionId: string
  family: string
  account?: string
  cwd?: string
  since: string
  /** When it stops counting as attended unless someone types again. */
  until: string
}

const fileName = (sessionId: string) => `${sha256(sessionId).slice(0, 32)}.json`
const lockName = (sessionId: string) => `${sha256(sessionId).slice(0, 32)}.lock`
/** One session's record is read and written back by one caller at a time; a holder that died frees it after `staleMs`. */
const LOCK = { staleMs: 15_000, beatMs: 5_000 }
const LOCK_WAIT = { timeoutMs: 5_000, pollMs: 25 }
const iso = (ms: number) => new Date(ms).toISOString()

function parse(text: string | undefined): AttendedRecord | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined)
    const sessionId = str(v.sessionId)
    const family = str(v.family)
    const at = str(v.at)
    const since = str(v.since)
    if (!sessionId || !family || !at || !since) return undefined
    if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(since))) return undefined
    const account = str(v.account)
    const cwd = str(v.cwd)
    const toldAt = str(v.toldAt)
    return {
      sessionId,
      family,
      ...(account ? { account } : {}),
      ...(cwd ? { cwd } : {}),
      at,
      since,
      ...(toldAt && Number.isFinite(Date.parse(toldAt)) ? { toldAt } : {}),
    }
  } catch {
    return undefined
  }
}

/** When the record stops counting, in ms; it counts while this is later than now. */
export const attendedEnd = (r: AttendedRecord): number => Date.parse(r.at) + ATTENDED_MS

/** The session's record while it still counts at `now`; undefined otherwise or when the folder is not safe. */
export async function readAttended(
  stateDir: string,
  sessionId: string,
  now: Date,
): Promise<AttendedRecord | undefined> {
  const dir = await ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  if (!dir) return undefined
  const r = parse(await readSmallFile(join(dir, fileName(sessionId)), 8192))
  const t = now.getTime()
  return r && r.sessionId === sessionId && Date.parse(r.at) <= t && t < attendedEnd(r) ? r : undefined
}

/**
 * Notes a prompt someone typed into the session at `at`: it counts as attended for `ATTENDED_MS` from then. A stretch
 * that was still running goes on (its `since` and `toldAt` are kept); otherwise a new one starts. A prompt no later than
 * the one already noted changes nothing. Removes records that ran out over an hour ago. Throws when the folder is not
 * safe to use, or when the session's record stays locked for 5 seconds.
 */
export async function markAttended(
  stateDir: string,
  who: { sessionId: string; family: string; account?: string; cwd?: string },
  at: Date,
): Promise<AttendedRecord> {
  const dir = (await ownedFolder(stateDir, PARTS, { create: true, private: true }))!
  const file = join(dir, fileName(who.sessionId))
  const t = at.getTime()
  const release = await takeFileLock(join(dir, lockName(who.sessionId)), { ...LOCK, wait: LOCK_WAIT })
  if (!release)
    throw new Error(`the Attended Session record ${file} stayed locked; the next prompt notes it again`)
  let record: AttendedRecord
  try {
    const old = parse(await readSmallFile(file, 8192))
    // A prompt no later than the one already noted (an old prompt's id handed in again, or two hooks out of order)
    // changes nothing.
    if (old && old.sessionId === who.sessionId && t <= Date.parse(old.at) && t < attendedEnd(old)) return old
    const running = old && old.sessionId === who.sessionId && t < attendedEnd(old) && Date.parse(old.at) <= t
    record = {
      sessionId: who.sessionId,
      family: who.family,
      ...(who.account ? { account: who.account } : {}),
      ...(who.cwd ? { cwd: who.cwd } : {}),
      at: iso(t),
      since: running ? old.since : iso(t),
      ...(running && old.toldAt ? { toldAt: old.toldAt } : {}),
    }
    await writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600)
  } finally {
    await release()
  }
  await pruneAttended(dir, t)
  return record
}

/**
 * Notes that the user was told in the session during the stretch that began at `since`. Best effort: a record that
 * stays locked is left as it is. `beforeWrite` runs between the read and the write (for tests).
 */
export async function markTold(
  stateDir: string,
  sessionId: string,
  since: string,
  now: Date,
  deps: { beforeWrite?: () => Promise<void> } = {},
): Promise<void> {
  const dir = await ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  if (!dir) return
  const file = join(dir, fileName(sessionId))
  const release = await takeFileLock(join(dir, lockName(sessionId)), { ...LOCK, wait: LOCK_WAIT }).catch(
    () => null,
  )
  if (!release) return
  try {
    const r = parse(await readSmallFile(file, 8192))
    if (!r || r.sessionId !== sessionId || r.since !== since) return
    await deps.beforeWrite?.()
    await writeFileAtomic(file, `${JSON.stringify({ ...r, toldAt: now.toISOString() })}\n`, 0o600)
  } finally {
    await release()
  }
}

async function pruneAttended(dir: string, t: number): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const r = parse(await readSmallFile(join(dir, name), 8192))
    if (!r || attendedEnd(r) + KEEP_EXPIRED_MS < t) await rm(join(dir, name), { force: true }).catch(() => {})
  }
}

/** Every session that counts as attended at `now`, latest end first. `prune` also removes long-expired records. */
export async function listAttended(
  stateDir: string,
  now: Date,
  opts: { prune?: boolean } = {},
): Promise<AttendedSession[]> {
  const dir = await ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  if (!dir) return []
  const t = now.getTime()
  const out: AttendedSession[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const r = parse(await readSmallFile(join(dir, name), 8192))
    if (!r || name !== fileName(r.sessionId) || Date.parse(r.at) > t || attendedEnd(r) <= t) continue
    out.push({
      sessionId: r.sessionId,
      family: r.family,
      ...(r.account ? { account: r.account } : {}),
      ...(r.cwd ? { cwd: r.cwd } : {}),
      since: r.since,
      until: iso(attendedEnd(r)),
    })
  }
  if (opts.prune) await pruneAttended(dir, t)
  return out.sort(
    (a, b) => Date.parse(b.until) - Date.parse(a.until) || a.sessionId.localeCompare(b.sessionId),
  )
}

/**
 * Whether `transcript` is the file where Claude Code keeps session `sessionId`'s transcript:
 * `<config dir>/projects/<folder>/<session id>.jsonl`, the config dir being `CLAUDE_CONFIG_DIR` or `~/.claude`, compared
 * after resolving links. A hook input that names any other file is not believed, so a made-up transcript elsewhere marks
 * nothing.
 */
export async function ownTranscript(
  transcript: string,
  sessionId: string,
  env: { HOME?: string | undefined; CLAUDE_CONFIG_DIR?: string | undefined },
): Promise<boolean> {
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
  if (!isAbsolute(transcript) || !isAbsolute(config) || basename(transcript) !== `${sessionId}.jsonl`)
    return false
  const [got, want] = await Promise.all([
    realpath(dirname(dirname(transcript))).catch(() => undefined),
    realpath(join(config, 'projects')).catch(() => undefined),
  ])
  return got !== undefined && got === want
}

/** What a session's transcript says of one prompt. Its text is only for checking, and is never kept. */
export interface PromptLine {
  /** `human` for a prompt a person typed; `other` for anything else that has an origin. */
  origin: 'human' | 'other'
  /** When Claude Code wrote the line (its `timestamp`, in ms); missing when it is not a time. */
  at?: number
  /** The prompt as the transcript holds it (a string, or its text blocks joined); missing when it is neither. */
  text?: string
}

/**
 * The transcript line of prompt `promptId`: Claude Code writes a `user` line with the prompt's `promptId`, its text, a
 * `timestamp` and an `origin` (`human` for a typed prompt; `task-notification`, `peer` for a Message from another
 * process or session; none under `-p`; checked with Claude Code 2.1.325). The line is written shortly after the hook
 * starts, so the transcript is read from the start of the line `ORIGIN_BACK_BYTES` before its end at the start, then every `ORIGIN_POLL_MS` what
 * was added, for at most `ORIGIN_WAIT_MS`. Only lines holding the prompt id are parsed, and of them only `type`,
 * `promptId`, `origin.kind`, `timestamp` and the message's text are looked at. Undefined when it cannot tell.
 */
export async function promptOrigin(
  transcript: string,
  promptId: string,
  deps: { sleep?: (ms: number) => Promise<void>; clock?: () => number } = {},
): Promise<PromptLine | undefined> {
  if (!isAbsolute(transcript) || !transcript.endsWith('.jsonl') || !promptId) return undefined
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const clock = deps.clock ?? Date.now
  const start = clock()
  let offset: number | undefined
  let rest = ''
  let read = 0
  for (;;) {
    const fh = await open(transcript, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
      () => undefined,
    )
    if (fh) {
      try {
        const st = await fh.stat()
        if (!st.isFile()) return undefined
        // A transcript that did not exist yet when the hook started (a new session's first prompt) is read whole.
        if (offset === undefined) offset = await lineStart(fh, Math.max(0, st.size - ORIGIN_BACK_BYTES))
        if (st.size < offset) [offset, rest] = [0, '']
        while (offset < st.size) {
          const len = Math.min(st.size - offset, 1024 * 1024)
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, offset)
          if (!bytesRead) break
          offset += bytesRead
          read += bytesRead
          const lines = (rest + buf.subarray(0, bytesRead).toString('utf8')).split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines) {
            const found = originOf(line, promptId)
            if (found) return found
          }
          if (read > ORIGIN_READ_MAX || rest.length > LINE_MAX) return undefined
        }
      } finally {
        await fh.close().catch(() => {})
      }
    } else offset ??= 0
    if (clock() - start >= ORIGIN_WAIT_MS) return undefined
    await sleep(ORIGIN_POLL_MS)
  }
}

/**
 * Where the line that holds byte `at` starts: just after the last newline before it, looked for at most `LINE_MAX`
 * back. A line longer than that is not held anyway, so `at` itself is kept.
 */
async function lineStart(fh: FileHandle, at: number): Promise<number> {
  const stop = Math.max(0, at - LINE_MAX)
  let end = at
  while (end > stop) {
    const len = Math.min(end - stop, 64 * 1024)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, end - len)
    if (bytesRead < len) return at
    const nl = buf.lastIndexOf(0x0a)
    if (nl >= 0) return end - len + nl + 1
    end -= len
  }
  return stop === 0 ? 0 : at
}

function originOf(line: string, promptId: string): PromptLine | undefined {
  if (!line.includes(promptId) || !line.includes('"origin"')) return undefined
  try {
    const r = JSON.parse(line) as {
      type?: unknown
      promptId?: unknown
      origin?: { kind?: unknown } | null
      timestamp?: unknown
      message?: { content?: unknown } | null
    }
    if (r.type !== 'user' || r.promptId !== promptId || !r.origin || typeof r.origin !== 'object')
      return undefined
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
    const text = textOf(r.message?.content)
    return {
      origin: r.origin.kind === 'human' ? 'human' : 'other',
      ...(Number.isFinite(at) ? { at } : {}),
      ...(text !== undefined ? { text } : {}),
    }
  } catch {
    return undefined
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const b of content as { type?: unknown; text?: unknown }[])
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  return parts.join('\n')
}

/**
 * Whether one session is unattended right now: Unattended Mode is on (the Schedule, the manual state and the session
 * flag, read fresh) and the session is not an Attended Session. `attended` is its record while it counts. Hooks and
 * later features that must stay quiet in an unattended session ask this.
 */
export async function sessionUnattended(opts: {
  stateDir: string
  configFile: string
  /** The session was started with `--unattended`. */
  session: boolean
  sessionId?: string
  now: Date
}): Promise<{ on: boolean; state: UnattendedState; attended?: AttendedRecord }> {
  const { schedule } = await readUnattendedConfig(opts.configFile)
  const override = await readUnattendedOverride(opts.stateDir)
  const state = unattendedState({ schedule, override, now: opts.now, session: opts.session })
  const attended = opts.sessionId ? await readAttended(opts.stateDir, opts.sessionId, opts.now) : undefined
  return { on: state.on && !attended, state, ...(attended ? { attended } : {}) }
}
