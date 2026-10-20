// The tab title of a running Host (spec §3.32, config `accountTitle`): `[cc002]` grows into the Session Label once
// the Account's Live Session for this Host process shows up. Runs only in the `sideby` process that started the
// Host, never in `statusline-tap` or `handoff-hook`.
import { liveSessionReader } from '../families/live-sessions.ts'
import type { Account } from '../types.ts'
import { sessionLabel } from './live-sessions.ts'
import { type LiveSessionDeps, type ProcessInfo, processView, systemDeps } from './live-sessions-procs.ts'

export const TITLE_EVERY_MS = 10_000
/** The first look comes sooner: Claude Code writes its session file as it starts. */
export const TITLE_FIRST_MS = 3_000
/** One check gives up after this long, so a slow `ps` or `lsof` never piles up behind the next one. */
export const TITLE_DEADLINE_MS = 8_000

export interface TitleWatchOptions {
  account: Account
  /** The short name in the title (`SIDEBY_LABEL`), for example `cc002`. */
  accountLabel: string
  /** The Host process sideby started. */
  pid: number
  /** Writes one title; called only when it changes. */
  write(title: string): void
  deps?: LiveSessionDeps
  env?: Record<string, string | undefined>
  everyMs?: number
  firstMs?: number
  deadlineMs?: number
}

/** Control characters would end the escape sequence early. */
const clean = (s: string) => [...s].filter((ch) => ch >= ' ' && ch !== '\x7f').join('')

/** Whether `pid` is `root` or runs under it (a Host started through a wrapper script). */
function under(pid: number, root: number, procs: readonly ProcessInfo[]): boolean {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]))
  for (let p: number | undefined = pid, n = 0; p !== undefined && n < 64; p = parent.get(p), n++)
    if (p === root) return true
  return false
}

/** The title for the Live Session of the Host process `pid`, or undefined while it has none. */
export async function sessionTitleOf(
  o: Pick<TitleWatchOptions, 'account' | 'accountLabel' | 'pid' | 'deps' | 'env'>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const reader = liveSessionReader(o.account.family)
  if (!reader) return undefined
  const procs = processView(o.deps ?? systemDeps(o.env ?? process.env), signal)
  const list = await procs.list()
  const raw = await reader.read(o.account, procs, [])
  // A guess is not tied to a process: it may be another tab's session.
  const mine = raw.find((s) => !s.guessed && s.pid !== undefined && under(s.pid, o.pid, list))
  return mine ? clean(`[${sessionLabel(o.accountLabel, mine.title ?? '', mine.sessionId)}]`) : undefined
}

/**
 * Checks every 10 s and writes the title only when it changes. Each check has a deadline, and the returned function
 * stops the timers and ends a check still running (its `ps` and `lsof`), so nothing keeps sideby alive after the Host.
 */
export function watchSessionTitle(o: TitleWatchOptions): () => void {
  let last: string | undefined
  let busy = false
  let stopped = false
  let current: AbortController | undefined
  const check = async () => {
    if (busy || stopped) return
    busy = true
    const ctl = new AbortController()
    current = ctl
    const deadline = setTimeout(() => ctl.abort(), o.deadlineMs ?? TITLE_DEADLINE_MS)
    deadline.unref()
    try {
      const aborted = new Promise<never>((_, reject) =>
        ctl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      )
      aborted.catch(() => {})
      const title = await Promise.race([sessionTitleOf(o, ctl.signal), aborted])
      if (!stopped && !ctl.signal.aborted && title && title !== last) {
        last = title
        o.write(title)
      }
    } catch {
      // keep the title as it is; the next check tries again
    } finally {
      clearTimeout(deadline)
      if (current === ctl) current = undefined
      busy = false
    }
  }
  const first = setTimeout(check, o.firstMs ?? TITLE_FIRST_MS)
  const every = setInterval(check, o.everyMs ?? TITLE_EVERY_MS)
  first.unref()
  every.unref()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(every)
    current?.abort()
  }
}
