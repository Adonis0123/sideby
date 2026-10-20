// Cross-session inbound (spec §3.32 step 2, ADR-0040): reads and writes one key, `crossSessionInbound`, of each
// Claude Account's `settings.json`. It decides what a session does with a Message from another session: `accept`
// shows it at once, `hold` waits for the user to approve it in the session's terminal (and drops it after about five
// minutes), `refuse` drops it. Writes follow Remote Control's rules (spec §3.22): a preview first, `writeIfUnchanged`,
// every other key kept, a shared file written once at its real target, never a settings.json created, and undo only
// while the key still holds what sideby wrote. A `refuse` the user chose is never changed.
import { rm } from 'node:fs/promises'
import { argsBypass } from '../families/claude/messaging.ts'
import type { Account, CheckResult, ReadContext } from '../types.ts'
import {
  isObj,
  keyRecordPath,
  locate,
  readKeyRecord,
  readObject,
  settingsFileGroups,
  writeKeyRecord,
  writeSettingsKey,
} from './claude-settings-file.ts'

export const INBOUND_KEY = 'crossSessionInbound'
const RECORDS = 'cross-session-inbound'

/**
 * `accept`, `hold`, `refuse`: the key holds that value; `default`: no key, so Claude Code's default decides (a session
 * in bypass permission mode holds Messages); `other`: a value sideby does not know; `missing`: no `settings.json`;
 * `blocked`: see `reason`.
 */
export type InboundState = 'accept' | 'hold' | 'refuse' | 'default' | 'other' | 'missing' | 'blocked'

export interface InboundGroup {
  /** The real settings file (canonical); for `missing`, where it would be. */
  file: string
  /** Refs of the Accounts whose `settings.json` is `file`, in discovery order. */
  accounts: string[]
  state: InboundState
  /** For `blocked`, `missing` and `refuse`: why, and what to do. */
  reason?: string
  /** sideby set it here and can put the earlier value back. */
  undo: boolean
}

export interface InboundChange {
  ok: boolean
  results: { file: string; accounts: string[]; ok: boolean; message: string }[]
  message: string
}

interface UndoRecord {
  file: string
  /** Whether the key was there before sideby wrote. */
  hadKey: boolean
  /** Its exact value then, when it was there. */
  previous?: unknown
  wrote: string
  at: string
}

const NO_SETTINGS =
  'this account has no settings.json; run `sideby doctor --fix` so it shares the main one, then try again'
const REFUSE =
  'you set it to refuse, so sideby leaves it alone; Messages to these sessions need pasting. To get them, set "crossSessionInbound": "accept" in this file yourself'
const OTHER =
  'it holds a value sideby does not know, so sideby leaves it alone; set "crossSessionInbound" to "accept" in this file yourself, or remove the key and run `sideby messages inbound accept` again'

export function inboundStateOf(v: unknown): InboundState {
  if (v === undefined) return 'default'
  return v === 'accept' || v === 'hold' || v === 'refuse' ? v : 'other'
}

async function readRecord(ctx: ReadContext, file: string): Promise<UndoRecord | null> {
  const r = await readKeyRecord(ctx.stateDir, RECORDS, file)
  return r && typeof r.wrote === 'string' && typeof r.hadKey === 'boolean'
    ? (r as unknown as UndoRecord)
    : null
}

/** Every Claude Account's setting, grouped by the file it lives in. Reads only the one key; writes nothing. */
export async function inboundGroups(accounts: readonly Account[], ctx: ReadContext): Promise<InboundGroup[]> {
  const out: InboundGroup[] = []
  for (const { file, accounts: refs, where } of await settingsFileGroups(accounts)) {
    const group: InboundGroup = { file, accounts: refs, state: 'missing', undo: false }
    out.push(group)
    if (where.broken) {
      group.state = 'blocked'
      group.reason =
        'settings.json is a link to a file that does not exist; run `sideby doctor` to see how to fix it'
    } else if (!where.exists) group.reason = NO_SETTINGS
    else {
      const read = await readObject(where.file)
      if ('error' in read) {
        group.state = 'blocked'
        group.reason = `settings.json cannot be changed safely: ${read.error}. Fix or move the file, then try again`
      } else {
        group.state = inboundStateOf(read.obj[INBOUND_KEY])
        if (group.state === 'refuse') group.reason = REFUSE
        if (group.state === 'other') group.reason = OTHER
        const record = await readRecord(ctx, where.file)
        group.undo = record !== null && read.obj[INBOUND_KEY] === record.wrote
      }
    }
  }
  return out
}

/** The setting of one Account (`default` when it cannot be read: Claude Code then uses its default as well). */
export async function inboundOf(account: Account, ctx: ReadContext): Promise<InboundState> {
  const [g] = await inboundGroups([account], ctx)
  return g?.state ?? 'default'
}

/** The groups `accept` would change: not set, or `hold`. A `refuse` or a value sideby does not know is left alone. */
export function groupsToAccept(groups: readonly InboundGroup[]): InboundGroup[] {
  return groups.filter((g) => g.state === 'default' || g.state === 'hold')
}

/** The groups `accept` leaves alone and why: refused, unknown, blocked or without a settings file. */
export function inboundLeftAlone(groups: readonly InboundGroup[]): InboundGroup[] {
  return groups.filter((g) => g.state !== 'accept' && g.state !== 'default' && g.state !== 'hold')
}

const leftAloneLines = (groups: readonly InboundGroup[]) =>
  inboundLeftAlone(groups).map((g) => `${g.accounts.join(', ')}: ${g.reason}`)

/** Groups sideby can put back: it wrote there and the key still holds what it wrote. */
export function inboundGroupsToUndo(groups: readonly InboundGroup[]): InboundGroup[] {
  return groups.filter((g) => g.undo)
}

/**
 * What `accept` or `undo` says when `groups` leave it nothing to do. Pure: the preview path uses it, so a run without
 * `--yes` never writes, even when a file changes after this read. A run that changes nothing is not `ok` (exit 1).
 */
export function inboundNothingToDo(
  action: 'accept' | 'undo',
  groups: readonly InboundGroup[],
): InboundChange {
  if (action === 'undo') return { ok: false, results: [], message: 'There is nothing from sideby to undo.' }
  if (!groups.length)
    return { ok: false, results: [], message: 'No Claude accounts found, so nothing was changed.' }
  const left = leftAloneLines(groups)
  return {
    ok: false,
    results: [],
    message: left.length
      ? `Nothing was changed. ${left.join('. ')}.`
      : 'Claude sessions already show Messages from other sessions at once (already accept, nothing changed).',
  }
}

/** Sets `crossSessionInbound` to `accept` in every group `groupsToAccept` names, remembering each old value. */
export async function acceptInbound(accounts: readonly Account[], ctx: ReadContext): Promise<InboundChange> {
  const groups = await inboundGroups(accounts, ctx)
  const todo = groupsToAccept(groups)
  if (todo.length === 0) return inboundNothingToDo('accept', groups)
  const results: InboundChange['results'] = []
  for (const g of todo) {
    let before: Pick<UndoRecord, 'hadKey' | 'previous'> = { hadKey: false }
    const failed = await writeSettingsKey(
      g.file,
      (obj) => {
        before = INBOUND_KEY in obj ? { hadKey: true, previous: obj[INBOUND_KEY] } : { hadKey: false }
        obj[INBOUND_KEY] = 'accept'
        return obj
      },
      (obj) =>
        obj[INBOUND_KEY] === undefined || obj[INBOUND_KEY] === 'hold'
          ? null
          : obj[INBOUND_KEY] === 'accept'
            ? 'It was set to accept meanwhile; nothing changed.'
            : 'It was changed meanwhile, so sideby left it alone.',
    )
    if (failed) {
      results.push({ file: g.file, accounts: g.accounts, ok: false, message: failed })
      continue
    }
    const record: UndoRecord = { file: g.file, ...before, wrote: 'accept', at: new Date().toISOString() }
    await writeKeyRecord(ctx.stateDir, RECORDS, g.file, record)
    results.push({ file: g.file, accounts: g.accounts, ok: true, message: 'Set to accept.' })
  }
  const ok = results.every((r) => r.ok)
  const left = leftAloneLines(groups)
  return {
    ok,
    results,
    message:
      (ok
        ? 'Done. New sessions show Messages from other sessions at once, also in bypass permission mode; restart sessions that are already running. Undo it with `sideby messages inbound undo`.'
        : 'Some files could not be changed; see each line.') +
      (left.length ? ` Left alone: ${left.join('. ')}.` : ''),
  }
}

/** Puts back what each file had before `acceptInbound`, only while the key still holds what sideby wrote. */
export async function undoInbound(accounts: readonly Account[], ctx: ReadContext): Promise<InboundChange> {
  const groups = await inboundGroups(accounts, ctx)
  const todo = inboundGroupsToUndo(groups)
  if (todo.length === 0) return inboundNothingToDo('undo', groups)
  const results: InboundChange['results'] = []
  for (const g of todo) {
    const record = await readRecord(ctx, g.file)
    if (!record) continue
    const failed = await writeSettingsKey(
      g.file,
      (obj) => {
        if (!record.hadKey) delete obj[INBOUND_KEY]
        else obj[INBOUND_KEY] = record.previous
        return obj
      },
      (obj) =>
        obj[INBOUND_KEY] === record.wrote
          ? null
          : 'The setting was changed after sideby set it, so it was left alone.',
    )
    if (!failed) await rm(keyRecordPath(ctx.stateDir, RECORDS, g.file), { force: true })
    results.push({ file: g.file, accounts: g.accounts, ok: !failed, message: failed ?? 'Put back.' })
  }
  const ok = results.length > 0 && results.every((r) => r.ok)
  return {
    ok,
    results,
    message: ok
      ? 'Undone. New sessions go back to the previous setting.'
      : 'Some files could not be put back; see each line.',
  }
}

/**
 * Doctor's warning (spec §3.32 step 2): the Account starts its sessions in bypass permission mode (one of `starts`,
 * its short commands' and config arguments, or `permissions.defaultMode` in its settings) while
 * `crossSessionInbound` is not `accept`, so a Message from another session waits for approval and is dropped after
 * about five minutes. Not fixable by `doctor --fix`: the file may be shared with other Accounts, so the fix is the
 * previewed `sideby messages inbound accept`. Reads only `crossSessionInbound` and `permissions.defaultMode`.
 */
export async function inboundFindings(
  account: Account,
  starts: readonly (readonly string[])[],
): Promise<CheckResult[]> {
  if (account.family !== 'claude') return []
  const where = await locate(account)
  if (!where.exists) return []
  const read = await readObject(where.file)
  if ('error' in read) return []
  const state = inboundStateOf(read.obj[INBOUND_KEY])
  if (state === 'accept' || state === 'refuse') return []
  const perms = read.obj.permissions
  const bypass =
    starts.some((args) => argsBypass(args)) || (isObj(perms) && perms.defaultMode === 'bypassPermissions')
  if (!bypass) return []
  return [
    {
      level: 'warn',
      item: 'settings.json',
      code: 'messages.inbound-held',
      message: `${account.ref} starts in bypass permission mode, so a message from another session waits for approval in its terminal and is dropped after about 5 minutes`,
      hint: 'run `sideby messages inbound accept` so its sessions show messages at once (it shows the change first)',
    },
  ]
}
