// One Claude Account's `settings.json`, as the writers of a single key use it (tune apply, ADR-0012; Remote Control,
// ADR-0017; Cross-session inbound, ADR-0040): where it really lives, a safe read, rendering it back with the file's
// own indentation, the write of one key and its undo record, and `settingsKey`, the write-and-undo of one key.
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../types.ts'
import { lstatOrNull, realpathOrNull, sha256, writeFileAtomic, writeIfUnchanged } from './fs-safe.ts'

const MAX_BYTES = 5_000_000

export type Json = Record<string, unknown>

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)"/m.exec(text)
  if (!m) return 2
  const lead = m[1] as string
  return lead.startsWith('\t') ? '\t' : lead.length
}

export function render(obj: Json, original: string): string {
  const out = JSON.stringify(obj, null, detectIndent(original))
  return original.endsWith('\n') || original === '' ? `${out}\n` : out
}

export async function readObject(file: string): Promise<{ text: string; obj: Json } | { error: string }> {
  const st = await stat(file).catch(() => null)
  if (!st?.isFile()) return { error: 'it is not a regular file' }
  if (st.size > MAX_BYTES) return { error: 'it is too large to be a settings file' }
  const text = await readFile(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: 'it is not valid JSON' }
  }
  if (!isObj(parsed)) return { error: 'it is not a JSON object' }
  return { text, obj: parsed }
}

/** Where the Account's settings really live, and whether `settings.json` is a link to it. */
export async function locate(
  account: Account,
): Promise<{ file: string; link: boolean; exists: boolean; broken?: boolean }> {
  const path = join(account.dir, 'settings.json')
  const lst = await lstatOrNull(path)
  // Every path is canonical (no link anywhere in it), so two Accounts that share a file compare equal and the undo
  // record is found from either of them, even when HOME itself sits behind a link.
  if (!lst) {
    const dir = (await realpathOrNull(account.dir)) ?? account.dir
    return { file: join(dir, 'settings.json'), link: false, exists: false }
  }
  const real = await realpathOrNull(path)
  if (!lst.isSymbolicLink()) return { file: real ?? path, link: false, exists: true }
  return real
    ? { file: real, link: true, exists: true }
    : { file: path, link: true, exists: false, broken: true }
}

/** The Claude Accounts of `accounts` grouped by the real file their `settings.json` is (a link joins its target's). */
export async function settingsFileGroups(
  accounts: readonly Account[],
): Promise<{ file: string; accounts: string[]; where: Awaited<ReturnType<typeof locate>> }[]> {
  const byFile = new Map<
    string,
    { file: string; accounts: string[]; where: Awaited<ReturnType<typeof locate>> }
  >()
  for (const account of accounts) {
    if (account.family !== 'claude') continue
    const where = await locate(account)
    const have = byFile.get(where.file)
    if (have) have.accounts.push(account.ref)
    else byFile.set(where.file, { file: where.file, accounts: [account.ref], where })
  }
  return [...byFile.values()]
}

/**
 * Rewrites one settings file through `writeIfUnchanged`, keeping its mode, every other key and its indentation.
 * `expect` refuses with a message when the file no longer holds what the change assumed. Returns null when written,
 * else what went wrong in plain words.
 */
export async function writeSettingsKey(
  file: string,
  change: (obj: Json) => Json,
  expect: (obj: Json) => string | null,
): Promise<string | null> {
  const read = await readObject(file)
  if ('error' in read) return `settings.json cannot be changed safely: ${read.error}.`
  const refused = expect(read.obj)
  if (refused) return refused
  const mode = (await stat(file)).mode & 0o777
  const wrote = await writeIfUnchanged(
    file,
    sha256(read.text),
    render(change({ ...read.obj }), read.text),
    mode,
  )
  return wrote ? null : 'settings.json changed while sideby was writing, so nothing was changed. Try again.'
}

/** Where sideby keeps the undo record of one key it wrote in `file`: `<state>/<dir>/<hash of file>.json`. */
export const keyRecordPath = (stateDir: string, dir: string, file: string): string =>
  join(stateDir, dir, `${sha256(file).slice(0, 16)}.json`)

/** Writes an undo record (mode 600) under the state directory. */
export async function writeKeyRecord(
  stateDir: string,
  dir: string,
  file: string,
  record: object,
): Promise<void> {
  await mkdir(join(stateDir, dir), { recursive: true })
  await writeFileAtomic(keyRecordPath(stateDir, dir, file), `${JSON.stringify(record, null, 2)}\n`, 0o600)
}

/** The parsed undo record of `file`, or null when there is none or it does not name `file`. */
export async function readKeyRecord(stateDir: string, dir: string, file: string): Promise<Json | null> {
  try {
    const r: unknown = JSON.parse(await readFile(keyRecordPath(stateDir, dir, file), 'utf8'))
    return isObj(r) && r.file === file ? r : null
  } catch {
    return null
  }
}

/** What sideby keeps to undo one key it wrote: whether the key was there, its exact value then, and what it wrote. */
export interface KeyUndo {
  file: string
  hadKey: boolean
  previous?: unknown
  wrote: unknown
  at: string
}

/** One line per settings file a change was meant for. */
export interface KeyResult {
  file: string
  accounts: string[]
  ok: boolean
  message: string
}

/**
 * One top-level key of Claude's settings files that sideby writes for the user and can undo (Remote Control,
 * ADR-0017; Cross-session inbound, ADR-0040). Each write goes through `writeSettingsKey` and leaves an undo record in
 * `<state>/<records>/`; undo puts the old value back (or removes the key) only while it still holds what sideby
 * wrote. `legacyWrote` reads a record from before `wrote` was kept as one that wrote that value.
 */
export function settingsKey(key: string, records: string, opts: { legacyWrote?: unknown } = {}) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const readRecord = async (stateDir: string, file: string): Promise<KeyUndo | null> => {
    const r = await readKeyRecord(stateDir, records, file)
    if (!r) return null
    const wrote = 'wrote' in r ? r.wrote : opts.legacyWrote
    if (wrote === undefined) return null
    // Records from before `hadKey` kept null for a key that was not there.
    const hadKey = typeof r.hadKey === 'boolean' ? r.hadKey : r.previous !== null && r.previous !== undefined
    return { file, hadKey, ...(hadKey ? { previous: r.previous } : {}), wrote, at: String(r.at ?? '') }
  }
  return {
    key,
    /** Whether sideby wrote `obj`'s key in `file` and it still holds that, so undo can put it back. */
    async undoable(stateDir: string, file: string, obj: Json): Promise<boolean> {
      const record = await readRecord(stateDir, file)
      return record !== null && same(obj[key], record.wrote)
    },
    /**
     * Sets the key to `to` in each group, remembering the old value. `expect` gets the value in the file right before
     * the write and refuses with a message when the change no longer fits it.
     */
    async set(
      stateDir: string,
      groups: readonly { file: string; accounts: string[] }[],
      to: unknown,
      expect: (current: unknown) => string | null,
      done: string,
    ): Promise<KeyResult[]> {
      const results: KeyResult[] = []
      for (const g of groups) {
        let before: Pick<KeyUndo, 'hadKey' | 'previous'> = { hadKey: false }
        const failed = await writeSettingsKey(
          g.file,
          (obj) => {
            before = key in obj ? { hadKey: true, previous: obj[key] } : { hadKey: false }
            obj[key] = to
            return obj
          },
          (obj) => expect(obj[key]),
        )
        if (!failed) {
          const record: KeyUndo = { file: g.file, ...before, wrote: to, at: new Date().toISOString() }
          await writeKeyRecord(stateDir, records, g.file, record)
        }
        results.push({ file: g.file, accounts: g.accounts, ok: !failed, message: failed ?? done })
      }
      return results
    },
    /** Puts back what each group had before `set`, only while the key still holds what sideby wrote. */
    async undo(
      stateDir: string,
      groups: readonly { file: string; accounts: string[] }[],
    ): Promise<KeyResult[]> {
      const results: KeyResult[] = []
      for (const g of groups) {
        const record = await readRecord(stateDir, g.file)
        if (!record) continue
        const failed = await writeSettingsKey(
          g.file,
          (obj) => {
            if (record.hadKey) obj[key] = record.previous
            else delete obj[key]
            return obj
          },
          (obj) =>
            same(obj[key], record.wrote)
              ? null
              : 'The setting was changed after sideby set it, so it was left alone.',
        )
        if (!failed) await rm(keyRecordPath(stateDir, records, g.file), { force: true })
        results.push({ file: g.file, accounts: g.accounts, ok: !failed, message: failed ?? 'Put back.' })
      }
      return results
    },
  }
}

/** Why a settings file cannot be read for a change: none there, a link to nothing, or not a safe JSON object. */
export type SettingsProblem = 'no-settings' | 'broken-link' | 'unsafe'

const NO_SETTINGS =
  'this account has no settings.json; run `sideby doctor --fix` so it shares the main one, then try again'

/**
 * Every Claude Account's settings file, grouped as `settingsFileGroups` does, with the parsed object, or the problem
 * and a reason that says what to do (the Panel words it from `why`).
 */
export async function readSettingsGroups(
  accounts: readonly Account[],
): Promise<
  (
    | { file: string; accounts: string[]; obj: Json }
    | { file: string; accounts: string[]; why: SettingsProblem; reason: string }
  )[]
> {
  const out = []
  for (const { file, accounts: refs, where } of await settingsFileGroups(accounts)) {
    if (where.broken)
      out.push({
        file,
        accounts: refs,
        why: 'broken-link' as const,
        reason:
          'settings.json is a link to a file that does not exist; run `sideby doctor` to see how to fix it',
      })
    else if (!where.exists)
      out.push({ file, accounts: refs, why: 'no-settings' as const, reason: NO_SETTINGS })
    else {
      const read = await readObject(where.file)
      out.push(
        'error' in read
          ? {
              file,
              accounts: refs,
              why: 'unsafe' as const,
              reason: `settings.json cannot be changed safely: ${read.error}. Fix or move the file, then try again`,
            }
          : { file, accounts: refs, obj: read.obj },
      )
    }
  }
  return out
}
