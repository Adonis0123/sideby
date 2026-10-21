// Remote Control at startup (spec §3.22, ADR-0017): reads and writes one key, `remoteControlAtStartup`, of each
// Claude Account's `settings.json`. Accounts that share a file (a link to the Main Account's) form one group and one
// write. Nothing but that key is ever read out of the file into an output, an error or the undo record; writes go
// through `writeIfUnchanged`, keep every other key, and never create, replace or retarget a link.
import type { Account, ReadContext } from '../types.ts'
import { readSettingsGroups, type SettingsProblem, settingsKey } from './claude-settings-file.ts'

export const RC_KEY = 'remoteControlAtStartup'
// Records from before `on` existed lack `wrote` and mean `false`.
const rc = settingsKey(RC_KEY, 'remote-control', { legacyWrote: false })

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
  /** For `blocked` and `missing`: why, as a code the Panel words in its language. */
  why?: SettingsProblem
  /** For `blocked` and `missing`: why, and what to do. */
  reason?: string
  /** sideby set it here and can put the earlier value back. */
  undo: boolean
}

export interface RemoteControlChange {
  ok: boolean
  /** One line per group that was meant to change. */
  results: { file: string; accounts: string[]; ok: boolean; message: string }[]
  message: string
}

function stateOf(v: unknown): RemoteControlState {
  return v === true ? 'on' : v === false ? 'off' : 'default'
}

/** Every Claude Account's setting, grouped by the file it lives in. Writes nothing. */
export async function remoteControlGroups(
  accounts: readonly Account[],
  ctx: ReadContext,
): Promise<RemoteControlGroup[]> {
  const out: RemoteControlGroup[] = []
  for (const g of await readSettingsGroups(accounts)) {
    if ('why' in g)
      out.push({
        file: g.file,
        accounts: g.accounts,
        state: g.why === 'no-settings' ? 'missing' : 'blocked',
        why: g.why,
        reason: g.reason,
        undo: false,
      })
    else
      out.push({
        file: g.file,
        accounts: g.accounts,
        state: stateOf(g.obj[RC_KEY]),
        undo: await rc.undoable(ctx.stateDir, g.file, g.obj),
      })
  }
  return out
}

/**
 * The groups `on` or `off` would change: those that do not hold that side yet, a default counting as either. Self-
 * contained, so the Panel page runs this same function (page-script.ts).
 */
export function remoteControlTodo<G extends { state: string }>(groups: readonly G[], to: 'on' | 'off'): G[] {
  return groups.filter((g) => g.state === 'default' || g.state === (to === 'on' ? 'off' : 'on'))
}

/** What `on`, `off` or `undo` says when no file needs it: always `ok: false`, so the CLI exits 1. */
export function remoteControlNothingToDo(
  action: 'on' | 'off' | 'undo',
  groups: readonly RemoteControlGroup[],
): RemoteControlChange {
  if (action === 'undo') return { ok: false, results: [], message: 'There is nothing from sideby to undo.' }
  if (!groups.length)
    return { ok: false, results: [], message: 'No Claude accounts found, so nothing was changed.' }
  const stuck = groups.find((g) => g.state === 'blocked' || (action === 'on' && g.state === 'missing'))
  return {
    ok: false,
    results: [],
    message: stuck
      ? `Nothing was changed: ${stuck.reason}`
      : action === 'on'
        ? 'Remote Control already starts by itself (already on, nothing changed).'
        : 'Remote Control already does not start by itself (already off, nothing changed).',
  }
}

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
  const todo = remoteControlTodo(groups, to ? 'on' : 'off')
  if (todo.length === 0) return remoteControlNothingToDo(to ? 'on' : 'off', groups)
  const results = await rc.set(
    ctx.stateDir,
    todo,
    to,
    (v) => (v === to ? `It was turned ${to ? 'on' : 'off'} meanwhile; nothing changed.` : null),
    to ? 'Turned on.' : 'Turned off.',
  )
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
  if (todo.length === 0) return remoteControlNothingToDo('undo', [])
  const results = await rc.undo(ctx.stateDir, todo)
  const ok = results.length > 0 && results.every((r) => r.ok)
  return {
    ok,
    results,
    message: ok
      ? 'Undone. New sessions go back to the previous setting.'
      : 'Some files could not be put back; see each line.',
  }
}
