// Carried trust between Claude Accounts (spec §3.43, ADR-0078). Claude Code asks "Is this a project you created or
// one you trust?" in every Account that has not trusted a folder yet, and keeps the answer per Account as
// `projects["<path>"].hasTrustDialogAccepted` in that Account's `.claude.json`. With config `claude.carryTrust` on,
// before sideby starts an interactive Claude session it copies that one mark from another Account that already trusts
// the folder: the same key, never a wider or narrower one, never trust nobody gave.
//
// `.claude.json` is a credential file: of it only `projects.*.hasTrustDialogAccepted` is read, no other value reaches
// an output, an error or a record, and errors name the path only. No git command is ever run in the folder (an
// untrusted repository's config can run programs); its `.git` files are read instead.
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Account } from '../types.ts'
import { isObj, type Json, render } from './claude-settings-file.ts'
import { ownedFolder, readSmallFile, sha256, writeFileAtomic, writeIfUnchanged } from './fs-safe.ts'
import { takeFileLock } from './lock.ts'

/** The one field of a `projects` entry sideby reads or writes. */
export const TRUST_FIELD = 'hasTrustDialogAccepted'

/** `.claude.json` holds history and caches; a file larger than this is not read. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

/**
 * The key a Claude Account's trust is looked up by for one folder, by Claude Code's documented rules
 * (https://code.claude.com/docs/en/permissions): inside a git checkout the main checkout's root (`git`, a linked
 * worktree uses its main checkout's), elsewhere the folder or any parent folder (`folder`). `unclear` when sideby
 * cannot tell from the files alone; then nothing counts as trusted and nothing is written.
 */
export type TrustRoot =
  | { kind: 'git'; folder: string; path: string }
  | { kind: 'folder'; folder: string; path: string }
  | { kind: 'unclear'; folder: string; why: string }

const realOrNull = (p: string) => realpath(p).catch(() => null)

/**
 * The main checkout root of a linked worktree whose checkout root is `root` (its `.git` is a file), or null when
 * `.git` does not describe one exactly: `gitdir: <common>/worktrees/<name>`, that folder's `gitdir` pointing back at
 * `root/.git`, its `commondir` (or the folder layout) leading to `<common>`, and `<common>` being the `.git` folder of
 * a checkout.
 */
async function worktreeMain(root: string): Promise<string | null> {
  const text = await readSmallFile(join(root, '.git'), 4096)
  const m = text === undefined ? null : /^gitdir:[ \t]*(\S.*?)\s*$/m.exec(text.split('\n')[0] ?? '')
  if (!m) return null
  const dir = await realOrNull(resolve(root, m[1]!))
  if (!dir || basename(dirname(dir)) !== 'worktrees') return null
  const back = (await readSmallFile(join(dir, 'gitdir'), 4096))?.trim()
  if (!back) return null
  const [backReal, ownReal] = await Promise.all([
    realOrNull(resolve(dir, back)),
    realOrNull(join(root, '.git')),
  ])
  if (!backReal || backReal !== ownReal) return null
  const layout = await realOrNull(dirname(dirname(dir)))
  const named = (await readSmallFile(join(dir, 'commondir'), 4096))?.trim()
  const common = named ? await realOrNull(resolve(dir, named)) : layout
  if (!common || common !== layout || basename(common) !== '.git') return null
  const main = dirname(common)
  const st = await lstat(join(main, '.git')).catch(() => null)
  if (!st?.isDirectory() || (await realOrNull(join(main, '.git'))) !== common) return null
  return main
}

/**
 * Where trust is looked up for `cwd`, from the files alone: walks up from its real path to the first `.git`. A `.git`
 * folder makes that folder the root; a `.git` file must describe a linked worktree exactly (`worktreeMain`). Anything
 * else (a submodule, a separate git folder, a link, a file sideby cannot read) is `unclear`. Without any `.git`, the
 * folder and its parents count.
 */
export async function trustRoot(cwd: string): Promise<TrustRoot> {
  const folder = await realOrNull(cwd)
  if (!folder) return { kind: 'unclear', folder: cwd, why: 'the folder cannot be found' }
  for (let d = folder; ; ) {
    const st = await lstat(join(d, '.git')).catch((err: NodeJS.ErrnoException) =>
      err.code === 'ENOENT' || err.code === 'ENOTDIR' ? null : err,
    )
    if (st instanceof Error) return { kind: 'unclear', folder, why: `${join(d, '.git')} cannot be read` }
    if (st?.isDirectory()) return { kind: 'git', folder, path: d }
    if (st?.isFile()) {
      const main = await worktreeMain(d)
      return main
        ? { kind: 'git', folder, path: main }
        : {
            kind: 'unclear',
            folder,
            why: `${join(d, '.git')} is not a linked worktree sideby can follow (a submodule or a separate git folder)`,
          }
    }
    if (st) return { kind: 'unclear', folder, why: `${join(d, '.git')} is not a folder or a file` }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return { kind: 'folder', folder, path: folder }
}

/**
 * The keys that make an Account trust the folder, narrowest first: the main checkout root in a git checkout, else the
 * folder and every parent. HOME and a filesystem root never count, as Claude Code does not keep trust for them.
 */
export async function trustCandidates(root: TrustRoot, home: string): Promise<string[]> {
  if (root.kind === 'unclear') return []
  const homes = new Set([home, (await realOrNull(home)) ?? home])
  const skip = (p: string) => homes.has(p) || dirname(p) === p
  if (root.kind === 'git') return skip(root.path) ? [] : [root.path]
  const out: string[] = []
  for (let d = root.path; dirname(d) !== d; d = dirname(d)) if (!skip(d)) out.push(d)
  return out
}

/**
 * `file` with every folder above it resolved and its own name kept: the file sideby reads and writes, fixed once, so a
 * folder swapped afterwards cannot move a write (a link at the file itself is still refused when it is opened).
 */
async function realFile(file: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(file)), basename(file))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : Promise.reject(err)
  }
}

/** What one Account's `.claude.json` says about trust: the keys it trusts, or why it cannot be read. */
export type TrustRead =
  | { status: 'ok'; keys: Set<string> }
  | { status: 'missing' }
  | { status: 'problem'; why: string }

/** The text of `file`, opened without following a link; never quotes the file in an error. */
async function readNoFollow(
  file: string,
): Promise<{ text: string } | { status: 'missing' } | { status: 'problem'; why: string }> {
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(file)
  } catch (err) {
    // Only a file that is not there is missing; a folder sideby cannot enter is a problem, so undo keeps its record.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' }
    return { status: 'problem', why: `${file} cannot be read` }
  }
  if (st.isSymbolicLink()) return { status: 'problem', why: `${file} is a link` }
  if (!st.isFile()) return { status: 'problem', why: `${file} is not a regular file` }
  if (st.size > MAX_JSON_BYTES) return { status: 'problem', why: `${file} is too large to read` }
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const fst = await fh.stat()
    if (!fst.isFile() || fst.size > MAX_JSON_BYTES)
      return { status: 'problem', why: `${file} is not a regular file` }
    return { text: await fh.readFile('utf8') }
  } catch {
    return { status: 'problem', why: `${file} cannot be read` }
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Parses `.claude.json` text into an object; the error names the file only, never a slice of it. */
function parseObject(text: string, file: string): { obj: Json } | { why: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { why: `${file} is not valid JSON` }
  }
  return isObj(parsed) ? { obj: parsed } : { why: `${file} is not a JSON object` }
}

/** The keys of `.claude.json` whose `hasTrustDialogAccepted` is `true`; nothing else of the file is kept. */
export async function readTrustKeys(file: string): Promise<TrustRead> {
  const read = await readNoFollow(file)
  if (!('text' in read)) return read
  const parsed = parseObject(read.text, file)
  if ('why' in parsed) return { status: 'problem', why: parsed.why }
  const projects = parsed.obj.projects
  if (projects === undefined) return { status: 'ok', keys: new Set() }
  if (!isObj(projects)) return { status: 'problem', why: `projects in ${file} is not an object` }
  const keys = new Set<string>()
  for (const [k, v] of Object.entries(projects)) if (isObj(v) && v[TRUST_FIELD] === true) keys.add(k)
  return { status: 'ok', keys }
}

/** The narrowest key of `candidates` that `read` trusts, or null. Keys compare as written (a real path). */
export function trustedKey(read: TrustRead, candidates: readonly string[]): string | null {
  if (read.status !== 'ok') return null
  return candidates.find((k) => read.keys.has(k)) ?? null
}

/** What the field held before sideby set it: no entry for the key, an entry without it, or `false`. */
export type TrustBefore = 'no-entry' | 'no-field' | 'false'

/** Internal, for tests: runs between reading the file and writing it, to change it in between. */
export interface WriteHooks {
  afterRead?: () => Promise<void>
}

/**
 * Sets `projects[key].hasTrustDialogAccepted` to true in `file`, under the rules of Share Mode `json-key`: never
 * through a link, never in a file that is not a JSON object, a `projects` or an entry that is not an object, or a field
 * that is neither absent nor `false`; only that one field (a new entry is `{ "hasTrustDialogAccepted": true }`), every
 * other key and its order and the file's indentation kept; written atomically (mode 600) only while the file still
 * has the hash it was read with. Never creates the file.
 */
export async function writeTrust(
  file: string,
  key: string,
  hooks: WriteHooks = {},
): Promise<{ ok: true; before: TrustBefore } | { ok: true; already: true } | { ok: false; why: string }> {
  const read = await readNoFollow(file)
  if (!('text' in read))
    return {
      ok: false,
      why:
        read.status === 'missing'
          ? `${file} does not exist yet (the account has not been started)`
          : read.why,
    }
  const parsed = parseObject(read.text, file)
  if ('why' in parsed) return { ok: false, why: parsed.why }
  const obj = parsed.obj
  const projects = obj.projects
  if (projects !== undefined && !isObj(projects))
    return { ok: false, why: `projects in ${file} is not an object` }
  const entry = projects?.[key]
  if (entry !== undefined && !isObj(entry))
    return { ok: false, why: `the entry for this folder in ${file} is not an object` }
  const field = entry?.[TRUST_FIELD]
  if (field === true) return { ok: true, already: true }
  if (field !== undefined && field !== false)
    return { ok: false, why: `the trust field for this folder in ${file} is neither true nor false` }
  const before: TrustBefore = entry === undefined ? 'no-entry' : field === undefined ? 'no-field' : 'false'
  // Spreading keeps every key where it was; a key the object did not have goes last.
  const nextEntry = entry === undefined ? { [TRUST_FIELD]: true } : { ...entry, [TRUST_FIELD]: true }
  const next = { ...obj, projects: { ...(projects ?? {}), [key]: nextEntry } }
  await hooks.afterRead?.()
  const wrote = await writeIfUnchanged(file, sha256(read.text), render(next, read.text), 0o600).catch(
    (err: Error) => err,
  )
  if (wrote instanceof Error) return { ok: false, why: `${file} could not be written` }
  if (!wrote) return { ok: false, why: `${file} changed while sideby was writing it` }
  return { ok: true, before }
}

/** One carry sideby made, as its record keeps it (sideby's state folder; never a value of `.claude.json`). */
export interface TrustCarry {
  version: 1
  /** The Account that got the mark. */
  account: string
  /** Its `.claude.json`. */
  file: string
  /** Where that file really was when sideby wrote it: an undo leaves the mark alone once the path leads elsewhere. */
  real: string
  /** The `projects` key sideby set the field under (a folder path). */
  key: string
  before: TrustBefore
  /** The Account whose trust was copied. */
  from: string
  at: string
}

const carriedDir = (stateDir: string, create: boolean) =>
  ownedFolder(stateDir, ['trust', 'carried'], { create, private: create })

const carryName = (file: string, key: string) => `${sha256(`${file}\0${key}`).slice(0, 32)}.json`

function isCarry(v: unknown): v is TrustCarry {
  if (!isObj(v)) return false
  return (
    v.version === 1 &&
    ['account', 'file', 'real', 'key', 'from', 'at'].every((k) => typeof v[k] === 'string') &&
    isAbsolute(v.file as string) &&
    isAbsolute(v.real as string) &&
    ['no-entry', 'no-field', 'false'].includes(v.before as string)
  )
}

/** Every carry sideby recorded, oldest first; a record that cannot be read is left out. */
export async function readCarries(
  stateDir: string,
): Promise<(TrustCarry & { record: string; parked?: true })[]> {
  const dir = await carriedDir(stateDir, false).catch(() => null)
  if (!dir) return []
  const out: (TrustCarry & { record: string; parked?: true })[] = []
  const names = (await readdir(dir).catch(() => [] as string[])).sort()
  for (const name of names) {
    // `<id>.json.undoing` is a record an undo set aside and could not put back: listed, never used to undo.
    const parked = /^[0-9a-f]{32}\.json\.undoing$/.test(name)
    if (!parked && !/^[0-9a-f]{32}\.json$/.test(name)) continue
    if (parked && names.includes(name.slice(0, -'.undoing'.length))) continue
    const carry = await readCarry(join(dir, name))
    if (carry) out.push({ ...carry, record: join(dir, name), ...(parked ? { parked: true as const } : {}) })
  }
  return out.sort(
    (a, b) => a.at.localeCompare(b.at) || `${a.account}\0${a.key}`.localeCompare(`${b.account}\0${b.key}`),
  )
}

/** One carry record, or null when it is gone or not a record. */
async function readCarry(record: string): Promise<TrustCarry | null> {
  const text = await readSmallFile(record, 64 * 1024)
  if (text === undefined) return null
  try {
    const v: unknown = JSON.parse(text)
    return isCarry(v) ? v : null
  } catch {
    return null
  }
}

async function recordCarry(stateDir: string, carry: TrustCarry): Promise<void> {
  const dir = await carriedDir(stateDir, true)
  if (!dir) throw new Error('no state folder')
  await writeFileAtomic(
    join(dir, carryName(carry.file, carry.key)),
    `${JSON.stringify(carry, null, 2)}\n`,
    0o600,
  )
}

/** How long a carry waits for another sideby change of the same `.claude.json`; mutable for tests only. */
export const trustLockWait = { timeoutMs: 2_000, pollMs: 50 }

/** Runs `fn` while no other sideby process changes `file` (the lock Claude settings writers use too). */
async function withFileLock<T>(stateDir: string, file: string, fn: () => Promise<T>): Promise<T | null> {
  const dir = await ownedFolder(stateDir, ['settings-locks'], { create: true })
  if (!dir) return null
  const release = await takeFileLock(join(dir, `${sha256(file).slice(0, 16)}.lock`), {
    staleMs: 15_000,
    beatMs: 3_000,
    wait: { ...trustLockWait },
  })
  if (!release) return null
  try {
    return await fn()
  } finally {
    await release()
  }
}

export interface TrustContext {
  /** Every Claude Account sideby knows (the Main Account included). */
  accounts: readonly Account[]
  /** Where each Account keeps `.claude.json` (the Family's own rule). */
  jsonOf: (account: Account) => string
  home: string
  stateDir: string
}

export type CarryResult =
  /** The folder has no key trust could be carried by (HOME, a root, or sideby cannot tell). */
  | { status: 'no-root' }
  | { status: 'already' }
  /** No other Account trusts the folder: nothing to copy, and nothing is created. */
  | { status: 'none' }
  | { status: 'carried'; key: string; from: string; recordProblem?: boolean }
  | { status: 'skipped'; key: string; from: string; why: string }

/**
 * Before `target` starts in `cwd`: when it does not trust the folder and another Claude Account does, copies that
 * Account's matching key into `target`'s `.claude.json` and records the carry. Reads the other Accounts only when the
 * target lacks trust. Never throws for a file it cannot read or write: the answer says why.
 */
export async function carryTrust(
  ctx: TrustContext,
  target: Account,
  cwd: string,
  opts: { now: Date; hooks?: WriteHooks },
): Promise<CarryResult> {
  const candidates = await trustCandidates(await trustRoot(cwd), ctx.home)
  if (!candidates.length) return { status: 'no-root' }
  const file = ctx.jsonOf(target)
  if (trustedKey(await readTrustKeys(file), candidates)) return { status: 'already' }
  let pick: { key: string; from: Account } | null = null
  const reads = new Map<string, TrustRead>()
  const others = ctx.accounts.filter((a) => a.family === 'claude' && a.ref !== target.ref)
  for (const key of candidates) {
    for (const a of others) {
      const other = ctx.jsonOf(a)
      if (other === file) continue
      if (!reads.has(other)) reads.set(other, await readTrustKeys(other))
      if (trustedKey(reads.get(other)!, [key])) {
        pick = { key, from: a }
        break
      }
    }
    if (pick) break
  }
  if (!pick) return { status: 'none' }
  const { key, from } = pick
  // The file first, the record after, both under the file's lock: a write that failed leaves no record claiming a
  // carry, and an undo running meanwhile cannot remove the record of a carry made after it restored the field.
  let recorded = false
  const done = await withFileLock(ctx.stateDir, file, async () => {
    const real = await realFile(file).catch(() => null)
    if (!real) return { ok: false as const, why: `${file} cannot be read` }
    // Looked at again under the lock: a carry that ran meanwhile already wrote it, and its record stays.
    const now = await readTrustKeys(real)
    // A file sideby cannot read now is not taken for one without trust: nothing changes, the earlier record stays.
    if (now.status !== 'ok')
      return { ok: false as const, why: now.status === 'missing' ? `${file} is not there` : now.why }
    if (trustedKey(now, [key])) return { ok: true as const, already: true as const }
    // A record left from an earlier carry of this folder is stale (the mark it wrote is gone, or this carry would not
    // run): it goes first, so it can never undo with an old `before` if the new record cannot be written. A record
    // folder sideby cannot check is not taken for an empty one.
    let dir: string | null
    try {
      dir = await carriedDir(ctx.stateDir, false)
    } catch {
      return { ok: false as const, why: "sideby's record folder is not safe to use" }
    }
    if (dir) {
      const cleared = await rm(join(dir, carryName(file, key))).then(
        () => true,
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      )
      if (!cleared)
        return { ok: false as const, why: 'sideby could not clear its earlier record of this folder' }
    }
    const wrote = await writeTrust(real, key, opts.hooks)
    if (wrote.ok && !('already' in wrote))
      recorded = await recordCarry(ctx.stateDir, {
        version: 1,
        account: target.ref,
        file,
        real,
        key,
        before: wrote.before,
        from: from.ref,
        at: opts.now.toISOString(),
      })
        .then(() => true)
        .catch(() => false)
    return wrote
  })
  if (!done)
    return {
      status: 'skipped',
      key,
      from: from.ref,
      why: 'another sideby change of the file is still running',
    }
  if (!done.ok) return { status: 'skipped', key, from: from.ref, why: done.why }
  if ('already' in done) return { status: 'already' }
  return { status: 'carried', key, from: from.ref, ...(recorded ? {} : { recordProblem: true }) }
}

/** The one line a Launch prints for a carry, or null when there is nothing to say. `show` shortens a path. */
export function carryLine(r: CarryResult, target: string, show: (p: string) => string): string | null {
  if (r.status === 'carried')
    return `${target} now trusts ${show(r.key)}, as ${r.from} does (claude.carryTrust; undo: sideby trust undo)${r.recordProblem ? '; sideby could not record it, so undo will not find it' : ''}`
  if (r.status === 'skipped')
    return `${target} was not given ${r.from}'s trust of ${show(r.key)}: ${show(r.why)}. Claude Code will ask whether you trust this folder`
  return null
}

/** Each Claude Account's trust of one folder, for `sideby trust`: booleans only, never another `projects` key. */
export interface TrustAccountState {
  ref: string
  /** Absent when sideby cannot tell (the folder is unclear, or the file cannot be read: `problem`). */
  trusts?: boolean
  problem?: string
  /** With the setting on, the next Launch of this Account here copies this Account's trust. */
  carryFrom?: string
}

export async function trustStates(
  ctx: TrustContext,
  cwd: string,
): Promise<{ root: TrustRoot; accounts: TrustAccountState[] }> {
  const root = await trustRoot(cwd)
  const candidates = await trustCandidates(root, ctx.home)
  const list = ctx.accounts.filter((a) => a.family === 'claude')
  const reads = await Promise.all(list.map((a) => readTrustKeys(ctx.jsonOf(a))))
  const trusts = reads.map((r) =>
    r.status === 'ok' && candidates.length ? Boolean(trustedKey(r, candidates)) : undefined,
  )
  const accounts = list.map((a, i): TrustAccountState => {
    const r = reads[i]!
    const own = trusts[i]
    let carryFrom: string | undefined
    // The same pick a Launch makes: the narrowest key, then the first Account that trusts it.
    for (const key of own === false ? candidates : []) {
      const j = list.findIndex(
        (b, k) => k !== i && ctx.jsonOf(b) !== ctx.jsonOf(a) && trustedKey(reads[k]!, [key]),
      )
      if (j >= 0) {
        carryFrom = list[j]!.ref
        break
      }
    }
    return {
      ref: a.ref,
      ...(own === undefined ? {} : { trusts: own }),
      ...(r.status === 'problem' ? { problem: r.why } : {}),
      ...(r.status === 'missing' ? { problem: `${ctx.jsonOf(a)} does not exist yet` } : {}),
      ...(carryFrom ? { carryFrom } : {}),
    }
  })
  return { root, accounts }
}

export type UndoStatus = 'undo' | 'undone' | 'changed' | 'gone' | 'blocked' | 'busy'

export interface UndoItem {
  /** The carry's record (its file name without `.json`): what a confirmation names to undo only what it showed. */
  id: string
  account: string
  key: string
  from: string
  at: string
  status: UndoStatus
  why?: string
}

/**
 * Takes back what one carry wrote, only while the field still holds `true` (what sideby wrote): a field that was
 * absent goes again (with the entry, when sideby made it and nothing else was added to it), one that was `false` is
 * `false` again. Every other key is kept. A change of the field since then is the user's (`changed`).
 */
async function undoOne(
  c: TrustCarry,
  apply: boolean,
  hooks: WriteHooks,
): Promise<{ status: UndoStatus; why?: string }> {
  const real = await realFile(c.file).catch(() => undefined)
  if (real === undefined) return { status: 'blocked', why: `${c.file} cannot be read` }
  if (real !== null && real !== c.real)
    return {
      status: 'blocked',
      why: `${c.file} now leads somewhere else than when sideby wrote it, so sideby left it alone`,
    }
  // From here on only the path sideby wrote: a folder swapped after this check cannot move the write elsewhere.
  const read = await readNoFollow(c.real)
  if (!('text' in read))
    return read.status === 'missing' ? { status: 'gone' } : { status: 'blocked', why: read.why }
  const parsed = parseObject(read.text, c.real)
  if ('why' in parsed) return { status: 'blocked', why: parsed.why }
  const obj = parsed.obj
  const projects = obj.projects
  const entry = isObj(projects) ? projects[c.key] : undefined
  if (!isObj(projects) || !isObj(entry) || entry[TRUST_FIELD] !== true) return { status: 'changed' }
  if (!apply) return { status: 'undo' }
  let nextProjects: Json
  if (c.before === 'false') nextProjects = { ...projects, [c.key]: { ...entry, [TRUST_FIELD]: false } }
  else {
    const { [TRUST_FIELD]: _drop, ...rest } = entry
    if (c.before === 'no-entry' && !Object.keys(rest).length) {
      const { [c.key]: _gone, ...others } = projects
      nextProjects = others
    } else nextProjects = { ...projects, [c.key]: rest }
  }
  await hooks.afterRead?.()
  const wrote = await writeIfUnchanged(
    c.real,
    sha256(read.text),
    render({ ...obj, projects: nextProjects }, read.text),
    0o600,
  ).catch(() => null)
  if (wrote === null) return { status: 'blocked', why: `${c.file} could not be written` }
  return wrote
    ? { status: 'undone' }
    : { status: 'busy', why: `${c.file} changed while sideby was writing it` }
}

/**
 * `sideby trust undo`: every recorded carry, with what undoing it does (`apply` false) or did. A carry that was undone,
 * or whose field the user changed since or whose file is gone, loses its record; one that is blocked or busy keeps it.
 */
export async function undoCarries(
  stateDir: string,
  opts: {
    apply: boolean
    hooks?: WriteHooks
    /** Only these carries, each as shown (`id` and `at`): one made or carried again since is left for another look. */
    only?: readonly { id: string; at: string }[]
  },
): Promise<UndoItem[]> {
  const out: UndoItem[] = []
  const idOf = (record: string) => basename(record).slice(0, 32)
  for (const c of await readCarries(stateDir)) {
    if (opts.only && !opts.only.some((o) => o.id === idOf(c.record) && o.at === c.at)) continue
    const r: { status: UndoStatus; why?: string } = c.parked
      ? {
          status: 'blocked',
          why: `an earlier undo stopped halfway, so sideby will not use this record again (${c.record}); check in Claude Code whether ${c.account} should still trust this folder`,
        }
      : opts.apply
        ? ((await withFileLock(stateDir, c.file, async () => {
            // Read again under the lock: a carry made since the listing replaced this record and is not this one.
            const now = await readCarry(c.record)
            if (!now || now.at !== c.at || now.before !== c.before || now.key !== c.key)
              return {
                status: 'busy' as const,
                why: 'sideby carried this trust again meanwhile; run `sideby trust undo` again',
              }
            // Set the record aside first: when its folder cannot be changed, the mark is not touched either, so no record
            // that could later take back trust the user gave by hand is left behind a successful undo.
            const parked = `${c.record}.undoing`
            try {
              await rename(c.record, parked)
            } catch {
              return {
                status: 'blocked' as const,
                why: `${dirname(c.record)} cannot be changed, so sideby left the trust as it is`,
              }
            }
            const res = await undoOne(c, true, opts.hooks ?? {})
            if (res.status === 'undone' || res.status === 'changed' || res.status === 'gone')
              await rm(parked, { force: true }).catch(() => {}) // a parked name is never used to undo
            else if (
              !(await rename(parked, c.record).then(
                () => true,
                () => false,
              ))
            )
              return {
                status: 'blocked' as const,
                why: `${res.why ?? 'the trust was not changed'}; sideby could not put its record back, so the next \`sideby trust undo\` lists it as stopped halfway`,
              }
            return res
          })) ?? {
            status: 'busy' as const,
            why: 'another sideby change of the file is still running',
          })
        : await undoOne(c, false, {})
    out.push({
      id: idOf(c.record),
      account: c.account,
      key: c.key,
      from: c.from,
      at: c.at,
      status: r.status,
      ...(r.why ? { why: r.why } : {}),
    })
  }
  return out
}

/** What `sideby trust` and the Panel show (spec §3.43). */
export interface TrustStatus {
  /** Config `claude.carryTrust`. */
  on: boolean
  /** The carries sideby recorded and can undo, oldest first. */
  carried: { account: string; key: string; from: string; at: string }[]
  /** The folder asked about (its real path), only while on. */
  dir?: string
  /** Where trust is looked up for it, only while on. */
  root?: { kind: TrustRoot['kind']; path?: string; why?: string }
  /** Each Claude Account's trust of that folder, only while on. */
  accounts?: TrustAccountState[]
}

/** `sideby trust` (spec §3.43): never reads a `.claude.json` while the setting is off. */
export async function trustStatus(ctx: TrustContext, on: boolean, cwd?: string): Promise<TrustStatus> {
  const carried = (await readCarries(ctx.stateDir)).map(({ account, key, from, at }) => ({
    account,
    key,
    from,
    at,
  }))
  if (!on || cwd === undefined) return { on, carried }
  const { root, accounts } = await trustStates(ctx, cwd)
  return {
    on,
    carried,
    dir: root.folder,
    root: root.kind === 'unclear' ? { kind: root.kind, why: root.why } : { kind: root.kind, path: root.path },
    accounts,
  }
}
