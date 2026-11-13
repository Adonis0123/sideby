// Advisor (spec §3.41, ADR-0074): Claude Code's advisor lets a session ask a stronger model for advice at key moments.
// sideby reads two things of each Claude subscription Account's `settings.json` (grouped by the real file, as Remote
// Control does, ADR-0017): the top-level `advisorModel`, and whether `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is
// true, which makes Claude Code hide the advisor. Choosing a model writes `advisorModel` and, where that variable stands
// in the way, removes it, in one confirmed write with one undo record. No other key or `env` entry is ever read into an
// output, an error or the undo record; writes go through `writeIfUnchanged`, keep every other key and `env` entry, and
// never create, replace or retarget a link. While config `advisor.unlock` is on, sideby also unlocks the advisor at
// launch with one environment variable.
import { rm } from 'node:fs/promises'
import type { Account, Env, ReadContext } from '../types.ts'
import {
  isObj,
  type Json,
  type KeyResult,
  keyRecordPath,
  readKeyRecord,
  readSettingsGroups,
  type SettingsProblem,
  writeKeyRecord,
  writeSettingsKey,
} from './claude-settings-file.ts'
import { editConfigAdvisor } from './config.ts'
import { UserError } from './errors.ts'

export const ADVISOR_KEY = 'advisorModel'
/** The aliases Claude Code's `/advisor` takes, in the order the Panel and the CLI show them. */
export const ADVISOR_MODELS = ['fable', 'opus', 'sonnet'] as const
export type AdvisorModel = (typeof ADVISOR_MODELS)[number]
export type AdvisorChoice = AdvisorModel | 'off'
export const ADVISOR_CHOICES: readonly AdvisorChoice[] = [...ADVISOR_MODELS, 'off']
export const isAdvisorChoice = (v: unknown): v is AdvisorChoice =>
  typeof v === 'string' && (ADVISOR_CHOICES as readonly string[]).includes(v)

/** Set at launch while config `advisor.unlock` is on: Claude Code then offers the advisor without waiting for Anthropic's rollout. */
export const ADVISOR_UNLOCK_VAR = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
/**
 * Turns off every experimental feature of Claude Code, the advisor among them, also with `ADVISOR_UNLOCK_VAR` set
 * (tried with Claude Code 2.1.322 on 2026-11-13). Users often keep it in a settings file's `env`.
 */
export const BETAS_VAR = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
/** Variables that make Claude Code hide the advisor whatever else is set. sideby never changes them in the shell. */
export const ADVISOR_OFF_VARS = ['CLAUDE_CODE_DISABLE_ADVISOR_TOOL', BETAS_VAR] as const

const TITLE: Record<AdvisorModel, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet' }
const RECORDS = 'advisor'
const ENV_NOT_OBJECT =
  'settings.json has an `env` that is not a JSON object; fix it in the file, then try again'

/**
 * A model alias: the advisor asks that model; `other`: a value sideby does not offer (a full model id, kept in `model`
 * when it looks like one); `off`: not set or empty; `missing`: the Account has no `settings.json`; `blocked`: see
 * `reason`.
 */
export type AdvisorState = AdvisorModel | 'other' | 'off' | 'missing' | 'blocked'

export interface AdvisorGroup {
  /** The real settings file (canonical); for `missing`, where it would be. */
  file: string
  /** Refs of the subscription Accounts whose `settings.json` is `file`, in discovery order. */
  accounts: string[]
  state: AdvisorState
  /** For `other`: the model id the file names, when it is a plain model id (letters, digits, `.-_:@[]`). */
  model?: string
  /**
   * The file's `env` sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` to a true value, so Claude Code turns off its
   * experimental features there, the advisor among them. Choosing a model offers to remove it.
   */
  betasOff?: true
  /** That value as JSON (`"1"`, `"true"`, …), for a preview; only with `betasOff`. */
  betasValue?: string
  /** For `blocked` and `missing`: why, as a code the Panel words in its language. */
  why?: SettingsProblem
  /** For `blocked` and `missing`: why, and what to do. */
  reason?: string
  /** sideby set it here and can put the earlier value back. */
  undo: boolean
}

export interface AdvisorStatus {
  groups: AdvisorGroup[]
  /** Config `advisor.unlock`: sessions sideby starts get `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1`. */
  unlock: boolean
  /** The variable in sideby's own environment that makes Claude Code hide the advisor, when one is set. */
  envOff?: string
}

export interface AdvisorChange {
  ok: boolean
  /** One line per group that was meant to change. */
  results: KeyResult[]
  /** This change turned config `advisor.unlock` on. */
  unlocked: boolean
  message: string
}

/** What sideby keeps to undo one change of a settings file. Only `advisorModel` and the one `env` entry. */
interface AdvisorRecord {
  file: string
  /** `advisorModel` was there, with `previous`. */
  hadKey: boolean
  previous?: unknown
  /** Where `advisorModel` stood among the top-level keys, when `off` removed it. */
  index?: number
  /** The alias sideby wrote; absent when it removed the key (`removed`). */
  wrote?: string
  removed?: true
  /** `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` that sideby removed: its value and its place in `env`. */
  betas?: { previous: unknown; index: number }
  at: string
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,99}$/

function stateOf(v: unknown): { state: AdvisorState; model?: string } {
  if (v === undefined) return { state: 'off' }
  if (typeof v !== 'string') return { state: 'other' }
  const text = v.trim()
  if (!text) return { state: 'off' }
  const alias = text.toLowerCase()
  if ((ADVISOR_MODELS as readonly string[]).includes(alias)) return { state: alias as AdvisorModel }
  return MODEL_ID.test(text) ? { state: 'other', model: text } : { state: 'other' }
}

/** Claude Code's own reading of an environment value as true. */
function truthy(v: unknown): boolean {
  if (v === true) return true
  return typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
}

/** The first variable of `ADVISOR_OFF_VARS` that `env` sets to a true value, or undefined. */
export function advisorOffVar(env: Env): string | undefined {
  return ADVISOR_OFF_VARS.find((v) => truthy(env[v]))
}

/**
 * Unlocks the advisor in `env` for a Claude subscription Account's Launch: sets `ADVISOR_UNLOCK_VAR` unless the
 * environment already sets it or one of `ADVISOR_OFF_VARS`. Returns whether it set it.
 */
export function unlockAdvisorEnv(env: Env, familyId: string, account: Pick<Account, 'kind'>): boolean {
  if (familyId !== 'claude' || account.kind === 'api') return false
  if (advisorOffVar(env) || env[ADVISOR_UNLOCK_VAR] !== undefined) return false
  env[ADVISOR_UNLOCK_VAR] = '1'
  return true
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Whether `obj` still holds what the record says sideby wrote (or still lacks the `advisorModel` it removed). */
function holds(obj: Json, r: AdvisorRecord): boolean {
  return r.removed ? !Object.hasOwn(obj, ADVISOR_KEY) : same(obj[ADVISOR_KEY], r.wrote)
}

async function readRecord(stateDir: string, file: string): Promise<AdvisorRecord | null> {
  const r = await readKeyRecord(stateDir, RECORDS, file)
  if (!r || typeof r.hadKey !== 'boolean') return null
  if (r.removed !== true && typeof r.wrote !== 'string') return null
  return r as unknown as AdvisorRecord
}

/** `obj` with `key` set to `value` at `index` among its keys (at the end without one), keeping the others' order. */
function insertAt(obj: Json, key: string, value: unknown, index?: number): Json {
  const entries: [string, unknown][] = Object.entries(obj).filter(([k]) => k !== key)
  entries.splice(Math.min(index ?? entries.length, entries.length), 0, [key, value])
  return Object.fromEntries(entries)
}

/**
 * Every Claude subscription Account's advisor, grouped by the file it lives in. Writes nothing. API Accounts are left
 * out: the advisor needs a Claude login.
 */
export async function advisorGroups(accounts: readonly Account[], ctx: ReadContext): Promise<AdvisorGroup[]> {
  const subscriptions = accounts.filter((a) => a.family === 'claude' && a.kind !== 'api')
  const out: AdvisorGroup[] = []
  for (const g of await readSettingsGroups(subscriptions)) {
    if ('why' in g)
      out.push({
        file: g.file,
        accounts: g.accounts,
        state: g.why === 'no-settings' ? 'missing' : 'blocked',
        why: g.why,
        reason: g.reason,
        undo: false,
      })
    else if (g.obj.env !== undefined && !isObj(g.obj.env))
      out.push({
        file: g.file,
        accounts: g.accounts,
        state: 'blocked',
        why: 'unsafe',
        reason: ENV_NOT_OBJECT,
        undo: false,
      })
    else {
      const betas = isObj(g.obj.env) ? g.obj.env[BETAS_VAR] : undefined
      const record = await readRecord(ctx.stateDir, g.file)
      out.push({
        file: g.file,
        accounts: g.accounts,
        ...stateOf(g.obj[ADVISOR_KEY]),
        ...(truthy(betas) ? { betasOff: true as const, betasValue: JSON.stringify(betas) } : {}),
        undo: record !== null && holds(g.obj, record),
      })
    }
  }
  return out
}

/** The groups, the unlock switch and any variable in sideby's own environment that hides the advisor. Writes nothing. */
export async function advisorStatus(
  accounts: readonly Account[],
  ctx: ReadContext,
  unlock: boolean,
): Promise<AdvisorStatus> {
  const envOff = advisorOffVar(ctx.env)
  return { groups: await advisorGroups(accounts, ctx), unlock, ...(envOff ? { envOff } : {}) }
}

/** `account` when the advisor can be set for it; else a UserError that says what to do. */
export function checkAdvisorAccount(account: Account): Account {
  if (account.family !== 'claude')
    throw new UserError(
      `${account.ref} is not a Claude Code account; the advisor is a Claude Code feature. Pick a Claude account, or leave out --account for all of them`,
    )
  if (account.kind === 'api')
    throw new UserError(
      `${account.ref} is an API account, and the advisor needs a Claude login. Pick a Claude subscription account, or leave out --account for all of them`,
    )
  return account
}

/** The groups `account` (a ref) uses, or every group without one. */
export function advisorScope<G extends { accounts: readonly string[] }>(
  groups: readonly G[],
  account?: string,
): G[] {
  return account ? groups.filter((g) => g.accounts.includes(account)) : [...groups]
}

/**
 * What choosing `to` changes, the one rule for the CLI, the Panel's server and its page: `todo`, the groups sideby can
 * write that do not hold `to` yet or, for a model, whose `env` turns experimental features off (also when they already
 * name it); and `unlocks`, whether config `advisor.unlock` turns on (a model, while it is off, when some group has or
 * gets that model). Choosing the model the files already name is still a change while either is set. Self-contained,
 * so the Panel page runs this same function (page-script.ts).
 */
export function advisorPending<G extends { state: string; betasOff?: boolean }>(
  groups: readonly G[],
  to: string,
  unlock: boolean,
): { todo: G[]; unlocks: boolean } {
  const todo = groups.filter(
    (g) =>
      g.state !== 'missing' &&
      g.state !== 'blocked' &&
      (g.state !== to || (to !== 'off' && g.betasOff === true)),
  )
  const unlocks = to !== 'off' && !unlock && (todo.length > 0 || groups.some((g) => g.state === to))
  return { todo, unlocks }
}

/**
 * What choosing `to` would do in `scope` (`advisorPending`), with the groups whose
 * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is removed with it and those sideby cannot change. Nothing to do when there
 * are no groups to write and no unlock.
 */
export function advisorPlan<G extends { state: string; betasOff?: boolean }>(
  scope: readonly G[],
  to: AdvisorChoice,
  unlock: boolean,
): { todo: G[]; betas: G[]; skipped: G[]; unlock: boolean } {
  const { todo, unlocks: unlockToo } = advisorPending(scope, to, unlock)
  return {
    todo,
    betas: to === 'off' ? [] : todo.filter((g) => g.betasOff === true),
    skipped: scope.filter((g) => g.state === 'missing' || g.state === 'blocked'),
    unlock: unlockToo,
  }
}

/** What a change says when there is nothing to do: always `ok: false`, so the CLI exits 1. */
export function advisorNothingToDo(
  action: AdvisorChoice | 'undo',
  scope: readonly AdvisorGroup[],
): AdvisorChange {
  const none = (message: string): AdvisorChange => ({ ok: false, results: [], unlocked: false, message })
  if (action === 'undo') return none('There is nothing from sideby to undo.')
  if (!scope.length)
    return none(
      'No Claude subscription accounts found, so nothing was changed. The advisor needs a Claude login; API accounts cannot use it.',
    )
  const stuck = scope.find((g) => g.state === 'blocked' || g.state === 'missing')
  if (!scope.some((g) => g.state === action)) return none(`Nothing was changed: ${stuck?.reason}`)
  const already =
    action === 'off'
      ? 'The advisor is already off (nothing changed).'
      : `The advisor is already ${TITLE[action]} and sideby already unlocks it at launch (nothing changed).`
  return none(stuck ? `${already} ${stuck.accounts.join(', ')} cannot be changed: ${stuck.reason}.` : already)
}

function doneMessage(to: AdvisorChoice, betas: boolean): string {
  if (to === 'off')
    return 'Done. New sessions no longer ask an advisor; restart sessions that are already running.'
  return [
    `Done. Sessions sideby starts ask ${TITLE[to]} for advice at key moments, which uses more quota; restart sessions that are already running.`,
    betas ? `Removing ${BETAS_VAR} also turned Claude Code's other experimental features back on.` : '',
    'Sessions started with plain `claude` get it only where Anthropic has turned the advisor on. If a session says "Advisor unavailable", Anthropic has not enabled it for that account.',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * One settings file's change: `advisorModel` set to `to` (`off` removes it) and, for a model, a true
 * `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` removed (the `env` object stays, even when empty), in one write. Leaves
 * an undo record of exactly those two entries.
 */
async function writeGroup(stateDir: string, g: AdvisorGroup, to: AdvisorChoice): Promise<KeyResult> {
  const dropBetas = to !== 'off'
  const box: { record?: AdvisorRecord } = {}
  const failed = await writeSettingsKey(
    g.file,
    (obj) => {
      const r: AdvisorRecord = {
        file: g.file,
        hadKey: Object.hasOwn(obj, ADVISOR_KEY),
        at: new Date().toISOString(),
      }
      if (r.hadKey) r.previous = obj[ADVISOR_KEY]
      if (to === 'off') {
        r.removed = true
        if (r.hadKey) r.index = Object.keys(obj).indexOf(ADVISOR_KEY)
        delete obj[ADVISOR_KEY]
      } else {
        r.wrote = to
        obj[ADVISOR_KEY] = to
      }
      const env = obj.env
      if (dropBetas && isObj(env) && truthy(env[BETAS_VAR])) {
        r.betas = { previous: env[BETAS_VAR], index: Object.keys(env).indexOf(BETAS_VAR) }
        obj.env = Object.fromEntries(Object.entries(env).filter(([k]) => k !== BETAS_VAR))
      }
      box.record = r
      return obj
    },
    (obj) => {
      if (obj.env !== undefined && !isObj(obj.env)) return `${ENV_NOT_OBJECT}.`
      const betas = dropBetas && isObj(obj.env) && truthy(obj.env[BETAS_VAR])
      return stateOf(obj[ADVISOR_KEY]).state === to && !betas
        ? 'It was set that way meanwhile; nothing changed.'
        : null
    },
  )
  if (!failed && box.record) await writeKeyRecord(stateDir, RECORDS, g.file, box.record)
  const done =
    (to === 'off' ? 'Turned off.' : `Set to ${to}.`) + (box.record?.betas ? ` Removed env.${BETAS_VAR}.` : '')
  return { file: g.file, accounts: g.accounts, ok: !failed, message: failed ?? done }
}

/**
 * Sets `advisorModel` to `to` (`off` removes the key) in every group of the scope that does not hold it yet, and for a
 * model removes a true `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, remembering how to undo it. A model also turns
 * config `advisor.unlock` on when it is off, once a file was written or none needed it.
 */
export async function setAdvisor(
  accounts: readonly Account[],
  ctx: ReadContext,
  to: AdvisorChoice,
  opts: { configFile: string; unlock: boolean; account?: string },
): Promise<AdvisorChange> {
  const scope = advisorScope(await advisorGroups(accounts, ctx), opts.account)
  const { todo, unlock: unlockToo } = advisorPlan(scope, to, opts.unlock)
  if (!todo.length && !unlockToo) return advisorNothingToDo(to, scope)
  const results: KeyResult[] = []
  for (const g of todo) results.push(await writeGroup(ctx.stateDir, g, to))
  let ok = results.every((r) => r.ok)
  let unlocked = false
  let unlockFailed = ''
  if (unlockToo && (!results.length || results.some((r) => r.ok))) {
    try {
      unlocked = (await editConfigAdvisor(opts.configFile, (c) => ({ ...c, unlock: true }))).changed
    } catch (err) {
      ok = false
      unlockFailed = (err as Error).message
    }
  }
  return {
    ok,
    results,
    unlocked,
    message: unlockFailed
      ? `The settings were changed, but sideby could not turn on unlocking at launch: ${unlockFailed}. Then run \`sideby advisor unlock on\`.`
      : !ok
        ? 'Some files could not be changed; see each line.'
        : doneMessage(
            to,
            results.some((r) => r.message.includes(BETAS_VAR)),
          ),
  }
}

/** Groups sideby can put back: it wrote there and the key still holds what it wrote. */
export function advisorGroupsToUndo(groups: readonly AdvisorGroup[]): AdvisorGroup[] {
  return groups.filter((g) => g.undo)
}

/**
 * Puts back what each file had before the last change, each entry at its old place, only while `advisorModel` still
 * holds what sideby wrote; a removed `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` comes back only while it is still
 * absent. Leaves config `advisor.unlock` as it is.
 */
export async function undoAdvisor(
  accounts: readonly Account[],
  ctx: ReadContext,
  unlock: boolean,
): Promise<AdvisorChange> {
  const todo = advisorGroupsToUndo(await advisorGroups(accounts, ctx))
  if (todo.length === 0) return advisorNothingToDo('undo', [])
  const results: KeyResult[] = []
  for (const g of todo) {
    const record = await readRecord(ctx.stateDir, g.file)
    if (!record) continue
    const failed = await writeSettingsKey(
      g.file,
      (obj) => {
        let out = obj
        if (record.removed) {
          if (record.hadKey) out = insertAt(out, ADVISOR_KEY, record.previous, record.index)
        } else if (record.hadKey) out[ADVISOR_KEY] = record.previous
        else delete out[ADVISOR_KEY]
        const b = record.betas
        if (b) {
          if (out.env === undefined) out.env = { [BETAS_VAR]: b.previous }
          else if (isObj(out.env) && !Object.hasOwn(out.env, BETAS_VAR))
            out.env = insertAt(out.env, BETAS_VAR, b.previous, b.index)
        }
        return out
      },
      (obj) =>
        holds(obj, record) ? null : 'The setting was changed after sideby set it, so it was left alone.',
    )
    if (!failed) await rm(keyRecordPath(ctx.stateDir, RECORDS, g.file), { force: true })
    results.push({ file: g.file, accounts: g.accounts, ok: !failed, message: failed ?? 'Put back.' })
  }
  const ok = results.length > 0 && results.every((r) => r.ok)
  return {
    ok,
    results,
    unlocked: false,
    message: ok
      ? `Undone. New sessions go back to the previous advisor setting.${unlock ? ' sideby still unlocks /advisor at launch; `sideby advisor unlock off` stops that.' : ''}`
      : 'Some files could not be put back; see each line.',
  }
}

/**
 * Turns config `advisor.unlock` on or off. Off removes the key (and the section once it is empty). `ok: false` when it
 * already was, so the CLI exits 1.
 */
export async function setAdvisorUnlock(
  configFile: string,
  on: boolean,
): Promise<{ ok: boolean; unlock: boolean; message: string }> {
  const r = await editConfigAdvisor(configFile, (c) => {
    if (on) return { ...c, unlock: true }
    const { unlock: _drop, ...rest } = c
    return Object.keys(rest).length ? rest : undefined
  })
  if (!r.changed)
    return {
      ok: false,
      unlock: on,
      message: on
        ? 'sideby already unlocks /advisor at launch (nothing changed).'
        : 'sideby already leaves /advisor to Claude Code (nothing changed).',
    }
  return {
    ok: true,
    unlock: on,
    message: on
      ? 'Done. Claude sessions sideby starts now offer /advisor; restart sessions that are already running.'
      : 'Done. sideby no longer unlocks /advisor; Claude Code shows it only where Anthropic has turned it on. Restart sessions that are already running.',
  }
}
