// Claude Code's own session files (spec §3.32), read one way wherever sideby needs them: the per-process record
// `<dir>/sessions/<pid>.json` that Live Sessions lists and Messages delivers through, and the tail of a session
// transcript (title, permission mode, read receipts). Tried with Claude Code 2.1.304 on 2026-10-20.
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { statOrNull } from '../../core/fs-safe.ts'
import { type ProcessInfo, parseLstart, sameStart } from '../../core/live-sessions-procs.ts'

/** A session record as Claude Code writes it; callers pick only the fields they need. */
export type SessionRecord = Record<string, unknown>

/** Where Claude Code keeps the record of the session process `pid` runs. */
export const sessionRecordPath = (accountDir: string, pid: number): string =>
  join(accountDir, 'sessions', `${pid}.json`)

/** The record at `file`, or null when it cannot be read or is not a JSON object. */
export async function readSessionRecord(file: string): Promise<SessionRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SessionRecord) : null
  } catch {
    return null
  }
}

/** When the record's process started (`procStart`, UTC, in ms), or NaN when it does not say. */
export const recordStart = (rec: SessionRecord): number =>
  parseLstart(typeof rec.procStart === 'string' ? rec.procStart : '')

/**
 * Whether `proc` is the process that wrote the record: the pid may have been reused since, so the record's start
 * time must be readable and match. Without one the record cannot be tied to the process.
 */
export function recordRunsOn(rec: SessionRecord, proc: ProcessInfo | undefined): proc is ProcessInfo {
  const started = recordStart(rec)
  return proc !== undefined && !Number.isNaN(started) && sameStart(proc, started)
}

/** How far back from the end of a transcript sideby looks; Claude Code repeats what it needs as it goes. */
export const TAIL_BYTES = 256 * 1024

/**
 * The lines of the last `TAIL_BYTES` of a file that contain `needle`. The first line is dropped only when the window
 * cuts it, which the byte just before the window tells (anything but a newline).
 */
export async function tailLinesWith(file: string, needle: string): Promise<string[]> {
  const st = await statOrNull(file)
  if (!st?.isFile()) return []
  const fh = await open(file, 'r')
  try {
    const len = Math.min(st.size, TAIL_BYTES)
    const cut = len < st.size ? 1 : 0
    const buf = Buffer.alloc(len + cut)
    await fh.read(buf, 0, len + cut, st.size - len - cut)
    const lines = buf.subarray(cut).toString('utf8').split('\n')
    if (cut && buf[0] !== 0x0a) lines.shift()
    return lines.filter((l) => l.includes(needle))
  } finally {
    await fh.close()
  }
}
