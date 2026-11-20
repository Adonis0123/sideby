// Pending Decisions by Project, and whether the user wrote in the session afterwards (spec §3.37 "按项目看",
// ADR-0078). The CLI's `sideby unattended pending` and the Panel's Unattended page list them through `pendingOverview`.
//
// A Pending Decision is `replied` when the session's own record holds a message the user typed later than the decision
// was kept: the record is found by the session id in the decision's Account (then the Family's other Accounts) and
// read read-only with Session History's reader, which gives only what a person typed. Of each record only the times
// of those messages are kept (per file version, in a FileMemo), never their text. Nothing is written into a Host
// directory, no credential is read and no model is called.
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  findsSessionRecords,
  historyReader,
  type SessionRecords,
  sessionRecords,
} from '../families/history.ts'
import { uaGroupByProject } from '../panel/page-logic.ts'
import type { Account } from '../types.ts'
import { FileMemo } from './file-memo.ts'
import { SAFE_ID } from './history.ts'
import { ProjectResolver, projectNames, projectsNamed } from './history-project.ts'
import { memoStore } from './memo-store.ts'
import { hostMade, PROGRESS_MARK, sidebyMessage } from './prompt-origin.ts'
import type { PendingDecision } from './unattended-pending.ts'

/**
 * done: marked done; replied: not marked, and the user typed in the session after it was kept (which does not tell
 * whether it was finished: the user looks before marking it done); open: not marked, and nothing typed after it.
 */
export type PendingState = 'open' | 'replied' | 'done'

/** One Pending Decision as it is listed: with its Project, its state, and when the user replied. */
export interface PendingRow extends PendingDecision {
  /** The Project's path (spec §3.33), or '' when the decision has no folder. */
  project: string
  /** The Project's short name, or '' when it has none. */
  projectName: string
  state: PendingState
  /** The first message the user typed in the session after `at` (ISO); only when `state` is `replied`. */
  repliedAt?: string
  /**
   * Why sideby could not tell whether the user replied: no-record, the session's record was not found; unsupported,
   * sideby reads no session records of this Family. Only on an open decision with a session id.
   */
  replyCheck?: 'no-record' | 'unsupported'
}

/** One Project's counts, in the order the Panel lists them. */
export interface PendingProject {
  project: string
  projectName: string
  open: number
  replied: number
  done: number
}

export interface PendingOverview {
  /** In the order given (oldest first). */
  rows: PendingRow[]
  projects: PendingProject[]
}

/**
 * The times of the messages the user typed in each session record, by file version. Kept in the memo cache file with
 * the usage readers' memos (times only), so a restarted Panel does not read every record again.
 */
const replyMemo = new FileMemo<number[]>({ name: 'pending-replies', version: 2 })
const MEMO_SCOPE = 'pending-replies'

/**
 * Marks of the notes sideby puts into a session, should a Host keep one as a message from the user: Unattended Mode's
 * reasons and wake-ups (src/unattended/hook.ts, core/unattended-retry.ts), in English and Chinese, and the Progress
 * Reminder. Claude Code keeps them as `isMeta` lines or `<task-notification>`s, which Session History's reader leaves
 * out already; these catch any Host that does not.
 */
export const SIDEBY_NOTE_MARKS: readonly string[] = [
  "sideby's Unattended Mode is on",
  "sideby's Unattended Mode: ",
  'sideby 无人值守已开启',
  'sideby 无人值守：',
  PROGRESS_MARK,
]

/**
 * Lines a person did not type as a reply: a slash command, a `!` shell line, a summary of an earlier conversation,
 * and sideby's own notes, should a Host keep one as the user's: Auto Handoff's all start with `sideby: `, and the first
 * prompt of the session a task was handed to starts the same way every time (src/handoff/messages.ts).
 */
const NOT_TYPED =
  /^\s*(?:[/!]|This session is being continued|sideby: |This task was handed over from \S+ by sideby\b)/

/**
 * Whether a message Session History's reader gives as the user's counts as a reply to a Pending Decision. When unsure
 * it does not, so a decision is shown as untouched rather than as written in afterwards.
 */
export function typedReply(text: string): boolean {
  if (!text.trim() || NOT_TYPED.test(text)) return false
  if (hostMade(text) || sidebyMessage(text)) return false
  return !SIDEBY_NOTE_MARKS.some((m) => text.includes(m))
}

/** The times (ms) of the messages the user typed in one session record, oldest first. */
async function replyTimes(family: string, path: string): Promise<number[]> {
  const reader = historyReader(family)
  if (!reader) return []
  const out: number[] = []
  for await (const m of reader.messages(path)) {
    // A person's message: Claude Code marks one `human`, and a notification or a peer's message as something else.
    if (m.role !== 'user' || !m.at || (m.origin && m.origin !== 'human') || !typedReply(m.text)) continue
    const t = Date.parse(m.at)
    if (Number.isFinite(t)) out.push(t)
  }
  return out.sort((a, b) => a - b)
}

/** Lists each Account's Session records at most once per overview, however many sessions are looked up in it. */
function recordLists(): (a: Account) => Promise<SessionRecords | undefined> {
  const listed = new Map<string, Promise<SessionRecords | undefined>>()
  return (a) => {
    let got = listed.get(a.ref)
    if (!got) {
      got = sessionRecords(a.family, a).catch(() => undefined)
      listed.set(a.ref, got)
    }
    return got
  }
}

/**
 * The session's record: in the decision's Account first, then in the Family's other Accounts. Undefined when none has
 * it, or the session id is not of the plain form Session History accepts.
 */
async function findRecord(
  d: PendingDecision,
  accounts: readonly Account[],
  recordsOf: (a: Account) => Promise<SessionRecords | undefined>,
): Promise<string | undefined> {
  if (!d.sessionId || !SAFE_ID.test(d.sessionId)) return undefined
  const own = accounts.filter((a) => a.family === d.family)
  const ordered = [...own.filter((a) => a.ref === d.account), ...own.filter((a) => a.ref !== d.account)]
  for (const a of ordered) {
    const path = (await recordsOf(a))?.find(d.sessionId)
    if (path) return path
  }
  return undefined
}

/**
 * When the user replied after each open decision of one session: the first typed message later than its `at`, or
 * undefined. The record is read only when it was written after the earliest of them.
 */
async function sessionReplies(
  family: string,
  path: string,
  decisions: readonly PendingDecision[],
  pass: ReturnType<FileMemo<number[]>['pass']>,
): Promise<Map<string, number | undefined>> {
  const out = new Map<string, number | undefined>()
  const st = await stat(path)
  const earliest = Math.min(...decisions.map((d) => Date.parse(d.at)))
  const times = st.mtimeMs <= earliest ? [] : await pass.get(path, st, () => replyTimes(family, path))
  for (const d of decisions)
    out.set(
      d.id,
      times.find((t) => t > Date.parse(d.at)),
    )
  return out
}

/**
 * Each Pending Decision with its Project, state and reply (in the order given), and every Project's counts in the
 * order the Panel lists them. `accounts` are where session records are looked for; `stateDir` holds the memo cache.
 */
export async function pendingOverview(opts: {
  decisions: readonly PendingDecision[]
  accounts: readonly Account[]
  stateDir: string
}): Promise<PendingOverview> {
  const resolver = new ProjectResolver({ nearest: true })
  const projectOf = new Map<string, string>()
  await Promise.all(
    opts.decisions.map(async (d) => {
      projectOf.set(d.id, d.cwd ? (await resolver.resolve(d.cwd)).path : '')
    }),
  )
  const names = projectNames([...projectOf.values()].filter(Boolean))

  // Open decisions with a session id, by Family and session.
  const bySession = new Map<string, PendingDecision[]>()
  for (const d of opts.decisions)
    if (!d.doneAt && d.sessionId) {
      const key = `${d.family}\0${d.sessionId}`
      bySession.set(key, [...(bySession.get(key) ?? []), d])
    }
  const replied = new Map<string, number | undefined>()
  const check = new Map<string, PendingRow['replyCheck']>()
  if (bySession.size) {
    const store = memoStore(opts.stateDir)
    await store.ready()
    const pass = replyMemo.pass(MEMO_SCOPE)
    const recordsOf = recordLists()
    await eachAtMost(READ_AT_ONCE, [...bySession.values()], async (list) => {
      const first = list[0]!
      if (!findsSessionRecords(first.family)) {
        for (const d of list) check.set(d.id, 'unsupported')
        return
      }
      const found = await findRecord(first, opts.accounts, recordsOf)
      const got = found
        ? await sessionReplies(first.family, found, list, pass).catch(() => undefined)
        : undefined
      if (!got) for (const d of list) check.set(d.id, 'no-record')
      else for (const [id, t] of got) replied.set(id, t)
    })
    pass.done()
    if (replyMemo.dirty) store.saveSoon()
  }

  const rows = opts.decisions.map((d): PendingRow => {
    const project = projectOf.get(d.id) ?? ''
    const at = replied.get(d.id)
    const state: PendingState = d.doneAt ? 'done' : at !== undefined ? 'replied' : 'open'
    const why = check.get(d.id)
    return {
      ...d,
      project,
      projectName: project ? (names.get(project) ?? project) : '',
      state,
      ...(state === 'replied' ? { repliedAt: new Date(at!).toISOString() } : {}),
      ...(state === 'open' && why ? { replyCheck: why } : {}),
    }
  })
  const projects = uaGroupByProject(rows).map(
    (g): PendingProject => ({
      project: g.project,
      projectName: g.name,
      open: g.open,
      replied: g.replied,
      done: g.done,
    }),
  )
  return { rows, projects }
}

/**
 * The Projects a `--project` value names among `projects`, as Session History's `--project` reads one: a path
 * (absolute, or from `~`) names the Project it is, or the one it is in; a name is a short name, else the end of a
 * Project's path.
 */
export async function pendingProjectsNamed(
  projects: readonly PendingProject[],
  name: string,
  home: string,
): Promise<string[]> {
  const paths = projects.filter((p) => p.project)
  if (isAbsolute(name) || name === '~' || name.startsWith('~/')) {
    const abs = resolve(name.startsWith('~') ? join(home, name.slice(1)) : name)
    if (paths.some((p) => p.project === abs)) return [abs]
    const found = (await new ProjectResolver({ nearest: true }).resolve(abs)).path
    return paths.some((p) => p.project === found) ? [found] : []
  }
  return projectsNamed(new Map(paths.map((p) => [p.project, p.projectName])), name.replace(/\/+$/, ''))
}

/** How many session records are read at once. */
const READ_AT_ONCE = 4

async function eachAtMost<T>(n: number, items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!)
    }),
  )
}
