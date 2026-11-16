// Progress Reminders' state (spec §3.42, ADR-0076): the config value the hook reads by hand, the two records each
// Claude session keeps under `<state>/progress/sessions/`, and whether a `Stop` ends a reminder's turn. A leaf module
// (Node built-ins and leaf modules only): `progress-hook` and `handoff-hook` import it.
//
// Every level of the folder must be a real folder of the user that nobody else can write to (`ownedFolder`). The
// records hold hashes, times and a random id only: never a command, a task's description, a reply or a prompt.
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic } from './fs-safe.ts'

/** Set in a session's environment: the interval at launch, used only when the config cannot be read. */
export const PROGRESS_ENV = 'SIDEBY_PROGRESS_EVERY'
/** The interval in whole minutes: at least this, at most `PROGRESS_MAX` (under the hook's five-hour timeout). */
export const PROGRESS_MIN = 1
export const PROGRESS_MAX = 240
/** What turning it on picks when no interval is given. */
export const PROGRESS_DEFAULT = 10
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

/** Whether `v` is an interval sideby takes. */
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
  /** When the `Stop` that started this watch came. */
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

/** `<state>/progress/sessions`, checked one level at a time; null when it is missing (without `create`) or not safe. */
async function folder(stateDir: string, create: boolean): Promise<string | null> {
  if (!create) return ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  return ownedFolder(stateDir, PARTS, { create: true, private: true })
}

export async function readWatch(stateDir: string, sessionId: string): Promise<WatchRecord | undefined> {
  const dir = await folder(stateDir, false)
  return dir ? parseWatch(await readSmallFile(join(dir, watchName(sessionId)), RECORD_MAX)) : undefined
}

/** Writes the session's watch (file 600, atomically); throws when the folder is not safe to use. */
export async function writeWatch(stateDir: string, sessionId: string, record: WatchRecord): Promise<void> {
  const dir = (await folder(stateDir, true))!
  await writeFileAtomic(join(dir, watchName(sessionId)), `${JSON.stringify(record)}\n`, 0o600)
}

export async function readPromptRecord(
  stateDir: string,
  sessionId: string,
): Promise<PromptRecord | undefined> {
  const dir = await folder(stateDir, false)
  return dir ? parsePrompt(await readSmallFile(join(dir, promptName(sessionId)), RECORD_MAX)) : undefined
}

/** Writes the session's latest prompt, then removes records nobody changed for a day. */
export async function writePromptRecord(
  stateDir: string,
  sessionId: string,
  record: PromptRecord,
  now: Date,
): Promise<void> {
  const dir = (await folder(stateDir, true))!
  await writeFileAtomic(join(dir, promptName(sessionId)), `${JSON.stringify(record)}\n`, 0o600)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const st = await stat(join(dir, name)).catch(() => null)
    if (st && now.getTime() - st.mtimeMs > KEEP_MS) await rm(join(dir, name), { force: true }).catch(() => {})
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
