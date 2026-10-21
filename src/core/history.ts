// Session History (spec §3.33, ADR-0042): every Session of every Account, grouped by Project and searchable. The
// History Index keeps what the Family readers parse; this module keeps it in step with the Hosts' files and answers
// listings, searches, one Session's messages and the tool-output scan. Read-only towards every Host directory.
import { statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { type HistoryFile, type HistoryReader, historyReader } from '../families/history.ts'
import { cutText, SESSION_TEXT_MAX } from '../families/shared/history-text.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { UserError } from './errors.ts'
import {
  DAY_GROUPS,
  dayGroup,
  GROUP_BYS,
  type GroupBy,
  type GroupItem,
  orderGroups,
} from './history-group.ts'
import {
  type Filters,
  HistoryIndex,
  type Outline,
  type SessionInput,
  type SessionRow,
} from './history-index.ts'
import { ProjectResolver, projectNames } from './history-project.ts'
import { accountLabels, hostResumeArgs, liveKey, referenceText } from './live-sessions.ts'
import type { ProjectCategories } from './project-categories.ts'

export type IndexState = 'building' | 'ready' | 'off' | 'unavailable'

export interface HistorySource {
  account: string
  accountLabel: string
  family: string
  /** Sessions stored for the Account. */
  sessions: number
  /** Record files found. */
  files: number
  /** Record files that could not be read. */
  failed: number
  /** Why the Account has no Sessions or could not be listed, in plain words. */
  note?: string
  /** The same reason as a code: no record files, records without a conversation, a folder that could not be read,
   * or a Family sideby reads no history for. */
  reason?: 'empty' | 'no-conversation' | 'unreadable' | 'unsupported'
}

export interface HistorySession {
  account: string
  accountLabel: string
  family: string
  sessionId: string
  title: string
  titleFrom: string
  project: string
  projectName: string
  cwd: string
  cwdGone?: boolean
  branch?: string
  model?: string
  startedAt: string
  updatedAt: string
  messages: number
  script: boolean
  parent?: string
  children: number
  /** The first prompt on one line, when it says more than the title. */
  preview?: string
  snippet?: string
  live: boolean
  transcript: string
  resumeCommand: string
  continueCommand: string
  reference: string
  /** The key of the group the Session is listed under, when the list is grouped. */
  group?: string
  /** `tools` when the words were found only in its tool output (`sideby history --tools`). */
  foundIn?: 'tools'
}

export interface IndexProgress {
  state: IndexState
  /** Files read in the current build, and how many it has to read. */
  progress: { done: number; total: number }
}

export interface HistoryGroup {
  /** The Project path, Category name, Account ref, Family id or day (`today`, `yesterday`, `week`, `month`,
   * `older`); '' for Sessions without one, listed last. */
  key: string
  label: string
  /** Sessions in the group, collapsed or not. */
  sessions: number
  updatedAt: string
  collapsed?: boolean
}

export interface HistoryResult extends IndexProgress {
  sessions: HistorySession[]
  /** Sessions in the paged list: the matches, without those in collapsed groups. */
  total: number
  /** The groups of every match, in order, when `group` is set and not `none`. */
  groups?: HistoryGroup[]
  /** Set when a Plugin sorts Projects into categories: what they are called and which Plugin. */
  categories?: { label: string; from: string }
  sources: HistorySource[]
  problems: string[]
}

export type Since = 'today' | '7d' | '30d' | 'all'

export interface HistoryQuery {
  /** Words, split on white space; every word must match. */
  q?: string
  /** A Project path, or a Project name as `history projects` shows it. */
  project?: string
  family?: string
  /** An Account ref or Alias. */
  account?: string
  since?: Since
  scripts?: boolean
  /** A Project Category: only Sessions in its Projects. */
  category?: string
  /** List the Sessions under group headers; `none` (the default) lists them as one. */
  group?: GroupBy
  /** Group keys whose Sessions are counted but left out of the page. */
  collapsed?: string[]
  limit?: number
  offset?: number
}

const DAY = 86_400_000
const HALF_LIFE = 7 * DAY
const SYNC_EVERY_MS = 5_000
const PARSE_AT_ONCE = 4

interface State {
  key: string
  enabled: boolean
  index?: HistoryIndex
  opening?: Promise<HistoryIndex | undefined>
  syncing?: Promise<void>
  /** Set once the State is replaced: its sync stops and its index closes when the work in flight ends. */
  retired?: boolean
  /** The previous State's close, which this State's index waits for before it opens or deletes the file. */
  after?: Promise<void>
  /** Reads in flight on this State's index; a retired State closes its index only after they end. */
  reads: Set<Promise<unknown>>
  lastSync: number
  built: boolean
  state: IndexState
  done: number
  total: number
  /** Per Account: why it could not be listed, or that it has no Session folder. */
  notes: Map<string, string>
  problems: string[]
  /** Set when the index file could not be opened and an in-memory one is used instead. */
  fallback?: string
  /** The device and inode of the index file this State opened, to notice another process deleting or replacing it. */
  fileId?: string
}

const STATES = new Map<string, State>()
/** Per index file: the last close or delete in flight. A new State opens nothing before it ends. */
const BARRIER = new Map<string, Promise<void>>()

/** Makes `work` the barrier of `key` until it ends. */
function fence(key: string, work: Promise<unknown>): Promise<void> {
  const done = work.then(
    () => {},
    () => {},
  )
  BARRIER.set(key, done)
  void done.then(() => {
    if (BARRIER.get(key) === done) BARRIER.delete(key)
  })
  return done
}

/** What a Session id may look like: the Hosts use UUIDs and similar plain names. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const historyIndexPath = (rt: Pick<Runtime, 'paths'>): string =>
  join(rt.paths.stateDir, 'history', 'index.sqlite')

const enabled = (rt: Pick<Runtime, 'config'>): boolean => rt.config.history?.index !== false

/** `dev:ino` of the file at `path`, or '' when there is none. */
function fileIdOf(path: string): string {
  try {
    const st = statSync(path)
    return `${st.dev}:${st.ino}`
  } catch {
    return ''
  }
}

function stateOf(rt: Runtime): State {
  const key = historyIndexPath(rt)
  let s = STATES.get(key)
  // Another sideby process (the Panel, a second command) may have cleared or rebuilt the file: this one then closes
  // its handle on the old file instead of writing into a deleted one, and opens the current file.
  if (s && ((s.fileId && fileIdOf(key) !== s.fileId) || s.enabled !== enabled(rt))) {
    retire(s)
    s = undefined
  }
  if (!s) {
    const after = BARRIER.get(key)
    s = {
      key,
      ...(after ? { after } : {}),
      reads: new Set(),
      enabled: enabled(rt),
      lastSync: 0,
      built: false,
      state: 'building',
      done: 0,
      total: 0,
      notes: new Map(),
      problems: [],
    }
    STATES.set(key, s)
  }
  return s
}

/**
 * Retires `s`: new calls get a new State, and its index closes once the open, sync and reads in flight on it end;
 * `then` (deleting the file) runs after that, before any new State opens the file.
 */
function retire(s: State, then?: () => Promise<unknown>): Promise<void> {
  s.retired = true
  if (STATES.get(s.key) === s) STATES.delete(s.key)
  return fence(
    s.key,
    (async () => {
      await s.after
      while (s.opening || s.syncing || s.reads.size)
        await Promise.allSettled([s.opening, s.syncing, ...s.reads])
      s.index?.close()
      s.index = undefined
      await then?.()
    })(),
  )
}

/** Runs `fn` on the current State, counted as a read so a retire waits for it before it closes the index. */
async function reading<T>(rt: Runtime, fn: (s: State) => Promise<T>): Promise<T> {
  const s = stateOf(rt)
  const p = fn(s)
  s.reads.add(p)
  try {
    return await p
  } finally {
    s.reads.delete(p)
  }
}

async function indexOf(_rt: Runtime, s: State): Promise<HistoryIndex | undefined> {
  if (s.index) return s.index
  s.opening ??= (async () => {
    await s.after
    // A retired State never opens (or deletes) the file again; it only finishes the call that is already waiting.
    if (s.retired) return HistoryIndex.open(':memory:', false)
    if (!s.enabled) {
      await HistoryIndex.remove(s.key).catch((err: Error) => {
        s.fallback = err.message
      })
      return HistoryIndex.open(':memory:', false)
    }
    let why: string | undefined
    const idx = await HistoryIndex.open(s.key, true).catch((err: Error) => {
      why = err.message
      return undefined
    })
    if (idx) {
      s.fileId = fileIdOf(s.key) || undefined
      return idx
    }
    s.fallback = why
      ? `${why}; searching only titles and folders this time`
      : `could not open the History Index at ${s.key}; searching only titles and folders this time. Run \`sideby history index --clear\` to start it again`
    return HistoryIndex.open(':memory:', false)
  })()
  const idx = await s.opening
  s.opening = undefined
  if (!idx) {
    s.state = 'unavailable'
    return undefined
  }
  s.index = idx
  return idx
}

const UNAVAILABLE = `Session History needs Node ${'>='}22.18 with node:sqlite (this is Node ${process.versions.node}); update Node and run the command again`

/** Closes the History Index of `rt` (tests), after the open, sync and reads in flight end. */
export function closeHistory(rt: Runtime): Promise<void> {
  const s = STATES.get(historyIndexPath(rt))
  return s ? retire(s) : (BARRIER.get(historyIndexPath(rt)) ?? Promise.resolve())
}

/** Closes the History Index like closeHistory, then deletes its files before any new State opens them. */
async function clearHistory(rt: Runtime): Promise<boolean> {
  const key = historyIndexPath(rt)
  let removed = false
  let failed: unknown
  const remove = async () => {
    removed = await HistoryIndex.remove(key).catch((err: unknown) => {
      failed = err
      return false
    })
  }
  const s = STATES.get(key)
  await (s ? retire(s, remove) : fence(key, (BARRIER.get(key) ?? Promise.resolve()).then(remove)))
  if (failed) throw failed
  return removed
}

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!)
    }),
  )
}

/**
 * Brings the History Index in step with the Hosts' files: lists every Account's record files, forgets the ones that
 * are gone, and reads the new or changed ones, newest first. One sync runs at a time; a call while one runs waits for
 * it. An Account that cannot be listed keeps the Sessions already stored for it.
 */
export async function syncHistory(rt: Runtime, opts: { force?: boolean } = {}): Promise<void> {
  const s = stateOf(rt)
  if (s.syncing) return s.syncing
  if (!opts.force && s.built && Date.now() - s.lastSync < SYNC_EVERY_MS) return
  s.syncing = (async () => {
    const idx = await indexOf(rt, s)
    if (!idx) return
    const accounts = (await rt.accounts()).filter((a) => historyReader(a.family, rt.families))
    const labels = accountLabels(rt, accounts)
    const notes = new Map<string, string>()
    const problems: string[] = []
    const listed = new Map<string, HistoryFile[]>()
    await Promise.all(
      accounts.map(async (a) => {
        try {
          const files = await historyReader(a.family, rt.families)!.list(a, problems)
          listed.set(a.ref, files)
          if (!files.length) notes.set(a.ref, 'no session records yet')
        } catch (err) {
          const why = (err as NodeJS.ErrnoException).code ?? (err as Error).message
          notes.set(a.ref, `could not be read (${why})`)
          problems.push(`${a.ref}: could not list its sessions (${why}); check that ${a.dir} is readable`)
        }
      }),
    )
    const known = idx.fileSigs()
    const refs = new Set(accounts.map((a) => a.ref))
    const seen = new Set<string>()
    const todo: { account: Account; file: HistoryFile }[] = []
    // Two Accounts whose record folders are links to one folder list the same files: each is kept once, for the
    // first Account that lists it, so a Session is not listed twice nor needs --account to be opened.
    const reals = new Map<string, Promise<string>>()
    const realDir = (d: string) => {
      let r = reals.get(d)
      if (!r) {
        r = realpath(d).catch(() => d)
        reals.set(d, r)
      }
      return r
    }
    const owners = new Set<string>()
    for (const a of accounts) {
      for (const f of listed.get(a.ref) ?? []) {
        const real = join(await realDir(dirname(f.path)), basename(f.path))
        if (owners.has(real)) continue
        owners.add(real)
        seen.add(f.path)
        if (known.get(f.path)?.sig !== f.sig) todo.push({ account: a, file: f })
      }
    }
    // A file is forgotten when its Account was listed and no longer has it, or the Account is gone.
    idx.remove(
      [...known]
        .filter(([path, k]) => !seen.has(path) && (!refs.has(k.account) || listed.has(k.account)))
        .map(([path]) => path),
    )
    todo.sort((x, y) => y.file.mtimeMs - x.file.mtimeMs)
    s.done = 0
    s.total = todo.length
    if (todo.length) s.state = 'building'
    const projects = new ProjectResolver()
    let failed = 0
    let busy = 0
    let cut = 0
    await mapLimit(todo, PARSE_AT_ONCE, async ({ account, file }) => {
      if (s.retired) return
      const reader = historyReader(account.family, rt.families)!
      try {
        const parsed = await reader.parse(file, account)
        if (s.retired) return
        let input: SessionInput | undefined
        // A Session id goes into a resume command the user may run, so only plain ids are kept.
        if (parsed) parsed.parent ??= file.parent
        if (parsed && SAFE_ID.test(parsed.sessionId) && (!parsed.parent || SAFE_ID.test(parsed.parent))) {
          const p = await projects.resolve(parsed.cwd, parsed.gitRoot)
          input = {
            account: account.ref,
            accountLabel: labels.get(account.ref) ?? account.ref,
            family: account.family,
            path: file.path,
            sig: file.sig,
            project: p.path,
            cwdGone: p.gone,
            session: parsed,
          }
        }
        if (input && parsed?.cut) cut++
        try {
          idx.put(account.ref, file.path, file.sig, input)
        } catch {
          // The index was busy or could not be written (another sideby writing it): the file is fine, so it is
          // not marked unreadable and the next sync reads it again.
          busy++
        }
      } catch (err) {
        // A file that vanished mid-read is picked up (or forgotten) by the next sync.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          failed++
          idx.putFailed(account.ref, file.path, file.sig)
        }
      }
      s.done++
    })
    if (s.retired) return
    // An Account given a new name or short command is found by it, also in Sessions read before.
    idx.relabel(labels)
    // A folder removed, or made a repository, after its Sessions were read moves them without reading them again.
    for (const place of idx.places()) {
      const p = await projects.resolve(place.cwd, place.gone ? place.project : undefined)
      if (p.path && (p.path !== place.project || p.gone !== place.gone))
        idx.moveProject(place.cwd, place.project, p.path, p.gone)
    }
    if (cut)
      problems.push(
        `${cut} session${cut === 1 ? ' has' : 's have'} more than ${SESSION_TEXT_MAX / 1024 / 1024} MB of text; only the start of each is searchable`,
      )
    if (busy)
      problems.push(
        `${busy} session${busy === 1 ? '' : 's'} could not be saved to the search index (another sideby may be updating it); they are added on the next refresh`,
      )
    if (failed)
      problems.push(
        `${failed} session file${failed === 1 ? '' : 's'} could not be read; they are tried again once they change`,
      )
    for (const a of accounts) {
      const reader = historyReader(a.family, rt.families)!
      if (!reader.titles || !listed.has(a.ref)) continue
      try {
        idx.setHostTitles(a.ref, await reader.titles(a))
      } catch (err) {
        problems.push(
          `${a.ref}: could not read its session titles (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); titles fall back to the first prompt`,
        )
      }
    }
    if (s.fallback) problems.push(s.fallback)
    s.notes = notes
    s.problems = [...new Set(problems)]
    s.state = s.enabled && !s.fallback ? 'ready' : 'off'
    s.built = true
    s.lastSync = Date.now()
  })().finally(() => {
    s.syncing = undefined
  })
  return s.syncing
}

/** How long a listing waits for a first build before it answers with what is built so far. */
export const FIRST_ANSWER_MS = 2_500

/** Waits for `sync` with `wait`; else for at most FIRST_ANSWER_MS while nothing was built yet, then not at all. */
async function settle(s: State, sync: Promise<void>, wait?: boolean): Promise<void> {
  if (wait) return sync
  sync.catch(() => {})
  if (s.built) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    sync.catch(() => {}),
    new Promise<void>((r) => (timer = setTimeout(r, FIRST_ANSWER_MS))),
  ])
  clearTimeout(timer)
}

/** Starts a sync without waiting for it; what is already built answers at once. */
export function syncHistoryInBackground(rt: Runtime): void {
  syncHistory(rt).catch(() => {
    // reported by the next listing
  })
}

function progressOf(s: State): IndexProgress {
  return { state: s.state, progress: { done: s.done, total: s.total } }
}

/** True once a first build finished (the Panel then answers without waiting). */
export const historyBuilt = (rt: Runtime): boolean => stateOf(rt).built

async function sourcesOf(rt: Runtime, s: State, idx: HistoryIndex): Promise<HistorySource[]> {
  const accounts = await rt.accounts()
  const labels = accountLabels(rt, accounts)
  const counts = idx.counts()
  return accounts.map((a) => {
    const c = counts.get(a.ref) ?? { files: 0, sessions: 0, failed: 0 }
    const out: HistorySource = {
      account: a.ref,
      accountLabel: labels.get(a.ref) ?? a.ref,
      family: a.family,
      sessions: c.sessions,
      files: c.files,
      failed: c.failed,
    }
    const note = s.notes.get(a.ref)
    if (!historyReader(a.family, rt.families)) {
      out.note =
        'sideby cannot read past sessions of this tool yet: its plugin gives no session reader (FamilyDef `history`, see docs/guide/plugins.md)'
      out.reason = 'unsupported'
    } else if (note) {
      out.note = note
      out.reason = note.startsWith('could not') ? 'unreadable' : 'empty'
    } else if (!c.sessions && c.files > c.failed) {
      out.note = 'its records hold no conversation yet'
      out.reason = 'no-conversation'
    }
    return out
  })
}

function sinceMs(since: Since | undefined, now = Date.now()): number | undefined {
  if (!since || since === 'all') return undefined
  if (since === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return now - (since === '7d' ? 7 : 30) * DAY
}

const SINCE = new Set(['today', '7d', '30d', 'all'])

/**
 * The query with its time checked and a `~` project made a path, before anything is read, so a bad query fails the
 * same way whether the index is there or not.
 */
function checkQuery<Q extends Pick<HistoryQuery, 'since' | 'project' | 'group'>>(rt: Runtime, q: Q): Q {
  if (q.since !== undefined && !SINCE.has(q.since))
    throw new UserError(`unknown time "${q.since}"; use today, 7d, 30d or all`)
  if (q.group !== undefined && !GROUP_BYS.includes(q.group))
    throw new UserError(`unknown grouping "${q.group}"; use ${GROUP_BYS.join(', ')}`)
  const p = q.project
  if (p === '~' || p?.startsWith('~/')) return { ...q, project: rt.paths.home + p.slice(1) }
  return q
}

async function filtersOf(
  rt: Runtime,
  idx: HistoryIndex,
  q: HistoryQuery,
  cats?: ProjectCategories,
): Promise<Filters> {
  const f: Filters = {}
  if (q.category !== undefined) {
    cats ??= await categoriesOf(rt, namesOf(idx), true)
    if (!cats)
      throw new UserError(
        'no plugin sorts projects into categories; add one (see docs/guide/plugins.md) or filter with --project',
      )
    const name = q.category
    f.projects = [...cats.of].filter(([, c]) => c === name).map(([p]) => p)
    if (!f.projects.length && !cats.problem)
      throw new UserError(`no category named "${name}"; run \`sideby history projects\` to see them`)
  }
  if (q.family) {
    if (!rt.families.has(q.family))
      throw new UserError(`unknown AI "${q.family}"; use one of ${[...rt.families.keys()].join(', ')}`)
    f.family = q.family
  }
  if (q.account) f.account = (await rt.resolve(q.account)).ref
  if (q.project !== undefined) f.project = await resolveProject(idx, q.project, rt.paths.home)
  const since = sinceMs(q.since)
  if (since) f.since = since
  if (q.scripts) f.scripts = true
  return f
}

/**
 * A Project path from a path or a name; an unknown name throws with the names that exist. A path (absolute, or
 * starting with `.` or `~`) is resolved from the current folder and moved up to the Project it is in, so a subfolder,
 * `.` or a worktree finds its repository's Sessions.
 */
async function resolveProject(idx: HistoryIndex, p: string, home: string): Promise<string> {
  if (p === '') return p
  const names = namesOf(idx)
  if (isAbsolute(p) || p === '.' || p === '..' || /^\.{1,2}\//.test(p) || p === '~' || p.startsWith('~/')) {
    const abs = resolve(p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p)
    if (names.has(abs)) return abs
    const found = (await new ProjectResolver().resolve(abs)).path
    if (names.has(found)) return found
    for (let dir = abs; dirname(dir) !== dir; dir = dirname(dir)) if (names.has(dir)) return dir
    return abs
  }
  const hit = projectsNamed(names, p)
  if (hit.length === 1) return hit[0]!
  if (hit.length > 1)
    throw new UserError(`"${p}" names ${hit.length} projects (${hit.join(', ')}); give the full path`)
  throw new UserError(`no project named "${p}"; run \`sideby history projects\` to see them`)
}

/**
 * The Projects a name given to `--project` may mean: the one whose shown name it is, else every Project whose path
 * ends with it. A shown name is unique, so it wins over a path tail it shares with a longer path (`a/app` for
 * `/a/app` beside `/x/a/app`).
 */
export function projectsNamed(names: ReadonlyMap<string, string>, p: string): string[] {
  const all = [...names.keys()]
  const named = all.filter((x) => names.get(x) === p)
  if (named.length === 1) return named
  return all.filter((x) => names.get(x) === p || x.endsWith(`/${p}`))
}

const SAFE = /^[\w@%+=:,./-]+$/
const shq = (v: string) => (SAFE.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`)

/** A snippet of `text` around the first of `words` it contains, about 40 characters each side. */
export function snippetOf(text: string, words: string[]): string | undefined {
  if (!text || !words.length) return undefined
  let at = -1
  let len = 0
  for (const w of words) {
    // Matched in the text itself: lowercasing can change its length and move every position after it.
    const m = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(text)
    if (m && (at < 0 || m.index < at)) {
      at = m.index
      len = m[0].length
    }
  }
  if (at < 0) return undefined
  let start = Math.max(0, at - 40)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--
  const end = start + cutText(text.slice(start), at - start + len + 40).length
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

const NAMES = new WeakMap<HistoryIndex, { version: number; names: Map<string, string> }>()

/** Project names, worked out again only after the index changed. */
function namesOf(idx: HistoryIndex): Map<string, string> {
  const kept = NAMES.get(idx)
  if (kept?.version === idx.version) return kept.names
  const names = projectNames(idx.projects({ scripts: true }).map((p) => p.project))
  NAMES.set(idx, { version: idx.version, names })
  return names
}

/** The command that resumes Session `id` in `account` itself. */
function accountResumeCommand(rt: Runtime, family: string, account: string, id: string): string {
  const custom = historyReader(family, rt.families)?.resumeArgs?.(id)
  const args = custom ? custom.map(shq).join(' ') : hostResumeArgs(family, id)
  return `sideby run ${shq(account)} -- ${args}`
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : '')

function toSession(
  rt: Runtime,
  r: SessionRow,
  labels: Map<string, string>,
  names: Map<string, string>,
  extra: { children?: number; snippet?: string; live?: boolean },
): HistorySession {
  const accountLabel = labels.get(r.account) ?? r.accountLabel
  // The Account of this row, not Resume Routing's pick: the same Session may be kept by another Account too.
  const resumeCommand = SAFE_ID.test(r.sessionId)
    ? accountResumeCommand(rt, r.family, r.account, r.sessionId)
    : ''
  const continueCommand =
    resumeCommand && r.cwd && !r.cwdGone ? `cd ${shq(r.cwd)} && ${resumeCommand}` : resumeCommand
  const out: HistorySession = {
    account: r.account,
    accountLabel,
    family: r.family,
    sessionId: r.sessionId,
    title: r.title,
    titleFrom: r.titleFrom,
    project: r.project,
    projectName: r.project ? (names.get(r.project) ?? r.project) : '',
    cwd: r.cwd,
    startedAt: iso(r.startedAt),
    updatedAt: iso(r.updatedAt),
    messages: r.messages,
    script: r.script,
    children: extra.children ?? 0,
    live: extra.live ?? false,
    transcript: r.path,
    resumeCommand,
    continueCommand,
    reference: referenceText(
      {
        accountLabel,
        sessionId: r.sessionId,
        title: r.title,
        cwd: r.cwd,
        transcript: r.path,
        guessed: false,
        resumeCommand,
      },
      'en',
    ),
  }
  if (r.cwdGone) out.cwdGone = true
  if (r.branch) out.branch = r.branch
  if (r.model) out.model = r.model
  if (r.parent) out.parent = r.parent
  const first = r.firstPrompt.replace(/\s+/g, ' ').trim()
  if (first && first !== r.title && !(r.titleFrom === 'prompt' && first.length <= r.title.length))
    out.preview = first.length > 240 ? `${cutText(first, 239)}…` : first
  if (extra.snippet) out.snippet = extra.snippet
  return out
}

/** The words of a search; `"two words"` in double quotes is one phrase, matched as written. */
export const splitWords = (q: string | undefined): string[] =>
  [...(q ?? '').matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean)

/**
 * Sessions matching `q`, best first (relevance times a recency boost that halves every 7 days), or newest first
 * without words. Answers from what is built; `wait` waits for the current sync first (the CLI's first run).
 * `live` names Sessions running now, as `<account>\0<sessionId>`.
 */
export async function searchHistory(
  rt: Runtime,
  q: HistoryQuery,
  opts: { wait?: boolean; live?: ReadonlySet<string> } = {},
): Promise<HistoryResult> {
  const checked = checkQuery(rt, q)
  return reading(rt, (s) => search(rt, s, checked, opts))
}

async function search(
  rt: Runtime,
  s: State,
  q: HistoryQuery,
  opts: { wait?: boolean; live?: ReadonlySet<string> },
): Promise<HistoryResult> {
  await settle(s, syncHistory(rt), opts.wait)
  const idx = await indexOf(rt, s)
  if (!idx)
    return {
      sessions: [],
      total: 0,
      sources: [],
      problems: [UNAVAILABLE],
      state: 'unavailable',
      progress: { done: 0, total: 0 },
    }
  const group = q.group ?? 'none'
  const names = namesOf(idx)
  const cats = await categoriesOf(rt, names, q.category !== undefined || group === 'category')
  const f = await filtersOf(rt, idx, q, cats)
  const words = splitWords(q.q)
  const limit = Math.max(1, Math.min(q.limit ?? 50, 500))
  const offset = Math.max(0, q.offset ?? 0)
  const accounts = await rt.accounts()
  const labels = accountLabels(rt, accounts)
  let rows: SessionRow[]
  let total: number
  let groups: HistoryGroup[] | undefined
  const groupOf = new Map<number, string>()
  const pageOf = (ids: number[]) => {
    const byId = new Map(idx.rows(ids).map((r) => [r.id, r]))
    return ids.map((id) => byId.get(id)!).filter(Boolean)
  }
  if (words.length || group !== 'none') {
    let items: GroupItem[]
    if (words.length) {
      const now = Date.now()
      const hits = idx.match(words, f)
      const outline = idx.outlineOf(hits.map((h) => h.id))
      items = hits.flatMap((h) => {
        const o = outline.get(h.id)
        return o ? [{ ...o, score: h.relevance * 0.5 ** (Math.max(0, now - o.updatedAt) / HALF_LIFE) }] : []
      })
    } else items = idx.outline(f).map((o) => ({ ...o, score: o.updatedAt }))
    if (group === 'none') {
      items.sort((a, b) => b.score - a.score || b.id - a.id)
      total = items.length
      rows = pageOf(items.slice(offset, offset + limit).map((h) => h.id))
    } else {
      const collapsed = new Set(q.collapsed ?? [])
      const now = new Date()
      const keyOf = (o: Outline): string =>
        group === 'project'
          ? o.project
          : group === 'category'
            ? (cats?.of.get(o.project) ?? '')
            : group === 'account'
              ? o.account
              : group === 'family'
                ? o.family
                : dayGroup(o.updatedAt, now)
      const ordered = orderGroups(items, keyOf, collapsed, group === 'day' ? DAY_GROUPS : undefined)
      total = ordered.items.length
      const page = ordered.items.slice(offset, offset + limit)
      for (const it of page) groupOf.set(it.id, it.group)
      rows = pageOf(page.map((it) => it.id))
      groups = ordered.groups.map((g) => {
        const out: HistoryGroup = {
          key: g.key,
          label: groupLabel(rt, group, g.key, names, labels),
          sessions: g.sessions,
          updatedAt: iso(g.updatedAt),
        }
        if (collapsed.has(g.key)) out.collapsed = true
        return out
      })
    }
  } else {
    ;({ rows, total } = idx.recent(f, limit, offset))
  }
  const children = idx.children(rows)
  const sessions = rows.map((r) => {
    let snippet: string | undefined
    if (words.length && idx.keepText) {
      const t = idx.text(r.id)
      snippet = snippetOf(t.prompts, words) ?? snippetOf(t.replies, words)
    }
    const out = toSession(rt, r, labels, names, {
      children: children.get(r.id) ?? 0,
      ...(snippet ? { snippet } : {}),
      live: opts.live?.has(liveKey(r.account, r.sessionId)) ?? false,
    })
    const g = groupOf.get(r.id)
    if (g !== undefined) out.group = g
    return out
  })
  const result: HistoryResult = {
    sessions,
    total,
    sources: await sourcesOf(rt, s, idx),
    problems: cats?.problem ? [...s.problems, cats.problem] : s.problems,
    ...progressOf(s),
  }
  if (groups) result.groups = groups
  if (rt.projectCategoriesFrom)
    result.categories = { label: cats?.label ?? '', from: rt.projectCategoriesFrom }
  return result
}

/** The Project Categories of every Project in the index, asked of the Plugin only when `need` is set. */
async function categoriesOf(
  rt: Runtime,
  names: Map<string, string>,
  need: boolean,
): Promise<ProjectCategories | undefined> {
  if (!need || !rt.projectCategoriesFrom) return undefined
  return rt.projectCategories([...names.keys()].filter(Boolean))
}

const DAY_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Last 7 days',
  month: 'Last 30 days',
  older: 'Older',
}

/** The English label of a group; the Panel shows its own words for days and for the group without a key. */
function groupLabel(
  rt: Runtime,
  group: GroupBy,
  key: string,
  names: Map<string, string>,
  labels: Map<string, string>,
): string {
  if (group === 'day') return DAY_LABELS[key] ?? key
  if (key === '') return group === 'category' ? 'No category' : group === 'project' ? 'No project' : 'Other'
  if (group === 'project') return names.get(key) ?? key
  if (group === 'account') return labels.get(key) ?? key
  if (group === 'family') return rt.families.get(key)?.title ?? key
  return key
}

export interface ProjectEntry {
  project: string
  name: string
  sessions: number
  updatedAt: string
  gone?: boolean
  /** Its Project Category, when a Plugin sorts Projects into categories. */
  category?: string
}

/** Every Project with its number of Sessions, most recent first. */
export async function historyProjects(
  rt: Runtime,
  q: Pick<HistoryQuery, 'family' | 'account' | 'since' | 'scripts'> = {},
  opts: { wait?: boolean } = {},
): Promise<
  {
    projects: ProjectEntry[]
    categories?: { label: string; from: string }
    problems?: string[]
  } & IndexProgress
> {
  q = checkQuery(rt, q)
  return reading(rt, async (s) => {
    await settle(s, syncHistory(rt), opts.wait)
    const idx = await indexOf(rt, s)
    if (!idx) throw new UserError(UNAVAILABLE, { code: 'history-unavailable' })
    const f = await filtersOf(rt, idx, q)
    const list = idx.projects(f)
    const names = namesOf(idx)
    const cats = await categoriesOf(rt, names, true)
    return {
      ...(cats ? { categories: { label: cats.label, from: cats.owner } } : {}),
      ...(cats?.problem ? { problems: [cats.problem] } : {}),
      projects: list.map((p) => {
        const e: ProjectEntry = {
          project: p.project,
          name: p.project ? (names.get(p.project) ?? p.project) : '',
          sessions: p.sessions,
          updatedAt: iso(p.updatedAt),
        }
        if (p.gone) e.gone = true
        const c = cats?.of.get(p.project)
        if (c) e.category = c
        return e
      }),
      ...progressOf(s),
    }
  })
}

export interface ShownMessage {
  n: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  at?: string
  tool?: string
}

export interface HistoryShow {
  session: HistorySession
  messages: ShownMessage[]
  /** Pass as `before` for the messages before these; absent when these start at the first one. */
  before?: number
}

/**
 * One Session's messages, oldest first: the newest `limit` (default 200) before message `before`. `id` is the
 * Session id or its first eight characters or more.
 */
export async function historyShow(
  rt: Runtime,
  id: string,
  opts: { before?: number; limit?: number; account?: string } = {},
): Promise<HistoryShow> {
  return reading(rt, (s) => show(rt, s, id, opts))
}

async function show(
  rt: Runtime,
  s: State,
  id: string,
  opts: { before?: number; limit?: number; account?: string },
): Promise<HistoryShow> {
  const idx = await indexOf(rt, s)
  if (!idx) throw new UserError(UNAVAILABLE, { code: 'history-unavailable' })
  const account = opts.account ? (await rt.resolve(opts.account)).ref : undefined
  const lookup = () => idx.find(id).filter((r) => !account || r.account === account)
  let found = lookup()
  if (!found.length) {
    await syncHistory(rt, { force: true })
    found = lookup()
  }
  if (!found.length)
    throw new UserError(
      `no session "${id}"${account ? ` in ${account}` : ''}; run \`sideby history\` to find its id`,
    )
  const ids = new Set(found.map((r) => `${r.account} ${r.sessionId}`))
  if (ids.size > 1) {
    const accounts = new Set(found.map((r) => r.account))
    throw new UserError(
      `"${id}" matches ${ids.size} sessions (${[...ids].slice(0, 5).join(', ')}); ${accounts.size > 1 && new Set(found.map((r) => r.sessionId)).size === 1 ? 'add --account <account> to pick one' : 'give more of the id'}`,
    )
  }
  // The same Session kept by two Accounts (a shared folder) reads the same file; take the newest.
  const r = found.sort((a, b) => b.updatedAt - a.updatedAt)[0]!
  const reader = historyReader(r.family, rt.families)
  if (!reader)
    throw new UserError(
      `sideby cannot read ${r.family} sessions: its plugin gives no session reader (FamilyDef \`history\`, see docs/guide/plugins.md)`,
    )
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000))
  const window: ShownMessage[] = []
  let n = 0
  try {
    for await (const m of reader.messages(r.path)) {
      n++
      if (opts.before !== undefined && n >= opts.before) break
      window.push({ n, ...m })
      if (window.length > limit) window.shift()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Forget the gone file now, so the list refreshed after this error no longer shows it.
    if (code === 'ENOENT') {
      try {
        idx.remove([r.path])
      } catch {}
    }
    throw new UserError(
      `could not read ${r.path} (${code ?? (err as Error).message}); the Host may have removed it, run \`sideby history\` again`,
      code === 'ENOENT' ? { code: 'session-gone' } : {},
    )
  }
  const labels = accountLabels(rt, await rt.accounts())
  const names = namesOf(idx)
  const out: HistoryShow = {
    session: toSession(rt, r, labels, names, { children: idx.children([r]).get(r.id) ?? 0 }),
    messages: window,
  }
  if (window[0] && window[0].n > 1) out.before = window[0].n
  return out
}

export interface IndexInfo extends IndexProgress {
  enabled: boolean
  path: string
  files: number
  sessions: number
  bytes: number
  sources: HistorySource[]
  cleared?: boolean
}

async function sizeOf(path: string): Promise<number> {
  let n = 0
  for (const p of [path, `${path}-wal`])
    n += await stat(p).then(
      (st) => st.size,
      () => 0,
    )
  return n
}

/** The History Index's state; with `clear` it is deleted first (and rebuilt by the next listing when on). */
export async function historyIndexInfo(
  rt: Runtime,
  opts: { clear?: boolean; wait?: boolean; rebuild?: boolean } = {},
): Promise<IndexInfo> {
  const cleared = opts.clear ? await clearHistory(rt) : undefined
  // Cleared without a rebuild (the CLI): nothing is opened again, so the command ends and the file stays deleted
  // until the next listing builds it.
  if (opts.clear && opts.rebuild === false)
    return {
      enabled: enabled(rt),
      path: historyIndexPath(rt),
      state: enabled(rt) ? 'building' : 'off',
      progress: { done: 0, total: 0 },
      files: 0,
      sessions: 0,
      bytes: 0,
      sources: [],
      cleared: cleared ?? false,
    }
  return reading(rt, async (s) => {
    const sync = syncHistory(rt)
    if (opts.wait) await sync
    else sync.catch(() => {})
    const idx = await indexOf(rt, s)
    const sources = idx ? await sourcesOf(rt, s, idx) : []
    const out: IndexInfo = {
      enabled: s.enabled,
      path: historyIndexPath(rt),
      ...progressOf(s),
      files: sources.reduce((n, x) => n + x.files, 0),
      sessions: sources.reduce((n, x) => n + x.sessions, 0),
      bytes: s.enabled ? await sizeOf(historyIndexPath(rt)) : 0,
      sources,
    }
    if (cleared !== undefined) out.cleared = cleared
    return out
  })
}

/**
 * A snippet when every word appears, case-insensitively, in the Session's tool calls and tool results, else
 * undefined. Only the reader's tool text is searched, never the record's other fields; nothing read is kept.
 */
async function findWords(
  reader: HistoryReader,
  path: string,
  words: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const missing = new Set(words.map((w) => w.toLowerCase()))
  let snippet: string | undefined
  try {
    for await (const text of reader.toolText(path)) {
      if (signal?.aborted) return undefined
      if (!text) continue
      const low = text.toLowerCase()
      for (const w of missing) {
        if (!low.includes(w)) continue
        missing.delete(w)
        snippet ??= snippetOf(text, [w]) ?? w
      }
      if (!missing.size) return snippet ?? ''
    }
  } catch {
    // A file that went away or cannot be read is skipped.
  }
  return undefined
}

export interface ToolHit {
  session: HistorySession
  snippet: string
}

/**
 * Reads the record files of the Sessions in scope, newest first, for `words` anywhere in them (tool output included),
 * and yields each Session in which every word appears. Nothing read is kept. Stops when `signal` aborts.
 */
export async function* scanToolOutput(
  rt: Runtime,
  q: HistoryQuery,
  opts: {
    signal?: AbortSignal
    skip?: ReadonlySet<string>
    live?: ReadonlySet<string>
    onProgress?: (done: number, total: number) => void | Promise<void>
  } = {},
): AsyncGenerator<ToolHit> {
  q = checkQuery(rt, q)
  const words = splitWords(q.q)
  if (!words.length) return
  const s = stateOf(rt)
  // Counted as a read for as long as the scan runs, so the index stays open under it.
  let end!: () => void
  const running = new Promise<void>((r) => (end = r))
  s.reads.add(running)
  try {
    yield* scan(rt, s, q, words, opts)
  } finally {
    s.reads.delete(running)
    end()
  }
}

async function* scan(
  rt: Runtime,
  s: State,
  q: HistoryQuery,
  words: string[],
  opts: {
    signal?: AbortSignal
    skip?: ReadonlySet<string>
    live?: ReadonlySet<string>
    onProgress?: (done: number, total: number) => void | Promise<void>
  },
): AsyncGenerator<ToolHit> {
  if (!s.built) await syncHistory(rt)
  const idx = await indexOf(rt, s)
  if (!idx) throw new UserError(UNAVAILABLE, { code: 'history-unavailable' })
  const f = await filtersOf(rt, idx, q)
  const files = idx.paths({ ...f, scripts: true })
  const labels = accountLabels(rt, await rt.accounts())
  const names = namesOf(idx)
  // Sessions are known by Account and id: a row is written again (with a new number) when its file changes mid-scan.
  const yielded = new Set<string>()
  let done = 0
  for (const file of files) {
    if (opts.signal?.aborted) return
    if (yielded.has(liveKey(file.account, file.parent || file.sessionId))) {
      opts.onProgress?.(++done, files.length)
      continue
    }
    const reader = historyReader(file.family, rt.families)
    const found = reader ? await findWords(reader, file.path, words, opts.signal) : undefined
    if (opts.signal?.aborted) return
    await opts.onProgress?.(++done, files.length)
    if (found === undefined) continue
    const target = (file.parent && idx.parentOf(file.account, file.parent)) || idx.idOf(file.path)
    const row = target === undefined ? undefined : idx.rows([target])[0]
    if (!row || (row.script && !q.scripts)) continue
    const key = liveKey(row.account, row.sessionId)
    if (opts.skip?.has(key)) continue
    yielded.add(key)
    yield {
      session: toSession(rt, row, labels, names, { snippet: found, live: opts.live?.has(key) ?? false }),
      snippet: found,
    }
  }
}
