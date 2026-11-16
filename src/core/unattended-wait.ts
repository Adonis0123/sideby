// Answer Wait (spec §3.37 item 7, ADR-0077): a question or a confirmation Claude Code shows in a session sideby started
// waits for a person; once it has waited `unattended.answerWait` minutes and Unattended Mode is on, `unattended-hook`
// lets the session go on without an answer. A leaf module (Node built-ins and core/fs-safe.ts only): the hook imports it.
//
// What is on screen is read from Claude Code's own session record, `<config dir>/sessions/<pid>.json`, the pid being the
// hook's parent (the Host): its `sessionId`, `status` and `statusUpdatedAt`, nothing else. Tried with Claude Code
// 2.1.325 on 2026-11-16: `status` is `waiting` while a question or a permission prompt is on screen and `idle` while the
// session waits for a prompt, and `statusUpdatedAt` changes when either ends or another dialog takes its place (it
// stayed the same for 11 minutes while one prompt waited). The record is written before the hook starts.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSmallFile } from './fs-safe.ts'

/**
 * The `timeout` of the hook entries that wait. A question shown at 18:00 with Unattended Mode off still goes on when a
 * Slot begins at 23:00; Claude Code ends the hook after this and the question then simply stays on screen.
 */
export const ANSWER_HOOK_TIMEOUT_S = 12 * 60 * 60
/** How long a hook looks for the record to show what it waits on before it gives up (it is written before the hook). */
const SHOWN_WAIT_MS = 2000
const SHOWN_POLL_MS = 100
/** How often a waiting hook looks again: an answered question frees its hook within this. */
export const WATCH_POLL_MS = 3000

/** What the session record says is on screen now. */
export interface ScreenMark {
  status: string
  /** `statusUpdatedAt`: changes whenever the dialog or the wait ends or another one takes its place. */
  at: number
}

/** Claude Code's config folder for the session: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: {
  HOME?: string | undefined
  CLAUDE_CONFIG_DIR?: string | undefined
}): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
}

/**
 * The status the record of process `pid` holds for session `sessionId`; undefined when it cannot be read, is a link,
 * names another session, or lacks `status` or `statusUpdatedAt`.
 */
export async function readScreen(
  env: { HOME?: string | undefined; CLAUDE_CONFIG_DIR?: string | undefined },
  pid: number,
  sessionId: string,
): Promise<ScreenMark | undefined> {
  if (!Number.isInteger(pid) || pid <= 1) return undefined
  const text = await readSmallFile(join(claudeConfigDir(env), 'sessions', `${pid}.json`), 64 * 1024)
  if (text === undefined) return undefined
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null
    if (!v || v.sessionId !== sessionId) return undefined
    if (typeof v.status !== 'string' || typeof v.statusUpdatedAt !== 'number') return undefined
    return { status: v.status, at: v.statusUpdatedAt }
  } catch {
    return undefined
  }
}

/** What a waiting hook reads afresh at every look: the wait (minutes, or null for never) and whether the mode is on. */
export interface WaitSettings {
  wait: number | null
  on: boolean
}

/**
 * Waits while the session shows `expect` (`waiting`: a question or a permission prompt; `idle`: a turn ended and the
 * session waits for a prompt). Returns the record's mark once the wait has passed since `startedAt` and Unattended
 * Mode is on, so the caller can look once more just before it acts (`lastLook`), and undefined as soon as anything
 * says a person (or anything else) moved on or it cannot tell: there is no record for the session, it does not show
 * `expect` within 2 seconds, it shows a dialog put up after `shownBy` (the dialog this hook was started for was on
 * screen before the hook began, so a later one is another dialog: the person answered this one meanwhile), it changes
 * (another status or another `statusUpdatedAt`), it cannot be read, `moved` says so (a person typed after the turn
 * the hook watches), the Host is gone, or the wait was set to never. While the mode is off past the wait it keeps
 * waiting; Claude Code's `timeout` ends it in the end. With `from` it goes on watching that mark, without looking for it
 * first.
 */
export async function watchScreen(opts: {
  env: { HOME?: string | undefined; CLAUDE_CONFIG_DIR?: string | undefined }
  pid: number
  sessionId: string
  expect: 'waiting' | 'idle'
  startedAt: number
  clock: () => number
  sleep: (ms: number) => Promise<void>
  parentGone: () => boolean
  settings: () => Promise<WaitSettings>
  /** Whether something sideby noted says the session moved on since `startedAt`; checked at every look. */
  moved?: () => Promise<boolean>
  /** The latest `statusUpdatedAt` the watched mark may have (when the hook began). */
  shownBy?: number
  /** A mark already found: go on watching it. */
  from?: ScreenMark
}): Promise<ScreenMark | undefined> {
  let mark = opts.from
  if (!mark) {
    // No record for this session at all: nothing is shown in a terminal that sideby can watch.
    mark = await readScreen(opts.env, opts.pid, opts.sessionId)
    if (!mark) return undefined
    for (let waited = 0; mark?.status !== opts.expect; waited += SHOWN_POLL_MS) {
      if (waited >= SHOWN_WAIT_MS) return undefined
      await opts.sleep(SHOWN_POLL_MS)
      mark = await readScreen(opts.env, opts.pid, opts.sessionId)
    }
    if (opts.shownBy !== undefined && mark.at > opts.shownBy) return undefined
    if (await opts.moved?.()) return undefined
  }
  for (;;) {
    await opts.sleep(WATCH_POLL_MS)
    if (opts.parentGone()) return undefined
    const m = await readScreen(opts.env, opts.pid, opts.sessionId)
    if (!sameMark(m, mark)) return undefined
    if (await opts.moved?.()) return undefined
    const d = await due(opts.settings, opts.clock, opts.startedAt)
    if (d === 'stop') return undefined
    if (d === 'act') return mark
  }
}

const sameMark = (a: ScreenMark | undefined, b: ScreenMark): boolean =>
  a !== undefined && a.status === b.status && a.at === b.at

/** With the wait and the mode as they are now: act, keep waiting (not due yet, or the mode is off), or stop (never). */
async function due(
  settings: () => Promise<WaitSettings>,
  clock: () => number,
  startedAt: number,
): Promise<'act' | 'wait' | 'stop'> {
  const s = await settings()
  if (s.wait === null) return 'stop'
  return clock() - startedAt >= s.wait * 60_000 && s.on ? 'act' : 'wait'
}

/**
 * The last look before a waiting hook acts (and again after it kept the Pending Decision), with the wait and the mode
 * read afresh: `act` while the Host is still there, the record still shows `mark`, nothing sideby noted says the
 * session moved on, the wait (as set now) has passed and Unattended Mode is on; `wait` when all that holds but the
 * wait was made longer and has not passed, or the mode went off: the hook goes on watching; `stop` for anything else,
 * the wait set to never, or anything it cannot read: the hook then lets it be.
 */
export async function lastLook(opts: {
  env: { HOME?: string | undefined; CLAUDE_CONFIG_DIR?: string | undefined }
  pid: number
  sessionId: string
  mark: ScreenMark
  startedAt: number
  clock: () => number
  parentGone: () => boolean
  settings: () => Promise<WaitSettings>
  moved?: () => Promise<boolean>
}): Promise<'act' | 'wait' | 'stop'> {
  try {
    if (opts.parentGone()) return 'stop'
    if (!sameMark(await readScreen(opts.env, opts.pid, opts.sessionId), opts.mark)) return 'stop'
    if (await opts.moved?.()) return 'stop'
    return await due(opts.settings, opts.clock, opts.startedAt)
  } catch {
    return 'stop'
  }
}

/** Whole minutes from `startedAt` to `now`, at least 1: how long the question waited, as the user reads it. */
export const waitedMinutes = (startedAt: number, now: number): number =>
  Math.max(1, Math.round((now - startedAt) / 60_000))
