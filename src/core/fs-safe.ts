import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  chmod,
  cp,
  lstat,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p)
  } catch {
    return null
  }
}

export async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

export async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** True when `link` is a symlink whose resolved target is the same file as `target`. */
export async function linksTo(link: string, target: string): Promise<boolean> {
  const st = await lstatOrNull(link)
  if (!st?.isSymbolicLink()) return false
  const [a, b] = await Promise.all([realpathOrNull(link), realpathOrNull(target)])
  return a !== null && a === b
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function fileHash(p: string): Promise<string | null> {
  try {
    return sha256(await readFile(p))
  } catch {
    return null
  }
}

/**
 * Writes via a temp file in the same directory, fsyncs, then renames over `path`.
 * Refuses to write when `path` is a symlink so a write can never pass through a link into another directory.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
  /** Checked after the temp file is complete, right before the rename; false aborts and keeps `path`. */
  beforeRename?: () => Promise<boolean>,
): Promise<boolean> {
  const existing = await lstatOrNull(path)
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${path}`)
  const tmp = join(dirname(path), `.${basename(path)}.sideby-${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'wx', mode)
  try {
    await fh.writeFile(data)
    // Set the final mode before the rename (open's mode is reduced by the umask), so nothing can fail
    // after the target has been replaced.
    await fh.chmod(mode)
    await fh.sync()
  } catch (err) {
    await fh.close()
    await rm(tmp, { force: true })
    throw err
  }
  await fh.close()
  try {
    if (beforeRename && !(await beforeRename())) {
      await rm(tmp, { force: true })
      return false
    }
    await rename(tmp, path)
    return true
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/**
 * Writes only if the file still has `expectedHash` (null = must not exist), checking both before writing and
 * again right before the rename. This narrows, but cannot close, the window in which another program (for
 * example the Host saving the same file) could write in between: plain files offer no compare-and-swap.
 */
export async function writeIfUnchanged(
  path: string,
  expectedHash: string | null,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<boolean> {
  if ((await fileHash(path)) !== expectedHash) return false
  return writeFileAtomic(path, data, mode, async () => (await fileHash(path)) === expectedHash)
}

/**
 * Throws unless `target` stays inside `root` both by name (no `..`) and on disk (no parent directory that is a
 * symlink leading elsewhere), so a repair can never write into another Account or the Main Account.
 */
export async function assertInside(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`refusing to write outside the account directory: ${target}`)
  const rootReal = (await realpathOrNull(root)) ?? root
  let dir = dirname(target)
  while (!(await lstatOrNull(dir))) {
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  const real = (await realpathOrNull(dir)) ?? dir
  if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`))
    throw new Error(
      `refusing to write outside the account directory: ${target} (a parent directory is a link)`,
    )
}

/** JSON.parse whose error never quotes the input: parse errors from Node include a slice of the text. */
export function parseJsonSafely(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

/** Recursive comparison of files, directories and symlink targets. Modes and times are ignored. */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)])
  if (!sa || !sb) return false
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    if (!(sa.isSymbolicLink() && sb.isSymbolicLink())) return false
    return (await readlink(a)) === (await readlink(b))
  }
  if (sa.isFile() && sb.isFile()) {
    if (sa.size !== sb.size) return false
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
    return ba.equals(bb)
  }
  if (sa.isDirectory() && sb.isDirectory()) {
    const [ea, eb] = await Promise.all([readdir(a), readdir(b)])
    if (ea.length !== eb.length) return false
    ea.sort()
    eb.sort()
    for (let i = 0; i < ea.length; i++) {
      if (ea[i] !== eb[i]) return false
      if (!(await sameContent(join(a, ea[i]!), join(b, eb[i]!)))) return false
    }
    return true
  }
  return false
}

/**
 * Copies `src` (resolving it if it is a symlink) to `dst`, keeping modes, hidden files and nested symlinks.
 * Builds the copy beside `dst` and swaps it in, so a failure leaves the old `dst` untouched.
 * Refuses when `dst` is a symlink: callers must remove links explicitly.
 */
export async function replaceWithCopy(src: string, dst: string): Promise<void> {
  const existing = await lstatOrNull(dst)
  if (existing?.isSymbolicLink()) throw new Error(`refusing to copy over a symlink: ${dst}`)
  const source = (await realpathOrNull(src)) ?? src
  const tmp = join(dirname(dst), `.${basename(dst)}.sideby-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await cp(source, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
    })
  } catch (err) {
    await rm(tmp, { recursive: true, force: true })
    throw err
  }
  if (!existing) {
    await rename(tmp, dst)
    return
  }
  const old = `${tmp}.old`
  await rename(dst, old)
  try {
    await rename(tmp, dst)
  } catch (err) {
    await rename(old, dst)
    await rm(tmp, { recursive: true, force: true })
    throw err
  }
  await rm(old, { recursive: true, force: true })
}

export async function isEmptyDir(p: string): Promise<boolean> {
  try {
    return (await readdir(p)).length === 0
  } catch {
    return false
  }
}

export function permBits(st: Stats): number {
  return st.mode & 0o777
}
