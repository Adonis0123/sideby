// The History Index (spec §3.33, ADR-0042): a SQLite database in sideby's state folder, through `node:sqlite`, with
// one row per record file and one per Session, and an FTS5 `trigram` table over each Session's title, place, prompts
// and replies. It holds no tool output, injected context or credential; it is rebuilt from the Hosts' files.
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open as openFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ParsedSession, TitleSource } from '../families/history.ts'
import { cutText } from '../families/shared/history-text.ts'
import { UserError } from './errors.ts'

/** Bumped whenever the tables or what a reader stores changes; an older database is dropped and rebuilt. */
const SCHEMA = 3

type Sqlite = typeof import('node:sqlite')
let sqlite: Promise<Sqlite | undefined> | undefined

/** `node:sqlite` without its experimental warning (ADR-0042); undefined when this Node has none. */
function loadSqlite(): Promise<Sqlite | undefined> {
  sqlite ??= (async () => {
    const emit = process.emitWarning
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      const text = typeof w === 'string' ? w : w.message
      if (/SQLite/i.test(text)) return
      ;(emit as (...a: unknown[]) => void).call(process, w, ...rest)
    }) as typeof process.emitWarning
    try {
      return await import('node:sqlite')
    } catch {
      return undefined
    } finally {
      process.emitWarning = emit
    }
  })()
  return sqlite
}

export interface SessionRow {
  id: number
  account: string
  accountLabel: string
  family: string
  sessionId: string
  path: string
  cwd: string
  project: string
  cwdGone: boolean
  title: string
  titleFrom: TitleSource
  firstPrompt: string
  branch: string
  model: string
  startedAt: number
  updatedAt: number
  messages: number
  script: boolean
  parent: string
}

export interface SessionInput {
  account: string
  accountLabel: string
  family: string
  path: string
  sig: string
  project: string
  cwdGone: boolean
  session: ParsedSession
}

export interface Filters {
  project?: string
  /** Any of these Projects (a Project Category). */
  projects?: string[]
  family?: string
  account?: string
  /** Last activity at or after this time, ms. */
  since?: number
  scripts?: boolean
}

export interface Outline {
  id: number
  updatedAt: number
  project: string
  account: string
  family: string
}

export interface Match {
  id: number
  /** Higher is better; 1 for a match that has no FTS rank (short words only). */
  relevance: number
}

const COLS = `id, account, account_label AS accountLabel, family, session_id AS sessionId, path, cwd, project,
  cwd_gone AS cwdGone, title, title_from AS titleFrom, first_prompt AS firstPrompt, branch, model,
  started_at AS startedAt, updated_at AS updatedAt, messages, script, parent`

function toRow(r: Record<string, unknown>): SessionRow {
  return { ...(r as unknown as SessionRow), cwdGone: Boolean(r.cwdGone), script: Boolean(r.script) }
}

/** `"word"` for FTS5, with quotes doubled. */
const phrase = (w: string) => `"${w.replaceAll('"', '""')}"`
/** `%word%` for LIKE, with the escape character and wildcards escaped. */
const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** Words a trigram can hold: three characters or more. */
const long = (w: string) => [...w].length >= 3

/** The searchable place of a Session: its Project, folder, branch and Account. */
const placeText = (project: string, cwd: string, branch: string, label: string, account: string) =>
  [project, cwd, branch, label, account].filter(Boolean).join('\n')

const JOURNALS = ['', '-wal', '-shm', '-journal']

/**
 * Why the index folder of `path` may not be used: it is a link, not a folder, or not the current user's. The
 * index never writes or deletes through a link (the folder or the files in it), so it cannot change someone's files.
 */
async function unsafeFolder(path: string): Promise<string | undefined> {
  const dir = dirname(path)
  const st = await lstat(dir).catch(() => undefined)
  if (!st) return undefined
  if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== process.getuid()))
    return `${dir} is a link or not a folder of yours, so sideby does not keep the History Index there; remove it and run the command again`
  return undefined
}

/** Creates `path` at mode 600 if it is missing, refusing a link or anything but a plain file. */
async function plainFile(path: string): Promise<void> {
  for (const suffix of JOURNALS) {
    const st = await lstat(path + suffix).catch(() => undefined)
    if (st && (st.isSymbolicLink() || !st.isFile()))
      throw new Error(
        `${path + suffix} is a link or not a plain file, so sideby leaves it alone; run \`sideby history index --clear\` to remove it`,
      )
  }
  const fh = await openFile(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await fh.chmod(0o600)
  } finally {
    await fh.close()
  }
}

export class HistoryIndex {
  readonly path: string
  readonly keepText: boolean
  readonly db: DatabaseSync
  /** Goes up on every write, so callers can keep what they derived from the index until it changes. */
  version = 0
  #stmts = new Map<string, StatementSync>()

  private constructor(db: DatabaseSync, path: string, keepText: boolean) {
    this.db = db
    this.path = path
    this.keepText = keepText
  }

  /**
   * Opens (and creates or upgrades) the database at `path`, or one in memory for `':memory:'`. With `keepText`
   * false the prompts and replies are not stored. Undefined when this Node has no `node:sqlite` with FTS5.
   */
  static async open(path: string, keepText: boolean): Promise<HistoryIndex | undefined> {
    const mod = await loadSqlite()
    if (!mod) return undefined
    if (path !== ':memory:') {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined)
      const why = await unsafeFolder(path)
      if (why) throw new Error(why)
      await chmod(dirname(path), 0o700)
      // Create the file at mode 600 before SQLite opens it: SQLite gives its journal files the same mode.
      await plainFile(path)
    }
    let db: DatabaseSync
    try {
      db = new mod.DatabaseSync(path)
      db.exec('PRAGMA busy_timeout = 5000')
      let v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (v !== SCHEMA && v !== 0 && path !== ':memory:') {
        // An older database is deleted, not emptied: dropped tables leave their old text in the file's free pages.
        db.close()
        await HistoryIndex.remove(path)
        await plainFile(path)
        db = new mod.DatabaseSync(path)
        db.exec('PRAGMA busy_timeout = 5000')
        v = 0
      }
      if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
      if (v !== SCHEMA) {
        db.exec(`DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS text;`)
        db.exec(`
          CREATE TABLE files(path TEXT PRIMARY KEY, account TEXT NOT NULL, sig TEXT NOT NULL, state TEXT NOT NULL);
          CREATE TABLE sessions(
            id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, account TEXT NOT NULL, account_label TEXT NOT NULL,
            family TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, project TEXT NOT NULL,
            cwd_gone INTEGER NOT NULL, title TEXT NOT NULL, title_from TEXT NOT NULL, first_prompt TEXT NOT NULL,
            branch TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            messages INTEGER NOT NULL, script INTEGER NOT NULL, parent TEXT NOT NULL);
          CREATE INDEX sessions_updated ON sessions(updated_at);
          CREATE INDEX sessions_sid ON sessions(session_id);
          CREATE INDEX sessions_list ON sessions(parent, script, project, updated_at, cwd_gone, family, account);
          CREATE VIRTUAL TABLE text USING fts5(title, place, prompts, replies, tokenize = 'trigram');
          PRAGMA user_version = ${SCHEMA};`)
      }
    } catch {
      return undefined
    }
    return new HistoryIndex(db, path, keepText)
  }

  /** Deletes the database file and its journal files (a link among them is removed, never what it points to). */
  static async remove(path: string): Promise<boolean> {
    const why = await unsafeFolder(path)
    if (why) throw new UserError(why)
    let removed = false
    for (const p of JOURNALS.map((suffix) => path + suffix)) {
      try {
        await rm(p)
        removed = true
      } catch {
        // not there
      }
    }
    return removed
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  #q(sql: string): StatementSync {
    let s = this.#stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.#stmts.set(sql, s)
    }
    return s
  }

  /** The signature each known record file was read at, with its Account. */
  fileSigs(): Map<string, { sig: string; account: string }> {
    const out = new Map<string, { sig: string; account: string }>()
    for (const r of this.#q('SELECT path, sig, account FROM files').all() as {
      path: string
      sig: string
      account: string
    }[])
      out.set(r.path, { sig: r.sig, account: r.account })
    return out
  }

  #dropSession(path: string): void {
    const old = this.#q('SELECT id FROM sessions WHERE path = ?').get(path) as { id: number } | undefined
    if (!old) return
    this.#q('DELETE FROM text WHERE rowid = ?').run(old.id)
    this.#q('DELETE FROM sessions WHERE id = ?').run(old.id)
  }

  /** Stores one record file: its Session, or that it holds none (`session` undefined). */
  put(account: string, path: string, sig: string, input?: SessionInput): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.#dropSession(path)
      this.#q('INSERT OR REPLACE INTO files(path, account, sig, state) VALUES (?, ?, ?, ?)').run(
        path,
        account,
        sig,
        input ? 'ok' : 'empty',
      )
      if (input) {
        const s = input.session
        const time = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0)
        const r = this.#q(
          `INSERT INTO sessions(path, account, account_label, family, session_id, cwd, project, cwd_gone, title,
            title_from, first_prompt, branch, model, started_at, updated_at, messages, script, parent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          path,
          account,
          input.accountLabel,
          input.family,
          s.sessionId,
          s.cwd ?? '',
          input.project,
          input.cwdGone ? 1 : 0,
          s.title ?? '',
          s.titleFrom,
          cutText(s.prompts[0] ?? '', 2000),
          s.branch ?? '',
          s.model ?? '',
          time(s.startedAt),
          time(s.updatedAt) || time(s.startedAt),
          s.messages,
          s.script ? 1 : 0,
          s.parent ?? '',
        )
        this.#q('INSERT INTO text(rowid, title, place, prompts, replies) VALUES (?, ?, ?, ?, ?)').run(
          Number(r.lastInsertRowid),
          s.title ?? '',
          placeText(input.project, s.cwd ?? '', s.branch ?? '', input.accountLabel, input.account),
          this.keepText ? s.prompts.join('\n') : '',
          this.keepText ? s.replies.join('\n') : '',
        )
      }
      this.db.exec('COMMIT')
      this.version++
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Gives each Account's Sessions its current label, in the rows and in the searchable place, where it changed. */
  relabel(labels: ReadonlyMap<string, string>): void {
    const stale = (
      this.#q('SELECT DISTINCT account, account_label AS label FROM sessions').all() as {
        account: string
        label: string
      }[]
    ).filter((r) => labels.has(r.account) && labels.get(r.account) !== r.label)
    if (!stale.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const { account } of stale) {
        const label = labels.get(account)!
        const rows = this.#q('SELECT id, project, cwd, branch FROM sessions WHERE account = ?').all(
          account,
        ) as {
          id: number
          project: string
          cwd: string
          branch: string
        }[]
        this.#q('UPDATE sessions SET account_label = ? WHERE account = ?').run(label, account)
        for (const r of rows)
          this.#q('UPDATE text SET place = ? WHERE rowid = ?').run(
            placeText(r.project, r.cwd, r.branch, label, account),
            r.id,
          )
      }
      this.db.exec('COMMIT')
      this.version++
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Every working directory Sessions were recorded in, with the Project and folder state stored for it. */
  places(): { cwd: string; project: string; gone: boolean }[] {
    return (
      this.#q("SELECT DISTINCT cwd, project, cwd_gone AS gone FROM sessions WHERE cwd != ''").all() as {
        cwd: string
        project: string
        gone: number
      }[]
    ).map((r) => ({ cwd: r.cwd, project: r.project, gone: r.gone === 1 }))
  }

  /** Moves the Sessions recorded in `cwd` under `from` to Project `to`, with the folder state `gone`. */
  moveProject(cwd: string, from: string, to: string, gone: boolean): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#q(
        'SELECT id, branch, account_label AS label, account FROM sessions WHERE cwd = ? AND project = ?',
      ).all(cwd, from) as { id: number; branch: string; label: string; account: string }[]
      this.#q('UPDATE sessions SET project = ?, cwd_gone = ? WHERE cwd = ? AND project = ?').run(
        to,
        gone ? 1 : 0,
        cwd,
        from,
      )
      for (const r of rows)
        this.#q('UPDATE text SET place = ? WHERE rowid = ?').run(
          placeText(to, cwd, r.branch, r.label, r.account),
          r.id,
        )
      this.db.exec('COMMIT')
      this.version++
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Stores that a record file could not be read, so it is tried again only once it changes. */
  putFailed(account: string, path: string, sig: string): void {
    this.#q('INSERT OR REPLACE INTO files(path, account, sig, state) VALUES (?, ?, ?, ?)').run(
      path,
      account,
      sig,
      'fail',
    )
  }

  /** Forgets record files that are gone. */
  remove(paths: Iterable<string>): void {
    const list = [...paths]
    if (!list.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of list) {
        this.#dropSession(p)
        this.#q('DELETE FROM files WHERE path = ?').run(p)
      }
      this.db.exec('COMMIT')
      this.version++
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Sets the Host's own title of an Account's Sessions kept apart from the record (Codex), unless the user named one. */
  setHostTitles(account: string, titles: Map<string, string>): void {
    if (!titles.size) return
    const rows = this.#q(
      "SELECT id, session_id AS sid, title FROM sessions WHERE account = ? AND title_from != 'user'",
    ).all(account) as { id: number; sid: string; title: string }[]
    const changed = rows.filter((r) => {
      const t = titles.get(r.sid)
      return t && t !== r.title
    })
    if (!changed.length) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of changed) {
        const t = titles.get(r.sid)!
        this.#q("UPDATE sessions SET title = ?, title_from = 'host' WHERE id = ?").run(t, r.id)
        this.#q('UPDATE text SET title = ? WHERE rowid = ?').run(t, r.id)
      }
      this.db.exec('COMMIT')
      this.version++
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** SQL for the filters, over the columns `col` names (a table alias, or the parent-or-self of a match). */
  #where(
    f: Filters,
    col: (name: string) => string = (n) => `s.${n}`,
  ): { sql: string; args: (string | number)[] } {
    const parts: string[] = []
    const args: (string | number)[] = []
    if (f.project !== undefined) {
      parts.push(`${col('project')} = ?`)
      args.push(f.project)
    }
    if (f.projects) {
      parts.push(`${col('project')} IN (SELECT value FROM json_each(?))`)
      args.push(JSON.stringify(f.projects))
    }
    if (f.family) {
      parts.push(`${col('family')} = ?`)
      args.push(f.family)
    }
    if (f.account) {
      parts.push(`${col('account')} = ?`)
      args.push(f.account)
    }
    if (f.since) {
      parts.push(`${col('updated_at')} >= ?`)
      args.push(f.since)
    }
    if (!f.scripts) parts.push(`${col('script')} = 0`)
    return { sql: parts.length ? parts.join(' AND ') : '1', args }
  }

  /**
   * Sessions that match every word (in title, place, prompts or replies) and the filters. Words of three characters
   * or more go through the trigram index and are ranked by bm25 (title and place before prompts before replies);
   * shorter ones are matched with LIKE. Subagent Sessions count for their parent (filters then apply to the parent).
   */
  match(words: string[], f: Filters): Match[] {
    const longs = words.filter(long)
    const shorts = words.filter((w) => !long(w))
    const args: (string | number)[] = []
    const conds: string[] = []
    let rank = '1.0'
    if (longs.length) {
      conds.push('text MATCH ?')
      args.push(longs.map(phrase).join(' '))
      rank = '-bm25(text, 6.0, 4.0, 2.0, 1.0)'
    }
    for (const w of shorts) {
      conds.push(
        "(text.title LIKE ? ESCAPE '\\' OR text.place LIKE ? ESCAPE '\\' OR text.prompts LIKE ? ESCAPE '\\' OR text.replies LIKE ? ESCAPE '\\')",
      )
      const l = like(w)
      args.push(l, l, l, l)
    }
    // Lift a matching subagent Session to its parent, and apply the filters to whichever row stands for it.
    const where = this.#where(f, (n) => `coalesce(p.${n}, s.${n})`)
    return this.#q(
      `WITH hits(id, rel) AS MATERIALIZED (SELECT text.rowid, ${rank} FROM text WHERE ${conds.join(' AND ') || '1'})
       SELECT coalesce(p.id, s.id) AS id, max(h.rel) AS relevance
       FROM hits h JOIN sessions s ON s.id = h.id
       LEFT JOIN sessions p ON s.parent != '' AND p.account = s.account AND p.session_id = s.parent AND p.parent = ''
       WHERE ${where.sql} GROUP BY 1`,
    )
      .all(...args, ...where.args)
      .map((r) => {
        const m = r as { id: number; relevance: number }
        return { id: m.id, relevance: Math.max(m.relevance, 1e-6) }
      })
  }

  /** Top-level Sessions matching the filters, newest first. */
  recent(f: Filters, limit: number, offset: number): { rows: SessionRow[]; total: number } {
    const w = this.#where(f)
    const base = `FROM sessions s WHERE s.parent = '' AND ${w.sql}`
    const total = (this.#q(`SELECT count(*) AS n ${base}`).get(...w.args) as { n: number }).n
    const rows = this.#q(`SELECT ${COLS} ${base} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...w.args, limit, offset)
      .map((r) => toRow(r as Record<string, unknown>))
    return { rows, total }
  }

  /** What grouping needs of every top-level Session matching the filters, newest first. */
  outline(f: Filters): Outline[] {
    const w = this.#where(f)
    return this.#q(
      `SELECT id, updated_at AS updatedAt, project, account, family FROM sessions s
       WHERE s.parent = '' AND ${w.sql} ORDER BY s.updated_at DESC, s.id DESC`,
    ).all(...w.args) as unknown as Outline[]
  }

  /** The same for the given Session ids. */
  outlineOf(ids: number[]): Map<number, Outline> {
    const out = new Map<number, Outline>()
    if (!ids.length) return out
    for (const r of this.#q(
      `SELECT id, updated_at AS updatedAt, project, account, family FROM sessions
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as unknown as Outline[])
      out.set(r.id, r)
    return out
  }

  rows(ids: number[]): SessionRow[] {
    if (!ids.length) return []
    return (
      this.#q(`SELECT ${COLS} FROM sessions WHERE id IN (SELECT value FROM json_each(?))`).all(
        JSON.stringify(ids),
      ) as Record<string, unknown>[]
    ).map(toRow)
  }

  /** The stored prompts and replies of a Session, for a snippet. */
  text(id: number): { prompts: string; replies: string } {
    const r = this.#q('SELECT prompts, replies FROM text WHERE rowid = ?').get(id) as
      | { prompts: string; replies: string }
      | undefined
    return r ?? { prompts: '', replies: '' }
  }

  /** How many subagent Sessions each Session (by account and id) started. */
  children(rows: SessionRow[]): Map<number, number> {
    const out = new Map<number, number>()
    for (const r of rows) {
      const n = (
        this.#q("SELECT count(*) AS n FROM sessions WHERE parent = ? AND account = ? AND parent != ''").get(
          r.sessionId,
          r.account,
        ) as { n: number }
      ).n
      if (n) out.set(r.id, n)
    }
    return out
  }

  /** Sessions whose id is `id` or starts with it (eight characters or more). */
  find(id: string): SessionRow[] {
    const exact = this.#q(`SELECT ${COLS} FROM sessions WHERE session_id = ?`).all(id) as Record<
      string,
      unknown
    >[]
    if (exact.length || [...id].length < 8) return exact.map(toRow)
    return (
      this.#q(`SELECT ${COLS} FROM sessions WHERE session_id LIKE ? ESCAPE '\\' LIMIT 20`).all(
        `${id.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      ) as Record<string, unknown>[]
    ).map(toRow)
  }

  /** Record paths of Sessions matching the filters (subagents included), newest first: what a tool-output scan reads. */
  paths(f: Filters): { path: string; sessionId: string; parent: string; account: string; family: string }[] {
    const w = this.#where({ ...f, scripts: true })
    return this.#q(
      `SELECT s.path, s.session_id AS sessionId, s.parent, s.account, s.family FROM sessions s WHERE ${w.sql}
       ORDER BY s.updated_at DESC`,
    ).all(...w.args) as { path: string; sessionId: string; parent: string; account: string; family: string }[]
  }

  /** The row of the Session read from `path`, which stays the same while the row is written again. */
  idOf(path: string): number | undefined {
    return (this.#q('SELECT id FROM sessions WHERE path = ?').get(path) as { id: number } | undefined)?.id
  }

  /** The Session that started `child`, by Account and id. */
  parentOf(account: string, sessionId: string): number | undefined {
    return (
      this.#q('SELECT id FROM sessions WHERE account = ? AND session_id = ?').get(account, sessionId) as
        | { id: number }
        | undefined
    )?.id
  }

  /** Every Project with how many top-level Sessions it has and their last activity. */
  projects(f: Filters): { project: string; sessions: number; updatedAt: number; gone: boolean }[] {
    const w = this.#where({ ...f, project: undefined })
    return (
      this.#q(
        `SELECT project, count(*) AS sessions, max(updated_at) AS updatedAt, min(cwd_gone) AS gone
         FROM sessions s WHERE s.parent = '' AND ${w.sql} GROUP BY project ORDER BY updatedAt DESC`,
      ).all(...w.args) as { project: string; sessions: number; updatedAt: number; gone: number }[]
    ).map((r) => ({ ...r, gone: Boolean(r.gone) }))
  }

  /** Per Account: record files known, Sessions stored, files that could not be read. */
  counts(): Map<string, { files: number; sessions: number; failed: number }> {
    const out = new Map<string, { files: number; sessions: number; failed: number }>()
    for (const r of this.#q(
      `SELECT account, count(*) AS files, sum(state = 'ok') AS sessions, sum(state = 'fail') AS failed
       FROM files GROUP BY account`,
    ).all() as { account: string; files: number; sessions: number; failed: number }[])
      out.set(r.account, { files: r.files, sessions: r.sessions ?? 0, failed: r.failed ?? 0 })
    return out
  }
}
