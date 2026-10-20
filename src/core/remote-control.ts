// Remote Control at startup (spec §3.22, ADR-0017): reads and writes one key, `remoteControlAtStartup`, of each
// Claude Account's `settings.json`. Accounts that share a file (a link to the Main Account's) form one group and one
// write. Nothing but that key is ever read out of the file into an output, an error or the undo record; writes go
// through `writeIfUnchanged`, keep every other key, and never create, replace or retarget a link.
import { rm } from 'node:fs/promises'
import type { Account, ReadContext } from '../types.ts'
import {
  keyRecordPath,
  readKeyRecord,
  readObject,
  settingsFileGroups,
  writeKeyRecord,
  writeSettingsKey,
} from './claude-settings-file.ts'

export const RC_KEY = 'remoteControlAtStartup'

/**
 * `on`: every session connects by itself; `default`: no key, so the organization's or Claude Code's default decides
 * (it may connect); `off`: never by itself; `missing`: the Account has no `settings.json`; `blocked`: see `reason`.
 */
export type RemoteControlState = 'on' | 'default' | 'off' | 'missing' | 'blocked'

export interface RemoteControlGroup {
  /** The real settings file (canonical); for `missing`, where it would be. */
  file: string
  /** Refs of the Accounts whose `settings.json` is `file`, in discovery order. */
  accounts: string[]
  state: RemoteControlState
  /** For `blocked` and `missing`: why, and what to do. */
  reason?: string
  /** sideby set it here and can put the earlier value back. */
  undo: boolean
}

export interface RemoteControlUndoRecord {
  file: string
  /** The value before sideby wrote, or null when the key was not there. */
  previous: boolean | null
  /** The value sideby wrote; records from before `on` existed lack it and mean `false`. */
  wrote?: boolean
  at: string
}

export interface RemoteControlChange {
  ok: boolean
  /** One line per group that was meant to change. */
  results: { file: string; accounts: string[]; ok: boolean; message: string }[]
  message: string
}

const NO_SETTINGS =
  'this account has no settings.json; run `sideby doctor --fix` so it shares the main one, then try again'

function stateOf(v: unknown): RemoteControlState {
  return v === true ? 'on' : v === false ? 'off' : 'default'
}

const RECORDS = 'remote-control'

const recordPath = (ctx: ReadContext, file: string) => keyRecordPath(ctx.stateDir, RECORDS, file)

async function readRecord(ctx: ReadContext, file: string): Promise<RemoteControlUndoRecord | null> {
  const r = await readKeyRecord(ctx.stateDir, RECORDS, file)
  return r && (r.previous === null || typeof r.previous === 'boolean')
    ? (r as unknown as RemoteControlUndoRecord)
    : null
}

/** Every Claude Account's setting, grouped by the file it lives in. Writes nothing. */
export async function remoteControlGroups(
  accounts: readonly Account[],
  ctx: ReadContext,
): Promise<RemoteControlGroup[]> {
  const out: RemoteControlGroup[] = []
  for (const { file, accounts: refs, where } of await settingsFileGroups(accounts)) {
    const group: RemoteControlGroup = { file, accounts: refs, state: 'missing', undo: false }
    out.push(group)
    if (where.broken) {
      group.state = 'blocked'
      group.reason =
        'settings.json is a link to a file that does not exist; run `sideby doctor` to see how to fix it'
    } else if (!where.exists) {
      group.reason = NO_SETTINGS
    } else {
      const read = await readObject(where.file)
      if ('error' in read) {
        group.state = 'blocked'
        group.reason = `settings.json cannot be changed safely: ${read.error}. Fix or move the file, then try again`
      } else {
        group.state = stateOf(read.obj[RC_KEY])
        const record = await readRecord(ctx, where.file)
        group.undo = record !== null && read.obj[RC_KEY] === (record.wrote ?? false)
      }
    }
  }
  return out
}

/** The groups `off` would change: those that are on, or follow a default that may be on. */
export function groupsToTurnOff(groups: readonly RemoteControlGroup[]): RemoteControlGroup[] {
  return groups.filter((g) => g.state === 'on' || g.state === 'default')
}

/** The groups `on` would change: those that are off, or follow a default that may be off. */
export function groupsToTurnOn(groups: readonly RemoteControlGroup[]): RemoteControlGroup[] {
  return groups.filter((g) => g.state === 'off' || g.state === 'default')
}

const writeKey = writeSettingsKey

/**
 * Sets `remoteControlAtStartup` to `to` in every group that does not hold it yet (a default counts as either),
 * remembering each old value for undo.
 */
export async function setRemoteControl(
  accounts: readonly Account[],
  ctx: ReadContext,
  to: boolean,
): Promise<RemoteControlChange> {
  const groups = await remoteControlGroups(accounts, ctx)
  const todo = to ? groupsToTurnOn(groups) : groupsToTurnOff(groups)
  if (todo.length === 0) {
    const stuck = groups.find((g) => g.state === 'blocked' || (to && g.state === 'missing'))
    return stuck
      ? { ok: false, results: [], message: `Nothing was changed: ${stuck.reason}` }
      : {
          ok: true,
          results: [],
          message: to
            ? 'Remote Control already starts by itself; nothing changed.'
            : 'Remote Control already does not start by itself; nothing changed.',
        }
  }
  const results: RemoteControlChange['results'] = []
  for (const g of todo) {
    let previous: boolean | null = null
    const failed = await writeKey(
      g.file,
      (obj) => {
        previous = typeof obj[RC_KEY] === 'boolean' ? (obj[RC_KEY] as boolean) : null
        obj[RC_KEY] = to
        return obj
      },
      (obj) => (obj[RC_KEY] === to ? `It was turned ${to ? 'on' : 'off'} meanwhile; nothing changed.` : null),
    )
    if (failed) {
      results.push({ file: g.file, accounts: g.accounts, ok: false, message: failed })
      continue
    }
    const record: RemoteControlUndoRecord = {
      file: g.file,
      previous,
      wrote: to,
      at: new Date().toISOString(),
    }
    await writeKeyRecord(ctx.stateDir, RECORDS, g.file, record)
    results.push({ file: g.file, accounts: g.accounts, ok: true, message: to ? 'Turned on.' : 'Turned off.' })
  }
  const ok = results.every((r) => r.ok)
  return {
    ok,
    results,
    message: !ok
      ? 'Some files could not be changed; see each line.'
      : to
        ? 'Done. New sessions connect to claude.ai and the Claude app by themselves, where every device signed in to that account can read them; restart sessions that are already running.'
        : 'Done. New sessions no longer connect to claude.ai by themselves; restart sessions that are already running. You can still start it in a session with /remote-control.',
  }
}

/** Sets `remoteControlAtStartup` to false in every group that is on or follows the default. */
export const turnRemoteControlOff = (accounts: readonly Account[], ctx: ReadContext) =>
  setRemoteControl(accounts, ctx, false)

/** Sets `remoteControlAtStartup` to true in every group that is off or follows the default. */
export const turnRemoteControlOn = (accounts: readonly Account[], ctx: ReadContext) =>
  setRemoteControl(accounts, ctx, true)

/** Groups sideby can put back: it wrote there and the key still holds what it wrote. */
export function groupsToUndo(groups: readonly RemoteControlGroup[]): RemoteControlGroup[] {
  return groups.filter((g) => g.undo)
}

/** Puts back what each file had before `on` or `off`, only while the key still holds what sideby wrote. */
export async function undoRemoteControlOff(
  accounts: readonly Account[],
  ctx: ReadContext,
): Promise<RemoteControlChange> {
  const todo = groupsToUndo(await remoteControlGroups(accounts, ctx))
  if (todo.length === 0) return { ok: false, results: [], message: 'There is nothing from sideby to undo.' }
  const results: RemoteControlChange['results'] = []
  for (const g of todo) {
    const record = await readRecord(ctx, g.file)
    if (!record) continue
    const failed = await writeKey(
      g.file,
      (obj) => {
        if (record.previous === null) delete obj[RC_KEY]
        else obj[RC_KEY] = record.previous
        return obj
      },
      (obj) =>
        obj[RC_KEY] === (record.wrote ?? false)
          ? null
          : 'The setting was changed after sideby set it, so it was left alone.',
    )
    if (!failed) await rm(recordPath(ctx, g.file), { force: true })
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
