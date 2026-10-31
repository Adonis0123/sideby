// Turn Retry (spec §3.37 item 6, ADR-0066): while Unattended Mode is on, a Claude turn that ended on a passing failure
// (an overloaded or failing server, a rate limit that is not a used-up Quota, a dropped or refused connection) is
// started again by `unattended-hook`'s background `StopFailure` entry, at most `RETRY_LIMIT` times in a row per
// session, each after a longer wait. A leaf module (Node built-ins and core/fs-safe.ts only): the hook imports it.
//
// The streak of one session is a file under `<state>/unattended/retries/`, named by a hash of the session id, so a
// session id never becomes a path. Both folders must be real folders of the user that nobody else can write to
// (`ownedFolder`, as for Pending Decisions); when one is not, nothing is read or written there and no turn is retried.
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic } from './fs-safe.ts'

/** How many times in a row one session's failed turn is started again before it is left for the user. */
export const RETRY_LIMIT = 3
/** The wait before the first retry; each next one waits twice as long (1, 2 and 4 minutes). */
export const RETRY_FIRST_MS = 60_000
/** A streak older than this starts again from one (a failure the next night is not the fourth of last night's). */
export const RETRY_FRESH_MS = 6 * 60 * 60_000

/** The `timeout` of the hook entry: the longest wait (4 minutes) with room to spare. */
export const RETRY_HOOK_TIMEOUT_S = 600

/** The wait before retry `n` (1-based). */
export const retryDelay = (n: number): number => RETRY_FIRST_MS * 2 ** (Math.max(1, n) - 1)

/**
 * The `StopFailure` error types (Claude Code's hook `error` field) that can be a passing failure. Also the hook's
 * matcher, so Claude Code starts the hook for nothing else (`|` is the only separator it takes for this event).
 */
export const PASSING_ERRORS: readonly string[] = ['rate_limit', 'overloaded', 'server_error', 'unknown']

/**
 * Claude Code's wording when a Quota, a plan limit, a spend cap or credits are used up (its error reference: "You've
 * hit your session limit", "Fable limit reached", "monthly spend limit", "Credit balance is too low", "Usage credits
 * required"). Waiting minutes does not help those: Auto Handoff or `autoContinueAtUsageLimit` takes them. A plain
 * "Rate limit reached" is a throttle, not a used-up Quota.
 */
const USED_UP =
  /hit your|usage limit|out of (?:extra )?usage|spend limit|spending limit|credit balance|usage credits|(?<!rate )limit reached/i

/** What an `unknown` error must say to count as passing: a timeout or overload status, or a dropped connection. */
const PASSING_TEXT =
  /\b(?:408|429|5\d\d)\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|connection (?:refused|reset|error|closed)|network|overloaded|temporarily/i

/**
 * Whether a failed turn's error is a passing one, from the hook input's `error` type and its text
 * (`last_assistant_message`, `error_details`). Checked with Claude Code 2.1.316 against a local server: HTTP 500 and
 * a refused connection come as `server_error`, 429 as `rate_limit`, 408 as `unknown`.
 */
export function passingFailure(error: string | undefined, text: string): boolean {
  if (!error || !PASSING_ERRORS.includes(error) || USED_UP.test(text)) return false
  return error !== 'unknown' || PASSING_TEXT.test(text)
}

/** One session's run of failed turns that were started again. */
export interface RetryStreak {
  /** How many failures in a row, this one included. */
  count: number
  /** The wait this failure's hook owns; a later failure or a finished turn replaces or removes it. */
  token: string
  at: string
}

const PARTS = ['unattended', 'retries'] as const
const fileName = (sessionId: string) => `${sha256(sessionId).slice(0, 32)}.json`

function parse(text: string | undefined): RetryStreak | undefined {
  if (!text) return undefined
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    if (typeof v.count !== 'number' || !Number.isInteger(v.count) || v.count < 1) return undefined
    if (typeof v.token !== 'string' || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at)))
      return undefined
    return { count: v.count, token: v.token, at: v.at }
  } catch {
    return undefined
  }
}

/** The session's streak, or undefined when there is none or its folder is not safe to read. */
export async function readRetryStreak(stateDir: string, sessionId: string): Promise<RetryStreak | undefined> {
  const dir = await ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  if (!dir) return undefined
  return parse(await readSmallFile(join(dir, fileName(sessionId)), 4096))
}

/**
 * Counts one more failure for the session and returns the streak with a new token. A streak older than
 * `RETRY_FRESH_MS` starts again from one. Throws when the folder is not safe to use (the caller then retries nothing).
 */
export async function countFailure(stateDir: string, sessionId: string, now: Date): Promise<RetryStreak> {
  const dir = (await ownedFolder(stateDir, PARTS, { create: true, private: true }))!
  const file = join(dir, fileName(sessionId))
  const old = parse(await readSmallFile(file, 4096))
  const fresh = old && now.getTime() - Date.parse(old.at) < RETRY_FRESH_MS
  const streak = {
    count: fresh ? old.count + 1 : 1,
    token: randomBytes(8).toString('hex'),
    at: now.toISOString(),
  }
  await writeFileAtomic(file, `${JSON.stringify(streak)}\n`, 0o600)
  return streak
}

/** Ends the session's streak: its turn finished, or it was left for the user. */
export async function clearRetryStreak(stateDir: string, sessionId: string): Promise<void> {
  const dir = await ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
  if (dir) await rm(join(dir, fileName(sessionId)), { force: true })
}

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

/** What the model reads when its session is woken to go on after a passing failure. */
export function retryMessage(error: string, text: string, count: number, zh: boolean): string {
  const why = clip(`${error}${text ? `: ${text}` : ''}`, 200)
  if (zh)
    return `sideby 无人值守：你上一个回合因为暂时性的错误中断了（${why}），没人在，sideby 让会话接着做（第 ${count} 次，最多 ${RETRY_LIMIT} 次）。先看看已经做完了什么，不要重做，从中断的地方继续完成任务。`
  return `sideby's Unattended Mode: your last turn failed for a passing reason (${why}), and nobody is here to start it again, so sideby did (retry ${count} of ${RETRY_LIMIT}). Check what is already done, do not redo it, and continue the task where it stopped.`
}

/** What the user reads in the morning when the retries ran out: kept as a Pending Decision. */
export function retryGaveUpText(error: string, text: string): string {
  const why = clip(`${error}${text ? `: ${text}` : ''}`, 300)
  const waits = Array.from({ length: RETRY_LIMIT }, (_, i) => retryDelay(i + 1) / 60_000).join(', ')
  return `The session stopped: its turn kept failing for a passing reason (${why}). sideby started it again ${RETRY_LIMIT} times (after ${waits} minutes) and then left it. Continue the session when you are back.`
}
