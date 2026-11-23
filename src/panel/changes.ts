// The Panel's change feed (spec §3.45, ADR-0084): while a page asks, watch the files Quota lands in and count their
// changes, so the page reads the state within about a second instead of at its next 20-second round. Events only bump
// a counter: no watched file is ever read here.
import { type FSWatcher, statSync, watch } from 'node:fs'
import { join } from 'node:path'

export interface WatchDir {
  dir: string
  recursive: boolean
  /** The changed name (relative to `dir`) that counts. An event without a name always counts. */
  match: { test(name: string): boolean }
  /** At most one change every this many ms from this folder. */
  gapMs: number
}

/** What `GET /api/changes` answers. */
export interface ChangeAnswer {
  seq: number
  /** The count differs from the `since` the page sent. */
  changed: boolean
  /** Some folder is watched; false means the page keeps to its poll. */
  watching: boolean
}

/** How long after the first event a change counts: an atomic write (temporary file, then rename) counts once. */
export const GATHER_MS = 300
/** How long a request with nothing new is held. */
export const HOLD_MS = 25_000
/** Watchers close this long after the last request: the page asks again at once, so only a gone page is this quiet. */
export const IDLE_MS = 40_000
/** How often the folders are listed again while a page asks (a new Account, a folder made since). */
const RESCAN_MS = 60_000
/** With several sessions open the status line rewrites its cache on every reply; each change rereads every Account. */
const QUOTA_GAP_MS = 5000
/** sideby's own churn under `<state>/quota`: ask locks, the folder `claude -p /usage` runs in, Limit Reset records. */
const OWN = new Set(['asking', 'claude-run', 'limit-reset'])

/** `<state>/quota`: the status line cache and the kept answers of each Host's own CLI. */
export function stateQuotaDir(stateDir: string): WatchDir {
  return {
    dir: join(stateDir, 'quota'),
    recursive: true,
    match: {
      test: (name) => {
        const parts = name.split(/[\\/]/)
        const base = parts[parts.length - 1] ?? ''
        return base.endsWith('.json') && !base.startsWith('.') && !OWN.has(parts[0] ?? '')
      },
    },
    gapMs: QUOTA_GAP_MS,
  }
}

interface Timers {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(t: unknown): void
}
const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms).unref(),
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
}

/**
 * Turns events into counted changes: one `GATHER_MS` after the first event, and never sooner than `gapMs` (the
 * event's folder) after the last one. Events meanwhile join that change; one whose folder allows an earlier time
 * brings it forward.
 */
export function changeClock(fire: () => void, timers: Timers = realTimers) {
  let last = Number.NEGATIVE_INFINITY
  let due: number | null = null
  let timer: unknown
  return {
    poke(gapMs: number): void {
      const at = timers.now()
      const want = Math.max(at + GATHER_MS, last + gapMs)
      if (due !== null && due <= want) return
      if (due !== null) timers.clear(timer)
      due = want
      timer = timers.set(() => {
        due = null
        last = timers.now()
        fire()
      }, want - at)
    },
    stop(): void {
      if (due !== null) timers.clear(timer)
      due = null
    },
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The feed of one Panel. `dirs` lists what to watch; `onChange` runs once per counted change, before held requests
 * are answered.
 */
export function createChangeFeed(opts: { dirs: () => Promise<WatchDir[]>; onChange?: () => void }) {
  let seq = 0
  const waiters = new Set<() => void>()
  const watchers = new Map<string, FSWatcher>()
  let lastAsk = 0
  let lastScan = 0
  let scanning: Promise<void> | null = null
  let idle: NodeJS.Timeout | undefined
  const clock = changeClock(() => {
    seq++
    opts.onChange?.()
    for (const done of [...waiters]) done()
  })

  function closeAll(): void {
    for (const w of watchers.values()) w.close()
    watchers.clear()
    clock.stop()
    lastScan = 0
    if (idle) clearInterval(idle)
    idle = undefined
  }

  async function scan(): Promise<void> {
    lastScan = Date.now()
    const dirs = await opts.dirs().catch(() => [] as WatchDir[])
    const want = new Map(dirs.map((d) => [`${d.recursive ? 'r' : 'f'}\0${d.dir}`, d]))
    for (const [key, w] of watchers)
      if (!want.has(key)) {
        w.close()
        watchers.delete(key)
      }
    for (const [key, d] of want) {
      if (watchers.has(key) || !isDir(d.dir)) continue
      // A platform without recursive watching, or a folder that cannot be watched, is left out: the page polls.
      try {
        const w = watch(d.dir, { recursive: d.recursive, persistent: false }, (_event, name) => {
          if (name === null || d.match.test(String(name))) clock.poke(d.gapMs)
        })
        // Unhandled, a watcher's error would end the process (a Portal's worker with it).
        w.on('error', () => {
          w.close()
          if (watchers.get(key) === w) watchers.delete(key)
        })
        watchers.set(key, w)
      } catch {}
    }
  }

  async function ensure(): Promise<void> {
    if (!idle) {
      idle = setInterval(() => {
        if (!waiters.size && Date.now() - lastAsk > IDLE_MS) closeAll()
      }, 10_000).unref()
    }
    if (!scanning && (!lastScan || Date.now() - lastScan > RESCAN_MS))
      scanning = scan().finally(() => {
        scanning = null
      })
    if (scanning) await scanning
  }

  return {
    /**
     * The answer for a page that last saw `since` (null: none yet). Held up to `HOLD_MS` while nothing changed, or
     * until `gone` settles (the request closed).
     */
    async wait(since: number | null, gone: Promise<unknown>): Promise<ChangeAnswer> {
      lastAsk = Date.now()
      await ensure()
      const now = (): ChangeAnswer => ({
        seq,
        changed: since !== null && since !== seq,
        watching: watchers.size > 0,
      })
      if (since === null || since !== seq || !watchers.size) return now()
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          waiters.delete(done)
          lastAsk = Date.now()
          resolve(now())
        }
        const timer = setTimeout(done, HOLD_MS).unref()
        waiters.add(done)
        void gone.then(done, done)
      })
    },
    /** For tests: closes every watcher now. */
    close: closeAll,
  }
}
