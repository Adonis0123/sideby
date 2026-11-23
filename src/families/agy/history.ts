// Antigravity CLI's Session History (spec §3.33, ADR-0082): agy lists its conversations in
// `conversation_summaries.db` (SQLite, table `conversation_summaries`) in the Account folder, one row per conversation
// with its title, step count, last change and workspace folders (tried with agy 1.5.14 on 2026-11-23). The
// conversations themselves are binary records in `conversations/<id>.db`, which sideby never opens: a Session is listed
// and found by its title and folder, and `history show` has no messages to show. Subagent conversations
// (`parent_conversation_id` set or `nesting_depth` above 0) and rows without a title are left out.
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSqlite } from '../../core/history-index.ts'
import type { HistoryFile, HistoryMessage, HistoryReader, ParsedSession } from '../history.ts'
import { isoTime, titleFromText } from '../shared/history-text.ts'

const DB = 'conversation_summaries.db'

interface Row {
  conversation_id: string
  title: string
  step_count: number
  last_modified_time: string
  workspace_uris: string
}

const COLUMNS = 'conversation_id, title, step_count, last_modified_time, workspace_uris'
const TOP_LEVEL = "parent_conversation_id = '' AND nesting_depth = 0 AND title <> ''"

/** The rows `list` read last, by record path, so `parse` does not open the database once per Session. */
const lastRows = new Map<string, Row>()

/** Rows of agy's summary database, opened read-only; empty when the file is not there. */
async function readRows(dir: string, where: string, args: string[] = []): Promise<Row[]> {
  const file = join(dir, DB)
  try {
    if (!(await stat(file)).isFile()) return []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const sqlite = await loadSqlite()
  if (!sqlite) return []
  // A read-only open of a WAL database creates its `-wal` and `-shm` files when they are missing, which would write
  // into agy's folder. While agy has them (it is running), they are read as agy left them, to see its newest rows;
  // otherwise the file is opened as `immutable`, which creates nothing (tried with Node 22.23 on 2026-11-23).
  const live = (
    await Promise.all(
      ['-wal', '-shm'].map((x) =>
        stat(file + x).then(
          () => true,
          () => false,
        ),
      ),
    )
  ).every(Boolean)
  let target: string | URL = file
  if (!live) {
    target = pathToFileURL(file)
    target.searchParams.set('immutable', '1')
  }
  const db = new sqlite.DatabaseSync(target, { readOnly: true })
  try {
    return db
      .prepare(`SELECT ${COLUMNS} FROM conversation_summaries WHERE ${where}`)
      .all(...args) as unknown as Row[]
  } finally {
    db.close()
  }
}

/** The key a Session is indexed by: its record file, which is never opened. */
const recordPath = (dir: string, id: string) => join(dir, 'conversations', `${id}.db`)

/** The first local folder of the conversation's workspaces. */
function firstFolder(uris: string): string | undefined {
  try {
    const list: unknown = JSON.parse(uris)
    if (!Array.isArray(list)) return undefined
    for (const u of list) if (typeof u === 'string' && u.startsWith('file://')) return fileURLToPath(u)
  } catch {
    return undefined
  }
  return undefined
}

const plainId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)

export const agyHistory: HistoryReader = {
  family: 'agy',

  async list(account) {
    const out: HistoryFile[] = []
    for (const r of await readRows(account.dir, `${TOP_LEVEL} ORDER BY last_modified_time DESC`)) {
      if (!plainId(r.conversation_id)) continue
      const path = recordPath(account.dir, r.conversation_id)
      const at = Date.parse(r.last_modified_time)
      lastRows.set(path, r)
      out.push({
        path,
        sig: createHash('sha256')
          .update(JSON.stringify([r.title, r.step_count, r.last_modified_time, r.workspace_uris]))
          .digest('hex')
          .slice(0, 32),
        mtimeMs: Number.isFinite(at) ? at : 0,
      })
    }
    return out
  },

  async parse(file, account) {
    const id = basename(file.path, '.db')
    let row = lastRows.get(file.path)
    if (!row) [row] = await readRows(account.dir, `conversation_id = ? AND ${TOP_LEVEL}`, [id])
    if (!row || row.conversation_id !== id) return undefined
    const updatedAt = isoTime(row.last_modified_time)
    const s: ParsedSession = {
      sessionId: id,
      title: titleFromText(row.title),
      titleFrom: 'host',
      messages: 0,
      script: false,
      prompts: [],
      replies: [],
    }
    const cwd = firstFolder(row.workspace_uris)
    if (cwd) s.cwd = cwd
    if (updatedAt) s.updatedAt = updatedAt
    return s
  },

  // The conversation is a binary record sideby does not read.
  async *messages(): AsyncGenerator<HistoryMessage> {},
  async *toolText(): AsyncGenerator<string> {},
}
