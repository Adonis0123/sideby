// Live Sessions across Accounts (spec §3.32, ADR-0039): which Session each Account is running now, its Session
// Label, and the Session Reference a copy button copies. Read-only: built from the Hosts' own non-credential files;
// nothing here copies, edits or ends a Session.
import { liveSessionReader, type RawLiveSession } from '../families/live-sessions.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { aliasesByAccount } from './accounts.ts'
import { aliasArgs, aliasRefs } from './config.ts'
import { type LiveSessionDeps, processView, systemDeps } from './live-sessions-procs.ts'
import type { SessionRun } from './run-link.ts'

export type LiveSessionStatus = 'needs-you' | 'busy' | 'idle' | 'unknown'

export interface LiveSession {
  /** The Account ref, for example `claude:002`. */
  account: string
  /** The short name shown for the Account (its Alias when it has one, for example `cc002`). */
  accountLabel: string
  family: string
  sessionId: string
  /** The Host's own title for the Session, or the working directory name when the Host has none. */
  title: string
  /** `<accountLabel> · <title> · <first 8 of sessionId>`. */
  label: string
  status: LiveSessionStatus
  cwd?: string
  pid?: number
  startedAt?: string
  updatedAt?: string
  /** True when sideby could not tie a running process to the Session and took the Account's newest one. */
  guessed: boolean
  /** Path of the Session's record (transcript), when known. */
  transcript?: string
  /** The command that resumes the Session in the Account that holds it. */
  resumeCommand: string
  /** The Session Reference in English, as `sessionCopyText(s, 'reference', 'en')` gives it. */
  reference: string
  /** The Run of a local orchestrator the Session works for (spec §3.32 step 2b); set by `withRuns`, not the readers. */
  run?: SessionRun
}

export interface LiveSessionsResult {
  sessions: LiveSession[]
  /** One line per Account or Family that could not be read; never aborts the listing. */
  problems: string[]
}

export type SessionCopyAs = 'reference' | 'id' | 'resume'

export const shortId = (id: string): string => id.slice(0, 8)

/** `<accountLabel> · <title> · <first 8 of id>`; a Session without a title leaves its part out. */
export const sessionLabel = (accountLabel: string, title: string, id: string): string =>
  [accountLabel, title, shortId(id)].filter(Boolean).join(' · ')

/** The key that names a Session across Accounts: the same id in two Accounts is two Sessions. */
export const liveKey = (account: string, sessionId: string): string => `${account}\0${sessionId}`

/** The Host arguments that resume Session `id` of a Family. */
export function hostResumeArgs(family: string, id: string): string {
  if (family === 'codex') return `resume ${id}`
  if (family === 'claude' || family === 'grok') return `--resume ${id}`
  return `--session ${id}`
}

/** The command that resumes `id` (Resume Routing, spec §3.15, starts the Account that holds it). */
export function resumeCommandFor(family: string, account: string, id: string): string {
  if (family === 'codex' || family === 'claude' || family === 'grok')
    return `sideby resume ${family} -- ${hostResumeArgs(family, id)}`
  // pi has no Resume Routing: start the Account itself on that session.
  return `sideby run ${account} -- ${hostResumeArgs(family, id)}`
}

/** The short name an Account is shown by: its first Alias without Host arguments, else its first Alias, else its ref. */
export function accountLabels(
  rt: Pick<Runtime, 'config'>,
  accounts: readonly Account[],
): Map<string, string> {
  const aliases = rt.config.aliases
  const byAccount = aliasesByAccount(aliasRefs(aliases), accounts)
  const out = new Map<string, string>()
  for (const a of accounts) {
    const names = byAccount.get(a.ref) ?? []
    const plain = names.filter((n) => aliasArgs(aliases?.[n]).length === 0)
    out.set(a.ref, plain[0] ?? names[0] ?? a.ref)
  }
  return out
}

/** A Family reader's record as a Live Session of `account`. */
export function toLiveSession(account: Account, accountLabel: string, raw: RawLiveSession): LiveSession {
  const title = raw.title ?? ''
  const s: Omit<LiveSession, 'reference'> = {
    account: account.ref,
    accountLabel,
    family: account.family,
    sessionId: raw.sessionId,
    title,
    label: sessionLabel(accountLabel, title, raw.sessionId),
    status: raw.status,
    ...(raw.cwd ? { cwd: raw.cwd } : {}),
    ...(raw.pid !== undefined ? { pid: raw.pid } : {}),
    ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    guessed: raw.guessed,
    ...(raw.transcript ? { transcript: raw.transcript } : {}),
    resumeCommand: resumeCommandFor(account.family, account.ref, raw.sessionId),
  }
  return { ...s, reference: referenceText(s, 'en') }
}

const time = (s: LiveSession) => Date.parse(s.updatedAt ?? s.startedAt ?? '') || 0

/** `needs-you` first, then the most recent activity. */
export function sortSessions(list: LiveSession[]): LiveSession[] {
  return list.sort(
    (a, b) =>
      Number(b.status === 'needs-you') - Number(a.status === 'needs-you') ||
      time(b) - time(a) ||
      a.label.localeCompare(b.label),
  )
}

/** How long one listing may take before it returns what it has. */
export const LIST_DEADLINE_MS = 8_000

/**
 * Lists Live Sessions of every Account, `needs-you` first, then by most recent activity. After `deadlineMs` it stops
 * the programs it still waits for and returns what it has, with a problem line naming the Accounts left out.
 */
export async function listLiveSessions(
  rt: Runtime,
  opts: { only?: string; deadlineMs?: number } = {},
  deps?: LiveSessionDeps,
): Promise<LiveSessionsResult> {
  const all = await rt.accounts()
  let accounts = all
  if (opts.only) {
    if (rt.families.has(opts.only)) accounts = all.filter((a) => a.family === opts.only)
    else {
      const one = await rt.resolve(opts.only)
      accounts = all.filter((a) => a.ref === one.ref)
    }
  }
  const labels = accountLabels(rt, all)
  const problems: string[] = []
  const readable = accounts.filter((a) => liveSessionReader(a.family))
  if (!readable.length) return { sessions: [], problems }
  const ctl = new AbortController()
  const procs = processView(deps ?? systemDeps(rt.env), ctl.signal)
  const found: LiveSession[] = []
  const pending = new Set(readable.map((a) => a.ref))
  const work = (async () => {
    try {
      await procs.list()
    } catch (err) {
      if (ctl.signal.aborted) return
      problems.push(
        `could not list running programs (${(err as Error).message}); sideby needs \`ps\` on PATH to tell which sessions still run`,
      )
      pending.clear()
      return
    }
    await Promise.all(
      readable.map(async (account) => {
        try {
          const raw = await liveSessionReader(account.family)!.read(account, procs, problems)
          if (ctl.signal.aborted) return
          found.push(...raw.map((r) => toLiveSession(account, labels.get(account.ref) ?? account.ref, r)))
        } catch (err) {
          if (ctl.signal.aborted) return
          problems.push(
            `${account.ref}: could not read its sessions (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); check that ${account.dir} is readable`,
          )
        }
        pending.delete(account.ref)
      }),
    )
  })()
  const deadlineMs = opts.deadlineMs ?? LIST_DEADLINE_MS
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), deadlineMs)
  })
  if ((await Promise.race([work.then(() => 'done' as const), late])) === 'late') {
    ctl.abort()
    problems.push(
      `stopped looking after ${deadlineMs / 1000} s; ${[...pending].join(', ') || 'some accounts'} may run sessions that are not shown; run \`sideby sessions\` again`,
    )
  }
  clearTimeout(timer)
  // One unreadable process is met by every Account of its Family: say it once.
  return { sessions: sortSessions([...found]), problems: [...new Set(problems)] }
}

export type ReferenceFields = Pick<
  LiveSession,
  'accountLabel' | 'sessionId' | 'title' | 'cwd' | 'transcript' | 'guessed' | 'resumeCommand'
>

export function referenceText(s: ReferenceFields, lang: 'en' | 'zh'): string {
  const id = shortId(s.sessionId)
  if (lang === 'zh') {
    const parts = [
      `${s.accountLabel} 的会话 ${id}${s.title ? `（${s.title}）` : ''}${s.guessed ? '（最新会话，推测）' : ''}`,
    ]
    if (s.cwd) parts.push(`工作目录 ${s.cwd}`)
    if (s.transcript) parts.push(`记录在 ${s.transcript}`)
    const tail = s.transcript ? '去读它的记录了解上下文。' : `用 \`${s.resumeCommand}\` 恢复它。`
    return `${parts.join('，')}。${tail}`
  }
  const parts = [
    `${s.accountLabel}'s session ${id}${s.title ? ` (${s.title})` : ''}${s.guessed ? ' (its newest session, a guess)' : ''}`,
  ]
  if (s.cwd) parts.push(`working directory ${s.cwd}`)
  if (s.transcript) parts.push(`record at ${s.transcript}`)
  const tail = s.transcript ? 'Read its record for the context.' : `Resume it with \`${s.resumeCommand}\`.`
  return `${parts.join(', ')}. ${tail}`
}

/** The text a copy button copies: the Session Reference (default), the bare id, or the resume command. */
export function sessionCopyText(s: LiveSession, as: SessionCopyAs, lang: 'en' | 'zh'): string {
  if (as === 'id') return s.sessionId
  if (as === 'resume') return s.resumeCommand
  return referenceText(s, lang)
}
