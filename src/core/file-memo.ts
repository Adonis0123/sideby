// Remembers what a reader parsed out of a file until the file changes. Usage readers scan many session logs on
// every Panel refresh; most of them are untouched since the last scan, so their parsed form is reused. A file
// counts as unchanged while its size, mtime, ctime and inode all match (ctime moves on every write, even one that
// restores the mtime). Results stay exactly what a full parse gives: only the parse of one file is reused, and
// the reader still combines the files with the current time.
//
// A memo created with `persist` is also kept on disk by core/memo-store.ts, so a new process (a Panel worker after
// a restart) starts warm instead of parsing every log again.
import type { Stats } from 'node:fs'

/** The parts of `fs.Stats` that tell whether a file changed. */
export type FileStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino'>

export function fileSignature(st: FileStats): string {
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
}

/** One pass over a scope's files. Files the pass does not ask for are forgotten when it ends. */
export interface MemoPass<T> {
  /** The remembered value for this file version, or `parse()` (remembered unless `keep` says no). */
  get(path: string, st: FileStats, parse: () => Promise<T>, keep?: (value: T) => boolean): Promise<T>
  /** Ends the pass: the scope now holds only the files this pass asked for. */
  done(): void
}

/**
 * How a memo is kept on disk. `name` is its key in the cache file; bump `version` whenever the parsed value's shape
 * or meaning changes, so a cache written by an older sideby is dropped instead of misread.
 */
export interface MemoPersist {
  name: string
  version: number
}

/** A memo as stored on disk: per scope, per file, the signature and the parsed value. */
export type MemoDump = Record<string, Record<string, [sig: string, value: unknown]>>

/** Every memo created with `persist`, by name. */
export const persistedMemos = new Map<string, FileMemo<unknown>>()

export class FileMemo<T> {
  readonly #scopes = new Map<string, Map<string, { sig: string; value: T }>>()
  /** Counters for tests and timing. */
  readonly stats = { hits: 0, misses: 0 }
  /** True when a pass changed what is remembered since the last `dump`. */
  dirty = false
  readonly persist?: MemoPersist

  constructor(persist?: MemoPersist) {
    if (!persist) return
    this.persist = persist
    persistedMemos.set(persist.name, this as FileMemo<unknown>)
  }

  /** Starts a pass over `scope`, such as one Account's directory. */
  pass(scope: string): MemoPass<T> {
    const before = this.#scopes.get(scope)
    const seen = new Map<string, { sig: string; value: T }>()
    return {
      get: async (path, st, parse, keep) => {
        const sig = fileSignature(st)
        const hit = seen.get(path) ?? before?.get(path)
        if (hit && hit.sig === sig) {
          this.stats.hits++
          seen.set(path, hit)
          return hit.value
        }
        this.stats.misses++
        const value = await parse()
        if (!keep || keep(value)) seen.set(path, { sig, value })
        return value
      },
      done: () => {
        if (!before || before.size !== seen.size || [...seen].some(([k, v]) => before.get(k) !== v))
          this.dirty = true
        this.#scopes.set(scope, seen)
      },
    }
  }

  /** What is remembered, for the cache file; clears `dirty`. */
  dump(): MemoDump {
    this.dirty = false
    const out: MemoDump = {}
    for (const [scope, files] of this.#scopes)
      out[scope] = Object.fromEntries([...files].map(([path, e]) => [path, [e.sig, e.value]]))
    return out
  }

  /**
   * Takes remembered parses from the cache file for scopes this process has not read yet. The values are trusted
   * to have the shape `persist.version` stands for; a stale one never matches, because its signature differs.
   */
  restore(data: MemoDump): void {
    for (const [scope, files] of Object.entries(data)) {
      if (this.#scopes.has(scope) || !files || typeof files !== 'object') continue
      const map = new Map<string, { sig: string; value: T }>()
      for (const [path, entry] of Object.entries(files))
        if (Array.isArray(entry) && typeof entry[0] === 'string')
          map.set(path, { sig: entry[0], value: entry[1] as T })
      this.#scopes.set(scope, map)
    }
  }

  /** Files remembered for a scope (for tests). */
  size(scope: string): number {
    return this.#scopes.get(scope)?.size ?? 0
  }

  clear(): void {
    this.#scopes.clear()
    this.dirty = false
    this.stats.hits = 0
    this.stats.misses = 0
  }
}
