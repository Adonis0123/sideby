// Remembers what a reader parsed out of a file until the file changes. Usage readers scan many session logs on
// every Panel refresh; most of them are untouched since the last scan, so their parsed form is reused. A file
// counts as unchanged while its size, mtime, ctime and inode all match (ctime moves on every write, even one that
// restores the mtime). Results stay exactly what a full parse gives: only the parse of one file is reused, and
// the reader still combines the files with the current time.
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

export class FileMemo<T> {
  readonly #scopes = new Map<string, Map<string, { sig: string; value: T }>>()
  /** Counters for tests and timing. */
  readonly stats = { hits: 0, misses: 0 }

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
        this.#scopes.set(scope, seen)
      },
    }
  }

  /** Files remembered for a scope (for tests). */
  size(scope: string): number {
    return this.#scopes.get(scope)?.size ?? 0
  }

  clear(): void {
    this.#scopes.clear()
    this.stats.hits = 0
    this.stats.misses = 0
  }
}
