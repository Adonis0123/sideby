// Keeps the persisted FileMemos (core/file-memo.ts) in `<stateDir>/cache/file-memo.json`, so a new process does not
// parse every session log again: the Panel worker starts cold after each restart, reinstall or language switch,
// and parsing the logs of a busy HOME takes seconds, while reading this file back takes milliseconds.
//
// The file holds token counts, session ids and log paths, never a credential; it is written atomically with mode
// 600. Anything unexpected in it (another format, a parse error, a memo version that changed) is ignored and the
// logs are parsed again, which gives the same results.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type MemoDump, persistedMemos } from './file-memo.ts'
import { writeFileAtomic } from './fs-safe.ts'

const FORMAT = 1
/** At most one write per this many milliseconds; a cache a minute old only means re-parsing the newest logs. */
export const SAVE_INTERVAL_MS = 60_000
/** A write waits this long after the last read, so one Panel refresh over every Account is written as a whole. */
export const SAVE_DELAY_MS = 2_000

interface CacheFile {
  format: number
  memos: Record<string, { version: number; data: MemoDump }>
}

export function memoCachePath(stateDir: string): string {
  return join(stateDir, 'cache', 'file-memo.json')
}

export interface MemoStore {
  /** Loads the cache file once; later calls return the same promise. Never rejects. */
  ready(): Promise<void>
  /**
   * Schedules a write SAVE_DELAY_MS after the last call, and no sooner than SAVE_INTERVAL_MS after the previous
   * write. The timer does not keep the process alive, so a short CLI run simply exits without writing.
   */
  saveSoon(): void
  /** Writes the cache now if a memo changed. Never rejects. */
  save(): Promise<void>
}

const stores = new Map<string, MemoStore>()

/** One store per state directory and process. */
export function memoStore(
  stateDir: string,
  now: () => number = Date.now,
  delayMs = SAVE_DELAY_MS,
): MemoStore {
  const known = stores.get(stateDir)
  if (known) return known
  const file = memoCachePath(stateDir)
  let loading: Promise<void> | undefined
  let writing: Promise<void> | undefined
  let lastWrite = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined

  const load = async () => {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile>
      if (data?.format !== FORMAT || !data.memos || typeof data.memos !== 'object') return
      for (const [name, memo] of persistedMemos) {
        const saved = data.memos[name]
        if (saved && saved.version === memo.persist?.version && saved.data && typeof saved.data === 'object')
          memo.restore(saved.data)
      }
    } catch {
      // No cache yet, or an unreadable one: the logs are parsed as before.
    }
  }

  const write = async () => {
    if (![...persistedMemos.values()].some((m) => m.dirty)) return
    lastWrite = now()
    const out: CacheFile = { format: FORMAT, memos: {} }
    for (const [name, memo] of persistedMemos)
      out.memos[name] = { version: memo.persist?.version ?? 0, data: memo.dump() }
    try {
      await mkdir(join(stateDir, 'cache'), { recursive: true, mode: 0o700 })
      await writeFileAtomic(file, JSON.stringify(out))
    } catch {
      // Best effort: a cache that could not be written only means a slower next start.
    }
  }

  const store: MemoStore = {
    ready: () => {
      loading ??= load()
      return loading
    },
    async save() {
      await store.ready()
      while (writing) await writing
      writing = write().finally(() => {
        writing = undefined
      })
      await writing
    },
    saveSoon() {
      if (timer) clearTimeout(timer)
      const wait = Math.max(delayMs, lastWrite + SAVE_INTERVAL_MS - now())
      timer = setTimeout(() => {
        timer = undefined
        void store.save()
      }, wait)
      timer.unref?.()
    },
  }
  stores.set(stateDir, store)
  return store
}

/** Forgets the per-directory stores (for tests). */
export function resetMemoStores(): void {
  stores.clear()
}
