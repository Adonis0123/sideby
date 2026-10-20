// Claude Code's Live Sessions (spec §3.32): one `<dir>/sessions/<pid>.json` per running session, written by Claude
// Code itself (tried with Claude Code 2.1.304 on 2026-10-20). A file whose process is gone, or whose pid now belongs
// to another process (`procStart` differs), is skipped and left in place.
import { open, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { statOrNull } from '../../core/fs-safe.ts'
import type { LiveSessionStatus } from '../../core/live-sessions.ts'
import { isoOf, parseLstart, sameStart } from '../../core/live-sessions-procs.ts'
import type { LiveSessionReader, RawLiveSession } from '../live-sessions.ts'

const PID_FILE = /^(\d+)\.json$/

/** Claude Code's `status`: `busy` and `shell` run, `idle` waits for a prompt, a blocked one waits for the user. */
export function claudeStatus(s: unknown): LiveSessionStatus {
  if (typeof s !== 'string') return 'unknown'
  if (s === 'busy' || s === 'shell') return 'busy'
  if (s === 'idle') return 'idle'
  if (/blocked|wait|permission|input|approv/i.test(s)) return 'needs-you'
  return 'unknown'
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The transcript Claude Code writes for a session: `projects/<cwd with every other character as ->/<id>.jsonl`. */
export const claudeTranscript = (dir: string, cwd: string, id: string): string =>
  join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)

/** How far back from the end of a transcript `claudeAiTitle` looks; Claude Code repeats the title as it goes. */
const TITLE_TAIL_BYTES = 256 * 1024
const titleMemo = new Map<string, { sig: string; title: string | undefined }>()

/**
 * The title Claude Code gave the session itself (the one it shows as the terminal tab title): the last `ai-title`
 * record near the end of the transcript. Only lines of that type are parsed; nothing else of the conversation is read
 * into a result. Remembered until the file changes.
 */
export async function claudeAiTitle(transcript: string): Promise<string | undefined> {
  const st = await statOrNull(transcript)
  if (!st?.isFile()) return undefined
  const sig = `${st.size}:${st.mtimeMs}`
  const known = titleMemo.get(transcript)
  if (known?.sig === sig) return known.title
  let title: string | undefined
  const fh = await open(transcript, 'r')
  try {
    const len = Math.min(st.size, TITLE_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0 && !title; i--) {
      const line = lines[i]!
      if (!line.includes('"ai-title"')) continue
      try {
        const rec = JSON.parse(line) as Record<string, unknown>
        if (rec.type === 'ai-title') title = str(rec.aiTitle)?.trim() || undefined
      } catch {
        // a line cut by the tail window or still being written
      }
    }
  } finally {
    await fh.close()
  }
  titleMemo.set(transcript, { sig, title })
  return title
}

export const claudeLiveSessions: LiveSessionReader = {
  family: 'claude',
  async read(account, procs, problems) {
    const root = join(account.dir, 'sessions')
    let names: string[]
    try {
      names = await readdir(root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: RawLiveSession[] = []
    for (const name of names) {
      const m = PID_FILE.exec(name)
      if (!m) continue
      const pid = Number(m[1])
      const proc = await procs.get(pid)
      if (!proc) continue
      const file = join(root, name)
      let rec: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        rec = parsed as Record<string, unknown>
      } catch {
        problems.push(
          `${account.ref}: could not read ${file}; it is skipped (Claude Code rewrites it as it runs)`,
        )
        continue
      }
      const sessionId = str(rec.sessionId)
      if (!sessionId) continue
      // The pid may have been reused since: `procStart` is when Claude Code's own process started (UTC). Without
      // a start time to compare, the file cannot be tied to this process, so it is left out.
      const started = parseLstart(str(rec.procStart) ?? '')
      if (Number.isNaN(started)) {
        problems.push(
          `${account.ref}: ${file} has no start time sideby can read, so it cannot tell whether process ${pid} still runs that session and leaves it out; an update of Claude Code writes it again`,
        )
        continue
      }
      if (!sameStart(proc, started)) continue
      const cwd = str(rec.cwd)
      const candidate = cwd ? claudeTranscript(account.dir, cwd, sessionId) : undefined
      const transcript = candidate && (await statOrNull(candidate)) ? candidate : undefined
      // A name the user gave (`/rename`, `-n`) wins; a derived one (`<dir>-3f`) loses to Claude Code's own title.
      const named = rec.nameSource !== 'derived' ? str(rec.name) : undefined
      const aiTitle =
        named || !transcript ? undefined : await claudeAiTitle(transcript).catch(() => undefined)
      const title = named ?? aiTitle ?? str(rec.name) ?? (cwd ? basename(cwd) : undefined)
      out.push({
        sessionId,
        ...(title ? { title } : {}),
        status: claudeStatus(rec.status),
        ...(cwd ? { cwd } : {}),
        pid,
        ...(isoOf(num(rec.startedAt)) ? { startedAt: isoOf(num(rec.startedAt)) } : {}),
        ...(isoOf(num(rec.updatedAt) ?? num(rec.statusUpdatedAt))
          ? { updatedAt: isoOf(num(rec.updatedAt) ?? num(rec.statusUpdatedAt)) }
          : {}),
        guessed: false,
        ...(transcript ? { transcript } : {}),
      })
    }
    return out
  },
}
