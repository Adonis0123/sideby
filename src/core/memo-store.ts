// Keeps the persisted FileMemos (core/file-memo.ts) in `<stateDir>/cache/file-memo-2.json`, so a new process does not
// parse every session log again: the Panel worker starts cold after each restart, reinstall or language switch,
// and parsing the logs of a busy HOME takes seconds, while reading this file back takes milliseconds.
//
// Several sideby processes share a state directory (a Panel worker, a background Panel, launchers that wait for hours).
// Each one writes only the scopes it read itself since its last write, into what the file holds at that moment, so a
// process that loaded the file long ago never puts its old parses back over newer ones. An older sideby that is still
// running writes the whole of `cache/file-memo.json`; this file has another name, so it cannot undo these merges.
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
  return join(stateDir, 'cache', 'file-memo-2.json')
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

  /** The cache file's memos, or null when it is missing or not one this sideby can read. */
  const readCache = async (): Promise<CacheFile['memos'] | null> => {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheFile>
      return data?.format === FORMAT && data.memos && typeof data.memos === 'object' ? data.memos : null
    } catch {
      return null
    }
  }

  const load = async () => {
    try {
      const memos = await readCache()
      if (!memos) return
      for (const [name, memo] of persistedMemos) {
        const saved = memos[name]
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
    // Taken before the file is read again, so a pass that ends meanwhile counts toward the next write.
    const fresh = [...persistedMemos].map(([name, memo]) => [name, memo, memo.takeFresh()] as const)
    // Memos this process does not know (another sideby's) are kept as they are.
    const out: CacheFile = { format: FORMAT, memos: { ...(await readCache()) } }
    for (const [name, memo, scopes] of fresh) {
      const version = memo.persist?.version ?? 0
      const saved = out.memos[name]
      // A memo of another version is dropped whole, as `load` would.
      const data: MemoDump =
        saved?.version === version && saved.data && typeof saved.data === 'object' ? { ...saved.data } : {}
      Object.assign(data, scopes)
      out.memos[name] = { version, data }
    }
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
