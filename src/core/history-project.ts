// The Project of a Session (spec §3.33): the git repository its working directory is in. A worktree's `.git` is a
// file naming `<main>/.git/worktrees/<name>`, so worktrees fold into their main repository. A folder that is gone
// keeps the root the Host recorded, else itself.
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface Project {
  /** The repository root, or the working directory outside a repository. */
  path: string
  /** True when the working directory no longer exists. */
  gone: boolean
}

async function kind(p: string): Promise<'dir' | 'file' | 'none'> {
  try {
    const st = await stat(p)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none'
  } catch {
    return 'none'
  }
}

/** The main repository a worktree's `.git` file points into, when it has the usual `.git/worktrees/<name>` form. */
async function worktreeMain(gitFile: string): Promise<string | undefined> {
  try {
    const text = await readFile(gitFile, 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (!m) return undefined
    const gitdir = resolve(dirname(gitFile), m[1]!.trim())
    const at = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`)
    return at > 0 ? gitdir.slice(0, at) : undefined
  } catch {
    return undefined
  }
}

/** Resolves Projects, remembering each working directory for the life of this object. */
export class ProjectResolver {
  #memo = new Map<string, Promise<Project>>()

  resolve(cwd: string | undefined, hostRoot?: string): Promise<Project> {
    const key = `${cwd ?? ''}\0${hostRoot ?? ''}`
    let p = this.#memo.get(key)
    if (!p) {
      p = this.#find(cwd, hostRoot)
      this.#memo.set(key, p)
    }
    return p
  }

  async #find(cwd: string | undefined, hostRoot?: string): Promise<Project> {
    if (!cwd || !isAbsolute(cwd)) return { path: hostRoot ?? cwd ?? '', gone: false }
    if ((await kind(cwd)) !== 'dir') {
      const root = hostRoot && isAbsolute(hostRoot) ? hostRoot : cwd
      const main =
        (await kind(join(root, '.git'))) === 'file' ? await worktreeMain(join(root, '.git')) : undefined
      return { path: main ?? root, gone: true }
    }
    for (let dir = resolve(cwd); ; ) {
      const git = await kind(join(dir, '.git'))
      if (git === 'dir') return { path: dir, gone: false }
      if (git === 'file') return { path: (await worktreeMain(join(dir, '.git'))) ?? dir, gone: false }
      const up = dirname(dir)
      if (up === dir) return { path: resolve(cwd), gone: false }
      dir = up
    }
  }
}

/** A short name for a Project: its folder name, with as many parent folders as it takes to tell it from another Project of the same name. */
export function projectNames(paths: Iterable<string>): Map<string, string> {
  const byBase = new Map<string, string[]>()
  for (const p of new Set(paths)) {
    const b = basename(p) || p
    byBase.set(b, [...(byBase.get(b) ?? []), p])
  }
  const out = new Map<string, string>()
  for (const [b, list] of byBase) {
    if (list.length === 1) {
      out.set(list[0]!, b)
      continue
    }
    const parts = list.map((p) => p.split(/[\\/]+/).filter(Boolean))
    const tail = (seg: string[], n: number) => seg.slice(-n).join('/')
    for (const [i, p] of list.entries()) {
      const seg = parts[i]!
      let n = 2
      while (n < seg.length && parts.some((o, j) => j !== i && tail(o, n) === tail(seg, n))) n++
      out.set(p, tail(seg, n))
    }
  }
  return out
}
