// Grok Build's Live Sessions (spec §3.32): `<dir>/active_sessions.json` lists each running session with its pid and
// the process start time in microseconds (tried with Grok Build on 2026-10-20). The title is Grok's own
// `generated_title` from the session's `summary.json`.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { statOrNull } from '../../core/fs-safe.ts'
import { sameStart } from '../../core/live-sessions-procs.ts'
import type { LiveSessionReader, RawLiveSession } from '../live-sessions.ts'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** A session's own directory: `sessions/<encoded cwd>/<id>/`. */
export const grokSessionDir = (dir: string, cwd: string, id: string): string =>
  join(dir, 'sessions', encodeURIComponent(cwd), id)

async function summaryOf(sessionDir: string): Promise<Record<string, unknown>> {
  try {
    const s: unknown = JSON.parse(await readFile(join(sessionDir, 'summary.json'), 'utf8'))
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export const grokLiveSessions: LiveSessionReader = {
  family: 'grok',
  async read(account, procs, problems) {
    const file = join(account.dir, 'active_sessions.json')
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let list: unknown
    try {
      list = JSON.parse(raw)
    } catch {
      problems.push(
        `${account.ref}: could not read ${file}; Grok Build rewrites it when a session starts or ends`,
      )
      return []
    }
    if (!Array.isArray(list)) return []
    const out: RawLiveSession[] = []
    for (const e of list as Record<string, unknown>[]) {
      const sessionId = str(e?.session_id)
      const pid = typeof e?.pid === 'number' ? e.pid : undefined
      if (!sessionId || pid === undefined) continue
      const proc = await procs.get(pid)
      if (!proc) continue
      // The pid may have been reused since; without a start time the entry cannot be tied to this process.
      if (typeof e.pid_start !== 'number' || !Number.isFinite(e.pid_start)) {
        problems.push(
          `${account.ref}: an entry of ${file} has no start time, so sideby cannot tell whether process ${pid} still runs session ${sessionId.slice(0, 8)} and leaves it out; Grok Build writes it again when the session restarts`,
        )
        continue
      }
      if (!sameStart(proc, e.pid_start / 1000)) continue
      const cwd = str(e.cwd)
      const sessionDir = cwd ? grokSessionDir(account.dir, cwd, sessionId) : undefined
      const summary = sessionDir ? await summaryOf(sessionDir) : {}
      const title =
        str(summary.generated_title) ?? str(summary.session_summary) ?? (cwd ? basename(cwd) : undefined)
      const opened = str(e.opened_at)
      const updated = str(summary.updated_at) ?? str(summary.last_active_at) ?? opened
      const transcript = sessionDir ? join(sessionDir, 'chat_history.jsonl') : undefined
      out.push({
        sessionId,
        ...(title ? { title } : {}),
        status: 'unknown',
        ...(cwd ? { cwd } : {}),
        pid,
        ...(opened ? { startedAt: opened } : {}),
        ...(updated ? { updatedAt: updated } : {}),
        guessed: false,
        ...(transcript && (await statOrNull(transcript)) ? { transcript } : {}),
      })
    }
    return out
  },
}
