// Progress Reminders' state (spec §3.42, ADR-0076): the config value the hook reads by hand, the two records each
// Claude session keeps under `<state>/progress/sessions/`, and whether a `Stop` ends a reminder's turn. A leaf module
// (Node built-ins and leaf modules only): `progress-hook` and `handoff-hook` import it.
//
// Every level of the folder must be a real folder of the user that nobody else can write to (`ownedFolder`). The
// records hold hashes, times and a random id only: never a command, a task's description, a reply or a prompt.
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic } from './fs-safe.ts'
import { takeFileLock } from './lock.ts'

/** Set in a session's environment: the interval at launch, used only when the config cannot be read. */
export const PROGRESS_ENV = 'SIDEBY_PROGRESS_EVERY'
/** The interval in whole minutes: at least this, at most `PROGRESS_MAX` (under the hook's five-hour timeout). */
export const PROGRESS_MIN = 1
export const PROGRESS_MAX = 240
/** What turning it on picks when no interval is given. */
export const PROGRESS_DEFAULT = 30
/** The intervals the Panel offers. */
export const PROGRESS_CHOICES: readonly number[] = [5, 10, 15, 30, 60]
/** The `timeout` of the `Stop` entry, in seconds (the same as Auto Handoff's IdleWatch). */
export const PROGRESS_STOP_TIMEOUT_S = 18_000
/** The `timeout` of the `UserPromptSubmit` entry, in seconds. */
export const PROGRESS_PROMPT_TIMEOUT_S = 10

const PARTS = ['progress', 'sessions'] as const
/** A record left unchanged this long is removed at the next write. */
const KEEP_MS = 24 * 3600_000
const RECORD_MAX = 4096

export const validEvery = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= PROGRESS_MIN && v <= PROGRESS_MAX

const fromEnv = (env: Record<string, string | undefined>): number | undefined => {
  const raw = env[PROGRESS_ENV]
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return validEvery(n) ? n : undefined
}

/**
 * Config `progress.every`, read by hand (no schema) on every check: undefined means off. No config file means the
 * defaults (off), as for every other config reader; only a file that exists but cannot be read or is not JSON falls
 * back to the interval the session started with.
 */
export async function readProgressEvery(
  configFile: string,
  env: Record<string, string | undefined>,
): Promise<number | undefined> {
  let text: string
  try {
    // The config may be a link a dotfiles manager keeps; reading through it is fine.
    text = await readFile(configFile, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : fromEnv(env)
  }
  if (text.length > 4 * 1024 * 1024) return fromEnv(env)
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    return fromEnv(env)
  }
  const section =
    config && typeof config === 'object' ? (config as { progress?: unknown }).progress : undefined
  const every = section && typeof section === 'object' ? (section as { every?: unknown }).every : undefined
  return validEvery(every) ? every : undefined
}

/** The first 32 hex digits of a SHA-256: how a session id and a prompt id are kept. */
export const hashOf = (s: string): string => sha256(s).slice(0, 32)

/** The watch a `Stop` started: a later `Stop` replaces it, and the earlier watch then ends. */
export interface WatchRecord {
  id: string
  /** When the session began waiting: kept across reminder turns. */
  since: string
  /** When the hook of the `Stop` that started this watch began, before reading its input: the order of the Stops. */
  at: string
  /** When this watch woke the session. */
  wokeAt?: string
}

/** The latest prompt of the session. */
export interface PromptRecord {
  at: string
  /** `hashOf(prompt_id)`. */
  prompt: string
  /** The prompt was a Progress Reminder's wake-up and nothing else. */
  reminder: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function parseWatch(text: string | undefined): WatchRecord | undefined {
  const v = parseJson(text)
  const id = str(v?.id)
  if (!v || !id || !isTime(v.since) || !isTime(v.at)) return undefined
  return { id, since: v.since, at: v.at, ...(isTime(v.wokeAt) ? { wokeAt: v.wokeAt } : {}) }
}

function parsePrompt(text: string | undefined): PromptRecord | undefined {
  const v = parseJson(text)
  const prompt = str(v?.prompt)
  if (!v || !prompt || !isTime(v.at)) return undefined
  return { at: v.at, prompt, reminder: v.reminder === true }
}

const watchName = (sessionId: string) => `${hashOf(sessionId)}.json`
const promptName = (sessionId: string) => `${hashOf(sessionId)}.prompt.json`
/**
 * Every write of a session's two records, and their removal, holds the session's lock (`<hash>.lock` beside them),
 * so no check-then-write of one caller can be undone by another. A lock still held after `LOCK_WAIT` is given up on:
 * nothing is written (a dead holder frees it at once; one that stopped touching it, after `staleMs`). The wait stays
 * under the 10 seconds Claude Code gives the `UserPromptSubmit` entry.
 */
const LOCK = { staleMs: 15_000, beatMs: 5_000 }
const LOCK_WAIT = { timeoutMs: 8_000, pollMs: 25 }

/** How long a write waits for the session's lock, for tests; by default `LOCK_WAIT`. */
export interface LockWait {
  lockWait?: { timeoutMs: number; pollMs: number }
}

/** Runs `fn` holding the lock of the session whose records start with `hash`; undefined when the lock is not had. */
async function underLock<T>(
  dir: string,
  hash: string,
  wait: { timeoutMs: number; pollMs: number } | null,
  fn: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  const release = await takeFileLock(join(dir, `${hash}.lock`), wait ? { ...LOCK, wait } : LOCK).catch(
    () => null,
  )
  if (!release) return undefined
  try {
    return { value: await fn() }
  } finally {
    await release()
  }
}

/** `<state>/progress/sessions`, checked one level at a time; null when it is missing (without `create`) or not safe. */
async function folder(stateDir: string, create: boolean): Promise<string | null> {
  if (!create) return ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  return ownedFolder(stateDir, PARTS, { create: true, private: true })
}

export async function readWatch(stateDir: string, sessionId: string): Promise<WatchRecord | undefined> {
  const dir = await folder(stateDir, false)
  return dir ? parseWatch(await readSmallFile(join(dir, watchName(sessionId)), RECORD_MAX)) : undefined
}

/**
 * Replaces the session's watch (file 600, atomically) under the session's lock, so it never lands between another
 * watch's last check and its `wokeAt`, unless the record holds the watch of a later `Stop` (its `at` is later): a
 * `Stop` whose hook got its input or the lock late never ends the watch of the turn after it. False when the lock
 * stays held or a later watch is kept: then nothing is written and the caller must not act as the session's watch.
 * Throws when the folder is not safe to use.
 */
export async function writeWatch(
  stateDir: string,
  sessionId: string,
  record: WatchRecord,
  opts: LockWait = {},
): Promise<boolean> {
  const dir = (await folder(stateDir, true))!
  const done = await underLock(dir, hashOf(sessionId), opts.lockWait ?? LOCK_WAIT, async () => {
    const file = join(dir, watchName(sessionId))
    const old = parseWatch(await readSmallFile(file, RECORD_MAX))
    if (old && Date.parse(old.at) > Date.parse(record.at)) return false
    await writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600)
    return true
  })
  return done?.value === true
}

/**
 * Whether the session's latest prompt is not the one the watching `Stop` ended, so a turn began after it: compared by
 * the prompt's id (`own`, hashed), never by time, because the next prompt's record can be written before the watch
 * starts. Only a `Stop` without an id falls back to whether the record came after it (`stopAt`).
 */
export function newerPrompt(p: PromptRecord | undefined, own: string | undefined, stopAt: number): boolean {
  return Boolean(p && (own ? p.prompt !== own : Date.parse(p.at) > stopAt))
}

/**
 * Marks the watch `id` woken at `at`, only while the session's record is still that watch and, with `turn`, no
 * prompt came after the turn the watch's `Stop` ended (`newerPrompt`): a reminder sent then would only queue behind
 * that turn and cost a model call of its own. The checks and the write hold the session's lock, so a later `Stop`
 * replaces the record, or a prompt is noted, before or after, never in between. False when the record is another
 * watch's, is missing, a newer prompt is noted, or the lock stays held (`beforeWrite` runs inside the lock, for tests).
 */
export async function markWatchWoken(
  stateDir: string,
  sessionId: string,
  id: string,
  at: Date,
  deps: { beforeWrite?: () => Promise<void>; turn?: { prompt?: string; stopAt: number } } = {},
): Promise<boolean> {
  const dir = await folder(stateDir, false)
  if (!dir) return false
  const done = await underLock(dir, hashOf(sessionId), LOCK_WAIT, async () => {
    const file = join(dir, watchName(sessionId))
    const fresh = parseWatch(await readSmallFile(file, RECORD_MAX))
    if (fresh?.id !== id) return false
    if (deps.turn) {
      const p = parsePrompt(await readSmallFile(join(dir, promptName(sessionId)), RECORD_MAX))
      if (newerPrompt(p, deps.turn.prompt, deps.turn.stopAt)) return false
    }
    await deps.beforeWrite?.()
    await writeFileAtomic(file, `${JSON.stringify({ ...fresh, wokeAt: at.toISOString() })}\n`, 0o600)
    return true
  })
  return done?.value === true
}

export async function readPromptRecord(
  stateDir: string,
  sessionId: string,
): Promise<PromptRecord | undefined> {
  const dir = await folder(stateDir, false)
  return dir ? parsePrompt(await readSmallFile(join(dir, promptName(sessionId)), RECORD_MAX)) : undefined
}

/**
 * Notes the session's latest prompt under the session's lock, unless the record already holds a later one: two
 * background hooks may finish out of order, and an older prompt never replaces a newer one (`at` is when the hook
 * started, so it follows the order the prompts came in). The same prompt noted again at the same time or later
 * replaces it. Then removes records nobody changed for a day. False when the lock stays held or a later prompt is kept.
 * `beforeRemove` runs with the file's name before each removal takes its lock (for tests).
 */
export async function writePromptRecord(
  stateDir: string,
  sessionId: string,
  record: PromptRecord,
  now: Date,
  opts: LockWait & { beforeRemove?: (name: string) => Promise<void> } = {},
): Promise<boolean> {
  const dir = (await folder(stateDir, true))!
  const done = await underLock(dir, hashOf(sessionId), opts.lockWait ?? LOCK_WAIT, async () => {
    const file = join(dir, promptName(sessionId))
    const old = parsePrompt(await readSmallFile(file, RECORD_MAX))
    const t = Date.parse(record.at)
    if (old && (old.prompt === record.prompt ? Date.parse(old.at) > t : Date.parse(old.at) >= t)) return false
    await writeFileAtomic(file, `${JSON.stringify(record)}\n`, 0o600)
    return true
  })
  await pruneRecords(dir, now, opts.beforeRemove)
  return done?.value === true
}

/**
 * Removes records nobody changed for a day. Each is checked again and removed under its session's lock, taken without
 * waiting (a held one is left for next time), so a record its session rewrote meanwhile is never removed.
 */
async function pruneRecords(
  dir: string,
  now: Date,
  beforeRemove?: (name: string) => Promise<void>,
): Promise<void> {
  const old = async (file: string) => {
    const st = await stat(file).catch(() => null)
    return Boolean(st && now.getTime() - st.mtimeMs > KEEP_MS)
  }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const hash = /^([0-9a-f]{32})\.(?:prompt\.)?json$/.exec(name)?.[1]
    if (!hash) continue
    const file = join(dir, name)
    if (!(await old(file))) continue
    await beforeRemove?.(name)
    await underLock(dir, hash, null, async () => {
      if (await old(file)) await rm(file, { force: true }).catch(() => {})
    })
  }
}

/**
 * Whether the `Stop` that carries `promptId` ends the turn a Progress Reminder started: the session's latest prompt
 * has that id and was a reminder. A record that is missing, late or for another prompt says no, so a caller that
 * cannot tell treats the turn as an ordinary one.
 */
export async function progressReminderTurn(
  stateDir: string,
  sessionId: string | undefined,
  promptId: string | undefined,
): Promise<boolean> {
  if (!sessionId || !promptId) return false
  try {
    const r = await readPromptRecord(stateDir, sessionId)
    return Boolean(r?.reminder && r.prompt === hashOf(promptId))
  } catch {
    return false
  }
}
