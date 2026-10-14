// Applying a Tuning Suggestion: writes one key, `autoCompactWindow`, of an Account's `settings.json` (spec §3.18,
// ADR-0012). Everything else in the file is kept, nothing but that key is ever read out of it into an output, an
// error or the undo record, and the write goes through `writeIfUnchanged`. A symlinked `settings.json` (settings
// shared with the Main Account) is written at the real file it points to, and the plan names every Account that
// shares it; a link is never created, replaced or retargeted.
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, ReadContext } from '../types.ts'
import { UserError } from './errors.ts'
import {
  fileHash,
  lstatOrNull,
  realpathOrNull,
  sha256,
  writeFileAtomic,
  writeIfUnchanged,
} from './fs-safe.ts'
import { MAX_COMPACT_WINDOW, MIN_COMPACT_WINDOW } from './tuning.ts'

export const TUNE_KEY = 'autoCompactWindow'
export const MIN_WINDOW = MIN_COMPACT_WINDOW
export const MAX_WINDOW = MAX_COMPACT_WINDOW
const MAX_BYTES = 5_000_000

export interface TuneApplyPlan {
  /** `ready`: will write; `unchanged`: already that value; `blocked`: `reason` says why and what to do. */
  status: 'ready' | 'unchanged' | 'blocked'
  /** The real file that will be written. */
  file: string
  /** The Account's `settings.json` is a link to `file`. */
  link: boolean
  /** Refs of the Accounts whose `settings.json` is `file`, the planned Account first. */
  affected: string[]
  /** The value in the file now, or null when the key is not there. */
  current: number | null
  /** The size to set, or null to go back to the default (the key is removed). */
  next: number | null
  /** The file does not exist yet and will be created. */
  creates: boolean
  /** Models that save a size of their own (`modelSettings`), which wins over this one for them. */
  overrides: ModelOverride[]
  reason?: string
}

export interface ModelOverride {
  model: string
  value: number
}

export interface TuneUndoRecord {
  file: string
  /** The value before sideby wrote, or null when the key was not there. */
  previous: number | null
  /** The value written; null when the default was restored (the key removed). */
  applied: number | null
  /** sideby created the file. */
  created: boolean
  at: string
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function checkValue(value: number | null): void {
  if (value === null) return
  if (!Number.isInteger(value) || value < MIN_WINDOW || value > MAX_WINDOW)
    throw new UserError(
      `${value} is not a usable size: give a whole number of tokens from ${MIN_WINDOW} to ${MAX_WINDOW}, for example 160000`,
      { code: 'bad-value' },
    )
}

function detectIndent(text: string): string | number {
  const m = /^([ \t]+)"/m.exec(text)
  if (!m) return 2
  const lead = m[1] as string
  return lead.startsWith('\t') ? '\t' : lead.length
}

function render(obj: Json, original: string): string {
  const out = JSON.stringify(obj, null, detectIndent(original))
  return original.endsWith('\n') || original === '' ? `${out}\n` : out
}

async function readObject(file: string): Promise<{ text: string; obj: Json } | { error: string }> {
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

/** The sizes models save for themselves under `modelSettings`: only those `autoCompactWindow` numbers are read. */
function overridesOf(obj: Json): ModelOverride[] {
  const ms = obj.modelSettings
  if (!isObj(ms)) return []
  const out: ModelOverride[] = []
  for (const [model, entry] of Object.entries(ms)) {
    const v = isObj(entry) ? entry[TUNE_KEY] : undefined
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ model, value: v })
  }
  return out
}

/** Where the Account's settings really live, and whether `settings.json` is a link to it. */
async function locate(
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

function recordPath(ctx: ReadContext, file: string): string {
  return join(ctx.stateDir, 'tune', `${sha256(file).slice(0, 16)}.json`)
}

async function readRecord(ctx: ReadContext, file: string): Promise<TuneUndoRecord | null> {
  try {
    const r = JSON.parse(await readFile(recordPath(ctx, file), 'utf8')) as Partial<TuneUndoRecord>
    if (
      r.file === file &&
      (r.applied === null || typeof r.applied === 'number') &&
      (r.previous === null || typeof r.previous === 'number')
    )
      return r as TuneUndoRecord
  } catch {
    // no record
  }
  return null
}

/** What applying `value` to the Account would do. Writes nothing. */
export async function planTuneApply(
  account: Account,
  value: number | null,
  accounts: readonly Account[],
): Promise<TuneApplyPlan> {
  checkValue(value)
  const where = await locate(account)
  const base = {
    file: where.file,
    link: where.link,
    affected: [account.ref],
    current: null,
    next: value,
    creates: false,
    overrides: [] as ModelOverride[],
  }
  if (where.broken)
    return {
      ...base,
      status: 'blocked',
      reason: 'settings.json is a link to a file that does not exist; fix the link first',
    }
  if (!where.exists)
    return { ...base, status: value === null ? 'unchanged' : 'ready', creates: value !== null }
  const read = await readObject(where.file)
  if ('error' in read)
    return {
      ...base,
      status: 'blocked',
      reason: `settings.json cannot be changed safely: ${read.error}. Fix or move the file, then try again`,
    }
  const have = read.obj[TUNE_KEY]
  const current = typeof have === 'number' && Number.isFinite(have) ? have : null
  const affected = [account.ref]
  for (const other of accounts) {
    if (other.ref === account.ref) continue
    const loc = await locate(other)
    if (loc.exists && loc.file === where.file) affected.push(other.ref)
  }
  return {
    ...base,
    affected,
    current,
    overrides: overridesOf(read.obj),
    status: current === value ? 'unchanged' : 'ready',
  }
}

export interface TuneChange {
  ok: boolean
  message: string
  plan: TuneApplyPlan
}

/** Plans, and writes only when the plan is `ready`. */
export async function applyTune(
  account: Account,
  value: number | null,
  accounts: readonly Account[],
  ctx: ReadContext,
): Promise<TuneChange> {
  const plan = await planTuneApply(account, value, accounts)
  if (plan.status === 'blocked') return { ok: false, plan, message: plan.reason ?? 'blocked' }
  if (plan.status === 'unchanged')
    return { ok: true, plan, message: 'It is already set to that value; nothing changed.' }
  let before: string | null = null
  let obj: Json = {}
  let mode = 0o600
  if (!plan.creates) {
    const read = await readObject(plan.file)
    if ('error' in read) return { ok: false, plan, message: `settings.json changed: ${read.error}` }
    before = read.text
    obj = read.obj
    mode = (await stat(plan.file)).mode & 0o777
  }
  const have = typeof obj[TUNE_KEY] === 'number' ? (obj[TUNE_KEY] as number) : null
  // Applying again over what sideby itself wrote keeps the original value, so one undo goes all the way back.
  const earlier = await readRecord(ctx, plan.file)
  const chained = earlier !== null && (earlier.applied ?? null) === have
  const previous = chained ? earlier.previous : have
  const changed: Json = { ...obj }
  if (value === null) delete changed[TUNE_KEY]
  else changed[TUNE_KEY] = value
  const next = render(changed, before ?? '')
  const wrote = await writeIfUnchanged(plan.file, before === null ? null : sha256(before), next, mode)
  if (!wrote)
    return {
      ok: false,
      plan,
      message: 'settings.json changed while sideby was writing, so nothing was changed. Try again.',
    }
  const record: TuneUndoRecord = {
    file: plan.file,
    previous,
    applied: value,
    created: chained ? earlier.created : plan.creates,
    at: new Date().toISOString(),
  }
  await mkdir(join(ctx.stateDir, 'tune'), { recursive: true })
  await writeFileAtomic(recordPath(ctx, plan.file), `${JSON.stringify(record, null, 2)}\n`, 0o600)
  return {
    ok: true,
    plan,
    message: 'Done. New sessions use it; sessions already running keep the old value.',
  }
}

/** What could be undone for the Account: the record, only while the key still holds the value sideby wrote. */
export async function tuneUndoInfo(account: Account, ctx: ReadContext): Promise<TuneUndoRecord | null> {
  const where = await locate(account)
  if (!where.exists) return null
  const record = await readRecord(ctx, where.file)
  if (!record) return null
  const read = await readObject(where.file)
  if ('error' in read || (read.obj[TUNE_KEY] ?? null) !== record.applied) return null
  return record
}

/** Puts the key back as it was, only while it still holds what sideby wrote. */
export async function undoTune(
  account: Account,
  ctx: ReadContext,
): Promise<{ ok: boolean; message: string }> {
  const where = await locate(account)
  const record = where.exists ? await readRecord(ctx, where.file) : null
  if (!record) return { ok: false, message: 'There is nothing from sideby to undo for this account.' }
  const read = await readObject(where.file)
  if ('error' in read) return { ok: false, message: `settings.json cannot be changed safely: ${read.error}.` }
  if ((read.obj[TUNE_KEY] ?? null) !== record.applied)
    return { ok: false, message: 'The setting was changed after sideby set it, so it was left alone.' }
  const obj: Json = { ...read.obj }
  if (record.previous === null) delete obj[TUNE_KEY]
  else obj[TUNE_KEY] = record.previous
  if (record.created && Object.keys(obj).length === 0) {
    // Same care as a write: delete only if the file is still what was read.
    if ((await fileHash(where.file)) !== sha256(read.text))
      return {
        ok: false,
        message: 'settings.json changed while sideby was working, so nothing was changed. Try again.',
      }
    await rm(where.file, { force: true })
  } else {
    const mode = (await stat(where.file)).mode & 0o777
    const wrote = await writeIfUnchanged(where.file, sha256(read.text), render(obj, read.text), mode)
    if (!wrote)
      return {
        ok: false,
        message: 'settings.json changed while sideby was writing, so nothing was changed. Try again.',
      }
  }
  await rm(recordPath(ctx, where.file), { force: true })
  return { ok: true, message: 'Undone. New sessions go back to the previous setting.' }
}

/** The real file an Account's setting lives in (canonical, so Accounts sharing it get the same answer). */
export async function settingsFileOf(account: Account): Promise<string> {
  return (await locate(account)).file
}

/**
 * The size in the Account's settings file now (null: the default) and the sizes models save for themselves. Reads
 * only those `autoCompactWindow` numbers.
 */
export async function readTuneSettings(
  account: Account,
): Promise<{ current: number | null; overrides: ModelOverride[] }> {
  const where = await locate(account)
  if (!where.exists) return { current: null, overrides: [] }
  const read = await readObject(where.file)
  if ('error' in read) return { current: null, overrides: [] }
  const v = read.obj[TUNE_KEY]
  return {
    current: typeof v === 'number' && Number.isFinite(v) ? v : null,
    overrides: overridesOf(read.obj),
  }
}
