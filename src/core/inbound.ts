// Cross-session inbound (spec §3.32 step 2, ADR-0040): reads and writes one key, `crossSessionInbound`, of each
// Claude Account's `settings.json`. It decides what a session does with a Message from another session: `accept`
// shows it at once, `hold` waits for the user to approve it in the session's terminal (and drops it after about five
// minutes), `refuse` drops it. Writes follow Remote Control's rules (spec §3.22): a preview first, `writeIfUnchanged`,
// every other key kept, a shared file written once at its real target, never a settings.json created, and undo only
// while the key still holds what sideby wrote. A `refuse` the user chose is never changed.
import { argsBypass } from '../families/claude/messaging.ts'
import type { Account, CheckResult, ReadContext } from '../types.ts'
import {
  isObj,
  locate,
  readObject,
  readSettingsGroups,
  type SettingsProblem,
  settingsKey,
} from './claude-settings-file.ts'

export const INBOUND_KEY = 'crossSessionInbound'
const inbound = settingsKey(INBOUND_KEY, 'cross-session-inbound')

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
  /** For `blocked`, `missing`, `refuse` and `other`: why, as a code the Panel words in its language. */
  why?: SettingsProblem | 'refuse' | 'other'
  /** For `blocked`, `missing`, `refuse` and `other`: why, and what to do. */
  reason?: string
  /** sideby set it here and can put the earlier value back. */
  undo: boolean
}

export interface InboundChange {
  ok: boolean
  results: { file: string; accounts: string[]; ok: boolean; message: string }[]
  message: string
}

const REFUSE =
  'you set it to refuse, so sideby leaves it alone; Messages to these sessions need pasting. To get them, set "crossSessionInbound": "accept" in this file yourself'
const OTHER =
  'it holds a value sideby does not know, so sideby leaves it alone; set "crossSessionInbound" to "accept" in this file yourself, or remove the key and run `sideby messages inbound accept` again'

export function inboundStateOf(v: unknown): InboundState {
  if (v === undefined) return 'default'
  return v === 'accept' || v === 'hold' || v === 'refuse' ? v : 'other'
}

/** Every Claude Account's setting, grouped by the file it lives in. Reads only the one key; writes nothing. */
export async function inboundGroups(accounts: readonly Account[], ctx: ReadContext): Promise<InboundGroup[]> {
  const out: InboundGroup[] = []
  for (const g of await readSettingsGroups(accounts)) {
    if ('why' in g) {
      const state = g.why === 'no-settings' ? 'missing' : 'blocked'
      out.push({ file: g.file, accounts: g.accounts, state, why: g.why, reason: g.reason, undo: false })
      continue
    }
    const state = inboundStateOf(g.obj[INBOUND_KEY])
    const why = state === 'refuse' || state === 'other' ? state : undefined
    out.push({
      file: g.file,
      accounts: g.accounts,
      state,
      ...(why ? { why, reason: why === 'refuse' ? REFUSE : OTHER } : {}),
      undo: await inbound.undoable(ctx.stateDir, g.file, g.obj),
    })
  }
  return out
}

/** The setting of one Account (`default` when it cannot be read: Claude Code then uses its default as well). */
export async function inboundOf(account: Account, ctx: ReadContext): Promise<InboundState> {
  const [g] = await inboundGroups([account], ctx)
  return g?.state ?? 'default'
}

/**
 * The settings files whose sessions hold a Message for approval (ADR-0045): set to `hold`, or not set while one of
 * its Accounts starts in bypass permission mode (doctor's `messages.inbound-held`). Reads what doctor reads.
 */
export async function waitingFiles(
  groups: readonly InboundGroup[],
  accounts: readonly Account[],
  starts: (a: Account) => readonly (readonly string[])[],
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const g of groups) {
    if (g.state === 'hold') out.add(g.file)
    if (g.state !== 'default') continue
    for (const a of accounts.filter((x) => g.accounts.includes(x.ref)))
      if ((await inboundFindings(a, starts(a))).length) {
        out.add(g.file)
        break
      }
  }
  return out
}

/**
 * The groups `accept` would change: not set, or `hold`. A `refuse` or a value sideby does not know is left alone.
 * Self-contained, so the Panel page runs this same function (page-script.ts).
 */
export function groupsToAccept<G extends { state: string }>(groups: readonly G[]): G[] {
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
  const results = await inbound.set(
    ctx.stateDir,
    todo,
    'accept',
    (v) =>
      v === undefined || v === 'hold'
        ? null
        : v === 'accept'
          ? 'It was set to accept meanwhile; nothing changed.'
          : 'It was changed meanwhile, so sideby left it alone.',
    'Set to accept.',
  )
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
  const results = await inbound.undo(ctx.stateDir, todo)
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
