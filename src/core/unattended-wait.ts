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
 * session waits for a prompt). Returns `act` once the wait has passed since `startedAt` and Unattended Mode is on, and
 * `stop` as soon as anything says a person (or anything else) moved on or it cannot tell: there is no record for the
 * session, it does not show `expect` within 2 seconds, it changes (another status or another `statusUpdatedAt`), it
 * cannot be read, the Host is gone, or the wait was set to never. While the mode is off past the wait it keeps waiting; Claude Code's `timeout`
 * ends it in the end.
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
}): Promise<'act' | 'stop'> {
  // No record for this session at all: nothing is shown in a terminal that sideby can watch.
  let mark = await readScreen(opts.env, opts.pid, opts.sessionId)
  if (!mark) return 'stop'
  for (let waited = 0; mark?.status !== opts.expect; waited += SHOWN_POLL_MS) {
    if (waited >= SHOWN_WAIT_MS) return 'stop'
    await opts.sleep(SHOWN_POLL_MS)
    mark = await readScreen(opts.env, opts.pid, opts.sessionId)
  }
  for (;;) {
    await opts.sleep(WATCH_POLL_MS)
    if (opts.parentGone()) return 'stop'
    const m = await readScreen(opts.env, opts.pid, opts.sessionId)
    if (!m || m.status !== mark.status || m.at !== mark.at) return 'stop'
    const s = await opts.settings()
    if (s.wait === null) return 'stop'
    if (opts.clock() - opts.startedAt >= s.wait * 60_000 && s.on) return 'act'
  }
}

/** Whole minutes from `startedAt` to `now`, at least 1: how long the question waited, as the user reads it. */
export const waitedMinutes = (startedAt: number, now: number): number =>
  Math.max(1, Math.round((now - startedAt) / 60_000))
