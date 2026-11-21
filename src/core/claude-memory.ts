// Shared Project Memory (spec §3.44, ADR-0081). Claude Code keeps auto memory per config directory, at
// `<config dir>/projects/<project>/memory/`, so every Claude Account holds its own copy for the same Project. With
// config `claude.shareMemory` on, a Launch names the Main Account's real folder for the Project as
// `autoMemoryDirectory` (through sideby's own `--settings` file, `memoryHookPart`), and Doctor folds what an Account
// wrote on its own (sessions sideby did not start) into the Main Account.
//
// Nothing here follows a link out of an Account folder or into the Main Account: a link anywhere on the way is
// reported and left alone. Nothing is deleted: a folder that was emptied goes to the system trash, or into sideby's
// state folder when there is no trash sideby may use.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  utimes,
} from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, extname, join, posix } from 'node:path'
import { claudeProjectDirName } from '../families/claude/layout.ts'
import { readSessionRecord, recordRunsOn, recordStart } from '../families/claude/session-files.ts'
import type { Account, CheckResult, Env, Finding, FixResult } from '../types.ts'
import { trustRoot } from './claude-trust.ts'
import {
  assertInside,
  lstatOrNull,
  ownedFolder,
  readSmallFile,
  sha256,
  writeFileAtomic,
  writeIfUnchanged,
} from './fs-safe.ts'
import type { ProcessView } from './live-sessions-procs.ts'
import type { SessionHookPart } from './session-hooks.ts'

/** The index Claude Code keeps in each memory folder. */
export const MEMORY_INDEX = 'MEMORY.md'

/** An index larger than this is not read or merged. */
const MAX_INDEX_BYTES = 1024 * 1024

/** Folders sideby looks into for the name check, at most; each is one small read. */
const NAME_CHECK_FOLDERS = 40

export type MemoryTarget =
  /** `root` is the Project's key, `name` its folder under `projects/`, `dir` the Main Account's memory folder. */
  { status: 'ok'; root: string; name: string; dir: string } | { status: 'skip'; why: string }

/** The entry at `p` is a real folder (not a link), missing (`null`), or something else (`false`). */
async function realFolder(p: string): Promise<boolean | null> {
  const st = await lstatOrNull(p)
  if (!st) return null
  return st.isDirectory() && !st.isSymbolicLink()
}

/**
 * Where Claude Code keeps auto memory for `cwd`, by its own rule (ADR-0081): the git repository's main checkout root
 * (a linked worktree and every subfolder use it), elsewhere the folder itself; real paths; named with
 * `claudeProjectDirName`. Read from files only, never by running `git` (`trustRoot`). `skip` when sideby cannot tell
 * (a submodule, a separate git folder), when the Main Account has no folder yet, or when a folder on the way under
 * the Main Account is a link (Claude Code refuses memory writes through one, anthropics/claude-code#108770).
 */
export async function memoryTarget(mainDir: string, cwd: string): Promise<MemoryTarget> {
  const root = await trustRoot(cwd)
  if (root.kind === 'unclear') return { status: 'skip', why: root.why }
  let main: string
  try {
    main = await realpath(mainDir)
  } catch {
    return { status: 'skip', why: `${mainDir} does not exist yet (start the main account once)` }
  }
  const name = claudeProjectDirName(root.path)
  const dir = join(main, 'projects', name, 'memory')
  for (const p of [join(main, 'projects'), join(main, 'projects', name), dir])
    if ((await realFolder(p)) === false) return { status: 'skip', why: `${p} is a link or not a folder` }
  return { status: 'ok', root: root.path, name, dir }
}

/** The session settings part that sends a Claude session's auto memory to `dir` (one file per folder, ADR-0081). */
export function memoryHookPart(dir: string): SessionHookPart {
  return {
    id: 'memory',
    claude: {},
    codex: {},
    settings: { autoMemoryDirectory: dir },
    fileKey: sha256(dir).slice(0, 12),
  }
}

const prefersChinese = (env: Env) => /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '')

/** The line a Claude Launch prints when the user's own `--settings` leaves no room for the memory folder. */
export function memorySettingsLine(env: Env): string {
  return prefersChinese(env)
    ? 'sideby：已经给了 `--settings`，这个会话不用共享记忆，用这个账号自己的记忆（`sideby doctor --fix` 之后会把它移进主账号）。'
    : "sideby: `--settings` is already given, so this session uses this account's own memory instead of the shared one (`sideby doctor --fix` moves it into the main account later)."
}

/** The line a Claude Launch prints when sideby cannot tell where the Project's memory belongs. */
export function memorySkipLine(env: Env, why: string): string {
  return prefersChinese(env)
    ? `sideby：这个会话不用共享记忆（${why}），用这个账号自己的记忆。`
    : `sideby: this session uses this account's own memory instead of the shared one (${why}).`
}

/** One Project folder of an Account that holds memory files. */
export interface AccountMemory {
  /** The folder name under `projects/`. */
  project: string
  dir: string
  files: number
}

/**
 * An Account's own memory: every `projects/<project>/memory` folder with at least one entry. A link anywhere on the
 * way (`projects`, the Project folder, `memory`) is not followed: it is named in `links`.
 */
export async function accountMemories(
  accountDir: string,
): Promise<{ list: AccountMemory[]; links: string[] }> {
  const projects = join(accountDir, 'projects')
  const links: string[] = []
  const kind = await realFolder(projects)
  if (kind === null) return { list: [], links }
  if (kind === false) {
    if ((await lstatOrNull(projects))?.isSymbolicLink()) links.push(projects)
    return { list: [], links }
  }
  const list: AccountMemory[] = []
  for (const project of (await readdir(projects).catch(() => [] as string[])).sort()) {
    const folder = join(projects, project)
    const st = await lstatOrNull(folder)
    if (!st?.isDirectory()) continue
    const dir = join(folder, 'memory')
    // A stage left by a fold that stopped halfway still holds memory, even when `memory/` is empty or gone.
    const staged = await stagedFiles(join(folder, FOLD_STAGE))
    const mem = await lstatOrNull(dir)
    if (!mem) {
      if (staged) list.push({ project, dir, files: staged })
      continue
    }
    if (mem.isSymbolicLink()) {
      links.push(dir)
      continue
    }
    if (!mem.isDirectory()) continue
    const files =
      (await readdir(dir).catch(() => [] as string[])).filter((n) => n !== '.DS_Store').length + staged
    if (files) list.push({ project, dir, files })
  }
  return { list, links }
}

/** How many entries a fold's stage still holds (a stage that is a link or not a folder counts as one, for Fix to report). */
async function stagedFiles(stage: string): Promise<number> {
  const st = await lstatOrNull(stage)
  if (!st) return 0
  if (!st.isDirectory() || st.isSymbolicLink()) return 1
  return (await readdir(stage).catch(() => [] as string[])).filter((n) => n !== '.DS_Store').length
}

/** Where a folder sideby emptied went: the system trash, or sideby's own folder (named). */
export type TrashResult = { ok: true; to: string } | { ok: false; why: string }

export type Trash = (path: string) => Promise<TrashResult>

/**
 * Moves `path` to the system trash with the `trash` command on PATH (macOS 14 and later ship `/usr/bin/trash`; Linux
 * has `trash-cli`), only when HOME is the user's own home (a demo or test HOME never reaches the real trash). Without
 * one, it moves the folder into `<state>/memory/trash/` and names it there. Never deletes anything.
 */
export function systemTrash(env: Env, stateDir: string, now: () => Date): Trash {
  return async (path) => {
    // The home of the user's account (the password database), not `$HOME`: a demo or test HOME sets `$HOME`.
    const own = await Promise.all([
      realpath(env.HOME ?? '').catch(() => ''),
      realpath(userHome()).catch(() => ''),
    ])
    if (own[0] && own[0] === own[1]) {
      const { which } = await import('./launch.ts')
      const bin = await which('trash', env)
      if (bin) {
        const { execFile } = await import('node:child_process')
        const ok = await new Promise<boolean>((resolve) =>
          execFile(bin, [path], { env: env as NodeJS.ProcessEnv, timeout: 30_000 }, (err) => resolve(!err)),
        )
        if (ok && !(await lstatOrNull(path))) return { ok: true, to: 'the trash' }
      }
    }
    return keepInState(path, stateDir, now())
  }
}

function userHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return ''
  }
}

/** Moves `path` into `<state>/memory/trash/<time>-<name>`; the folder is the user's own (700). */
export async function keepInState(path: string, stateDir: string, at: Date): Promise<TrashResult> {
  try {
    const dir = await ownedFolder(stateDir, ['memory', 'trash'], { create: true, private: true })
    if (!dir) return { ok: false, why: "sideby's state folder cannot be used" }
    const stamp = at.toISOString().replace(/[:.]/g, '-')
    const parts = path.split(/[\\/]+/).filter(Boolean)
    const label = parts
      .slice(-4)
      .join('_')
      .replace(/[^A-Za-z0-9._-]/g, '-')
    const to = join(dir, `${stamp}-${label}`)
    await rename(path, to)
    return { ok: true, to }
  } catch (err) {
    return {
      ok: false,
      why: `${path} could not be moved (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    }
  }
}

/** The working folders of an Account's Live Sessions, or why sideby cannot tell which run. */
export type LiveCwds = { cwds: string[] } | { unknown: string }

const PID_FILE = /^(\d+)\.json$/

/**
 * The working folders of a Claude Account's Live Sessions, from Claude Code's `sessions/<pid>.json` files and the
 * process list. It fails closed: a record of a running process that cannot be read (one Claude Code is rewriting),
 * lacks its session id, working folder or start time, or a process list that cannot be read, means sideby cannot
 * tell which Projects are in use, so the Fix moves nothing of that Account. Only a record whose process is gone, or
 * whose pid now belongs to another process (its start time differs), counts as ended.
 */
export async function claudeLiveCwds(account: Account, procs: ProcessView): Promise<LiveCwds> {
  const root = join(account.dir, 'sessions')
  let names: string[]
  try {
    names = await readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { cwds: [] }
    return { unknown: `${root} cannot be read` }
  }
  const files = names.filter((n) => PID_FILE.test(n)).sort()
  if (!files.length) return { cwds: [] }
  try {
    await procs.list()
  } catch (err) {
    return { unknown: `the running programs cannot be listed (${(err as Error).message})` }
  }
  const cwds: string[] = []
  for (const name of files) {
    const proc = await procs.get(Number(PID_FILE.exec(name)![1]))
    if (!proc) continue
    const file = join(root, name)
    const rec = await readSessionRecord(file)
    if (!rec) return { unknown: `${file} cannot be read right now (Claude Code rewrites it as it runs)` }
    if (Number.isNaN(recordStart(rec))) return { unknown: `${file} has no start time sideby can read` }
    // The pid belongs to another process now: that session ended.
    if (!recordRunsOn(rec, proc)) continue
    const cwd = typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : undefined
    const id = typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : undefined
    if (!cwd || !id) return { unknown: `${file} does not say which ${cwd ? 'session' : 'folder'} it runs` }
    cwds.push(cwd)
  }
  return { cwds }
}

/** The names of the session folders a Live Session in each of `cwds` uses for memory (its Project, and itself). */
export async function liveProjects(cwds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const cwd of cwds) {
    out.add(claudeProjectDirName(cwd))
    const real = await realpath(cwd).catch(() => null)
    if (real) out.add(claudeProjectDirName(real))
    const root = await trustRoot(cwd)
    if (root.kind !== 'unclear') out.add(claudeProjectDirName(root.path))
  }
  return out
}

/** What folding one Project did. */
export interface FoldOutcome {
  project: string
  /** `partial`: what was read is in the Main Account, but something written meanwhile stays in the Account. */
  status: 'moved' | 'merged' | 'partial' | 'skipped' | 'failed'
  /** Files that reached the Main Account under their own name. */
  moved: string[]
  /** Files kept beside a different file of the same name in the Main Account. */
  renamed: { from: string; to: string }[]
  /** Files the Main Account already held with the same content. */
  same: string[]
  /** Lines added to the Main Account's `MEMORY.md`. */
  indexLines: number
  /** Where the emptied Account folder went. */
  trashed?: string
  why?: string
}

/** `name` with `.<account>` before its extension, then `-2`, `-3`… (`notes.md` → `notes.work.md`, `notes.work-2.md`). */
function altName(name: string, account: string, n: number): string {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  return `${stem}.${account}${n > 1 ? `-${n}` : ''}${ext}`
}

/**
 * The memory file a link in `MEMORY.md` points at, with its `#fragment`: the target resolved against the memory
 * folder (`a.md`, `./a.md`, `../memory/a.md` and `a.md#section` all name `a.md`). Null for a link with a scheme, an
 * absolute path, or a file outside the memory folder.
 */
export function memoryLink(target: string): { file: string; fragment: string } | null {
  const at = target.indexOf('#')
  const path = at < 0 ? target : target.slice(0, at)
  const fragment = at < 0 ? '' : target.slice(at)
  if (!path || path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null
  const resolved = posix.normalize(posix.join('project/memory', path))
  return posix.dirname(resolved) === 'project/memory' ? { file: posix.basename(resolved), fragment } : null
}

/**
 * An index with every link to a renamed file pointing at its new name (its `#fragment` kept), in one pass over the
 * links, each resolved against the memory folder, so one rename never feeds another.
 */
export function rewriteLinks(text: string, renamed: ReadonlyMap<string, string>): string {
  if (!renamed.size) return text
  return text.replace(/\]\(([^)\s]+)\)/g, (all, target: string) => {
    const link = memoryLink(target)
    const to = link && renamed.get(link.file)
    return to === undefined || to === null ? all : `](${to}${link!.fragment})`
  })
}

/** A memory file as read once: what a fold copies, and what it checks the folder against before it goes. */
interface NoteRead {
  data: Buffer
  hash: string
  atime: Date
  mtime: Date
}

/** A memory note larger than this is not moved (Claude Code keeps them to a few KB). */
const MAX_NOTE_BYTES = 4 * 1024 * 1024

/** Every entry of a memory folder, read once without following a link; or why sideby leaves the folder alone. */
async function readFolder(
  dir: string,
): Promise<{ names: string[]; files: Map<string, NoteRead> } | { why: string }> {
  const names = (await readdir(dir)).filter((n) => n !== '.DS_Store').sort()
  const files = new Map<string, NoteRead>()
  for (const n of names) {
    const p = join(dir, n)
    const st = await lstat(p)
    if (!st.isFile())
      return {
        why: `${p} is ${st.isSymbolicLink() ? 'a link' : 'not a file'}; sideby moves only folders of plain files and left this one as it is`,
      }
    if (st.size > MAX_NOTE_BYTES) return { why: `${p} is too large to move` }
    const data = await readNoFollow(p)
    if (!data) return { why: `${p} cannot be read` }
    files.set(n, { data, hash: sha256(data), atime: st.atime, mtime: st.mtime })
  }
  return { names, files }
}

/** The bytes of a regular file, opened without following a link; null when that fails. */
async function readNoFollow(p: string): Promise<Buffer | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await fh.stat()).isFile()) return null
    return await fh.readFile()
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Writes a new file at `path` and never over one: the bytes go to a temp file beside it (fsynced, times set), which is
 * then hard-linked to `path` (that fails when the name is taken) and removed. A write that fails partway leaves only
 * the temp file, which is removed, so a retry finds the name free.
 */
async function writeNew(
  path: string,
  note: NoteRead,
  write: (fh: FileHandle, data: Buffer) => Promise<void>,
): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.sideby-${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'wx', 0o644)
  try {
    try {
      await write(fh, note.data)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await utimes(tmp, note.atime, note.mtime)
    await link(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

const hashOf = async (p: string) => {
  const data = await readNoFollow(p)
  return data ? sha256(data) : null
}

/** `into` with every line of `from` it does not hold yet (trailing spaces ignored), in order; and how many. */
export function mergeIndex(into: string, from: string): { text: string; added: number } {
  const have = new Set(into.split('\n').map((l) => l.trimEnd()))
  const add: string[] = []
  for (const line of from.split('\n')) {
    const l = line.trimEnd()
    if (!l.trim() || have.has(l)) continue
    have.add(l)
    add.push(l)
  }
  if (!add.length) return { text: into, added: 0 }
  const base = into.length && !into.endsWith('\n') ? `${into}\n` : into
  return { text: `${base}${add.join('\n')}\n`, added: add.length }
}

export interface FoldInput {
  /** The Main Account's folder (`~/.claude`). */
  mainDir: string
  account: Account
  project: string
  trash: Trash
  /** Internal, for tests: runs after every copy is checked and before the Account's files are taken out. */
  afterCopy?: () => Promise<void>
  /** Internal, for tests: writes a copy's bytes into its temp file (default: all of them). */
  write?: (fh: FileHandle, data: Buffer) => Promise<void>
  /** Internal, for tests: runs after a file is renamed into the stage and before it is hashed there. */
  staged?: (name: string) => Promise<void>
}

/** The folder beside an Account's `memory` that holds the files being taken out, until they go to the trash. */
export const FOLD_STAGE = 'memory-folded-by-sideby'

/**
 * Moves a plain file to `to` without ever replacing one there: a hard link (which fails when the name is taken), then
 * the old name removed. `taken` when `to` exists, `error` when the move cannot be made at all.
 */
async function moveNoClobber(from: string, to: string): Promise<'moved' | 'taken' | 'error'> {
  try {
    await link(from, to)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'taken' : 'error'
  }
  // Should removing the old name fail, both names point at the same file: trashing the stage leaves `to` intact.
  await unlink(from).catch(() => {})
  return 'moved'
}

/**
 * A stage left by a fold that stopped halfway: each plain file goes back into the memory folder where its name is
 * free (never over a file there); the stage is removed once empty, else the Project is left for the user.
 */
async function recoverStage(src: string, stage: string): Promise<string | null> {
  const st = await lstatOrNull(stage)
  if (!st) return null
  if (!st.isDirectory() || st.isSymbolicLink())
    return `${stage} is a link or not a folder; sideby left it as it is`
  for (const n of await readdir(stage)) {
    if ((await lstatOrNull(join(stage, n)))?.isFile()) await moveNoClobber(join(stage, n), join(src, n))
  }
  return rmdir(stage).then(
    () => null,
    () => `${stage} still holds files whose names are taken in ${src}; move them by hand`,
  )
}

const fail = (project: string, why: string, part: Partial<FoldOutcome> = {}): FoldOutcome => ({
  project,
  status: 'failed',
  moved: [],
  renamed: [],
  same: [],
  indexLines: 0,
  ...part,
  why,
})

/**
 * Folds one Project's memory of `account` into the Main Account (ADR-0081). When the Main Account has no memory for
 * it, the folder moves whole. Otherwise every file is read once, and copied in from that read (temp file, fsync, then
 * a hard link to its name, so never over another file and never half-written; times kept): a file the Main Account
 * holds with the same content counts as there, one with other content is kept as `<name>.<account>.md` (a name
 * neither folder uses), and `MEMORY.md` gets the Account's lines it lacks, with links to renamed files rewritten in
 * one pass. Then each file read is taken out on its own: renamed into a stage beside the memory folder, hashed there,
 * and kept out only when it still holds what was copied (else renamed back). The stage goes to the trash, and the
 * memory folder is removed only when empty, so a file written meanwhile is never trashed: it stays for the next fold.
 */
export async function foldProject(input: FoldInput): Promise<FoldOutcome> {
  const { account, project } = input
  const accountDir = account.dir
  const srcParent = join(accountDir, 'projects', project)
  const src = join(srcParent, 'memory')
  const stage = join(srcParent, FOLD_STAGE)
  // A fold that stopped after its last file left `memory/` gone or empty: recreate it so the stage can be put back.
  if ((await realFolder(srcParent)) === true && !(await lstatOrNull(src)) && (await lstatOrNull(stage)))
    await mkdir(src).catch(() => {})
  for (const p of [join(accountDir, 'projects'), srcParent, src])
    if ((await realFolder(p)) !== true)
      return fail(project, `${p} is a link or not a folder; sideby left it as it is`)
  await assertInside(accountDir, src)
  await assertInside(accountDir, join(stage, 'x'))
  const leftover = await recoverStage(src, stage)
  if (leftover) return fail(project, leftover)
  let main: string
  try {
    main = await realpath(input.mainDir)
  } catch {
    return fail(project, `${input.mainDir} does not exist`)
  }
  const dstParent = join(main, 'projects', project)
  const dst = join(dstParent, 'memory')
  for (const p of [join(main, 'projects'), dstParent, dst])
    if ((await realFolder(p)) === false)
      return fail(project, `${p} is a link or not a folder; sideby left it as it is`)
  const read = await readFolder(src)
  if ('why' in read) return fail(project, read.why)
  const { names, files } = read
  const accountName = account.name.replace(/[^A-Za-z0-9._-]/g, '-')

  // The Main Account has no memory for this Project: the folder moves whole (one rename takes whatever it holds).
  if ((await realFolder(dst)) === null) {
    await mkdir(dstParent, { recursive: true, mode: 0o700 })
    if ((await realFolder(dstParent)) !== true) return fail(project, `${dstParent} is a link or not a folder`)
    await assertInside(main, dst)
    try {
      await rename(src, dst)
      return { project, status: 'moved', moved: names, renamed: [], same: [], indexLines: 0 }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV')
        return fail(project, `${src} could not be moved (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      await mkdir(dst, { mode: 0o700 })
    }
  }

  await assertInside(main, join(dst, MEMORY_INDEX))
  // Where each file goes, decided before anything is written: a kept name is free in both folders and among the
  // names this fold already gave out.
  const plan: { from: string; to: string; copy: boolean }[] = []
  const taken = new Set<string>()
  for (const n of names) {
    if (n === MEMORY_INDEX) continue
    const note = files.get(n)!
    let pick: { to: string; copy: boolean } | null = null
    for (let i = 0; i <= 50 && !pick; i++) {
      const to = i === 0 ? n : altName(n, accountName, i)
      if (taken.has(to) || (i > 0 && files.has(to))) continue
      const there = await lstatOrNull(join(dst, to))
      if (!there) pick = { to, copy: true }
      else if (there.isFile() && (await hashOf(join(dst, to))) === note.hash) pick = { to, copy: false }
    }
    if (!pick) return fail(project, `no free name for ${n} in ${dst}`)
    taken.add(pick.to)
    plan.push({ from: n, ...pick })
  }
  const moved = plan.filter((x) => x.to === x.from && x.copy).map((x) => x.from)
  const same = plan.filter((x) => x.to === x.from && !x.copy).map((x) => x.from)
  const renamed = plan.filter((x) => x.to !== x.from).map(({ from, to }) => ({ from, to }))
  const sofar = { moved, renamed, same }
  const write = input.write ?? ((fh: FileHandle, data: Buffer) => fh.writeFile(data))
  for (const x of plan) {
    if (!x.copy) continue
    try {
      await writeNew(join(dst, x.to), files.get(x.from)!, write)
    } catch (err) {
      return fail(
        project,
        `${join(dst, x.to)} could not be written (${(err as NodeJS.ErrnoException).code ?? 'error'}); nothing was left under that name`,
        sofar,
      )
    }
  }

  let indexLines = 0
  const index = files.get(MEMORY_INDEX)
  if (index) {
    if (index.data.length > MAX_INDEX_BYTES)
      return fail(project, `${join(src, MEMORY_INDEX)} is too large`, sofar)
    const text = rewriteLinks(index.data.toString('utf8'), new Map(renamed.map((r) => [r.from, r.to])))
    const target = join(dst, MEMORY_INDEX)
    const st = await lstatOrNull(target)
    if (st && !st.isFile())
      return fail(project, `${target} is a link or not a file; sideby left the index as it is`, sofar)
    const ours = st ? await readSmallFile(target, MAX_INDEX_BYTES) : ''
    if (ours === undefined) return fail(project, `${target} cannot be read or is too large`, sofar)
    const merged = st
      ? mergeIndex(ours, text)
      : { text, added: text.split('\n').filter((l) => l.trim()).length }
    if (merged.text !== ours) {
      const wrote = await writeIfUnchanged(target, st ? sha256(ours) : null, merged.text, 0o644).catch(
        () => false,
      )
      if (!wrote) return fail(project, `${target} changed while sideby merged it; run the fix again`, sofar)
    }
    indexLines = merged.added
  }

  for (const x of plan)
    if ((await hashOf(join(dst, x.to))) !== files.get(x.from)!.hash)
      return fail(project, `${join(dst, x.to)} does not match ${join(src, x.from)} after copying`, {
        ...sofar,
        indexLines,
      })
  await input.afterCopy?.()

  // Each file read is taken out on its own: renamed into the stage (one atomic step, so a write by its name after it
  // makes a new file in the memory folder), then kept out only when it still holds what was copied or merged.
  try {
    await mkdir(stage, { mode: 0o700 })
  } catch (err) {
    return fail(project, `${stage} could not be made (${(err as NodeJS.ErrnoException).code ?? 'error'})`, {
      ...sofar,
      indexLines,
    })
  }
  const back: string[] = []
  const stuck: string[] = []
  for (const n of names) {
    try {
      await rename(join(src, n), join(stage, n))
    } catch {
      continue // gone meanwhile: its copy is in the Main Account
    }
    await input.staged?.(n)
    if ((await hashOf(join(stage, n))) === files.get(n)!.hash) continue
    // Changed after the read: back into the memory folder, never over a file there. When a new file took its name, it
    // goes back as `<name>.changed.md` (the next free one), so the stage keeps only files that match their copies.
    let to: string | null = null
    for (let i = 0; i <= 50 && to === null; i++) {
      const name = i === 0 ? n : altName(n, 'changed', i)
      const how = await moveNoClobber(join(stage, n), join(src, name))
      if (how === 'moved') to = name
      else if (how === 'error') break
    }
    if (to === null) stuck.push(n)
    else back.push(to === n ? n : `${n} (as ${to})`)
  }
  if (stuck.length) {
    // An unchecked file cannot go back: nothing goes to the trash, the verified files go back too.
    await recoverStage(src, stage)
    return fail(
      project,
      `${stuck.join(', ')} changed while sideby moved ${stuck.length === 1 ? 'it' : 'them'} and could not be put back in ${src}; ${stuck.length === 1 ? 'it is' : 'they are'} in ${stage}, move ${stuck.length === 1 ? 'it' : 'them'} back by hand`,
      { ...sofar, indexLines },
    )
  }
  const leftInStage = (await readdir(stage).catch(() => [] as string[])).length
  let trashed: string | undefined
  if (leftInStage) {
    const gone = await input.trash(stage)
    if (!gone.ok) {
      await recoverStage(src, stage)
      return fail(
        project,
        `the files are in the main account, but ${gone.why}; they stay in ${account.ref} too`,
        {
          ...sofar,
          indexLines,
        },
      )
    }
    trashed = gone.to
  } else await rmdir(stage).catch(() => {})
  const emptied = await rmdir(src).then(
    () => true,
    () => false,
  )
  const result = { project, moved, renamed, same, indexLines, ...(trashed ? { trashed } : {}) }
  if (emptied && !back.length) return { ...result, status: 'merged' }
  return {
    ...result,
    status: 'partial',
    why: back.length
      ? `${back.join(', ')} changed while sideby moved ${back.length === 1 ? 'it' : 'them'}, so ${back.length === 1 ? 'it stays' : 'they stay'} in ${account.ref}; the next fix moves ${back.length === 1 ? 'it' : 'them'}`
      : `new memory appeared in ${src} while sideby moved the rest; the next fix moves it`,
  }
}

/** One fold sideby recorded (its state folder; names and counts only, never a file's text). */
export interface FoldRecord {
  account: string
  project: string
  /** Memory files that reached the Main Account, `MEMORY.md` not counted. */
  files: number
  at: string
}

const RECORDS = 'folded.json'
const MAX_RECORDS = 500

/** Every fold sideby recorded, oldest first; a file that cannot be read gives none. */
export async function readFolds(stateDir: string): Promise<FoldRecord[]> {
  const dir = await ownedFolder(stateDir, ['memory'], { create: false }).catch(() => null)
  if (!dir) return []
  const text = await readSmallFile(join(dir, RECORDS), 4 * 1024 * 1024)
  if (text === undefined) return []
  try {
    const v = JSON.parse(text) as { folds?: unknown }
    if (!Array.isArray(v.folds)) return []
    return v.folds.filter(
      (f): f is FoldRecord =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as FoldRecord).account === 'string' &&
        typeof (f as FoldRecord).project === 'string' &&
        typeof (f as FoldRecord).files === 'number' &&
        typeof (f as FoldRecord).at === 'string',
    )
  } catch {
    return []
  }
}

async function recordFolds(stateDir: string, add: readonly FoldRecord[]): Promise<void> {
  if (!add.length) return
  const dir = await ownedFolder(stateDir, ['memory'], { create: true, private: true })
  if (!dir) return
  const folds = [...(await readFolds(stateDir)), ...add].slice(-MAX_RECORDS)
  await writeFileAtomic(join(dir, RECORDS), `${JSON.stringify({ version: 1, folds }, null, 2)}\n`, 0o600)
}

export interface MemoryDoctorContext {
  mainDir: string
  stateDir: string
  /** The working folders of the Account's Live Sessions, or why sideby cannot tell (`claudeLiveCwds`). */
  liveCwds: (account: Account) => Promise<LiveCwds>
  trash: Trash
  now: () => Date
  /** Shortens a path for a message (`~/…`). */
  show: (p: string) => string
}

/** Every Project of `account` with memory of its own, folded unless a Live Session of the Account works in it. */
export async function foldAccount(ctx: MemoryDoctorContext, account: Account): Promise<FixResult> {
  const { list } = await accountMemories(account.dir)
  if (!list.length) return { ok: true, message: `${account.ref} keeps no memory of its own now` }
  const running = await ctx.liveCwds(account)
  if ('unknown' in running)
    return {
      ok: false,
      message: `sideby cannot tell which sessions of ${account.ref} are running (${ctx.show(running.unknown)}), so it moved nothing of ${account.ref}; run the fix again in a moment`,
    }
  const live = await liveProjects(running.cwds)
  const outcomes: FoldOutcome[] = []
  for (const m of list) {
    if (live.has(m.project)) {
      outcomes.push({
        project: m.project,
        status: 'skipped',
        moved: [],
        renamed: [],
        same: [],
        indexLines: 0,
      })
      continue
    }
    outcomes.push(
      await foldProject({ mainDir: ctx.mainDir, account, project: m.project, trash: ctx.trash }).catch(
        (err) => fail(m.project, (err as Error).message),
      ),
    )
  }
  const done = outcomes.filter((o) => o.status === 'moved' || o.status === 'merged' || o.status === 'partial')
  await recordFolds(
    ctx.stateDir,
    done.map((o) => ({
      account: account.ref,
      project: o.project,
      files: [...o.moved, ...o.renamed.map((r) => r.from), ...o.same].filter((n) => n !== MEMORY_INDEX)
        .length,
      at: ctx.now().toISOString(),
    })),
  ).catch(() => {})
  const parts: string[] = []
  if (done.length)
    parts.push(
      `moved ${account.ref}'s memory of ${done.length} ${done.length === 1 ? 'project' : 'projects'} into the main account`,
    )
  const kept = outcomes.flatMap((o) => o.renamed)
  if (kept.length)
    parts.push(
      `kept ${kept.length} ${kept.length === 1 ? 'file' : 'files'} that differed under a new name (${kept
        .slice(0, 3)
        .map((r) => r.to)
        .join(', ')}${kept.length > 3 ? ', …' : ''})`,
    )
  const where = [...new Set(done.map((o) => o.trashed).filter((t): t is string => !!t))]
  if (where.length) parts.push(`the emptied folders went to ${where.map((w) => ctx.show(w)).join(', ')}`)
  const skipped = outcomes.filter((o) => o.status === 'skipped')
  if (skipped.length)
    parts.push(
      `left ${skipped.length} ${skipped.length === 1 ? 'project' : 'projects'} while a session of ${account.ref} works there (${skipped
        .map((o) => o.project)
        .join(', ')}); run the fix again once it ends`,
    )
  const failed = outcomes.filter((o) => o.status === 'failed' || o.status === 'partial')
  for (const f of failed) parts.push(`${f.project}: ${ctx.show(f.why ?? 'not moved')}`)
  return { ok: failed.length === 0, message: parts.join('; ') || `nothing to move for ${account.ref}` }
}

/** Doctor's check of one Claude Account that is not the Main Account (only while config `claude.shareMemory` is on). */
export async function memoryFindings(ctx: MemoryDoctorContext, account: Account): Promise<CheckResult[]> {
  if (account.family !== 'claude' || account.isMain) return []
  const { list, links } = await accountMemories(account.dir)
  const out: CheckResult[] = []
  if (list.length) {
    const files = list.reduce((n, m) => n + m.files, 0)
    const names = list.map((m) => m.project)
    out.push({
      level: 'warn',
      item: 'projects/*/memory',
      code: 'memory.unfolded',
      message: `${account.ref} keeps its own memory for ${list.length} ${list.length === 1 ? 'project' : 'projects'} (${files} ${files === 1 ? 'file' : 'files'}) that your other Claude accounts do not see: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`,
      hint: `\`sideby doctor ${account.ref} --fix\` moves it into the main account (shared memory is on); a file that differs is kept beside the main one under a new name, and emptied folders go to the trash`,
      fixable: true,
      fix: () => foldAccount(ctx, account),
    })
  }
  for (const l of links)
    out.push({
      level: 'warn',
      item: 'projects/*/memory',
      code: 'memory.link',
      message: `${ctx.show(l)} is a link; Claude Code refuses memory writes through a link, and sideby does not follow it`,
      hint: 'replace the link with a real folder (move its files into the main account first), then run `sideby doctor --fix`',
      fixable: false,
    })
  return out
}

/** The memory files an index links to (`memoryLink`); links to anything else are left out. */
export function indexTargets(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = memoryLink(m[1]!)
    if (link) out.add(link.file)
  }
  return [...out]
}

/** One memory folder whose index does not match its files. */
export interface IndexProblem {
  project: string
  /** Files the index links to that are not there. */
  missing: string[]
  /** Memory files the index does not list. */
  unlisted: string[]
}

/** Every memory folder of the Main Account whose `MEMORY.md` lists a missing file or misses a file that is there. */
export async function indexProblems(mainDir: string): Promise<IndexProblem[]> {
  const { list } = await accountMemories(mainDir)
  const out: IndexProblem[] = []
  for (const m of list) {
    const entries = await readdir(m.dir).catch(() => [] as string[])
    const files: string[] = []
    for (const n of entries) if ((await lstatOrNull(join(m.dir, n)))?.isFile()) files.push(n)
    const notes = files.filter((n) => n !== MEMORY_INDEX && n.endsWith('.md'))
    const text = files.includes(MEMORY_INDEX)
      ? await readSmallFile(join(m.dir, MEMORY_INDEX), MAX_INDEX_BYTES)
      : ''
    if (text === undefined) continue
    const targets = indexTargets(text)
    const missing = targets.filter((t) => !files.includes(t)).sort()
    const unlisted = notes.filter((n) => !targets.includes(n)).sort()
    if (missing.length || unlisted.length) out.push({ project: m.project, missing, unlisted })
  }
  return out
}

/**
 * Every `cwd` the first and the last records of a session file name, from its first and last 64 KB only. Both ends:
 * a session resumed in another folder keeps the earlier records, and their `cwd`, of the folder it came from.
 */
async function transcriptCwds(file: string): Promise<string[]> {
  const out = new Set<string>()
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile()) return []
    const size = Math.min(st.size, 64 * 1024)
    for (const at of new Set([0, Math.max(0, st.size - size)])) {
      const buf = Buffer.alloc(size)
      await fh.read(buf, 0, size, at)
      const lines = buf.toString('utf8').split('\n')
      for (const line of at === 0 ? lines.slice(0, 40) : lines.slice(-40)) {
        if (!line.includes('"cwd"')) continue
        try {
          const v = JSON.parse(line) as { cwd?: unknown }
          if (typeof v.cwd === 'string' && v.cwd.startsWith('/')) out.add(v.cwd)
        } catch {
          // a line cut at the 64 KB edge
        }
      }
    }
    return [...out]
  } catch {
    return [...out]
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** A Project folder Claude Code named differently from the name sideby gives the same path. */
export interface NameMismatch {
  account: string
  folder: string
  cwd: string
  derived: string
}

/**
 * Whether Claude Code still names Project folders the way sideby does (ADR-0081). Claude Code names a session's
 * folder after the session's working folder, by the same rule as its memory folder; a folder that holds memory and
 * session files none of whose `cwd`s (first and last records, folders that still exist) names it means the rule
 * changed. The three newest session files of up to 40 folders are looked at, and a folder counts only when none of
 * them agrees.
 */
export async function nameMismatches(accounts: readonly Account[]): Promise<NameMismatch[]> {
  const out: NameMismatch[] = []
  let looked = 0
  for (const a of accounts) {
    if (a.family !== 'claude') continue
    const { list } = await accountMemories(a.dir)
    for (const m of list) {
      if (looked >= NAME_CHECK_FOLDERS) return out
      const folder = join(a.dir, 'projects', m.project)
      const named = (await readdir(folder).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))
      if (!named.length) continue
      const timed = await Promise.all(
        named.map(async (n) => ({ n, at: (await lstatOrNull(join(folder, n)))?.mtimeMs ?? 0 })),
      )
      const sessions = timed
        .sort((x, y) => y.at - x.at)
        .slice(0, 3)
        .map((x) => x.n)
      looked++
      // A working folder that is gone says nothing: a moved project's folder is often renamed by hand to follow it.
      const seen = [
        ...new Set((await Promise.all(sessions.map((s) => transcriptCwds(join(folder, s))))).flat()),
      ]
      const cwds: string[] = []
      for (const c of seen) if ((await lstatOrNull(c))?.isDirectory()) cwds.push(c)
      if (cwds.length && !cwds.some((c) => claudeProjectDirName(c) === m.project))
        out.push({
          account: a.ref,
          folder: m.project,
          cwd: cwds[0]!,
          derived: claudeProjectDirName(cwds[0]!),
        })
    }
  }
  return out
}

/** Doctor's warnings about the Main Account's memory (only while config `claude.shareMemory` is on); never `fail`. */
export async function mainMemoryFindings(
  ctx: Pick<MemoryDoctorContext, 'mainDir' | 'show'>,
  accounts: readonly Account[],
): Promise<Finding[]> {
  const out: Finding[] = []
  const bad = await indexProblems(ctx.mainDir)
  if (bad.length) {
    const say = (p: IndexProblem) =>
      `${p.project} (${[
        p.missing.length
          ? `lists missing ${p.missing.slice(0, 2).join(', ')}${p.missing.length > 2 ? ', …' : ''}`
          : '',
        p.unlisted.length
          ? `does not list ${p.unlisted.slice(0, 2).join(', ')}${p.unlisted.length > 2 ? ', …' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join('; ')})`
    out.push({
      level: 'warn',
      account: 'claude:main',
      item: 'memory',
      code: 'memory.index',
      message: `the memory index (MEMORY.md) of ${bad.length} ${bad.length === 1 ? 'project' : 'projects'} in the main account does not match its files: ${bad.slice(0, 3).map(say).join(', ')}${bad.length > 3 ? ', …' : ''}`,
      hint: 'Claude reads only what MEMORY.md lists. Ask Claude in that project to tidy its memory index, or edit MEMORY.md in that folder; two accounts writing at the same moment can overwrite it',
      source: 'core',
      fixable: false,
    })
  }
  const odd = await nameMismatches(accounts)
  if (odd.length) {
    const first = odd[0]!
    out.push({
      level: 'warn',
      account: 'claude:main',
      item: 'memory',
      code: 'memory.name-mismatch',
      message: `Claude Code named the folder of ${ctx.show(first.cwd)} "${first.folder}" (${first.account}), but sideby would name it "${first.derived}"${odd.length > 1 ? ` (and ${odd.length - 1} more)` : ''}: Claude Code may have changed how it names project folders, so shared memory may land in another folder than Claude Code's own`,
      hint: 'turn shared memory off with `sideby memory off --yes` until sideby is updated (`sideby update`); the memory already in the main account stays',
      source: 'core',
      fixable: false,
    })
  }
  return out
}

/** What `sideby memory` and the Panel show (spec §3.44). */
export interface MemoryStatus {
  /** Config `claude.shareMemory`. */
  on: boolean
  /** The Main Account's folder that holds every Project's memory (`~/.claude/projects`). */
  main: string
  /** Folds Doctor recorded, newest last. */
  folded: FoldRecord[]
  /** The folder asked about and where its memory goes; only while on. */
  dir?: { path: string; name?: string; memory?: string; why?: string }
  /** Each Project with memory in the Main Account or of an Account's own; only while on. */
  projects?: {
    name: string
    /** Files in the Main Account's memory folder. */
    main: number
    /** Accounts that keep memory of their own for it: files Doctor would fold. */
    pending: { account: string; files: number }[]
    /** Files Doctor folded into the Main Account, per Account. */
    folded: { account: string; files: number }[]
  }[]
}

/** `sideby memory` (spec §3.44): reads no Account folder while the setting is off. */
export async function memoryStatus(
  opts: {
    mainDir: string
    stateDir: string
    /** Asked only while on: finding the Accounts reads the Host folders. */
    accounts: () => Promise<readonly Account[]>
  },
  on: boolean,
  cwd?: string,
): Promise<MemoryStatus> {
  const folded = await readFolds(opts.stateDir)
  const main = join(opts.mainDir, 'projects')
  if (!on) return { on, main, folded }
  const projects = new Map<string, NonNullable<MemoryStatus['projects']>[number]>()
  const entry = (name: string) => {
    let e = projects.get(name)
    if (!e) {
      e = { name, main: 0, pending: [], folded: [] }
      projects.set(name, e)
    }
    return e
  }
  for (const m of (await accountMemories(opts.mainDir)).list) entry(m.project).main = m.files
  for (const a of await opts.accounts()) {
    if (a.family !== 'claude' || a.isMain) continue
    for (const m of (await accountMemories(a.dir)).list)
      entry(m.project).pending.push({ account: a.ref, files: m.files })
  }
  for (const f of folded) {
    if (!projects.has(f.project)) continue
    const e = entry(f.project)
    const had = e.folded.find((x) => x.account === f.account)
    if (had) had.files += f.files
    else e.folded.push({ account: f.account, files: f.files })
  }
  let dir: MemoryStatus['dir']
  if (cwd !== undefined) {
    const t = await memoryTarget(opts.mainDir, cwd)
    const real = await realpath(cwd).catch(() => cwd)
    dir = t.status === 'ok' ? { path: real, name: t.name, memory: t.dir } : { path: real, why: t.why }
  }
  return {
    on,
    main,
    folded,
    ...(dir ? { dir } : {}),
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}
