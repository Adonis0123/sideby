// Pick Records (spec §3.13 "分摊选号", ADR-0083): a short-lived note in sideby's state directory that a pick just
// started an Account, so picks made at the same moment do not all land on one Account. A pick that starts something
// holds one lock across counting Live Sessions, ranking and writing its record; a preview only reads.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-safe.ts'
import { type PickRecord, pickRecordFresh } from './handoff.ts'
import { type ReleaseLock, takeFileLock } from './lock.ts'

const DIR = 'picks'
const FILE = 'records.json'
/** Counting Live Sessions takes about half a second; a holder that stopped frees the lock within seconds. */
const LOCK = { staleMs: 10_000, beatMs: 2_000, maxMs: 60_000 }
/** How long a pick waits for another one to finish before it goes on without the lock. */
const WAIT_MS = 5_000

const isRecord = (r: unknown): r is PickRecord =>
  typeof r === 'object' &&
  r !== null &&
  typeof (r as PickRecord).ref === 'string' &&
  typeof (r as PickRecord).at === 'string' &&
  Number.isFinite((r as PickRecord).liveAtPick)

/** The Pick Records whose time still counts (`pickRecordFresh`); a missing or unreadable file is none. */
export async function readPickRecords(stateDir: string, now: Date): Promise<PickRecord[]> {
  let list: unknown
  try {
    list = JSON.parse(await readFile(join(stateDir, DIR, FILE), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list.filter(isRecord).filter((r) => pickRecordFresh(r.at, now))
}

async function takePickLock(stateDir: string, waitMs = WAIT_MS): Promise<ReleaseLock | null> {
  const dir = join(stateDir, DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return takeFileLock(join(dir, 'pick.lock'), { ...LOCK, wait: { timeoutMs: waitMs, pollMs: 50 } })
}

/** What a pick that starts something writes: its record, and the records that still count beside it. */
export interface PickStart {
  ref: string
  liveAtPick: number
  /**
   * The records that still count (`activePicks`); the rest, arrived or expired, are dropped from the file, so a record
   * whose Session arrived never counts again when an older Session of that login ends. Left out: all fresh ones stay.
   */
  keep?: readonly PickRecord[]
}

/**
 * One pick. `rank` gets the Pick Records and ranks; with `record`, `started` names the Account the caller will start
 * (with its login's load now, `loginLoad`), and its record is written before the lock is let go, then given to
 * `written`. Without `record` nothing is written. A lock that stays busy, or a file that cannot be written, never
 * stops a start: it picks from what it read and writes nothing, so it never puts back an older list over a record
 * another pick wrote meanwhile. The clock is read once the lock is held, so a pick that waited sees its peer's record.
 */
export async function withPickRecords<T>(
  stateDir: string,
  clock: () => Date,
  record: boolean,
  rank: (picks: readonly PickRecord[], now: Date) => Promise<T>,
  started: (result: T, picks: readonly PickRecord[], now: Date) => PickStart | null,
  written?: (rec: PickRecord) => void,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const release = record ? await takePickLock(stateDir, opts.waitMs).catch(() => null) : null
  try {
    const now = clock()
    const picks = await readPickRecords(stateDir, now)
    const result = await rank(picks, now)
    const start = release ? started(result, picks, now) : null
    if (start) {
      const rec = { ref: start.ref, at: now.toISOString(), liveAtPick: start.liveAtPick }
      const next = [...(start.keep ?? picks), rec]
      if (await writeFileAtomic(join(stateDir, DIR, FILE), `${JSON.stringify(next)}\n`).catch(() => false))
        written?.(rec)
    }
    return result
  } finally {
    await release?.()
  }
}

/**
 * Takes back a record whose start did not happen (the user stayed, the terminal did not open), so it does not count
 * for two minutes. Without the lock it leaves the file alone: the record then expires by itself.
 */
export async function dropPickRecord(stateDir: string, rec: PickRecord): Promise<void> {
  const release = await takePickLock(stateDir).catch(() => null)
  if (!release) return
  try {
    const picks = await readPickRecords(stateDir, new Date())
    const next = picks.filter((r) => !(r.ref === rec.ref && r.at === rec.at))
    if (next.length !== picks.length)
      await writeFileAtomic(join(stateDir, DIR, FILE), `${JSON.stringify(next)}\n`).catch(() => false)
  } finally {
    await release()
  }
}
