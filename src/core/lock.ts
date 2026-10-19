// Lock files: who holds one, how the holder shows it is still alive, and when a lock counts as left behind.
// A lock is a file created exclusively (mode 600) holding `<pid> <ms since epoch>`. Its holder touches it every
// `beatMs`; a lock nobody touched for `staleMs` is free even while its pid runs, because a Portal that ends the worker
// thread holding it leaves a process (the same pid) that lives on. A dead pid frees it at once.
import { readFileSync } from 'node:fs'
import { type FileHandle, open, readFile, rm, stat } from 'node:fs/promises'

export interface FileLockOptions {
  /** A lock its holder has not touched for this long is free, whether or not its pid runs. */
  staleMs: number
  /** How often the holder touches its lock. Keep it well under `staleMs`. */
  beatMs: number
  /** A lock older than this is free even when touched: its pid may since belong to another process. Default: none. */
  maxMs?: number
  /** How long an empty or unreadable lock counts as held (its owner may still be writing it). Default: `staleMs`. */
  writeGraceMs?: number
  /** Whether a pid runs. Default: `processAlive`. */
  alive?: (pid: number) => boolean
  /** Milliseconds since epoch, for the lock's content and its age. Default: `Date.now`. */
  now?: () => number
  /** Wait for a held lock, checking every `pollMs`, up to `timeoutMs`. Without it a held lock gives null at once. */
  wait?: { timeoutMs: number; pollMs: number }
}

/** Stops the heartbeat and removes the lock, only while it still holds this holder's content. */
export type ReleaseLock = () => Promise<void>

/** Whether a Linux `/proc/<pid>/stat` line is of a zombie: the state after the parenthesised command name is `Z`. */
export function isZombieStat(line: string): boolean {
  return /\)\s+Z\s/.test(line.slice(line.lastIndexOf(')')))
}

/** Whether `pid` runs. A zombie (exited, nobody waited for it) answers signal 0 on Linux but holds nothing. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
  try {
    return !isZombieStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true // no /proc (macOS): signal 0 is the answer
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Takes the lock `file` (its directory must exist). Returns its release function, or null when another holder keeps
 * it (after waiting, with `wait`). Errors other than the file existing are thrown.
 */
export async function takeFileLock(file: string, opts: FileLockOptions): Promise<ReleaseLock | null> {
  const now = opts.now ?? Date.now
  const deadline = opts.wait ? now() + opts.wait.timeoutMs : 0
  for (;;) {
    const release = await tryTake(file, opts, now)
    if (release || !opts.wait || now() >= deadline) return release
    await sleep(opts.wait.pollMs)
  }
}

async function tryTake(file: string, opts: FileLockOptions, now: () => number): Promise<ReleaseLock | null> {
  const alive = opts.alive ?? processAlive
  const grace = opts.writeGraceMs ?? opts.staleMs
  for (let attempt = 0; attempt < 2; attempt++) {
    const me = `${process.pid} ${now()}`
    try {
      const fh = await open(file, 'wx', 0o600)
      try {
        await fh.writeFile(me)
      } catch (err) {
        await fh.close().catch(() => {})
        throw err
      }
      return hold(file, fh, me, opts.beatMs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    // Judging and removing a lock left behind happen under the guard: two takers that both judged it stale would
    // otherwise let the slower one remove the lock the faster one has just made.
    const freed = await guarded(file, async () => {
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) return true
      const m = /^(\d+) (\d+)$/.exec(text)
      // The file's time is the real clock's; `now` may be swapped, so the lock's age in touches uses the real one.
      const sinceTouch = Date.now() - ((await stat(file).catch(() => null))?.mtimeMs ?? 0)
      const held = m
        ? alive(Number(m[1])) &&
          (opts.maxMs === undefined || now() - Number(m[2]) < opts.maxMs) &&
          sinceTouch < opts.staleMs
        : sinceTouch < grace
      if (held) return false
      await rm(file, { force: true })
      return true
    })
    if (!freed) return null
  }
  return null
}

/** A guard older than this was left by a holder that stopped; nothing holds the guard for more than a few file calls. */
const GUARD_STALE_MS = 5000

/**
 * Runs `fn` while holding `<file>.guard`, a lock only for the read, the judgement and the removal of `file`. Waits up
 * to a second for it; false (nothing run) when it stays busy.
 */
async function guarded(file: string, fn: () => Promise<boolean>): Promise<boolean> {
  const guard = `${file}.guard`
  for (let i = 0; i < 200; i++) {
    try {
      const fh = await open(guard, 'wx', 0o600)
      await fh.close()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = Date.now() - ((await stat(guard).catch(() => null))?.mtimeMs ?? Date.now())
      if (age > GUARD_STALE_MS) await rm(guard, { force: true })
      else await sleep(5)
      continue
    }
    try {
      return await fn()
    } finally {
      await rm(guard, { force: true })
    }
  }
  return false
}

/**
 * Holds the lock through its open handle: the heartbeat touches that file, so a holder whose lock was taken over (and
 * removed) touches only its own removed file, never the lock that replaced it.
 */
function hold(file: string, fh: FileHandle, me: string, beatMs: number): ReleaseLock {
  const beat = setInterval(() => {
    const at = new Date()
    fh.utimes(at, at).catch(() => {})
  }, beatMs)
  beat.unref()
  let released = false
  return async () => {
    if (released) return
    released = true
    clearInterval(beat)
    await fh.close().catch(() => {})
    const remove = async () => {
      if ((await readFile(file, 'utf8').catch(() => '')) === me) await rm(file, { force: true })
      return true
    }
    // Under the guard, so a taker cannot replace the lock between the read and the removal. Without it (busy for a
    // second) the lock stays: its heartbeat has stopped, so it is free once `staleMs` has passed.
    await guarded(file, remove).catch(() => false)
  }
}
