import { stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { aliasesByAccount } from '../core/accounts.ts'
import { listAppProfiles, openAppProfile, parseProfileRef, removeAppProfile } from '../core/app-profiles.ts'
import {
  browserReport,
  openInBrowser,
  setBrowserChoice,
  setBrowserSignIns,
} from '../core/browser-profiles.ts'
import { CLI_COMMANDS, type CliCommand, COMMAND_GROUPS, commonCommands } from '../core/cli-commands.ts'
import { aliasAccount, aliasArgs, aliasRefs, type DisplayConfig, editConfigUpdate } from '../core/config.ts'
import { openDesktopApp, withDesktopApps } from '../core/desktop-app.ts'
import type { DoctorReport } from '../core/doctor.ts'
import { editSettings } from '../core/edit-settings.ts'
import { UserError } from '../core/errors.ts'
import { requestHandoff } from '../core/handoff-chain.ts'
import { handoffOverview } from '../core/handoff-overview.ts'
import { type HandoffRule, handoffRulesView } from '../core/handoff-rules.ts'
import { explain, type HandoffIo, readyDecision, runWithHandoff } from '../core/handoff-run.ts'
import type { HandoffDecision } from '../core/handoff-select.ts'
import {
  checkHandoffRefs,
  configureHandoff,
  type HandoffChange,
  handoffHint,
  handoffRefs,
  handoffStatus,
} from '../core/handoff-status.ts'
import type { HistoryQuery, HistoryResult } from '../core/history.ts'
import { installHint, runHost } from '../core/launch.ts'
import { type LoginSnapshot, loginAfterLine, loginBeforeLine } from '../core/login-check.ts'
import { accountModel, type ModelChange, setAccountModel } from '../core/model-choice.ts'
import { resolvePaths, tildify } from '../core/paths.ts'
import { type QuotaFetchMode, quotaCheckOff } from '../core/quota-fetch.ts'
import { takeoverLimits, USAGE_DAYS } from '../core/quota-levels.ts'
import { quotaStoreFile, readQuotaStore } from '../core/quota-store.ts'
import {
  groupsToUndo,
  type RemoteControlGroup,
  type RemoteControlState,
  remoteControlNothingToDo,
  remoteControlTodo,
} from '../core/remote-control.ts'
import { SEARCH_CATALOG, searchCatalog } from '../core/search-catalog.ts'
import { SHELLS, type Shell, type ShellInitWrite } from '../core/shell-init.ts'
import type { TuneApplyPlan } from '../core/tuning-apply.ts'
import { clockText, daysText } from '../core/unattended-state.ts'
import { MODEL_NAME } from '../families/shared/model-args.ts'
import {
  AI_TASK_KINDS,
  type AiTaskKind,
  hiddenIn,
  inDisplayOrder,
  pinnedIn,
  resetWhen,
  suggestAlias,
  suggestName,
  withPinned,
} from '../panel/page-logic.ts'
import { createRuntime, type Runtime, UnknownFamilyError } from '../runtime.ts'
import type { Account, Finding } from '../types.ts'
import { type ParsedArgs, UsageError } from './args.ts'
import { c, clock, compactNumber, quotaText, table, truncate, tuningLines, usageText } from './format.ts'

export interface Io {
  out(s: string): void
  err(s: string): void
  /** The terminal Auto Handoff counts down on (spec §3.17); `process.stdin` when left out. */
  stdin?: HandoffIo['stdin']
}

/** Runs `fn` while a record under the state directory says a Host runs (also for `login`), so an Auto Update waits (spec §3.23). */
async function whileRunning<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  const { markRunning } = await import('../core/update.ts')
  const done = await markRunning(rt.paths)
  try {
    return await fn()
  } finally {
    await done().catch(() => {})
  }
}

/** Runs the Account with Auto Handoff when it applies (spec §3.17), else the Host as usual. */
/** `opts.aiTask`: an AI Task's Host, started without permission bypasses (ADR-0031); `sideby run` leaves it out. */
async function runAccount(
  rt: Runtime,
  ref: string,
  args: readonly string[],
  io: Io,
  opts: LaunchFlags & { aiTask?: boolean } = {},
): Promise<number> {
  return whileRunning(rt, () => runAccountNow(rt, ref, args, io, opts))
}

/** sideby's own options on a Launch: `--ignore-network` (spec §3.35) and `--unattended` (§3.37). */
interface LaunchFlags {
  ignoreNetwork?: boolean
  unattended?: boolean
}

/**
 * Takes sideby's own `--unattended` (spec §3.37) out of the arguments `run` and `resume` pass to the Host, anywhere
 * before `--`: no Host has an option of that name.
 */
export function takeUnattended(args: readonly string[]): { args: string[]; unattended: boolean } {
  const end = args.indexOf('--')
  const head = end === -1 ? args : args.slice(0, end)
  if (!head.includes('--unattended')) return { args: [...args], unattended: false }
  return {
    args: [...head.filter((x) => x !== '--unattended'), ...(end === -1 ? [] : args.slice(end))],
    unattended: true,
  }
}

/** Both of sideby's own Launch options, as `run` and `resume` find them among the Host's arguments. */
function takeLaunchFlags(args: readonly string[]): { args: string[]; flags: LaunchFlags } {
  const net = takeIgnoreNetwork(args)
  const un = takeUnattended(net.args)
  return {
    args: un.args,
    flags: {
      ...(net.ignoreNetwork ? { ignoreNetwork: true } : {}),
      ...(un.unattended ? { unattended: true } : {}),
    },
  }
}

/**
 * Takes sideby's own `--ignore-network` (spec §3.35) out of the arguments `run` and `resume` pass to the Host,
 * anywhere before `--`: no Host has an option of that name.
 */
export function takeIgnoreNetwork(args: readonly string[]): { args: string[]; ignoreNetwork: boolean } {
  const end = args.indexOf('--')
  const head = end === -1 ? args : args.slice(0, end)
  if (!head.includes('--ignore-network')) return { args: [...args], ignoreNetwork: false }
  return {
    args: [...head.filter((x) => x !== '--ignore-network'), ...(end === -1 ? [] : args.slice(end))],
    ignoreNetwork: true,
  }
}

async function runAccountNow(
  rt: Runtime,
  ref: string,
  args: readonly string[],
  io: Io,
  opts: LaunchFlags & { aiTask?: boolean },
): Promise<number> {
  const handed = await runWithHandoff(
    rt,
    ref,
    args,
    { err: (l) => io.err(c.dim(l)), stdin: io.stdin ?? process.stdin },
    opts,
  )
  if (handed !== null) return handed
  const prepared = await rt.prepareLaunch(ref, args, 'run', opts)
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  const code = await runHost(prepared)
  if ((io.stdin ?? process.stdin).isTTY) {
    const hint = await handoffHint(rt, ref)
    if (hint) io.err(c.dim(`sideby: ${hint}`))
  }
  return code
}

// The `_notice` main.ts works out before a `--json` command (spec §3.23); every JSON output of this run carries it.
let notice: object | null = null
export function setJsonNotice(n: object | null): void {
  notice = n
}
const json = (io: Io, data: object) =>
  io.out(JSON.stringify({ schemaVersion: 1, ...data, ...(notice ? { _notice: notice } : {}) }, null, 2))

function stripFix(f: Finding): Omit<Finding, 'fix'> {
  const { fix: _fix, ...rest } = f
  return rest
}

export function serializeDoctor(r: DoctorReport) {
  return {
    status: r.status,
    accounts: r.accounts.map((a) => ({ ...a, findings: a.findings.map(stripFix) })),
    general: r.general.map(stripFix),
    fixes: r.fixes,
  }
}

/** Shows paths under HOME as `~/…` so output is short and safe to share. */
function tilde(text: string, home: string): string {
  return text.split(`${home}/`).join('~/')
}

/** Accounts in the Display Order the user gave them in the Panel (spec §3.25): Families first, then each one's, Pinned Accounts leading. */
function displayOrdered(accounts: Account[], rt: Runtime): Account[] {
  const d = rt.displayOrder()
  const ids = inDisplayOrder([...new Set(accounts.map((x) => x.family))], (id) => id, d.families)
  return ids.flatMap((id) =>
    withPinned(
      inDisplayOrder(
        accounts.filter((x) => x.family === id),
        (x) => x.name,
        d.accounts?.[id],
      ),
      d.pinned?.[id],
    ),
  )
}

/** Drop deleted accounts and unloaded Families only when saving a display change. */
/**
 * Groups the Display Order may name (spec §3.25): every Family, and every desktop app with windows of its own (Grok
 * Bot, `grok-bot`), each with the names it holds.
 */
async function orderGroups(rt: Runtime, accounts: Account[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const id of rt.families.keys())
    out.set(
      id,
      accounts.filter((a) => a.family === id).map((a) => a.name),
    )
  for (const p of await listAppProfiles(rt)) {
    const [id, name] = [p.ref.slice(0, p.ref.indexOf(':')), p.ref.slice(p.ref.indexOf(':') + 1)]
    out.set(id, [...(out.get(id) ?? []), name])
  }
  return out
}

function cleanDisplay(rt: Runtime, groups: Map<string, string[]>): DisplayConfig {
  const d = rt.displayOrder()
  const clean = (lists: Record<string, string[]> | undefined) =>
    Object.fromEntries(
      Object.entries(lists ?? {})
        .filter(([id]) => groups.has(id))
        .map(([id, names]) => [id, names.filter((name) => groups.get(id)?.includes(name))]),
    )
  return {
    families: d.families?.filter((id) => groups.has(id)),
    accounts: clean(d.accounts),
    pinned: clean(d.pinned),
    hiddenFamilies: d.hiddenFamilies?.filter((id) => groups.has(id)),
    hidden: clean(d.hidden),
  }
}

export async function cmdPin(a: ParsedArgs, io: Io, pin: boolean): Promise<number> {
  if (a.positionals.length !== 1 || a.rest.length)
    throw new UsageError('usage: sideby pin|unpin <account|short command> [--json]')
  const rt = await createRuntime()
  const account = await rt.resolve(a.positionals[0]!)
  const accounts = await rt.accounts()
  const d = cleanDisplay(rt, await orderGroups(rt, accounts))
  const peers = new Set([account.ref, ...(await rt.sameLogin(account))])
  const names = accounts.filter((x) => peers.has(x.ref)).map((x) => x.name)
  const pins = d.pinned?.[account.family] ?? []
  const already = names.some((name) => pins.includes(name))
  if (pin && !already) {
    const units = new Set<string>()
    for (const x of accounts.filter((x) => x.family === account.family && pins.includes(x.name))) {
      units.add([x.ref, ...(await rt.sameLogin(x))].sort().join('|'))
    }
    if (units.size >= 3)
      throw new UserError('At most 3 pinned logins per family; unpin one first with sideby unpin <account>.')
  }
  const next = pin
    ? [...pins, ...names.filter((name) => !pins.includes(name))]
    : pins.filter((name) => !names.includes(name))
  d.pinned = { ...d.pinned, [account.family]: next }
  const before = JSON.stringify(rt.displayOrder())
  const display = await rt.setDisplayOrder(d)
  const changed = before !== JSON.stringify(display)
  const message = pin
    ? already
      ? 'Already pinned.'
      : 'Pinned.'
    : already
      ? 'Unpinned.'
      : 'Account is not pinned; nothing to change.'
  if (a.flags.has('json')) json(io, { ref: account.ref, pinned: pin, changed, message, display })
  else io.out(`${account.ref}: ${message}`)
  return 0
}

/**
 * `sideby hide|unhide <family|account>` (spec §3.25): takes a Family, or an Account with the other directories of its
 * Same Login, out of the lists or puts it back. Display only.
 */
export async function cmdHide(a: ParsedArgs, io: Io, hide: boolean): Promise<number> {
  if (a.positionals.length !== 1 || a.rest.length)
    throw new UsageError('usage: sideby hide|unhide <family|account|short command> [--json]')
  const rt = await createRuntime()
  const target = a.positionals[0]!
  const accounts = await rt.accounts()
  const d = cleanDisplay(rt, await orderGroups(rt, accounts))
  let kind: 'family' | 'account'
  let ref: string
  let already: boolean
  if (rt.families.has(target)) {
    kind = 'family'
    ref = target
    const list = d.hiddenFamilies ?? []
    already = list.includes(target)
    d.hiddenFamilies = hide ? (already ? list : [...list, target]) : list.filter((id) => id !== target)
  } else {
    kind = 'account'
    const account = await rt.resolve(target)
    ref = account.ref
    const peers = new Set([account.ref, ...(await rt.sameLogin(account))])
    const names = accounts.filter((x) => peers.has(x.ref)).map((x) => x.name)
    const list = d.hidden?.[account.family] ?? []
    already = names.some((name) => list.includes(name))
    d.hidden = {
      ...d.hidden,
      [account.family]: hide
        ? [...list, ...names.filter((name) => !list.includes(name))]
        : list.filter((name) => !names.includes(name)),
    }
    if (!hide && !already && d.hiddenFamilies?.includes(account.family))
      throw new UserError(
        `All of ${account.family} is hidden, not just ${account.ref}; run sideby unhide ${account.family} to show the family again.`,
      )
  }
  const before = JSON.stringify(rt.displayOrder())
  const display = await rt.setDisplayOrder(d)
  const changed = before !== JSON.stringify(display)
  const message = hide
    ? already
      ? 'Already hidden.'
      : `Hidden from the Panel, the menu bar and sideby list; it can still be started. sideby unhide ${ref} shows it again.`
    : already
      ? 'Shown again.'
      : 'Not hidden; nothing to change.'
  if (a.flags.has('json')) json(io, { target: ref, kind, hidden: hide, changed, message, display })
  else io.out(`${ref}: ${message}`)
  return 0
}

export async function cmdOrder(a: ParsedArgs, io: Io): Promise<number> {
  const reset = a.flags.has('reset')
  const families = a.flags.has('families')
  if (
    a.rest.length ||
    (reset && (families || a.positionals.length)) ||
    (families && !a.positionals.length) ||
    (!reset && !families && a.positionals.length === 1)
  )
    throw new UsageError('usage: sideby order [--json] | <family> <name>... | --families <id>... | --reset')
  const rt = await createRuntime()
  const accounts = await rt.accounts()
  if (reset || families || a.positionals.length) {
    const groups = await orderGroups(rt, accounts)
    let d = cleanDisplay(rt, groups)
    if (reset) d = { pinned: d.pinned, hiddenFamilies: d.hiddenFamilies, hidden: d.hidden }
    else {
      const [id, ...names] = a.positionals
      const requested = families ? a.positionals : names
      const unknown = families
        ? requested.filter((x) => !groups.has(x))
        : !groups.has(id!)
          ? [id!]
          : names.filter((name) => !groups.get(id!)?.includes(name))
      if (unknown.length)
        throw new UserError(
          `Unknown ${families || !groups.has(id!) ? 'families' : 'account names'}: ${unknown.join(', ')}; run sideby families or sideby list to choose existing names.`,
        )
      if (new Set(requested).size !== requested.length)
        throw new UsageError('Names must not repeat; list each name once.')
      if (families) d.families = requested
      else d.accounts = { ...d.accounts, [id!]: names }
    }
    await rt.setDisplayOrder(d)
  }
  const display = rt.displayOrder()
  const ordered = displayOrdered(accounts, rt)
  const groups = await orderGroups(rt, accounts)
  const rows = inDisplayOrder([...groups.keys()], (id) => id, display.families).map((family) => ({
    family,
    hidden: display.hiddenFamilies?.includes(family) ?? false,
    accounts: rt.families.has(family)
      ? ordered
          .filter((x) => x.family === family)
          .map((x) => ({
            name: x.name,
            ref: x.ref,
            pinned: display.pinned?.[family]?.includes(x.name) ?? false,
            hidden: hiddenIn(x, display),
          }))
      : inDisplayOrder(groups.get(family) ?? [], (n) => n, display.accounts?.[family]).map((name) => ({
          name,
          ref: `${family}:${name}`,
          pinned: false,
          hidden: hiddenIn({ family, name }, display),
        })),
  }))
  if (a.flags.has('json')) json(io, { display, families: rows })
  else
    for (const row of rows)
      io.out(
        `${row.family}${row.hidden ? ' (hidden)' : ''}: ${row.accounts.map((x) => `${x.name}${x.pinned ? ' (pinned)' : ''}${x.hidden && !row.hidden ? ' (hidden)' : ''}`).join(', ') || '(no accounts)'}`,
      )
  return 0
}

function onOff(value: string | boolean | undefined, usage: string): boolean {
  if (value !== 'on' && value !== 'off') throw new UsageError(usage)
  return value === 'on'
}

export async function cmdList(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const accounts = displayOrdered(await rt.accounts(), rt)
  const [statuses, appProfiles] = await Promise.all([
    withDesktopApps(rt, accounts, Promise.all(accounts.map((x) => rt.status(x)))).then((list) =>
      list.map((s) => {
        const d = rt.displayOrder()
        const marked = pinnedIn(s, d.pinned?.[s.family] ?? []) ? { ...s, pinned: true as const } : s
        return hiddenIn(s, d) ? { ...marked, hidden: true as const } : marked
      }),
    ),
    // Desktop app windows in the Display Order too (spec §3.25), the main window first by default.
    listAppProfiles(rt).then((list) => {
      const d = rt.displayOrder()
      const appOf = (ref: string) => ref.slice(0, ref.indexOf(':'))
      const nameOf = (ref: string) => ref.slice(ref.indexOf(':') + 1)
      const apps = inDisplayOrder([...new Set(list.map((p) => appOf(p.ref)))], (id) => id, d.families)
      return apps.flatMap((app) =>
        inDisplayOrder(
          list.filter((p) => appOf(p.ref) === app),
          (p) => nameOf(p.ref),
          d.accounts?.[app],
        ),
      )
    }),
  ])
  const hasDesktop = statuses.some((s) => s.desktopApp)
  const families = inDisplayOrder(await rt.familyInfo(), (f) => f.id, rt.displayOrder().families).map((f) =>
    rt.displayOrder().hiddenFamilies?.includes(f.id) ? { ...f, hidden: true as const } : f,
  )
  if (a.flags.has('json')) {
    json(io, { families, accounts: statuses, appProfiles, pluginErrors: [...rt.pluginErrors] })
    return 0
  }
  const home = rt.paths.home
  // Hidden Accounts (spec §3.25) stay out of the text unless --all asks for them; --json above has them all.
  const all = a.flags.has('all')
  const shown = all ? statuses : statuses.filter((s) => !s.hidden)
  const hiddenCount = statuses.length - shown.length
  const hiddenLine = c.dim(
    `\n${hiddenCount} hidden; sideby list --all shows them, sideby unhide <family|account> puts one back.`,
  )
  if (statuses.length && !shown.length) {
    io.out(`All ${statuses.length} accounts are hidden.`)
    io.out(hiddenLine)
  } else if (statuses.length === 0) {
    io.out('No accounts found yet.')
    const installed = families.filter((f) => f.installed)
    if (installed.length === 0)
      io.out(`Install a host first:\n${families.map((f) => `  ${f.title}: ${installHint(f)}`).join('\n')}`)
    else io.out(`Run ${installed.map((f) => f.bin).join(' or ')} once, then \`sideby new <family> <name>\`.`)
  } else {
    // `= main`: the other Accounts of its Same Login, which share its Quota (spec §3.21).
    const brokenOf = (id: string) => families.find((f) => f.id === id)?.brokenBin
    const sameMark = (refs: readonly string[] | undefined) =>
      refs?.length ? ` ${c.dim(`= ${refs.map((r) => r.slice(r.indexOf(':') + 1)).join(', ')}`)}` : ''
    const rows = shown.map((s) => [
      `${c.bold(s.ref)}${sameMark(s.sameLogin)}${s.hidden ? ` ${c.dim('(hidden)')}` : ''}`,
      s.isMain ? 'main' : s.kind === 'api' ? c.cyan('api') : 'sub',
      s.login === 'logged-in'
        ? c.green('✓')
        : s.login === 'not-needed'
          ? c.dim('key')
          : s.login === 'logged-out'
            ? c.yellow('login needed')
            : c.dim('?'),
      s.identity?.email ?? c.dim('—'),
      s.model ?? c.dim('—'),
      s.hostInstalled
        ? tildify(s.dir, home)
        : `${tildify(s.dir, home)} ${c.yellow(brokenOf(s.family) ? '(host install broken)' : '(host not installed)')}`,
      ...(hasDesktop ? [s.desktopApp?.running ? c.green('open') : c.dim('—')] : []),
    ])
    io.out(
      table(rows, ['ACCOUNT', 'TYPE', 'LOGIN', 'EMAIL', 'MODEL', 'DIR', ...(hasDesktop ? ['DESKTOP'] : [])]),
    )
    // One line per Host that cannot run, with what to do: the rows only say which accounts it affects.
    for (const f of families.filter((x) => !x.installed && shown.some((s) => s.family === x.id)))
      io.out(
        c.yellow(
          f.brokenBin
            ? `\n${f.title}'s install is broken (${tildify(f.brokenBin, home)} cannot run, often after an interrupted upgrade); reinstall it: ${installHint(f)}`
            : `\n${f.title} is not installed; install it: ${installHint(f)}`,
        ),
      )
    if (shown.some((s) => s.sameLogin?.length))
      io.out(c.dim('\n= <account>: signed in as the same login as that account, so they share one quota.'))
    if (hiddenCount) io.out(hiddenLine)
    io.out(c.dim('\nsideby run <account>  ·  sideby new <family> <name>  ·  sideby quota  ·  sideby ui'))
  }
  // App Profiles (ADR-0019): windows of an app that signs in apart from the Accounts above. Not on the first screen
  // of someone without Accounts yet, where they would only distract from installing a Host; --json keeps them.
  for (const app of statuses.length ? new Set(appProfiles.map((p) => p.app)) : []) {
    const list = appProfiles.filter((p) => p.app === app)
    io.out(`\n${c.bold(app)} ${c.dim('(signs in on its own, not with the accounts above)')}`)
    io.out(
      table(
        list.map((p) => [
          c.bold(p.ref),
          p.running ? c.green('open') : c.dim('—'),
          p.signedIn === true
            ? c.green('signed in')
            : p.signedIn === false
              ? c.yellow('not signed in')
              : c.dim('?'),
          p.appData ? tildify(p.appData, home) : c.dim('default'),
        ]),
        ['WINDOW', 'STATE', 'SIGN-IN', 'DATA'],
      ),
    )
    if (!list[0]?.installed) io.out(c.yellow(`${app} is not installed; these windows open again once it is`))
    const id = list[0]?.ref.slice(0, list[0].ref.indexOf(':'))
    io.out(c.dim(`sideby desktop ${id}:<name> opens one (a new name makes a new window)`))
  }
  for (const s of shown) for (const p of s.problems ?? []) io.err(c.yellow(`${s.ref}: ${p}`))
  for (const e of rt.pluginErrors) io.err(c.yellow(`plugin ${e.where}: ${e.message}`))
  return 0
}

export interface NewSuggestion {
  name: string
  alias?: string
  /** Why the alias the pattern suggests was left out (taken, reserved); the Account is created without it. */
  aliasProblem?: string
}

/**
 * `new --next`: the next name of a Family, and a short command following the pattern of its existing aliases,
 * from the same helpers the Panel uses (spec §3.16).
 */
async function suggestNew(rt: Runtime, family: string, alias: string | undefined): Promise<NewSuggestion> {
  if (!(await rt.familyInfo()).some((f) => f.id === family))
    throw new UnknownFamilyError(`unknown family "${family}"; run \`sideby families\` to see them`)
  const all = await rt.accounts()
  const mine = all.filter((x) => x.family === family)
  const name = suggestName(mine.map((x) => x.name))
  if (alias !== undefined) return { name }
  const byRef = aliasesByAccount(aliasRefs(rt.config.aliases), all)
  const offer = suggestAlias(
    mine.map((x) => ({ family: x.family, name: x.name, ref: x.ref, aliases: byRef.get(x.ref) ?? [] })),
    family,
    name,
  )
  if (!offer) return { name }
  const problem = rt.aliasProblem(offer, `${family}:${name}`)
  return problem ? { name, aliasProblem: `${offer}: ${problem}` } : { name, alias: offer }
}

export async function cmdNew(a: ParsedArgs, io: Io): Promise<number> {
  const [family, given] = a.positionals
  const next = a.flags.has('next')
  if (!family || (next ? given !== undefined : !given) || a.positionals.length > 2)
    throw new UsageError(
      next
        ? 'usage: sideby new <family> --next [--api] [--alias <short-command>]; --next picks the name, so leave it out'
        : 'usage: sideby new <family> <name> [--api] [--alias <short-command>], or `--next` instead of <name>',
    )
  const givenAlias = a.flags.get('alias')
  const rt = await createRuntime()
  const suggestion = next
    ? await suggestNew(rt, family, typeof givenAlias === 'string' ? givenAlias : undefined)
    : undefined
  const name = suggestion?.name ?? given!
  const alias = typeof givenAlias === 'string' ? givenAlias : suggestion?.alias
  const res = await rt.createAccount(family, name, {
    api: a.flags.has('api'),
    ...(alias !== undefined ? { alias } : {}),
  })
  const pickOffer = await pickOfferAfterNew(rt, res.account)
  if (a.flags.has('json')) {
    json(io, {
      ...res,
      ...(suggestion ? { suggestion } : {}),
      ...(pickOffer ? { pickCommandOffer: pickOffer } : {}),
    })
    return res.ok ? 0 : 1
  }
  if (suggestion?.aliasProblem)
    io.out(`${c.yellow('!')} no short command: the pattern suggests ${suggestion.aliasProblem}`)
  const home = rt.paths.home
  const where = tildify(res.account.dir, home)
  if (res.ok) io.out(`${c.green('✓')} created ${c.bold(res.account.ref)} at ${where}`)
  else io.out(`${c.yellow('!')} created ${c.bold(res.account.ref)} at ${where} with problems; see below`)
  // Items the main account does not have are normal for a new setup: one line, not one per item, so a beginner does
  // not read a list of problems.
  const notInMain = res.steps.filter(
    (x) => x.ok && x.action === 'skipped' && x.message === 'not in the main account',
  )
  for (const s of res.steps.filter((x) => (!x.ok || x.action === 'skipped') && !notInMain.includes(x)))
    io.out(`  ${s.ok ? c.dim('·') : c.red('✗')} ${s.item}: ${s.message ?? s.action}`)
  if (notInMain.length)
    io.out(
      `  ${c.dim('·')} nothing to share yet: ${notInMain.map((x) => x.item).join(', ')} ${notInMain.length === 1 ? 'is' : 'are'} not in the main account (add ${notInMain.length === 1 ? 'it' : 'them'} there; \`sideby doctor\` then says what to do)`,
    )
  for (const e of res.hookErrors) io.err(c.red(`  ${e.message}`))
  if (res.alias?.added) io.out(`${c.green('✓')} short command ${c.bold(res.alias.name)} (in a new shell)`)
  else if (res.alias) io.out(`  ${c.red('✗')} ${res.alias.message}`)
  printShellInitWrites(io, res.shellInitFiles ?? [], home)
  io.out('\nNext:')
  for (const n of res.nextSteps) io.out(`  ${n}`)
  if (pickOffer)
    io.out(
      c.dim(
        `\nTip: with two ${res.account.family} accounts, \`${pickOffer.command}\` adds ${pickOffer.name}, which starts the one with the most quota left each time.`,
      ),
    )
  return res.ok ? 0 : 1
}

/**
 * The Pick Command `sideby new` offers once, when the new Account is its Family's second Subscription Account and
 * the Family has none yet (spec §3.13).
 */
async function pickOfferAfterNew(
  rt: Runtime,
  account: Account,
): Promise<{ name: string; command: string; shadows?: string } | null> {
  if (account.kind === 'api') return null
  const subs = (await rt.accounts()).filter((x) => x.family === account.family && x.kind !== 'api')
  if (subs.length !== 2) return null
  const offer = await rt.pickSuggestion(account.family)
  if (!offer || offer.exists || offer.name === null) return null
  return {
    name: offer.name,
    command: `sideby alias add ${offer.name} --pick ${account.family}`,
    ...(offer.shadows ? { shadows: offer.shadows } : {}),
  }
}

function printShellInitWrites(io: Io, files: readonly ShellInitWrite[], home: string) {
  for (const f of files) {
    const path = f.path.startsWith('/') ? tildify(f.path, home) : f.path
    if (f.ok) io.out(`${c.green('✓')} ${f.action === 'unchanged' ? 'up to date' : 'updated'} ${path}`)
    else io.out(`  ${c.red('✗')} ${f.message}`)
  }
}

export async function cmdRun(a: ParsedArgs, io: Io, command: 'run' | 'login'): Promise<number> {
  const [ref, ...extra] = a.positionals
  if (!ref)
    throw new UsageError(`usage: sideby ${command} <account>${command === 'run' ? ' [-- host args]' : ''}`)
  if (command === 'login' && (extra.length || a.rest.length))
    throw new UsageError('login takes no extra arguments')
  const rt = await createRuntime()
  const { args, flags } = takeLaunchFlags([...extra, ...a.rest])
  if (command === 'run' && rt.pickCommandFamily(ref) !== undefined) return runPick(rt, ref, args, io, flags)
  if (command === 'run') return runAccount(rt, ref, args, io, flags)
  return runLogin(rt, ref, io)
}

/** Who an Account is signed in as, for `runLogin`; identity fields and Same Login peers only, never a credential. */
async function loginSnapshot(rt: Runtime, account: Account): Promise<LoginSnapshot> {
  const s = await rt.status(account)
  return {
    login: s.login,
    ...(s.identity?.email ? { email: s.identity.email } : {}),
    sameLogin: s.sameLogin ?? [],
  }
}

/**
 * `sideby login` and the Panel's sign-in (spec §3.21 "换个账号登录"): the Host's own sign-in, with a line before on how
 * to choose another login and a line after on whether the Account now has a login of its own. Exits as the Host does.
 */
async function runLogin(rt: Runtime, ref: string, io: Io): Promise<number> {
  const account = await rt.resolve(ref)
  // pi signs in inside the app (`login.args` null), so there is no sign-in of its own to compare around.
  const before = rt.families.get(account.family)?.login.args
    ? await loginSnapshot(rt, account).catch(() => undefined)
    : undefined
  const prepared = await rt.prepareLaunch(account.ref, [], 'login')
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  const hint = before && loginBeforeLine(account.ref, before)
  if (hint) io.err(c.dim(`sideby: ${hint}`))
  const code = await whileRunning(rt, () => runHost(prepared))
  if (!before) return code
  const after = await loginSnapshot(rt, account).catch(() => undefined)
  const result = after && loginAfterLine(account.ref, before, after)
  if (result) io.err((result.ok ? c.green : c.yellow)(`sideby: ${result.line}`))
  return code
}

/** A Pick Command (spec §3.13, ADR-0035): start the Account with the most room, else the Main Account, and say which. */
async function runPick(
  rt: Runtime,
  name: string,
  args: readonly string[],
  io: Io,
  opts: LaunchFlags = {},
): Promise<number> {
  const { choice, family } = await rt.pickChoice(name)
  if (choice.ref === null) {
    const now = rt.readContext().now
    const why = choice.earliestReset
      ? `every signed-in ${family} account has used up its quota; ${choice.earliestReset.ref} is back ${resetWhen(choice.earliestReset.at, now.getTime(), 'en')}`
      : `no ${family} account can be used now`
    const signIn = choice.signIn.length
      ? `; sign in with \`sideby login ${choice.signIn.join('` or `sideby login ')}\``
      : ''
    io.err(c.yellow(`${name}: ${why}${signIn}, or start one yourself with \`sideby run <account>\`.`))
    return 1
  }
  const { pickLine } = await import('../core/pick-commands.ts')
  io.err((choice.reason === 'tight' ? c.yellow : c.dim)(`sideby: ${pickLine(name, choice, family)}`))
  return runAccount(rt, choice.ref, args, io, opts)
}

/**
 * `sideby resume <family>`: what the Host-named shell function calls (spec §3.15). Starts the Account that holds the
 * session the arguments resume by id, a new session where a never-saved one started (ADR-0009), or the Host unchanged.
 */
export async function cmdResume(a: ParsedArgs, io: Io, runtime?: Runtime): Promise<number> {
  const [family, ...extra] = a.positionals
  if (!family) throw new UsageError('usage: sideby resume <family> [-- host args]')
  const rt = runtime ?? (await createRuntime())
  const { args, flags } = takeLaunchFlags([...extra, ...a.rest])
  const route = await rt.resumeLaunch(family, args, flags)
  // The Main Account under `handoff.auto` starts exactly as `sideby run` would (ADR-0059).
  if (route.run && route.account) {
    io.err(
      c.dim(
        route.newSession
          ? `sideby: session ${route.sessionId} was never saved; starting a new session in ${route.account.ref} with Auto Handoff`
          : `sideby: session ${route.sessionId} is in ${route.account.ref}; starting it there with Auto Handoff`,
      ),
    )
    return runAccount(rt, route.account.ref, route.run.args, io, flags)
  }
  if (route.launch.notice) io.err(c.cyan(route.launch.notice))
  if (route.newSession)
    io.err(
      c.dim(
        `sideby: session ${route.sessionId} was never saved; starting a new session in ${route.account!.ref}`,
      ),
    )
  else if (route.account)
    io.err(c.dim(`sideby: session ${route.sessionId} is in ${route.account.ref}; starting it there`))
  return whileRunning(rt, () => runHost(route.launch))
}

/** Quotes a Host argument for a command line the user may paste; plain words stay as they are. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** `sideby next <family>`: recommend the Account with the most room, then start it (spec §3.13). */
export async function cmdNext(a: ParsedArgs, io: Io): Promise<number> {
  const [family, ...extra] = a.positionals
  if (!family || extra.length)
    throw new UsageError(
      'usage: sideby next <family> [--dry-run] [--include-api] [--ignore-network] [--unattended] [-- host args]',
    )
  const includeApi = a.flags.has('include-api')
  const rt = await createRuntime()
  const plan = await rt.handoff(family, { includeApi })
  if (a.flags.has('json')) {
    json(io, plan)
    return plan.pick && plan.hasQuota ? 0 : 1
  }
  const now = rt.readContext().now
  const limits = plan.tight
    ? { short: plan.tight.limit, long: plan.tight.longLimit }
    : takeoverLimits(rt.handoffSettings().threshold)
  const low = (e: (typeof plan.accounts)[number]) =>
    e.state === 'full' && e.pressure !== null && e.pressure < 100
  // The window closest to its own Takeover Limit, which decides the rank: "7d 87% of 95%".
  const closest = (e: (typeof plan.accounts)[number]) =>
    e.window
      ? `${e.window.label} ${e.window.usedPercent}% of ${e.window.limit}%`
      : `${Math.round(e.pressure ?? 0)}%`
  const note = (e: (typeof plan.accounts)[number]): string => {
    if (e.sameLoginAs) return `same login as ${e.sameLoginAs}, which shares its quota; skipped`
    if (e.state === 'ready') return `closest to its limit: ${closest(e)}`
    if (e.state === 'unknown') return 'no quota data yet'
    if (e.state === 'api')
      return includeApi ? 'API account, pay per use' : 'left out; add --include-api to use it'
    if (low(e)) {
      const over = `past its limit: ${closest(e)} (limits ${limits.short}% for 5-hour, ${limits.long}% for weekly windows)`
      return e.resetsAt ? `${over}; resets ${resetWhen(e.resetsAt, now.getTime(), 'en')}` : over
    }
    if (e.state === 'full')
      return e.resetsAt ? `used up; back ${resetWhen(e.resetsAt, now.getTime(), 'en')}` : 'used up'
    return `signed out; sign in with \`sideby login ${e.ref}\``
  }
  const mark = { ready: c.green, unknown: c.yellow, api: c.cyan, full: c.red, 'logged-out': c.dim } as const
  // A full Account with no window used up still has some quota: `low` in the table, and a Last Resort can start it.
  const stateText = (e: (typeof plan.accounts)[number]): string =>
    low(e) ? c.yellow('low') : mark[e.state](e.state === 'logged-out' ? 'signed out' : e.state)
  io.out(
    table(
      plan.accounts.map((e) => [
        e.ref === plan.pick ? c.green('→') : ' ',
        c.bold(e.ref),
        stateText(e),
        c.dim(note(e)),
      ]),
      ['', 'ACCOUNT', 'STATE', 'NOTE'],
    ),
  )
  if (!plan.pick) {
    const out = plan.accounts.filter((e) => e.state === 'logged-out').map((e) => `sideby login ${e.ref}`)
    const apiLeft = !includeApi && plan.accounts.some((e) => e.state === 'api')
    const why = plan.earliestReset
      ? `every signed-in ${family} account has used up its quota; ${plan.earliestReset.ref} is back ${resetWhen(plan.earliestReset.at, now.getTime(), 'en')}`
      : `no ${family} account can be used now`
    const same = plan.accounts.filter((e) => e.sameLoginAs).map((e) => e.ref)
    const sameNote = same.length ? `; ${same.join(', ')} share the quota of ${plan.from}` : ''
    const next = [
      ...(out.length ? [`sign in with \`${out.join('` or `')}\``] : []),
      ...(apiLeft ? ['add --include-api to use an API account'] : []),
    ]
    io.err(c.yellow(`\n${why}${sameNote}${next.length ? `; ${next.join(', or ')}` : ''}.`))
    return 1
  }
  const picked = plan.accounts.find((e) => e.ref === plan.pick)!
  const runCmd = ['sideby run', plan.pick, ...(a.rest.length ? ['--', ...a.rest.map(shellQuote)] : [])].join(
    ' ',
  )
  if (!plan.hasQuota) {
    // Without any Quota the pick is a guess, often the Account that just ran out: recommend nothing, start nothing.
    const setup = (await rt.quotaSetups()).some(
      (s) => s.family === family && s.plan.status === 'ready' && !s.plan.upgrade,
    )
    io.err(
      c.yellow(
        `\nno ${family} account has quota data yet, so sideby cannot tell which one has room; ${
          setup ? `turn it on with \`sideby quota setup ${family}\`, or ` : ''
        }start one yourself, for example \`${runCmd}\`.`,
      ),
    )
    return 1
  }
  const reason =
    picked.state === 'ready'
      ? `furthest from its limits, ${closest(picked)}`
      : plan.tight
        ? `every ${family} account is past its limit (${plan.tight.limit}% of a 5-hour window, ${plan.tight.longLimit}% of a weekly one); this one has the most left, ${closest(picked)}`
        : picked.state === 'unknown'
          ? 'no account with known room; this one has no quota data yet'
          : 'API account, pay per use'
  io.out(`\nNext: ${c.bold(plan.pick)} (${reason}).`)
  if (a.flags.has('dry-run')) {
    io.out(`Start it with \`${runCmd}\`.`)
    return 0
  }
  // The old session stays in the old Account (spec §3.13); a short note carries the context over.
  io.out(c.dim('Tip: ask your old session for a short handoff note and paste it into the new one.'))
  if (!rt.handoffSettings().auto)
    io.out(
      c.dim('Sessions can also hand over by themselves when quota runs low: see `sideby handoff status`.'),
    )
  return runAccount(rt, plan.pick, a.rest, io, {
    ...(a.flags.has('ignore-network') ? { ignoreNetwork: true } : {}),
    ...(a.flags.has('unattended') ? { unattended: true } : {}),
  })
}

export async function cmdDoctor(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const report = await rt.doctor({
    ...(a.positionals[0] ? { target: a.positionals[0] } : {}),
    fix: a.flags.has('fix'),
    force: a.flags.has('force'),
  })
  if (a.flags.has('json')) {
    json(io, serializeDoctor(report))
    return report.status === 'ok' ? 0 : 1
  }
  const home = rt.paths.home
  for (const f of report.fixes)
    io.out(`${f.ok ? c.green('fixed') : c.red('not fixed')} ${f.account} ${f.item}: ${f.message}`)
  for (const f of report.general)
    io.out(
      `${f.level === 'fail' ? c.red('✗') : c.yellow('!')} ${tilde(f.message, home)}${f.hint ? c.dim(` — ${f.hint}`) : ''}`,
    )
  for (const acc of report.accounts) {
    const bad = acc.findings.filter((f) => f.level !== 'ok')
    const mark = bad.some((f) => f.level === 'fail') ? c.red('✗') : bad.length ? c.yellow('!') : c.green('✓')
    const shared = acc.shared.total ? `shared ${acc.shared.ok}/${acc.shared.total}` : ''
    const backups = acc.backups ? c.dim(`  ${acc.backups} backup leftovers`) : ''
    io.out(
      `${mark} ${c.bold(acc.ref)} ${c.dim(acc.kind)} ${shared}${backups}  ${c.dim(tildify(acc.dir, home))}`,
    )
    for (const f of bad) {
      const lvl = f.level === 'fail' ? c.red('fail') : c.yellow('warn')
      const src = f.source === 'core' ? '' : c.dim(` [${f.source}]`)
      io.out(`    ${lvl} ${tilde(f.message, home)}${src}`)
      if (f.hint) io.out(`         ${c.dim(tilde(f.hint, home))}`)
    }
  }
  if (report.accounts.length === 0 && report.general.length === 0) io.out('No accounts to check.')
  const fixable = report.accounts.flatMap((x) => x.findings).filter((f) => f.fixable).length
  if (!a.flags.has('fix') && fixable)
    io.out(c.cyan(`\n${fixable} issue(s) can be fixed with \`sideby doctor --fix\`.`))
  return report.status === 'ok' ? 0 : 1
}

/** The words a person reads before agreeing to a change: where, from what to what, and who else it reaches. */
function tuneChangeLines(plan: TuneApplyPlan, home: string): string[] {
  const from = plan.current === null ? 'the default' : compactNumber(plan.current)
  const lines = [
    `  File:    ${tilde(plan.file, home)}${plan.creates ? ' (will be created)' : ''}`,
    `  Change:  auto-compact size ${from} -> ${plan.next === null ? 'the default' : compactNumber(plan.next)}`,
  ]
  if (plan.affected.length > 1)
    lines.push(`  Careful: this file is shared, so it also changes ${plan.affected.slice(1).join(', ')}`)
  if (plan.overrides.length)
    lines.push(
      `  Careful: these models save a size of their own, which wins over this one: ${plan.overrides.map((o) => `${o.model} (${compactNumber(o.value)})`).join(', ')}`,
    )
  lines.push('  Sessions already running keep the old value; new ones use the new one. You can undo it.')
  return lines
}

/** `160000`, `160k` or `1m` as a number of tokens, `default` as null (go back to the default); NaN when it is none of those. */
function parseTokens(text: string): number | null {
  if (text.trim().toLowerCase() === 'default') return null
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.trim())
  if (!m) return Number.NaN
  return Math.round(Number(m[1]) * (m[2] === '' ? 1 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1_000_000))
}

/** `sideby tune apply <account> [tokens]` and `sideby tune undo <account>` (spec §3.18, ADR-0012). */
async function cmdTuneChange(a: ParsedArgs, io: Io, action: 'apply' | 'undo'): Promise<number> {
  const [, ref, tokens] = a.positionals
  if (!ref || a.positionals.length > (action === 'apply' ? 3 : 2))
    throw new UsageError(
      `usage: sideby tune ${action} <account>${action === 'apply' ? ' [tokens]' : ''} [--yes] [--json]`,
    )
  const wantJson = a.flags.has('json')
  const yes = a.flags.has('yes')
  const rt = await createRuntime()
  const account = await rt.resolve(ref)
  const home = rt.paths.home
  const out = (data: object) => json(io, { account: account.ref, action, ...data })
  if (action === 'undo') {
    const info = await rt.tuneUndoInfo(account)
    if (!info) {
      if (wantJson) out({ applied: false, message: 'There is nothing from sideby to undo for this account.' })
      else io.out('There is nothing from sideby to undo for this account.')
      return 1
    }
    if (!yes) {
      if (wantJson) out({ applied: false, message: 'Run again with --yes to undo.' })
      else
        io.out(
          `Undo: auto-compact size ${info.applied === null ? 'the default' : compactNumber(info.applied)} -> ${info.previous === null ? 'the default' : compactNumber(info.previous)} in ${tilde(info.file, home)}\nRun again with --yes to undo.`,
        )
      return 10
    }
    const r = await rt.tuneUndo(account)
    if (wantJson) out({ applied: r.ok, message: r.message })
    else io.out(r.message)
    return r.ok ? 0 : 1
  }
  let value = tokens === undefined ? undefined : parseTokens(tokens)
  if (value === undefined) {
    const pick = (await rt.tuneGroups(account)).groups[0]?.pick ?? null
    if (!pick)
      throw new UserError(
        `no suggested size for ${account.ref} to use: give one, for example \`sideby tune apply ${account.ref} 160000\`, or run \`sideby tune ${account.ref}\` to see why`,
        { code: 'no-suggestion' },
      )
    value = pick.threshold
  }
  const plan = await rt.tuneApplyPlan(account, value)
  const planJson = { ...plan, file: tilde(plan.file, home) }
  if (plan.status === 'blocked') {
    if (wantJson) out({ applied: false, plan: planJson, message: plan.reason })
    else io.out(plan.reason ?? 'blocked')
    return 1
  }
  if (plan.status === 'unchanged') {
    if (wantJson)
      out({ applied: false, plan: planJson, message: 'It is already set to that value; nothing changed.' })
    else io.out('It is already set to that value; nothing changed.')
    return 0
  }
  if (!yes) {
    if (wantJson) out({ applied: false, plan: planJson, message: 'Run again with --yes to apply.' })
    else
      io.out(
        [
          `${plan.next === null ? 'Go back to the default' : `Use ${compactNumber(plan.next)}`} for ${account.ref}?`,
          ...tuneChangeLines(plan, home),
          'Run again with --yes to apply.',
        ].join('\n'),
      )
    return 10
  }
  const r = await rt.tuneApply(account, value)
  if (wantJson)
    out({ applied: r.ok, plan: { ...r.plan, file: tilde(r.plan.file, home) }, message: r.message })
  else io.out(r.message)
  return r.ok ? 0 : 1
}

const RC_STATE: Record<RemoteControlState, string> = {
  on: 'on',
  default: 'default',
  off: 'off',
  missing: 'no file',
  blocked: 'cannot change',
}

function rcGroupLine(g: RemoteControlGroup, home: string): string {
  const state = RC_STATE[g.state].padEnd(13)
  const paint =
    g.state === 'on'
      ? c.yellow
      : g.state === 'off'
        ? c.green
        : g.state === 'default'
          ? (x: string) => x
          : c.dim
  const where = g.reason ? tilde(g.reason, home) : tildify(g.file, home)
  return `  ${paint(state)} ${c.bold(g.accounts.join(', '))}  ${c.dim(where)}`
}

/**
 * `sideby remote-control [on|off|undo] [--yes] [--json]` (spec §3.22, ADR-0017): whether Claude sessions connect to
 * claude.ai by themselves, and turning that on or off for every Account (a preview with exit 10 until --yes).
 */
export async function cmdRemoteControl(a: ParsedArgs, io: Io, runtime?: Runtime): Promise<number> {
  const [action, extra] = a.positionals
  if (
    extra !== undefined ||
    (action !== undefined && action !== 'on' && action !== 'off' && action !== 'undo')
  )
    throw new UsageError('usage: sideby remote-control [on|off|undo] [--yes] [--json]')
  const wantJson = a.flags.has('json')
  const rt = runtime ?? (await createRuntime())
  const home = rt.paths.home
  const show = (gs: RemoteControlGroup[]) => gs.map((g) => ({ ...g, file: tildify(g.file, home) }))
  const out = (data: object) => json(io, { action: action ?? 'status', ...data })
  const groups = await rt.remoteControl()
  if (!action) {
    if (wantJson) {
      out({ groups: show(groups) })
      return 0
    }
    if (groups.length === 0) {
      io.out('No Claude accounts found.')
      return 0
    }
    io.out(
      'Remote Control: whether Claude sessions connect to claude.ai/code and the Claude app by themselves',
    )
    for (const g of groups) io.out(rcGroupLine(g, home))
    io.out(
      c.dim(
        '  on: every session connects; default: Claude Code or your organization decides; off: only when you run /remote-control',
      ),
    )
    if (remoteControlTodo(groups, 'off').length)
      io.out(
        c.cyan(
          '\nRun `sideby remote-control off` so no session connects by itself (it shows the change first).',
        ),
      )
    return 0
  }
  const apply = () =>
    action === 'off' ? rt.remoteControlOff() : action === 'on' ? rt.remoteControlOn() : rt.remoteControlUndo()
  const todo =
    action === 'off'
      ? remoteControlTodo(groups, 'off')
      : action === 'on'
        ? remoteControlTodo(groups, 'on')
        : groupsToUndo(groups)
  const verb = action === 'off' ? 'turn it off' : action === 'on' ? 'turn it on' : 'undo'
  if (todo.length === 0) {
    // Only what was read: writing here would act on a file the user never saw in a preview.
    const r = remoteControlNothingToDo(action, groups)
    if (wantJson) out({ applied: false, groups: show(groups), message: r.message })
    else io.out(tilde(r.message, home))
    return 1
  }
  if (!a.flags.has('yes')) {
    if (wantJson)
      out({
        applied: false,
        groups: show(todo),
        message: `Run again with --yes to ${verb}.`,
      })
    else {
      io.out(
        action === 'off'
          ? 'Turn off Remote Control at startup?'
          : action === 'on'
            ? 'Turn on Remote Control at startup?'
            : 'Put back the Remote Control setting sideby replaced?',
      )
      for (const g of todo) {
        const to = action === 'off' ? 'false' : action === 'on' ? 'true' : 'what it was before'
        const from = g.state === 'default' ? 'not set' : g.state === 'on' ? 'true' : 'false'
        io.out(`  ${tildify(g.file, home)}: remoteControlAtStartup ${from} -> ${to}`)
        io.out(c.dim(`    used by ${g.accounts.join(', ')}`))
      }
      io.out(
        action === 'off'
          ? 'Sessions already running stay connected until you restart them. You can still start it in a session with /remote-control, and undo this with `sideby remote-control undo`.'
          : action === 'on'
            ? 'Every new session then connects to claude.ai and the Claude app, where every device signed in to that account can read it. Undo this with `sideby remote-control undo`.'
            : 'New sessions go back to the previous setting.',
      )
      io.out(`Run again with --yes to ${verb}.`)
    }
    return 10
  }
  const r = await apply()
  const results = r.results.map((x) => ({ ...x, file: tildify(x.file, home) }))
  if (wantJson) out({ applied: r.ok, results, message: r.message })
  else {
    for (const x of results) io.out(`  ${x.ok ? c.green('ok') : c.red('failed')} ${x.file}: ${x.message}`)
    io.out(r.message)
  }
  return r.ok ? 0 : 1
}

const FROM: Record<string, string> = {
  sideby: 'set by sideby',
  host: 'from the host config',
  last: 'last session',
}

/**
 * `sideby model <account> [<model>|default] [--effort <level>|default] [--yes]` (spec §3.19, ADR-0014): shows the
 * Account's model and effort; with a change, shows it (exit 10) and writes it with --yes.
 */
export async function cmdModel(a: ParsedArgs, io: Io): Promise<number> {
  const [ref, model] = a.positionals
  if (!ref || a.positionals.length > 2 || a.flags.get('effort') === true)
    throw new UsageError(
      'usage: sideby model <account> [<model>|default] [--effort <level>|default] [--yes] [--json]',
    )
  const wantJson = a.flags.has('json')
  const rt = await createRuntime()
  const account = await rt.resolve(ref)
  const effort = a.flags.get('effort')
  const view = await accountModel(rt, account)
  const shown = {
    account: account.ref,
    family: account.family,
    settable: view.settable,
    ...(view.reason ? { reason: view.reason } : {}),
    efforts: view.efforts,
    models: view.models,
    sideby: view.sideby,
    host: view.host,
    last: view.last,
    ...(view.model ? { model: view.model } : {}),
    ...(view.effort ? { effort: view.effort } : {}),
  }
  if (model === undefined && effort === undefined) {
    if (a.flags.has('yes'))
      throw new UsageError('--yes needs a change: sideby model <account> <model> or --effort <level>')
    if (wantJson) json(io, shown)
    else {
      io.out(account.ref)
      io.out(
        `  model   ${view.model ? `${view.model.value}  (${FROM[view.model.from]})` : 'the host default'}`,
      )
      io.out(
        `  effort  ${view.effort ? `${view.effort.value}  (${FROM[view.effort.from]})` : 'the host default'}`,
      )
      if (view.settable)
        io.out(
          c.dim(
            `Change it: sideby model ${account.ref} <model|default> --effort <${view.efforts.join('|')}|default>`,
          ),
        )
      else if (view.reason) io.out(c.dim(view.reason))
    }
    return 0
  }
  const asChange = (v: string | undefined) => (v === undefined ? undefined : v === 'default' ? null : v)
  const change: ModelChange = {
    ...(model !== undefined ? { model: asChange(model) } : {}),
    ...(typeof effort === 'string' ? { effort: asChange(effort) } : {}),
  }
  const yes = a.flags.has('yes')
  const r = await setAccountModel(rt, account, change, { apply: yes })
  const home = rt.paths.home
  const result = { ...r, file: tilde(r.file, home) }
  if (wantJson) json(io, { ...shown, change: result })
  else if (!r.changed) io.out('Nothing to change.')
  else if (!yes)
    io.out(`${r.diff}Run again with --yes to apply. It affects sessions started with sideby from now on.`)
  else
    io.out(
      `Saved. New sessions of ${account.ref} started with sideby use: ${r.args.join(' ') || 'the host defaults'}`,
    )
  return r.changed && !yes ? 10 : 0
}

/** `sideby tune [account|family]`: estimated Compaction Threshold per model (spec §3.18). */
export async function cmdTune(a: ParsedArgs, io: Io): Promise<number> {
  if (a.positionals[0] === 'apply' || a.positionals[0] === 'undo')
    return cmdTuneChange(a, io, a.positionals[0])
  if (a.positionals.length > 1 || a.flags.has('yes'))
    throw new UsageError(
      'usage: sideby tune [account|family] [--json]  (--yes belongs to `tune apply` and `tune undo`)',
    )
  const rt = await createRuntime()
  const target = a.positionals[0]
  const all = await rt.accounts()
  let accounts = all
  if (target) {
    const ofFamily = all.filter((x) => x.family === target)
    if (ofFamily.length) accounts = ofFamily
    else if ((await rt.familyInfo()).some((f) => f.id === target)) accounts = []
    else accounts = [await rt.resolve(target)]
  }
  const rows = await Promise.all(
    accounts.map(async (x) => ({ ref: x.ref, family: x.family, tuning: await rt.tuning(x) })),
  )
  if (a.flags.has('json')) {
    json(io, { accounts: rows })
    return 0
  }
  if (rows.length === 0) {
    io.out(
      target
        ? `No ${target} accounts yet. Run \`sideby new ${target} <name>\` to add one.`
        : 'No accounts found yet. Run `sideby` for how to start.',
    )
    return 0
  }
  for (const r of rows) {
    io.out(c.bold(r.ref))
    for (const line of tuningLines(r.tuning)) io.out(`  ${line}`)
  }
  io.out(
    c.dim(
      `\nEstimates from your last ${USAGE_DAYS} days of local sessions; sideby does not change any setting.`,
    ),
  )
  return 0
}

export async function cmdQuota(a: ParsedArgs, io: Io): Promise<number> {
  const sub = a.positionals[0]
  if (sub === 'check') {
    const usage = 'usage: sideby quota check <family> on|off [--json]'
    if (a.positionals.length !== 3 || a.rest.length || a.flags.has('refresh') || a.flags.has('yes'))
      throw new UsageError(usage)
    const on = onOff(a.positionals[2], usage)
    const family = a.positionals[1]!
    const rt = await createRuntime()
    if (!rt.quotaChecks().some((x) => x.family === family))
      throw new UserError(
        `${family} has no quota fetcher; run sideby families to choose a family that fetches quota.`,
      )
    const r = await rt.setQuotaCheck(family, on)
    if (a.flags.has('json')) json(io, { family, on, ...r })
    else io.out(`${family}: quota checks ${on ? 'on' : 'off'}.`)
    return 0
  }
  if (sub === 'setup' || sub === 'teardown') return cmdQuotaSetup(a, io, sub)
  const rt = await createRuntime()
  const accounts = !sub
    ? displayOrdered(await rt.accounts(), rt)
    : rt.families.has(sub)
      ? displayOrdered(await rt.accounts(), rt).filter((x) => x.family === sub)
      : [await rt.resolve(sub)]
  // Asks the Families that fetch Quota again now (spec §3.26); a check that is turned off stays off.
  if (a.flags.has('refresh')) await rt.refreshQuota(accounts)
  const rows = await Promise.all(
    accounts.map(async (x) => ({
      ref: x.ref,
      kind: x.kind,
      quota: await rt.quota(x),
      usage: await rt.usage(x),
    })),
  )
  if (a.flags.has('json')) {
    json(io, { accounts: rows })
    return 0
  }
  if (rows.length === 0) {
    io.out('No accounts found yet. Run `sideby` for how to start.')
    return 0
  }
  const now = new Date()
  io.out(
    table(
      rows.map((r) => [
        c.bold(r.ref),
        `${quotaText(r.quota, now)}${r.quota.status === 'ok' && r.quota.from ? c.dim(` read from ${r.quota.from} (same login)`) : ''}`,
        usageText(r.usage),
      ]),
      ['ACCOUNT', 'QUOTA', `USAGE (${USAGE_DAYS}d)`],
    ),
  )
  for (const r of rows) {
    if (r.quota.status === 'unavailable' && r.quota.detail) io.out(c.dim(`${r.ref}: ${r.quota.detail}`))
    if (r.quota.status === 'ok' && r.quota.fetchError)
      io.out(c.dim(`${r.ref}: the latest check failed: ${r.quota.fetchError}`))
  }
  // Suggest a setup only where it would help: the Family has one and its plan can be applied.
  const off = new Set(
    rows
      .filter((r) => r.quota.status === 'unavailable' && r.quota.reason === 'not-enabled')
      .map((r) => r.ref.slice(0, r.ref.indexOf(':'))),
  )
  if (off.size)
    for (const s of await rt.quotaSetups())
      if (off.has(s.family) && s.plan.status === 'ready')
        io.out(
          c.cyan(
            `\nTurn on ${s.family} quota with \`sideby quota setup ${s.family}\` (shows the change first).`,
          ),
        )
  return 0
}

async function cmdQuotaSetup(a: ParsedArgs, io: Io, sub: 'setup' | 'teardown'): Promise<number> {
  const familyId = a.positionals[1]
  if (!familyId)
    throw new UsageError(`usage: sideby quota ${sub} <family>${sub === 'setup' ? ' [--yes]' : ''}`)
  const rt = await createRuntime()
  return runSetup(a, io, rt, 'quota', sub, familyId, rt.quotaSetup(familyId))
}

/** `sideby quota|handoff setup|teardown <family>`: show the change, apply it only with --yes (exit 10 before). */
async function runSetup(
  a: ParsedArgs,
  io: Io,
  rt: Runtime,
  command: 'quota' | 'handoff',
  sub: 'setup' | 'teardown',
  familyId: string,
  setup: ReturnType<Runtime['quotaSetup']>,
): Promise<number> {
  if (sub === 'teardown') {
    const r = await setup.teardown()
    if (a.flags.has('json')) json(io, { family: familyId, ...r })
    else {
      io.out(`${r.ok ? c.green('✓') : c.red('✗')} ${r.message}`)
      if (r.diff) io.out(r.diff)
    }
    return r.ok ? 0 : 1
  }
  const plan = await setup.plan()
  const apply = a.flags.has('yes')
  if (plan.status !== 'ready' || !apply) {
    if (a.flags.has('json')) json(io, { family: familyId, applied: false, plan })
    else {
      io.out(plan.message)
      if (plan.status === 'ready') {
        // An upgrade's message already says what the one added key does; the summary describes the first setup.
        io.out(
          `\n${plan.upgrade ? '' : `${setup.summary}\n`}Change to ${tildify(plan.file, rt.paths.home)}:\n`,
        )
        io.out(plan.diff)
        io.out(
          c.cyan(
            `\nApply it with \`sideby ${command} setup ${familyId} --yes\`; undo any time with \`sideby ${command} teardown ${familyId}\`.`,
          ),
        )
      }
    }
    // 10: the change is shown and waits for the user's yes (spec §3.9); agents ask before adding --yes.
    return plan.status === 'blocked' ? 1 : plan.status === 'ready' ? 10 : 0
  }
  const after = await setup.apply()
  if (a.flags.has('json')) json(io, { family: familyId, applied: after.status === 'enabled', plan: after })
  else io.out(`${after.status === 'enabled' ? c.green('✓') : c.red('✗')} ${after.message}`)
  return after.status === 'enabled' ? 0 : 1
}

/** `sideby handoff status` (spec §3.17): what Auto Handoff still needs, with the commands to run. */
async function cmdHandoffStatus(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const st = await handoffStatus(rt)
  if (a.flags.has('json')) {
    const overview = await handoffOverview(rt)
    json(io, { ...st, apiUndecided: (await handoffRulesView(rt, overview)).apiUndecided, overview })
    return 0
  }
  io.out(
    `Auto Handoff: ${st.auto ? c.green('on') : c.yellow('off')} (same family ${st.sameFamily ? 'on' : 'off'}; brief at ${st.prepareAt}%, hand over at ${st.threshold}%)`,
  )
  if (st.sideby.problem) io.out(c.red(`sideby on PATH: ${st.sideby.problem}`))
  if ((await handoffRulesView(rt)).apiUndecided) io.out(c.yellow(API_UNDECIDED))
  io.out(c.dim('Every rule in plain words: `sideby handoff rules`.'))
  if (st.families.length)
    io.out(
      `\n${table(
        st.families.map((f) => [
          c.bold(f.family),
          f.starts.length ? f.starts.join(', ') : c.dim('takes over only'),
          f.ready ? c.green('ready') : f.starts.length ? c.yellow('not yet') : c.dim('—'),
          f.order.policy === 'order' ? f.order.order.join(' → ') : c.dim('by quota'),
        ]),
        ['FAMILY', 'STARTS', 'STATE', 'ORDER'],
      )}`,
    )
  for (const f of st.families) {
    for (const p of f.problems) io.out(c.yellow(`${f.family}: ${p}`))
    for (const n of f.notes) io.out(c.dim(`${f.family}: ${n}`))
  }
  if (st.nextSteps.length) {
    io.out('\nNext:')
    for (const [i, step] of st.nextSteps.entries()) io.out(`  ${i + 1}. ${step}`)
  }
  return 0
}

/** `sideby handoff rules` (spec §3.17 "接力规则"): every rule in effect, in plain words, and how to change each. */
async function cmdHandoffRules(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const view = await handoffRulesView(rt)
  if (a.flags.has('json')) {
    json(io, view)
    return 0
  }
  io.out(
    `Auto Handoff: ${view.auto ? c.green('on') : c.yellow('off')}${view.auto ? '' : c.dim(' (these rules apply once it is on)')}`,
  )
  if (view.apiUndecided) io.out(c.yellow(`\n${API_UNDECIDED}`))
  io.out('')
  for (const [i, r] of view.rules.entries()) {
    io.out(`${String(i + 1).padStart(2)}. ${r.text}`)
    const change = ruleCommand(r)
    if (change) io.out(c.dim(`    change: ${change}`))
  }
  if (view.takeover.length) {
    io.out('\nIf a handoff started now:')
    for (const t of view.takeover) io.out(`  ${t.ref} → ${decisionText(t.decision)}`)
  }
  return 0
}

const API_UNDECIDED =
  'API accounts no longer take over by default: they are billed per use. Keep them as the last resort with `sideby config set handoff.api true --yes`, or say no with `sideby config set handoff.api false --yes`.'

/** The command that changes a rule, or null for a fixed one. */
function ruleCommand(r: HandoffRule): string | null {
  const set = (key: string, v: string) => `sideby config set handoff.${key} ${v} --yes`
  switch (r.id) {
    case 'when':
      return `${set('threshold', '<percent>')}; ${set('prepareAt', '<percent>')}; ${set('adaptive', String(!r.params.adaptive))}`
    case 'takeover':
      return `follows the threshold: ${set('threshold', '<percent>')}`
    case 'wait':
      return set('waitIfResetWithinMinutes', '<minutes>')
    case 'sameFamily':
    case 'otherFamilies':
    case 'api':
      return (
        set(r.id, String(!r.params.on)) +
        (r.id === 'otherFamilies' ? `; ${set('familyOrder', '\'["codex","grok"]\'')}` : '')
      )
    case 'organization':
      return set('crossOrganization', '\'["<account>"]\'')
    case 'order':
      return `sideby handoff enable --order ${r.params.family}=<account,account>`
    case 'countdown':
      return set('countdownSeconds', '<seconds>')
    default:
      return null
  }
}

function decisionText(d: HandoffDecision): string {
  if (d.kind === 'pick') return d.ref
  if (d.kind === 'wait') return `waits for the reset at ${new Date(d.until).toLocaleTimeString()}`
  return d.earliestReset
    ? `none now (${d.reason}); ${d.earliestReset.ref} is back at ${new Date(d.earliestReset.at).toLocaleTimeString()}`
    : `none (${d.reason})`
}

function intFlag(a: ParsedArgs, name: string): number | undefined {
  const v = a.flags.get(name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (typeof v !== 'string' || !Number.isInteger(n) || n < 0)
    throw new UsageError(`--${name} takes a whole number, for example --${name} 95`)
  return n
}

/** The `enable`/`disable` command line for `change`, to repeat with --yes. */
function switchCommand(sub: 'enable' | 'disable', change: HandoffChange): string {
  const parts = [`sideby handoff ${sub}`]
  if (change.sameFamily === true) parts.push('--same-family')
  if (change.sameFamily === false) parts.push('--no-same-family')
  if (change.otherFamilies === true) parts.push('--other-ai')
  if (change.otherFamilies === false) parts.push('--no-other-ai')
  if (change.familyOrder) parts.push(`--ai-order ${change.familyOrder.join(',')}`)
  if (change.api === true) parts.push('--api')
  if (change.api === false) parts.push('--no-api')
  for (const o of change.orders ?? []) parts.push(`--order ${o.family}=${o.order.join(',')}`)
  if (change.prepareAt !== undefined) parts.push(`--prepare-at ${change.prepareAt}`)
  if (change.threshold !== undefined) parts.push(`--threshold ${change.threshold}`)
  if (change.waitIfResetWithinMinutes !== undefined)
    parts.push(`--wait-minutes ${change.waitIfResetWithinMinutes}`)
  if (change.countdownSeconds !== undefined) parts.push(`--countdown ${change.countdownSeconds}`)
  return parts.join(' ')
}

/** `sideby handoff enable|disable` (spec §3.17): show the config change (exit 10), write it with --yes. */
async function cmdHandoffSwitch(a: ParsedArgs, io: Io, sub: 'enable' | 'disable'): Promise<number> {
  const change: HandoffChange = { auto: sub === 'enable' }
  if (sub === 'enable') {
    if (a.flags.has('same-family')) change.sameFamily = true
    if (a.flags.has('no-same-family')) change.sameFamily = false
    if (a.flags.has('other-ai')) change.otherFamilies = true
    if (a.flags.has('no-other-ai')) change.otherFamilies = false
    if (a.flags.has('api')) change.api = true
    if (a.flags.has('no-api')) change.api = false
    const aiOrder = a.flags.get('ai-order')
    if (aiOrder === true) throw new UsageError('--ai-order takes families, for example --ai-order codex,grok')
    if (typeof aiOrder === 'string')
      change.familyOrder = aiOrder
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    const order = a.flags.get('order')
    if (typeof order === 'string') {
      const eq = order.indexOf('=')
      if (eq <= 0)
        throw new UsageError(
          '--order takes <family>=<account,account>, for example --order claude=codex001,cc002',
        )
      change.orders = [
        {
          family: order.slice(0, eq),
          order: order
            .slice(eq + 1)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        },
      ]
    }
    const nums = {
      prepareAt: 'prepare-at',
      threshold: 'threshold',
      waitIfResetWithinMinutes: 'wait-minutes',
      countdownSeconds: 'countdown',
    } as const
    for (const [key, flag] of Object.entries(nums)) {
      const n = intFlag(a, flag)
      if (n !== undefined) change[key as keyof typeof nums] = n
    }
  }
  const rt = await createRuntime()
  const r = await configureHandoff(rt, change, { apply: a.flags.has('yes') })
  const nextSteps =
    r.applied && sub === 'enable' ? (await handoffStatus(await createRuntime())).nextSteps : []
  if (a.flags.has('json')) {
    json(io, { applied: r.applied, file: r.file, diff: r.diff, settings: r.settings, nextSteps })
  } else if (!r.changed)
    io.out(`Auto Handoff is already ${sub === 'enable' ? 'set that way' : 'off'}; nothing to change.`)
  else if (!r.applied) {
    io.out(`Change to ${tildify(r.file, rt.paths.home)}:\n\n${r.diff}`)
    if (sub === 'enable' && r.settings.api)
      io.out(
        c.yellow(
          'API accounts are billed per use and sideby does not cap spending; set a limit in the provider’s console.',
        ),
      )
    if (sub === 'enable' && r.settings.sameFamily)
      io.out(
        c.yellow(
          'Same-family hand-over moves work between subscriptions of one vendor; vendors may act on that.',
        ),
      )
    io.out(c.cyan(`\nApply it with \`${switchCommand(sub, change)} --yes\`.`))
  } else {
    io.out(`${c.green('✓')} Auto Handoff is ${sub === 'enable' ? 'on' : 'off'}.`)
    if (nextSteps.length) {
      io.out('Still to do:')
      for (const [i, step] of nextSteps.entries()) io.out(`  ${i + 1}. ${step}`)
    }
  }
  // 10: the change is shown and waits for the user's yes, as for `quota setup`.
  return r.changed && !r.applied ? 10 : 0
}

/** `sideby handoff ready|setup|teardown` (spec §3.17). */
export async function cmdHandoff(a: ParsedArgs, io: Io): Promise<number> {
  const sub = a.positionals[0]
  if (sub === 'setup' || sub === 'teardown') {
    const familyId = a.positionals[1]
    if (!familyId)
      throw new UsageError(`usage: sideby handoff ${sub} <family>${sub === 'setup' ? ' [--yes]' : ''}`)
    const rt = await createRuntime()
    return runSetup(a, io, rt, 'handoff', sub, familyId, rt.handoffSetup(familyId))
  }
  if (sub === 'status') return cmdHandoffStatus(a, io)
  if (sub === 'rules') return cmdHandoffRules(a, io)
  if (sub === 'enable' || sub === 'disable') return cmdHandoffSwitch(a, io, sub)
  if (sub !== 'ready')
    throw new UsageError(
      'usage: sideby handoff status | rules | enable [--same-family] [--other-ai] [--ai-order <family,…>] [--api] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes] | disable [--yes] | ready [--to <account>] [--brief <file>] | setup|teardown <family> [--yes]',
    )
  const flag = a.flags.get('brief')
  const brief = typeof flag === 'string' ? flag : undefined
  const toFlag = a.flags.get('to')
  if (toFlag === true) throw new UsageError('usage: sideby handoff ready --to <account> [--brief <file>]')
  const rt = await createRuntime()
  // An Account or a short command; resolve() says what to do when there is no such Account.
  const to = toFlag === undefined ? undefined : (await rt.resolve(toFlag)).ref
  const decision = await readyDecision(rt, process.env, to)
  if (decision && decision.kind !== 'pick')
    throw new UserError(
      to
        ? `cannot hand over to ${to}: ${explain(decision)}; keep working in this account or pick another with --to`
        : `nothing can take over now: ${explain(decision)}; keep working in this account`,
      { code: 'no-pick' },
    )
  let request: Awaited<ReturnType<typeof requestHandoff>>
  try {
    request = await requestHandoff(process.env, brief, to)
  } catch (err) {
    throw new UserError(
      `cannot read the brief ${brief}: ${(err as Error).message}; check the path and retry`,
      {
        code: 'brief-unreadable',
      },
    )
  }
  if (!request)
    throw new UserError(
      'not inside a session sideby started with Auto Handoff; set `handoff.auto` in the config and start the account with sideby (`sideby run`, a short command), or use `sideby next <family>`',
      { code: 'not-in-handoff-run' },
    )
  // The account that will really take over; `sideby next` cannot tell, it does not know the chain.
  const next = decision?.kind === 'pick' ? decision.ref : undefined
  if (a.flags.has('json'))
    json(io, {
      requested: true,
      ...(next ? { next } : {}),
      ...(request.brief ? { brief: request.brief } : {}),
      ...(request.now ? { now: true } : {}),
    })
  else if (request.now)
    io.out(`This session was waiting for its quota; ${next ?? 'the next account'} takes over now.`)
  else
    io.out(
      `${next ? `${next} takes over` : 'The next account starts'} when this turn ends; finish the turn now.`,
    )
  return 0
}

export async function cmdPlugins(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  if (a.positionals.length) {
    const [action, target, ...extra] = a.positionals
    if (!target || extra.length || a.rest.length || !['new', 'check'].includes(action!))
      throw new UsageError('Use sideby plugins new <id> or sideby plugins check <id|path>.')
    const { join, isAbsolute } = await import('node:path')
    const { expandUserPath } = await import('../core/paths.ts')
    const dirs = (rt.config.pluginDirs ?? [rt.paths.userPluginsDir]).map(
      (p) => expandUserPath(p, rt.paths.home) ?? p,
    )
    if (action === 'new') {
      const { scaffoldPlugin } = await import('../plugins/scaffold.ts')
      const result = await scaffoldPlugin({ id: target, dir: dirs[0] ?? rt.paths.userPluginsDir })
      if (a.flags.has('json')) json(io, result)
      else io.out(`Created ${result.dir}. Fill in the TODOs, then run sideby plugins check ${target}.`)
      return 0
    }
    const { checkPlugin } = await import('../plugins/check.ts')
    const { access } = await import('node:fs/promises')
    let dir = target
    if (!isAbsolute(target) && !target.includes('/') && !target.startsWith('.')) {
      dir = join(dirs[0] ?? rt.paths.userPluginsDir, target)
      for (const root of dirs)
        if (
          await access(join(root, target)).then(
            () => true,
            () => false,
          )
        ) {
          dir = join(root, target)
          break
        }
    }
    const result = await checkPlugin({ dir })
    if (a.flags.has('json')) json(io, result)
    else {
      io.out(result.ok ? 'OK' : result.problems.map((p) => `${p.message}: ${p.fix}`).join('\n'))
      io.out('Plugins run as you, with your permissions. Only load plugins you trust.')
    }
    return result.ok ? 0 : 1
  }
  if (a.flags.has('json'))
    // Plugin settings can hold tokens: report which keys are set, never their values.
    json(io, {
      plugins: rt.plugins.map(({ config, ...p }) => ({ ...p, configKeys: Object.keys(config).sort() })),
      errors: [...rt.pluginErrors],
    })
  else {
    io.out(
      table(
        rt.plugins.map((p) => [
          c.bold(p.name),
          p.version,
          p.source === 'builtin' ? 'built-in' : tildify(p.source, rt.paths.home),
          [...p.families, ...(p.name === rt.projectCategoriesFrom ? ['project categories'] : [])].join(
            ', ',
          ) || c.dim('hooks'),
        ]),
        ['PLUGIN', 'VERSION', 'SOURCE', 'PROVIDES'],
      ),
    )
    for (const e of rt.pluginErrors) io.err(c.red(`✗ ${e.where}: ${e.message}`))
    io.out(c.dim('\nPlugins run as you, with your permissions. Only load plugins you trust.'))
  }
  return rt.pluginErrors.length ? 1 : 0
}

export async function cmdShellInit(a: ParsedArgs, io: Io): Promise<number> {
  if (a.positionals[0] === 'setup') return cmdShellSetup(a, io)
  const shell = a.positionals[0]
  const write = a.flags.has('write')
  const usage = 'usage: sideby shell-init zsh|bash  |  sideby shell-init [zsh|bash] --write'
  if (a.positionals.length > 1 || (shell === undefined && !write)) throw new UsageError(usage)
  if (shell !== undefined && !SHELLS.includes(shell as Shell)) throw new UsageError(usage)
  const rt = await createRuntime()
  if (!write) {
    io.out((await rt.shellInitScript(shell as Shell)).replace(/\n$/, ''))
    return 0
  }
  const configured = SHELLS.filter((s) => rt.config.shellInitFile?.[s])
  const wanted = shell ? [shell as Shell] : configured
  const missing = shell && !configured.includes(shell as Shell) ? shell : wanted.length ? null : 'zsh'
  if (missing)
    throw new UserError(
      `no shellInitFile.${missing} in ${tildify(rt.paths.configFile, rt.paths.home)}; add for example "shellInitFile": { "${missing}": "~/.config/sideby/shell-init.${missing}" }`,
    )
  const files = await rt.writeShellInitFiles(wanted)
  printShellInitWrites(io, files, rt.paths.home)
  return files.every((f) => f.ok) ? 0 : 1
}

/**
 * `sideby shell-init setup [zsh|bash] [--yes|--undo]` (spec §3.13, ADR-0036): shows the line it would add to the rc
 * file and exits 10, adds it with --yes, or takes out exactly what it added with --undo.
 */
async function cmdShellSetup(a: ParsedArgs, io: Io): Promise<number> {
  const [, given, ...extra] = a.positionals
  if (extra.length || (given !== undefined && !SHELLS.includes(given as Shell)) || a.flags.has('write'))
    throw new UsageError('usage: sideby shell-init setup [zsh|bash] [--yes|--undo] [--json]')
  const { applyShellSetup, setupBlock, shellSetupStatus, userShell } = await import('../core/shell-setup.ts')
  const rt = await createRuntime()
  const shell = (given as Shell | undefined) ?? userShell(rt.env)
  const home = rt.paths.home
  const undo = a.flags.has('undo')
  const st = await shellSetupStatus(shell, home, rt.env, rt.config.shellInitFile)
  const rc = tildify(st.rc, home)
  const out = (data: object, code: number) => {
    if (a.flags.has('json')) json(io, { shell, rc, ...data })
    return code
  }
  if (!undo && st.loaded) {
    if (!a.flags.has('json')) io.out(`${c.green('✓')} new terminals already load your short commands (${rc})`)
    return out({ status: 'loaded' }, 0)
  }
  if (undo && !st.added) {
    if (!a.flags.has('json')) io.out(`${c.dim('·')} ${rc} has no line sideby added; nothing to undo`)
    return out({ status: 'not-added' }, 0)
  }
  if (!a.flags.has('yes') && !undo) {
    if (!a.flags.has('json')) {
      io.out(`New terminals do not load your short commands yet. sideby would add to the end of ${rc}:\n`)
      io.out(c.dim(setupBlock(shell).replace(/\n$/, '')))
      io.out('\nRun again with --yes to add it; `sideby shell-init setup --undo` takes it out again.')
    }
    return out({ status: 'confirm', block: setupBlock(shell) }, 10)
  }
  const r = await applyShellSetup(shell, home, rt.env, rt.config.shellInitFile, { undo })
  if (!a.flags.has('json'))
    io.out(
      r.status === 'added'
        ? `${c.green('✓')} added the line to ${rc}; it works in a new terminal window`
        : `${c.green('✓')} took sideby's line out of ${rc}`,
    )
  return out({ status: r.status }, 0)
}

/** Absolute path of this CLI's entry (`main.ts` from source, `main.js` from dist), for detached processes. */
function cliEntry(): string {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return fileURLToPath(new URL(`./main.${ext}`, import.meta.url))
}

function parsePort(a: ParsedArgs): number | undefined {
  const portFlag = a.flags.get('port')
  const port = typeof portFlag === 'string' ? Number(portFlag) : undefined
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
    throw new UsageError('--port must be a number between 1 and 65535')
  return port
}

export async function cmdUi(a: ParsedArgs, io: Io): Promise<number> {
  const port = parsePort(a)
  const bg = await import('../panel/background.ts')
  const paths = resolvePaths(process.env)
  if (a.flags.has('stop')) {
    if (a.flags.size > 1) throw new UsageError('--stop takes no other options')
    const r = await bg.stopBackgroundPanel(paths)
    if (r.status === 'stopped')
      io.out(`${c.green('✓')} stopped the background panel (pid ${r.pid}, ${r.url})`)
    else if (r.status === 'not-running')
      io.out(`No background panel is running.${r.detail ? ` ${r.detail}.` : ''}`)
    else io.err(c.red(`✗ could not stop the background panel: ${r.detail}`))
    return r.status === 'failed' ? 1 : 0
  }
  if (a.flags.has('wait') && !a.flags.has('background'))
    throw new UsageError('--wait goes with --background: sideby ui --background --wait')
  if (a.flags.has(bg.DETACHED_FLAG))
    return bg.serveDetached({
      paths,
      env: process.env,
      ...(port ? { port } : {}),
      runtimeFactory: (env) => createRuntime({ env }),
      log: (s) => io.out(s),
    })
  const { openBrowser, startPanelServer } = await import('../panel/server.ts')
  if (a.flags.has('background')) {
    const r = await bg.startBackgroundPanel({
      paths,
      env: process.env,
      entry: cliEntry(),
      ...(port ? { port } : {}),
    })
    io.out(
      r.reused
        ? `sideby panel is already running at ${r.url}`
        : `sideby panel: ${r.url} (in the background${r.replaced ? ', replacing the one from an older sideby' : ''}; stop it with \`sideby ui --stop\`)`,
    )
    if (!a.flags.has('no-open') && !(await openBrowser(r.url))) io.out(`open ${r.url} in your browser`)
    // Under WSL the Startup script's `wsl.exe` waits here, so WSL keeps the distribution (and the Panel) up (ADR-0055).
    if (a.flags.has('wait'))
      while ((await bg.backgroundPanelPort(paths)) !== null) await new Promise((r) => setTimeout(r, 30_000))
    return 0
  }
  const srv = await startPanelServer({
    runtimeFactory: () => createRuntime(),
    ...(port ? { port } : {}),
    open: !a.flags.has('no-open'),
    log: (s) => io.out(s),
  })
  if (srv.reused) return 0
  io.out(c.dim('Ctrl+C to stop'))
  // Like the background Panel, a Panel left running notices the end of a stretch of Unattended Mode (spec §3.37).
  const { watchUnattendedEnded } = await import('../core/unattended-ended.ts')
  const stopWatch = watchUnattendedEnded(paths, async (ctx) => {
    for (const f of await (await createRuntime()).unattendedEnded(ctx))
      io.err(`sideby: [${f.plugin}] unattended.ended failed: ${f.error}`)
  })
  await new Promise<void>((resolve) => {
    const stop = () => {
      stopWatch()
      void srv.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

/**
 * `sideby update --skill [--yes] [--json]` (spec §3.23): only the installed sideby skill, toward this version. It
 * never installs the CLI, also when a newer one exists (it says that update is separate), and asks no registry. The
 * new code runs it after an install, so a registry that moved meanwhile never installs a version nobody confirmed.
 */
async function cmdUpdateSkill(a: ParsedArgs, io: Io): Promise<number> {
  if (a.positionals.length || a.rest.length)
    throw new UsageError('usage: sideby update --skill [--yes] [--json]')
  const u = await import('../core/update.ts')
  const { SKILL_INSTALL } = await import('../core/skill-check.ts')
  const paths = resolvePaths(process.env)
  const asJson = a.flags.has('json')
  const plan = await u.planSkillUpdate(paths, process.env)
  const shown = u.shownPlan(plan)
  const sk = plan.skill
  // The skills tool fetches the newest skill, so a newer CLI should follow; that stays the user's own step.
  const cliLine = () => {
    if (plan.available)
      io.out(
        c.cyan(`sideby ${plan.latest} is available; updating sideby itself is separate: \`sideby update\`.`),
      )
  }
  if (!sk?.outdated || !sk.canRun) {
    if (asJson) json(io, { ...shown, updated: false })
    else {
      if (!sk) io.out(`No sideby skill is installed. To install it: ${SKILL_INSTALL}`)
      else if (!sk.outdated) io.out(`${c.green('✓')} The sideby skill is already for sideby ${plan.current}.`)
      else io.out(c.yellow(`The sideby skill is not updated by sideby: ${sk.reason}.\n  ${sk.command}`))
      cliLine()
    }
    return 0
  }
  if (!a.flags.has('yes')) {
    if (asJson) json(io, { ...shown, updated: false })
    else {
      const from = sk.installed.map((v) => v ?? 'no version').join(', ')
      io.out(`Updating the sideby skill (for ${from}) to sideby ${plan.current} runs:\n  ${sk.command}`)
      cliLine()
      io.out(c.cyan('\nRun it with `sideby update --skill --yes`.'))
    }
    return 10
  }
  if (!asJson) io.out(c.dim(`$ ${sk.command}`))
  const r = await u.applySkillOnly(
    paths,
    sk,
    process.env,
    asJson ? undefined : (t) => process.stderr.write(t),
  )
  if (asJson) json(io, { ...shown, updated: false, skillUpdated: r?.ok ?? false, message: r?.message ?? '' })
  else {
    if (r?.ok) io.out(`${c.green('✓')} ${r.message}; agents load it in their next session.`)
    else io.err(c.red(`✗ ${r?.message}`))
    cliLine()
  }
  return r?.ok ? 0 : 1
}

/**
 * `sideby update [--yes] [--json]` (spec §3.23): asks the registry now, shows what an Update runs, and runs it with
 * `--yes` (exit 10 before). An install sideby cannot update gets the command to run and exit 1. `--skill` updates the
 * skill alone (cmdUpdateSkill).
 */
export async function cmdUpdate(a: ParsedArgs, io: Io): Promise<number> {
  if (a.positionals.length) throw new UsageError('usage: sideby update [--skill] [--yes] [--json]')
  if (a.flags.has('auto')) {
    if (a.rest.length) throw new UsageError('usage: sideby update --auto on|off [--json]')
    const auto = onOff(a.flags.get('auto'), 'usage: sideby update --auto on|off [--json]')
    const paths = resolvePaths(process.env)
    const r = await editConfigUpdate(paths.configFile, (cur) => ({ ...cur, auto }))
    if (a.flags.has('json')) json(io, { auto, changed: r.changed })
    else io.out(`Auto Update ${auto ? 'on' : 'off'}${r.changed ? '.' : ' (unchanged).'}`)
    return 0
  }
  if (a.flags.has('skill')) return cmdUpdateSkill(a, io)
  const u = await import('../core/update.ts')
  const { SKILL_INSTALL } = await import('../core/skill-check.ts')
  const { backgroundPanelPort } = await import('../panel/background.ts')
  const paths = resolvePaths(process.env)
  const asJson = a.flags.has('json')
  const plan = await u.planUpdate(paths, process.env)
  const shown = u.shownPlan(plan)
  const sk = plan.skill
  const skillLine = (s: NonNullable<typeof sk>) =>
    s.canRun
      ? `the sideby skill (for ${s.installed.map((v) => v ?? 'no version').join(', ')}) is updated too:\n  ${s.command}`
      : `the sideby skill is not updated by sideby: ${s.reason}.\n  ${s.command}`
  if (!plan.available) {
    // The CLI is current; an outdated skill is the one thing left to update.
    if (sk?.outdated && sk.canRun) {
      if (!a.flags.has('yes')) {
        if (asJson) json(io, { ...shown, updated: false })
        else {
          io.out(`${c.green('✓')} sideby ${plan.current} is the latest version.`)
          io.out(`\nUpdating ${skillLine(sk)}`)
          io.out(c.cyan('\nRun it with `sideby update --yes`.'))
        }
        return 10
      }
      if (!asJson) io.out(c.dim(`$ ${sk.command}`))
      const r = await u.applySkillOnly(
        paths,
        sk,
        process.env,
        asJson ? undefined : (t) => process.stderr.write(t),
      )
      if (asJson)
        json(io, { ...shown, updated: false, skillUpdated: r?.ok ?? false, message: r?.message ?? '' })
      else if (r?.ok) io.out(`${c.green('✓')} ${r.message}; agents load it in their next session.`)
      else io.err(c.red(`✗ ${r?.message}`))
      return r?.ok ? 0 : 1
    }
    if (asJson) json(io, { ...shown, updated: false })
    else {
      io.out(`${c.green('✓')} sideby ${plan.current} is the latest version.`)
      if (sk?.outdated) io.out(c.yellow(skillLine(sk)))
    }
    return 0
  }
  if (!plan.canRun) {
    if (asJson) json(io, { ...shown, updated: false })
    else {
      io.out(
        `sideby ${c.bold(plan.latest)} is available (you have ${plan.current}). What changed: ${plan.releaseNotes}`,
      )
      io.err(
        c.yellow(`sideby cannot update itself: ${plan.method.reason}. Run it yourself:\n  ${plan.command}`),
      )
    }
    return 1
  }
  if (!a.flags.has('yes')) {
    if (asJson) json(io, { ...shown, updated: false })
    else {
      io.out(
        `sideby ${c.bold(plan.latest)} is available (you have ${plan.current}). What changed: ${plan.releaseNotes}`,
      )
      io.out(`\nUpdating runs:\n  ${plan.command}`)
      if (sk?.outdated) io.out(`Then ${skillLine(sk)}`)
      io.out(c.cyan('\nRun it with `sideby update --yes`.'))
    }
    return 10
  }
  if (!asJson) io.out(c.dim(`$ ${plan.command}`))
  const r = await u.applyUpdate(paths, plan, process.env, {
    ...(asJson ? {} : { onOutput: (text: string) => process.stderr.write(text) }),
    panelPort: () => backgroundPanelPort(paths),
  })
  if (asJson) {
    json(io, {
      ...shown,
      updated: r.ok,
      message: r.message,
      restartedPanel: r.restartedPanel,
      refreshedApp: r.refreshedApp,
      ...(r.refreshedAutostart === undefined ? {} : { refreshedAutostart: r.refreshedAutostart }),
      skill: SKILL_INSTALL,
      ...(r.skillUpdated === undefined ? {} : { skillUpdated: r.skillUpdated }),
      ...(r.ok ? {} : { output: r.output }),
    })
    return r.ok ? 0 : 1
  }
  if (!r.ok) {
    io.err(c.red(`✗ ${r.message}`))
    return 1
  }
  io.out(`${c.green('✓')} ${r.message}.`)
  if (r.restartedPanel)
    io.out('  The background panel is restarting with the new version; open pages reload by themselves.')
  if (r.refreshedApp) io.out('  The desktop app now starts the new version and shows its icon.')
  if (r.refreshedAutostart) io.out('  The login item now starts the new version.')
  else if (r.refreshedAutostart === false)
    io.out('  The login item could not be pointed at the new version; run `sideby autostart` to see why.')
  io.out(
    '  A `sideby ui` running in a terminal and sessions already running keep the old version until you restart them.',
  )
  if (r.skillUpdated) io.out('  The sideby skill was updated too; agents load it in their next session.')
  else if (r.skillUpdated === false) io.err(c.yellow(`  ${r.skillMessage}`))
  else if (sk?.outdated) io.out(c.yellow(`  ${skillLine(sk)}`))
  else if (!sk) io.out(`  If you use the sideby skill, install it with: ${SKILL_INSTALL}`)
  return 0
}

/** The internal `sideby update-check` the CLI starts detached: one Update Check, then Auto Update if it is on. */
export async function cmdUpdateCheck(_a: ParsedArgs, _io: Io): Promise<number> {
  const { backgroundCheck } = await import('../core/update.ts')
  const { loadConfig } = await import('../core/config.ts')
  const { backgroundPanelPort } = await import('../panel/background.ts')
  const paths = resolvePaths(process.env)
  const config = await loadConfig(paths.configFile).catch(() => ({}))
  await backgroundCheck(paths, process.env, config, () => backgroundPanelPort(paths))
  return 0
}

/**
 * `sideby local [on|off]` (ADR-0024): which side the global `sideby` runs, and a switch between the newest Local
 * Build (`pnpm local` builds it) and the npm package. Shows the change first and exits 10 without `--yes`.
 */
export async function cmdLocal(a: ParsedArgs, io: Io): Promise<number> {
  const usage = 'usage: sideby local [on|off] [--yes] [--json]'
  const sub = a.positionals[0]
  if (a.positionals.length > 1 || (sub !== undefined && sub !== 'on' && sub !== 'off'))
    throw new UsageError(usage)
  const lb = await import('../core/local-build.ts')
  const asJson = a.flags.has('json')
  const d = await lb.localDirs(process.env)
  if (!d)
    throw new UserError(
      '`npm prefix -g` failed; switching needs npm on PATH and an npm global install of sideby',
    )
  const s = await lb.localStatus(d)
  const now = new Date()
  const build = (l: NonNullable<typeof s.local>) =>
    `${l.version}-dev · ${l.commit || 'no commit'}${l.dirty ? '+' : ''}${l.builtAt ? `, built ${clock(l.builtAt, now)}` : ''}`
  if (sub === undefined) {
    if (asJson) json(io, { ...s, switched: false })
    else {
      io.out(
        s.running === 'local' && s.local
          ? `The global sideby runs the local build ${build(s.local)}.`
          : s.running === 'npm'
            ? 'The global sideby runs the npm package.'
            : 'The global sideby is not an npm global install; switching supports `npm install -g sideby` only.',
      )
      if (s.running === 'local') io.out(c.dim('Back to the release: sideby local off'))
      else if (s.running === 'npm' && s.local)
        io.out(c.dim(`A local build is kept (${build(s.local)}): sideby local on`))
    }
    return 0
  }
  const to = sub === 'on' ? 'local' : 'npm'
  const blocked = lb.switchBlocker(s, to)
  if (blocked) {
    if (asJson) json(io, { ...s, to, switched: false, blocked })
    else io.err(c.yellow(`sideby cannot switch: ${blocked}`))
    return 1
  }
  if (s.running === to) {
    if (asJson) json(io, { ...s, to, switched: false })
    else
      io.out(
        `${c.green('✓')} The global sideby already runs the ${to === 'local' ? 'local build' : 'npm package'}.`,
      )
    return 0
  }
  if (!a.flags.has('yes')) {
    if (asJson) json(io, { ...s, to, switched: false })
    else {
      io.out(
        to === 'local' && s.local
          ? `Switching runs the local build ${build(s.local)} instead of the npm package. It is not rebuilt: \`pnpm local\` in the checkout builds a new one.`
          : `Switching goes back to the npm package: the kept ${s.kept ?? 'copy'} when it is the latest, else \`npm install -g sideby@latest\`.`,
      )
      io.out(c.cyan(`\nRun it with \`sideby local ${sub} --yes\`.`))
    }
    return 10
  }
  const { backgroundPanelPort } = await import('../panel/background.ts')
  const paths = resolvePaths(process.env)
  const r = await lb.switchLocal(paths, d, to, process.env, {
    panelPort: () => backgroundPanelPort(paths),
    ...(asJson ? {} : { onOutput: (t: string) => process.stderr.write(t) }),
  })
  if (asJson)
    json(io, {
      ...(await lb.localStatus(d)),
      to,
      switched: r.ok,
      message: r.message,
      restartedPanel: r.restartedPanel,
      ...(r.skillSynced === undefined ? {} : { skillSynced: r.skillSynced }),
    })
  else if (r.ok) {
    io.out(`${c.green('✓')} ${r.message}.`)
    if (r.skillSynced === false)
      io.err(c.yellow('The sideby skill was not brought along; run `sideby update` to see why.'))
    if (r.restartedPanel)
      io.out(c.dim('The background panel restarted with it; open panels reload by themselves.'))
  } else io.err(c.red(`✗ ${r.message}`))
  return r.ok ? 0 : 1
}

export async function cmdApp(a: ParsedArgs, io: Io): Promise<number> {
  const sub = a.positionals[0]
  const usage = 'usage: sideby app install [--url <url>] | sideby app uninstall'
  if ((sub !== 'install' && sub !== 'uninstall') || a.positionals.length > 1) throw new UsageError(usage)
  if (sub === 'uninstall' && a.flags.has('url')) throw new UsageError('--url belongs to `sideby app install`')
  const { installApp, uninstallApp } = await import('../desktop/app.ts')
  const home = resolvePaths(process.env).home
  const ctx = { home, env: process.env, platform: process.platform }
  if (sub === 'install') {
    const url = a.flags.get('url')
    const { packageVersion } = await import('../core/version.ts')
    const r = await installApp(ctx, {
      node: process.execPath,
      entry: cliEntry(),
      version: packageVersion(),
      ...(typeof url === 'string' ? { url } : {}),
    })
    if (a.flags.has('json')) json(io, r)
    else {
      io.out(`${c.green('✓')} ${r.updated ? 'updated' : 'installed'} ${c.bold(tildify(r.path, home))}`)
      io.out(c.dim(`  starts ${tildify(r.node, home)} ${tildify(r.entry, home)}`))
      for (const h of r.hints) io.out(`  ${h}`)
    }
    return 0
  }
  const r = await uninstallApp(ctx)
  if (a.flags.has('json')) json(io, r)
  else {
    for (const p of r.removed) io.out(`${c.green('✓')} removed ${tildify(p, home)}`)
    for (const s of r.skipped) io.err(c.yellow(`! ${tildify(s.path, home)}: ${s.reason}`))
    if (!r.removed.length && !r.skipped.length) io.out('No sideby app is installed.')
  }
  return r.skipped.length ? 1 : 0
}

/**
 * `sideby desktop <account>`: the Family's Desktop App as that Account (spec §3.20); `sideby desktop grok-bot:<name>`:
 * a Grok Bot window, new or open, and with `--remove` its removal (ADR-0019).
 */
export async function cmdDesktop(a: ParsedArgs, io: Io): Promise<number> {
  const [ref, ...extra] = a.positionals
  if (!ref || extra.length || a.rest.length)
    throw new UsageError(
      'usage: sideby desktop <account> | sideby desktop grok-bot:<name> [--remove [--yes]]',
    )
  const rt = await createRuntime()
  const profile = parseProfileRef(ref) !== undefined
  if (a.flags.has('remove')) {
    if (!profile)
      throw new UsageError('--remove works on Grok Bot windows only: sideby desktop grok-bot:<name> --remove')
    const r = await removeAppProfile(rt, ref, { yes: a.flags.has('yes') })
    if (a.flags.has('json')) json(io, r)
    else if (r.removed) io.out(`${c.green('✓')} removed the ${r.app} window ${c.bold(r.ref)} and its data`)
    else {
      io.out(`Remove the ${r.app} window ${c.bold(r.ref)}?`)
      io.out(`  deletes ${tildify(r.appData, rt.paths.home)}: its sign-in, bots and local data on this Mac`)
      io.out('Run again with --yes to remove it.')
    }
    return r.removed ? 0 : 10
  }
  const r = profile ? await openAppProfile(rt, ref) : await openDesktopApp(rt, ref)
  if (a.flags.has('json')) {
    json(io, r)
    return 0
  }
  const home = rt.paths.home
  if (r.action === 'started') io.out(`${c.green('✓')} opened ${r.app} as ${c.bold(r.ref)}`)
  else if (r.action === 'focused')
    io.out(`${c.green('✓')} ${r.app} is already open as ${c.bold(r.ref)}; brought it to the front`)
  if (r.appData) io.out(c.dim(`  its data: ${tildify(r.appData, home)}`))
  for (const f of r.linked) io.out(c.dim(`  linked ${f} to the main account's`))
  for (const n of r.notices) io.err(c.cyan(n))
  return 0
}

/** `sideby edit <account> [--path]`: the Account's Host settings file in the user's editor (spec §3.30, ADR-0033). */
export async function cmdEdit(a: ParsedArgs, io: Io): Promise<number> {
  const [ref, ...extra] = a.positionals
  if (!ref || extra.length || a.rest.length) throw new UsageError('usage: sideby edit <account> [--path]')
  const rt = await createRuntime()
  const r = await editSettings(rt, ref, { open: !a.flags.has('path') })
  if (a.flags.has('json')) {
    json(io, r)
    return 0
  }
  const home = rt.paths.home
  if (!r.opened) io.out(r.target ?? r.path)
  else io.out(`${c.green('✓')} opened ${c.bold(r.ref)}'s ${r.file} with your default program`)
  if (r.opened || r.target)
    io.out(
      c.dim(
        `  ${tildify(r.target ?? r.path, home)}${r.target ? ` (linked from ${tildify(r.path, home)})` : ''}`,
      ),
    )
  if (r.sharedWith.length) io.out(c.dim(`  shared: a change also applies to ${r.sharedWith.join(', ')}`))
  return 0
}

/** `sideby browser [--enable|--disable] [--yes]` and `sideby browser open <account> [--profile <p>]` (spec §3.24). */
export async function cmdBrowser(a: ParsedArgs, io: Io): Promise<number> {
  const [sub, ref, ...extra] = a.positionals
  const rt = await createRuntime()
  const home = rt.paths.home
  if (sub === 'open') {
    if (!ref || extra.length || a.rest.length)
      throw new UsageError('usage: sideby browser open <account> [--profile <folder|name>]')
    const profile = a.flags.get('profile')
    const r = await openInBrowser(
      rt,
      await rt.resolve(ref),
      typeof profile === 'string' ? profile : undefined,
    )
    if (a.flags.has('json')) json(io, r)
    else io.out(`${c.green('✓')} opened ${r.url} in Chrome as ${c.bold(r.profile.name)} for ${c.bold(r.ref)}`)
    return 0
  }
  if (sub === 'set') {
    const auto = a.flags.has('auto')
    const [profile, ...more] = extra
    if (!ref || more.length || a.rest.length || auto === (profile !== undefined))
      throw new UsageError(
        'usage: sideby browser set <account> <folder|name> | sideby browser set <account> --auto',
      )
    const r = await setBrowserChoice(rt, await rt.resolve(ref), auto ? null : (profile as string))
    if (a.flags.has('json')) json(io, r)
    else if (r.profile)
      io.out(
        `${c.green('✓')} ${c.bold(r.ref)} now opens in ${c.bold(r.profile.name)} (${r.profile.dir})${r.changed ? '' : '; it already did'}.`,
      )
    else
      io.out(
        r.changed
          ? `${c.green('✓')} sideby finds the browser user of ${c.bold(r.ref)} by itself again.`
          : `Nothing was chosen for ${r.ref}; sideby already finds its browser user by itself.`,
      )
    return 0
  }
  if (sub !== undefined || a.rest.length)
    throw new UsageError(
      'usage: sideby browser [--enable|--disable] [--yes] | sideby browser open <account> | sideby browser set <account> <folder|name>',
    )
  const enable = a.flags.has('enable')
  if (enable || a.flags.has('disable')) {
    if (enable && a.flags.has('disable')) throw new UsageError('pass --enable or --disable, not both')
    const r = await setBrowserSignIns(rt, enable, { apply: a.flags.has('yes') })
    if (a.flags.has('json')) json(io, r)
    else if (!r.changed)
      io.out(`Finding browser sign-ins is already ${enable ? 'on' : 'off'}; nothing to change.`)
    else if (!r.applied) {
      if (enable) {
        io.out('sideby will read, on this computer only (nothing is sent anywhere):')
        for (const x of r.reads) io.out(`  - ${x}`)
        io.out('It never opens cookies, saved passwords or the Keychain, and never changes Chrome.')
      }
      io.out(`\nChange to ${tildify(r.file, home)}: browser.signIns ${enable ? 'off → on' : 'on → off'}`)
      io.out(c.cyan(`Apply it with \`sideby browser --${enable ? 'enable' : 'disable'} --yes\`.`))
    } else io.out(`${c.green('✓')} finding browser sign-ins is ${enable ? 'on' : 'off'}.`)
    return r.changed && !r.applied ? 10 : 0
  }
  const accounts = await rt.accounts()
  const r = await browserReport(rt, accounts)
  if (a.flags.has('json')) {
    json(io, r)
    return 0
  }
  for (const p of r.problems) io.err(c.yellow(p))
  if (!r.enabled) {
    io.out('Finding which Chrome browser user signed in to each account is off.')
    io.out(c.cyan('Turn it on with `sideby browser --enable` (it shows what it reads first).'))
    io.out(
      c.dim(
        'Without it, open a website in a browser user you name: sideby browser open <account> --profile <name>',
      ),
    )
    return 0
  }
  if (!r.found) {
    io.out('Google Chrome has no data on this computer yet; open it once, then try again.')
    return 0
  }
  const signedIn = new Set(r.profiles.flatMap((p) => p.signIns))
  const now = new Date()
  io.out(
    table(
      r.profiles.map((p) => [
        p.name,
        p.email ?? c.dim('-'),
        p.dir,
        p.signIns.map((x) => (r.choices[x] ? `${x} (chosen)` : x)).join(', ') || c.dim('-'),
        p.changedAt ? clock(p.changedAt, now) : '-',
      ]),
      ['Browser user', 'Google account', 'Folder', 'Signed in to', 'Changed'],
    ),
  )
  const missing = accounts.filter(
    (x) => r.families.matched.includes(x.family) && x.kind !== 'api' && !signedIn.has(x.ref),
  )
  if (missing.length) io.out(c.dim(`\nNo browser user found for: ${missing.map((x) => x.ref).join(', ')}`))
  if (r.families.openOnly.length)
    io.out(
      c.dim(
        `${r.families.openOnly.join(', ')}: the website keeps no id to match, so only the login email can find it; choose one with \`sideby browser set\`.`,
      ),
    )
  io.out(c.dim('\nRead from Chrome on this computer only; a browser user that signed out may still show.'))
  io.out(c.dim('Open one: sideby browser open <account> [--profile <name>]'))
  io.out(c.dim('Wrong one? sideby browser set <account> <folder|name>; --auto finds it again'))
  return 0
}

export async function cmdAlias(a: ParsedArgs, io: Io): Promise<number> {
  const [sub, alias, target, ...more] = a.positionals
  const usage =
    'usage: sideby alias add <short-command> <account> [-- host args]  |  sideby alias add <short-command> --pick <family> [--yes]  |  sideby alias rm <short-command>  |  sideby alias list'
  const pick = a.flags.get('pick')
  if (sub === 'list' && alias === undefined && pick === undefined) return aliasList(a, io)
  const addPick =
    sub === 'add' && alias !== undefined && typeof pick === 'string' && target === undefined && !a.rest.length
  const add =
    sub === 'add' && pick === undefined && alias !== undefined && target !== undefined && more.length === 0
  const rm =
    sub === 'rm' && pick === undefined && alias !== undefined && target === undefined && a.rest.length === 0
  if (!add && !rm && !addPick) throw new UsageError(usage)
  const rt = await createRuntime()
  const res = addPick
    ? await rt.addPickCommand(alias, pick, { yes: a.flags.has('yes') })
    : add
      ? await rt.addAlias(alias, target, a.rest)
      : await rt.removeAlias(alias)
  if (a.flags.has('json')) {
    json(io, res)
    return res.status === 'confirm' ? 10 : res.ok ? 0 : 1
  }
  if (res.status === 'confirm') {
    io.out(
      `Adds ${c.bold(res.alias)}: typed in a new terminal, it starts the ${res.family} account with the most quota left.`,
    )
    io.out(c.dim(`Saved in ${tildify(rt.paths.configFile, rt.paths.home)} (pickCommands).`))
    if (res.shadows)
      io.out(
        `${c.yellow('!')} ${res.alias} is already a command (${res.shadows}): in your shell, typing ${res.alias} would start ${res.family} instead.`,
      )
    io.out(`Run again with --yes to add it${res.shadows ? ' anyway, or pick another name' : ''}.`)
    return 10
  }
  const starts =
    res.kind === 'pick'
      ? ` → the ${res.family} account with the most room`
      : res.account
        ? ` → ${res.account}${res.args ? ` ${res.args.join(' ')}` : ''}`
        : ''
  const what = res.kind === 'pick' ? 'pick command' : 'short command'
  const said = {
    added: `${c.green('✓')} ${what} ${c.bold(res.alias)}${starts} (in a new shell)`,
    exists: `${c.green('✓')} ${what} ${c.bold(res.alias)}${starts} was already in the config`,
    removed: `${c.green('✓')} removed ${what} ${c.bold(res.alias)}${starts}`,
    absent: `${c.dim('·')} no short command ${res.alias} in the config; nothing to remove`,
  }
  io.out(said[res.status])
  printShellInitWrites(io, res.shellInitFiles ?? [], rt.paths.home)
  return res.ok ? 0 : 1
}

/** `sideby alias list`: every Alias and Pick Command in the config. */
async function aliasList(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const shortCommands = [
    ...Object.entries(rt.config.aliases ?? {}).map(([name, v]) => {
      const args = aliasArgs(v)
      return { name, kind: 'account' as const, account: aliasAccount(v), ...(args.length ? { args } : {}) }
    }),
    ...Object.entries(rt.config.pickCommands ?? {}).map(([name, family]) => ({
      name,
      kind: 'pick' as const,
      family,
    })),
  ].sort((x, y) => x.name.localeCompare(y.name))
  if (a.flags.has('json')) {
    json(io, { shortCommands })
    return 0
  }
  if (!shortCommands.length) {
    io.out(
      'No short commands yet. Add one with `sideby alias add cc --pick claude` or `sideby alias add cc008 claude:008`.',
    )
    return 0
  }
  io.out(
    table(
      shortCommands.map((s) => [
        c.bold(s.name),
        s.kind === 'pick'
          ? `the ${s.family} account with the most room`
          : `${s.account}${s.args ? ` ${s.args.join(' ')}` : ''}`,
      ]),
      ['SHORT', 'STARTS'],
    ),
  )
  return 0
}

/** `sideby families [family]`: each Family's layout, sign-in and Shared Items, from its FamilyDef (spec §3.16). */
export async function cmdFamilies(a: ParsedArgs, io: Io): Promise<number> {
  const [only, ...extra] = a.positionals
  if (extra.length) throw new UsageError('usage: sideby families [family] [--json]')
  const rt = await createRuntime()
  const all = await rt.familyDetails()
  const families = only === undefined ? all : all.filter((f) => f.id === only)
  if (only !== undefined && families.length === 0)
    throw new UnknownFamilyError(
      `unknown family "${only}"; available: ${all.map((f) => f.id).join(', ') || 'none (check `sideby plugins`)'}`,
    )
  if (a.flags.has('json')) {
    json(io, { families })
    return 0
  }
  families.forEach((f, i) => {
    if (i) io.out('')
    io.out(
      `${c.bold(f.title)} (${f.id})  ${f.installed ? c.green('installed') : c.yellow(f.brokenBin ? `install broken (${tildify(f.brokenBin, rt.paths.home)} cannot run); reinstall: ${installHint(f)}` : `not installed: ${installHint(f)}`)}`,
    )
    io.out(
      f.mainOnly
        ? `  Accounts   ~/${f.layout.main} (main only: ${f.title} keeps one sign-in per computer)`
        : `  Accounts   ~/${f.layout.main} (main), ~/${f.layout.account}; selected with ${f.selectVar}`,
    )
    io.out(
      `  Sign in    sideby login ${f.id}:${f.mainOnly ? 'main' : '<name>'}  ${c.dim(f.login.args ? `(runs ${[f.bin, ...f.login.args].join(' ')})` : `(${f.login.hint})`)}`,
    )
    const yes = (b: boolean) => (b ? c.green('yes') : c.dim('no public source'))
    io.out(
      `  Quota      ${yes(f.quota)}${f.quotaSetup ? c.dim(`, after \`sideby quota setup ${f.id}\``) : ''}   Usage ${yes(f.usage)}`,
    )
    if (!f.shared.length) {
      io.out(c.dim('  No shared items: everything in the account directory is its own.'))
      return
    }
    io.out('  Shared items, and how each account holds them:')
    const rows = f.shared.map((s) => [
      `    ${s.path}${s.key ? `#${s.key}` : ''}`,
      s.source === 'config' ? `${s.mode} ${c.dim('(config)')}` : s.mode,
      s.meaning,
    ])
    io.out(table(rows, ['    ITEM', 'MODE', 'IN EACH ACCOUNT']))
    io.out(c.dim('  Everything else in an account directory is its own: sign-in, sessions and history.'))
  })
  return 0
}

/** `sideby ask` arguments: `--attach` may repeat, so main.ts collects every value here. */
export type AskArgs = ParsedArgs & { attach?: string[] }

/** AI Task CLI; the terminal receives only an opaque task id. */
export async function cmdAsk(a: AskArgs, io: Io, runtime?: Runtime): Promise<number> {
  const {
    movedCwdError,
    previewAttachments,
    promptForTask,
    readTask,
    realCwdInHome,
    startAiTask,
    taskEnv,
    taskHostArgs,
    taskStateDir,
  } = await import('../core/ask.ts')
  const run = a.flags.get('run')
  if (typeof run === 'string') {
    const stateDir = a.flags.get('state-dir')
    if (
      a.positionals.length ||
      a.rest.length ||
      [...a.flags.keys()].some((f) => f !== 'run' && f !== 'state-dir') ||
      stateDir === true
    )
      throw new UsageError('Use `sideby ask --run <id> [--state-dir <dir>]` on its own.')
    // The task names the state folder the Panel wrote it to; without it, this environment's folder is used.
    const where =
      typeof stateDir === 'string'
        ? { stateDir: await taskStateDir(stateDir) }
        : (runtime?.paths ?? resolvePaths())
    const task = await readTask(run, where)
    // The Host starts with the HOME, config and state the Panel used, whatever this terminal's environment says.
    const rt =
      task.home && (!runtime || runtime.paths.home !== task.home || runtime.paths.stateDir !== task.stateDir)
        ? await createRuntime({ env: taskEnv(task, runtime?.env ?? process.env) })
        : (runtime ?? (await createRuntime()))
    const cwd = process.cwd()
    try {
      try {
        process.chdir(task.cwd)
      } catch (err) {
        if (task.cwdInHome) throw movedCwdError('does not exist')
        throw err
      }
      // A Portal's folder is checked where the process now is, so a link swapped in after the task was written is
      // caught, and the folder cannot change between the check and the Host start.
      if (task.cwdInHome) {
        const now = await realCwdInHome(process.cwd(), task.home ?? rt.paths.home)
        if ('why' in now) throw movedCwdError(now.why)
        if (now.real !== task.cwd) throw movedCwdError('points somewhere else')
      }
      if (task.kind === 'prompt')
        return await runAccount(rt, task.account, await taskHostArgs(rt, task), io, { aiTask: true })
      if (task.kind === 'run')
        return rt.pickCommandFamily(task.account) !== undefined
          ? await runPick(rt, task.account, [], io)
          : await runAccount(rt, task.account, [], io)
      return await runLogin(rt, task.account, io)
    } finally {
      process.chdir(cwd)
    }
  }
  if (a.flags.has('spec') || a.flags.has('choices')) return cmdAskSpec(a, io, runtime)
  const rt = runtime ?? (await createRuntime())
  const task = String(a.flags.get('task') ?? 'free')
  if (!AI_TASK_KINDS.includes(task as AiTaskKind))
    throw new UsageError(`Choose --task ${AI_TASK_KINDS.join('|')}.`)
  if (a.positionals.length > 1 || a.rest.length)
    throw new UsageError('Pass the text as one quoted argument: sideby ask "help me".')
  const input = {
    task,
    text: a.positionals[0],
    account: a.flags.get('account') as string | undefined,
    terminal: a.flags.get('terminal') as string | undefined,
    files: a.attach ?? [],
  }
  // The files are checked before anything else; `--print` lists them where they are and copies nothing.
  const preview = promptForTask(rt, input, await previewAttachments(rt, input))
  if (preview.removedSecrets)
    io.err('Key-shaped text was removed. Enter keys with `sideby key` or the Panel key box.')
  if (a.flags.has('print')) {
    io.out(preview.prompt)
    return 0
  }
  // A chosen account becomes the next default, as choosing it in the Panel does.
  const result = await startAiTask(rt, { ...input, remember: Boolean(input.account || input.terminal) })
  if (a.flags.has('json')) json(io, result)
  else if (result.command) io.out(result.opened ? await openedLine(rt, result) : result.command)
  else io.out(result.prompt ?? preview.prompt)
  if (!result.opened) io.err(result.detail!)
  return result.opened ? 0 : 1
}

/** What `sideby ask` prints once the terminal opened; a Family with `aiTaskArgs` adds that its checks stay on. */
async function openedLine(rt: Runtime, result: { terminal: string | null; account: string | null }) {
  const line = `Opened ${result.terminal} for ${result.account}.`
  const family = result.account
    ? await rt.resolve(result.account).then(
        (a) => rt.families.get(a.family),
        () => undefined,
      )
    : undefined
  return family?.aiTaskArgs
    ? `${line} Its permission checks stay on, so risky actions are checked first.`
    : line
}

/**
 * `sideby ask --spec - [--print]` and `sideby ask --choices` (ADR-0030): the AI Tasks a Portal starts. The Task Spec
 * comes on stdin, never through a shell. A refused spec exits 1 with its `code` (and `reason`, as the Portal reads
 * it), or 2 for a spec version this sideby does not know.
 */
async function cmdAskSpec(a: AskArgs, io: Io, runtime?: Runtime): Promise<number> {
  const { previewTaskSpec, parseTaskSpec, readSpecText, SpecError, startTaskSpec, taskChoices } =
    await import('../core/task-spec.ts')
  const choices = a.flags.has('choices')
  const allowed = choices ? ['choices', 'json'] : ['spec', 'print', 'json']
  if (
    a.positionals.length ||
    a.rest.length ||
    a.attach?.length ||
    [...a.flags.keys()].some((f) => !allowed.includes(f))
  )
    throw new UsageError(
      'Use `sideby ask --spec - [--print] --json` or `sideby ask --choices --json` on their own.',
    )
  const rt = runtime ?? (await createRuntime())
  if (choices) {
    const result = await taskChoices(rt)
    if (a.flags.has('json')) json(io, result)
    else {
      io.out(result.account ? `Account: ${result.account}` : `No account: ${result.detail}`)
      io.out(`Terminal: ${result.terminal}`)
    }
    return 0
  }
  if (a.flags.get('spec') !== '-')
    throw new UsageError('Pass the Task Spec on stdin: sideby ask --spec - --json')
  const stdin = io.stdin ?? process.stdin
  if (stdin.isTTY)
    throw new UsageError('Pipe the Task Spec into stdin: sideby ask --spec - --json < spec.json')
  try {
    const spec = parseTaskSpec(await readSpecText(stdin as AsyncIterable<Buffer>))
    if (a.flags.has('print')) {
      const preview = await previewTaskSpec(rt, spec)
      if (a.flags.has('json')) json(io, preview)
      else io.out(preview.prompt)
      return 0
    }
    const result = await startTaskSpec(rt, spec)
    if (a.flags.has('json')) json(io, result)
    else if (result.command) io.out(result.opened ? await openedLine(rt, result) : result.command)
    else io.out(result.prompt ?? '')
    if (!result.opened) io.err(result.detail!)
    return result.opened ? 0 : 1
  } catch (err) {
    // A folder that changed between the check and the task file is refused like a bad one.
    if (!(err instanceof SpecError) && !(err instanceof UserError && err.code === 'bad-cwd')) throw err
    if (a.flags.has('json'))
      json(io, { schemaVersion: 1, error: err.message, code: err.code, reason: err.code })
    else io.err(`sideby: ${err.message}`)
    return err.code === 'spec-version' ? 2 : 1
  }
}

export async function cmdTerminal(a: ParsedArgs, io: Io): Promise<number> {
  const { terminals, setCustomTerminal, setPreferredTerminal } = await import('../core/ask.ts')
  const rt = await createRuntime()
  const changes = ['set', 'unset', 'custom'].filter((f) => a.flags.has(f))
  if (a.positionals.length || a.rest.length || changes.length > 1)
    throw new UsageError(
      "Use sideby terminal [--set <id>|--custom '<program> … {cwd} … {cmd}'|--unset] [--json].",
    )
  const custom = a.flags.get('custom')
  if (a.flags.has('custom')) {
    if (typeof custom !== 'string')
      throw new UsageError("Use sideby terminal --custom '<program> … {cwd} … {cmd}'.")
    await setCustomTerminal(rt, custom)
  } else if (a.flags.has('set') || a.flags.has('unset'))
    await setPreferredTerminal(rt, a.flags.get('set') as string | undefined)
  const result = await terminals(rt)
  if (a.flags.has('json')) json(io, result)
  else {
    io.out(
      table(
        result.terminals.map((t) => [t.id, t.installed ? 'yes' : 'no']),
        ['Terminal', 'Installed'],
      ),
    )
    io.out(
      `Preferred: ${result.preferred ?? 'automatic'}; selected: ${result.guess.id} (${result.guess.source}).`,
    )
  }
  return 0
}

/** Reads a key only from an interactive terminal, restoring its original mode on every exit. */
export function readKeyLine(input: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (!input.isTTY || !input.setRawMode)
    throw new UserError('Run `sideby key` in a terminal or use the Panel key box.', { code: 'tty-required' })
  return new Promise((resolve, reject) => {
    const raw = input.isRaw
    // A stdin nobody read yet is not paused but not flowing either; leaving it flowing keeps the process alive.
    const flowing = input.readableFlowing === true
    let value = ''
    const finish = (error?: Error) => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      input.setRawMode(raw)
      if (!flowing) input.pause()
      if (error) reject(error)
      else resolve(value)
    }
    const onEnd = () => finish(new UserError('Key input ended; rerun `sideby key` in a terminal.'))
    const onError = () => finish(new UserError('Cannot read the key; use the Panel key box.'))
    // Bytes decode across chunks, so a character split by a paste arrives whole.
    const decoder = new StringDecoder('utf8')
    // An escape sequence (an arrow key: ESC [ D) is dropped whole: 0 none, 1 after ESC, 2 inside CSI, 3 inside SS3.
    let sequence = 0
    const onData = (data: Buffer | string) => {
      for (const ch of typeof data === 'string' ? data : decoder.write(data)) {
        // A control character (Enter, Ctrl-C) still counts inside a sequence; it also ends the sequence.
        if (sequence && ch >= ' ' && ch !== '\u007f') {
          if (sequence === 1) sequence = ch === '[' ? 2 : ch === 'O' ? 3 : 0
          else if (sequence === 3 || (ch >= '@' && ch <= '~')) sequence = 0
          continue
        }
        sequence = 0
        if (ch === '\u001b') {
          sequence = 1
          continue
        }
        if (ch === '\u0003') {
          finish(new UserError('Cancelled; rerun `sideby key` when ready.'))
          return
        }
        if (ch === '\r' || ch === '\n') {
          finish()
          return
        }
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('')
        else if (ch >= ' ') value += ch
      }
    }
    input.setRawMode(true)
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
    input.resume()
  })
}
export async function cmdKey(a: ParsedArgs, io: Io, runtime?: Runtime): Promise<number> {
  const rt = runtime ?? (await createRuntime())
  const { join } = await import('node:path')
  const { setSecret, secretVarFor, SECRET_VAR_NAME } = await import('../core/secret-file.ts')
  if (a.positionals.length !== 1 || a.rest.length)
    throw new UsageError('Use sideby key <account> [--var <NAME>] [--json].')
  const account = await rt.resolve(a.positionals[0]!)
  const family = rt.families.get(account.family)!
  if (account.kind !== 'api' && family.secretFileMeansApi !== false)
    throw new UserError(
      'This is a subscription account; use `sideby login <account>` or create an API account with `sideby new <family> <name> --api`.',
    )
  const name = (a.flags.get('var') as string | undefined) ?? secretVarFor(family)
  if (!SECRET_VAR_NAME.test(name)) throw new UsageError('Use an uppercase variable name such as API_KEY.')
  const input = (io.stdin ?? process.stdin) as NodeJS.ReadStream
  if (!input.isTTY)
    throw new UserError('Run `sideby key` in a terminal or use the Panel key box.', { code: 'tty-required' })
  io.err(`Enter ${name} (hidden), then press Enter:`)
  const value = await readKeyLine(input)
  if (!value.trim())
    throw new UserError(`No key entered; nothing was written. Run \`sideby key ${account.ref}\` again.`, {
      code: 'key-empty',
    })
  const result = await setSecret(account.secretFile ?? join(account.dir, 'proxy.env'), name, value)
  if (a.flags.has('json')) json(io, { account: account.ref, var: name, written: true, path: result.path })
  else io.out(`Wrote ${name} to ${result.path}.`)
  return 0
}
export async function cmdTry(a: ParsedArgs, io: Io): Promise<number> {
  const { tryAccount, tryPreview } = await import('../core/ask.ts')
  if (a.positionals.length !== 1 || a.rest.length)
    throw new UsageError('Use sideby try <account> [--model <model>] [--yes] [--json].')
  const model = a.flags.get('model') as string | undefined
  const rt = await createRuntime()
  const ref = a.positionals[0]!
  const { account, command } = await tryPreview(rt, ref, model)
  if (!a.flags.has('yes')) {
    if (a.flags.has('json'))
      json(io, { account: account.ref, ...(model === undefined ? {} : { model }), command, confirmed: false })
    else
      io.out(
        `This spends a few tokens: ${command.map((v) => JSON.stringify(v)).join(' ')}. Run again with --yes to continue.`,
      )
    return 10
  }
  const { account: done, command: _command, ...result } = await tryAccount(rt, ref, undefined, model)
  if (a.flags.has('json')) json(io, { account: done, confirmed: true, ...result })
  else io.out(result.ok ? 'OK' : result.output || 'The Host did not reply; check the account and try again.')
  return result.ok ? 0 : 1
}

/** `sideby autostart [on|off] [--yes]` (spec §3.29, ADR-0029): start the Panel in the background at login. */
export async function cmdAutostart(a: ParsedArgs, io: Io): Promise<number> {
  const { applyAutostart, autostartStatus, autostartWhen, planAutostart, refreshAutostart } = await import(
    '../core/autostart.ts'
  )
  const [action, extra] = a.positionals
  if (extra !== undefined || (action !== undefined && action !== 'on' && action !== 'off'))
    throw new UsageError('usage: sideby autostart [on|off] [--yes] [--json]')
  if (a.flags.has('yes') && !action)
    throw new UsageError('--yes needs a change: sideby autostart on|off --yes')
  const paths = resolvePaths()
  const home = paths.home
  const ctx = { home }
  const wantJson = a.flags.has('json')
  if (a.flags.has('refresh')) {
    // After an update or a local build switch: point an existing agent at this sideby; never create one.
    const r = await refreshAutostart(ctx)
    const status = await autostartStatus(ctx)
    if (wantJson)
      json(io, {
        ...status,
        path: tilde(status.path, home),
        changed: r.rewritten,
        ...(r.note ? { note: r.note } : {}),
      })
    else io.out(r.rewritten ? 'The login item now starts this sideby.' : (r.note ?? 'Nothing to change.'))
    return 0
  }
  if (!action) {
    const s = await autostartStatus(ctx)
    if (wantJson) json(io, { ...s, path: tilde(s.path, home) })
    else if (!s.supported) io.out(`${s.reason}.`)
    else if (s.state === 'off')
      io.out(`Off: sideby does not start ${autostartWhen(s.mechanism)}. Turn it on: sideby autostart on`)
    else if (s.state === 'foreign')
      io.out(
        `${tilde(s.path, home)} is not sideby's, so sideby leaves it alone; remove or rename it yourself if it is not needed.`,
      )
    else if (s.state === 'stale')
      io.out(
        `Out of date: the login item starts ${s.missing!.join(' and ')}, which no longer exists. Run \`sideby autostart on\` to point it at this sideby.`,
      )
    else {
      io.out(
        `On: the panel starts in the background ${autostartWhen(s.mechanism)}, without opening a window.`,
      )
      if (!s.current)
        io.out(c.dim('It starts another sideby than this one; `sideby autostart on` points it here.'))
      io.out(c.dim('Turn it off: sideby autostart off'))
    }
    return 0
  }
  const plan = await planAutostart(ctx, action)
  if (plan.blocked) throw new UserError(plan.blocked.message, { code: plan.blocked.code })
  const yes = a.flags.has('yes')
  const shown = {
    ...plan.status,
    path: tilde(plan.path, home),
    action,
    changed: plan.changed,
    applied: false,
    ...(plan.content ? { content: plan.content } : {}),
    ...(plan.programArguments ? { programArguments: plan.programArguments } : {}),
    commands: plan.commands,
  }
  if (!plan.changed) {
    if (wantJson) json(io, shown)
    else io.out(action === 'on' ? 'Already on.' : 'Already off.')
    return 0
  }
  if (!yes) {
    if (wantJson) json(io, shown)
    else {
      if (action === 'on') {
        io.out(`Writes ${tilde(plan.path, home)}:`)
        io.out(c.dim(plan.content!.trimEnd()))
      } else io.out(`Removes ${tilde(plan.path, home)}.`)
      if (plan.commands.length) io.out(`Then runs: ${plan.commands.map((cmd) => cmd.join(' ')).join('; ')}`)
      io.out(
        action === 'on'
          ? `Then the panel starts in the background ${autostartWhen(plan.status.mechanism)}, without opening a window. Run again with --yes to turn it on.`
          : 'Run again with --yes to turn it off.',
      )
    }
    return 10
  }
  const r = await applyAutostart(ctx, plan)
  if (wantJson)
    json(io, {
      ...shown,
      state: r.state,
      applied: true,
      loaded: r.loaded,
      ...(r.note ? { note: r.note } : {}),
    })
  else {
    io.out(
      action === 'on'
        ? `On: the panel starts in the background ${autostartWhen(plan.status.mechanism)}. Undo: sideby autostart off`
        : `Off: sideby no longer starts ${autostartWhen(plan.status.mechanism)}.`,
    )
    if (r.note) io.out(c.dim(r.note))
  }
  return 0
}

/** The newest session activity among these Accounts, from their Usage; undefined when none can be read. */
async function lastLocalUse(rt: Runtime, list: readonly Account[]): Promise<string | undefined> {
  const times = await Promise.all(
    list.map(async (x) => {
      const u = await rt.usage(x).catch(() => null)
      return u?.status === 'ok' && u.lastActivityAt ? Date.parse(u.lastActivityAt) : Number.NaN
    }),
  )
  const newest = Math.max(...times.filter(Number.isFinite))
  return Number.isFinite(newest) ? new Date(newest).toISOString() : undefined
}

/**
 * What the Menu Bar Item lists (spec §3.31): each Family's accounts in Display Order, with its Handoff ranking. `fetch`
 * `never` reads only the kept answers (the script's cache-only snapshots during a refresh). With `since` (when a manual
 * refresh started, ms), each account that refresh asks says whether its answer is still to come or failed.
 */
async function menubarFamilies(
  rt: Runtime,
  o: { fetch?: QuotaFetchMode; since?: number; final?: boolean } = {},
) {
  // Hidden Families and Accounts (spec §3.25) stay out of the menu and its percent; a Same Login is hidden whole.
  const display = rt.displayOrder()
  const every = displayOrdered(await rt.accounts(), rt)
  const accounts: Account[] = []
  for (const x of every) if (!hiddenIn({ ...x, sameLogin: await rt.sameLogin(x) }, display)) accounts.push(x)
  const ids = [...new Set(accounts.map((x) => x.family))]
  return Promise.all(
    ids.map(async (id) => {
      const f = rt.families.get(id)!
      const plan =
        f.readQuota || f.fetchQuota ? await rt.handoff(id, { fetch: o.fetch }).catch(() => null) : null
      const now = rt.readContext().now.getTime()
      // Whether the refresh asks this Family at all: the same rule as `refreshQuota` and `ownQuota`.
      const asks = o.since !== undefined && Boolean(f.fetchQuota) && !quotaCheckOff(f.id, rt.config, rt.env)
      const list = await Promise.all(
        accounts
          .filter((x) => x.family === id)
          .map(async (x) => {
            const quota = await rt.quota(x, { fetch: o.fetch })
            const sameLogin = await rt.sameLogin(x)
            const login = x.kind === 'api' ? ('not-needed' as const) : (await rt.status(x)).login
            let refresh: 'waiting' | 'failed' | undefined
            if (asks && x.kind === 'subscription' && login !== 'logged-out') {
              const kept = await readQuotaStore(quotaStoreFile(rt.paths.stateDir, x.family, x.name))
              const attempted = kept ? Date.parse(kept.attemptedAt) : Number.NaN
              // The refresh's own snapshot has nothing left waiting: an answer it could not keep counts as failed.
              if (!(attempted >= o.since!)) refresh = o.final ? 'failed' : 'waiting'
              else if (kept?.error) refresh = 'failed'
            }
            // Usage is read only for a reading over an hour old, to tell whether this computer used the login since.
            const old = quota.status === 'ok' && now - Date.parse(quota.observedAt) > 3600_000
            const lastUseAt = old
              ? await lastLocalUse(rt, [x, ...accounts.filter((p) => sameLogin.includes(p.ref))])
              : undefined
            return {
              ref: x.ref,
              name: x.name,
              kind: x.kind,
              login,
              quota,
              sameLogin,
              ...(refresh ? { refresh } : {}),
              ...(lastUseAt ? { lastUseAt } : {}),
            }
          }),
      )
      return {
        id,
        title: f.title,
        logo: f.logo ?? null,
        refreshable: Boolean(f.fetchQuota),
        plan,
        accounts: list,
      }
    }),
  )
}

/**
 * `sideby menubar [on|off] [--yes]`, `menubar snapshot` and `menubar start <account>` (spec §3.31, ADR-0034): quota in
 * the macOS menu bar.
 */
export async function cmdMenubar(a: ParsedArgs, io: Io): Promise<number> {
  const [action, extra] = a.positionals
  const wantJson = a.flags.has('json')
  if (action === 'snapshot') {
    const reported = a.flags.get('hotkey') as string | undefined
    const icon = a.flags.get('icon') as string | undefined
    const sinceFlag = a.flags.get('refreshing-since') as string | undefined
    const since = sinceFlag === undefined ? undefined : Date.parse(sinceFlag)
    const cached = a.flags.has('cached')
    if (
      extra !== undefined ||
      (cached && a.flags.has('refresh')) ||
      (since !== undefined && (!cached || !Number.isFinite(since))) ||
      (reported !== undefined && reported !== 'ok' && reported !== 'taken') ||
      (icon !== undefined && icon !== 'visible' && icon !== 'hidden')
    )
      throw new UsageError(
        'usage: sideby menubar snapshot [--refresh | --cached [--refreshing-since <ISO time>]] [--lang en|zh] [--hotkey ok|taken [--hotkey-label <label>]] [--icon visible|hidden] [--json]',
      )
    const { menubarHotkey, menubarLang, menubarSnapshot } = await import('../menubar/snapshot.ts')
    const rt = await createRuntime()
    const hotkey = menubarHotkey(rt.config.menubar?.hotkey)
    // The menu bar script says whether it could register the shortcut; the Panel and `menubar hotkey` show it.
    // The script says whether macOS shows its icon now; the Panel says where it went when it does not.
    if (icon) {
      const { writeMenubarState } = await import('../menubar/hotkey.ts')
      await writeMenubarState(rt.paths.stateDir, {
        icon: { visible: icon === 'visible', at: rt.readContext().now.toISOString() },
      }).catch(() => {})
    }
    // The script names the shortcut it registered; config may have changed since, and the Panel then shows nothing.
    const label = (a.flags.get('hotkey-label') as string | undefined) ?? hotkey?.label
    if (reported && label) {
      const { readHotkeyState, writeHotkeyState } = await import('../menubar/hotkey.ts')
      const before = await readHotkeyState(rt.paths.stateDir)
      const registered = reported === 'ok'
      if (before?.label !== label || before.registered !== registered)
        await writeHotkeyState(rt.paths.stateDir, {
          label,
          registered,
          at: rt.readContext().now.toISOString(),
        }).catch(() => {})
    }
    const lang = menubarLang(
      rt.config.panel?.language,
      (a.flags.get('lang') as string | undefined) ?? rt.env.LANG,
    )
    // A refresh asks every account now; its own snapshot then marks the ones whose answer failed. A cache-only snapshot
    // (`--cached`, which the menu bar script runs every 2 s during a refresh) never asks a Host.
    let refreshedSince: number | undefined
    if (a.flags.has('refresh')) {
      refreshedSince = Date.now()
      await rt.refreshQuota()
    }
    const families = await menubarFamilies(
      rt,
      cached ? { fetch: 'never', since } : { since: refreshedSince, final: true },
    )
    const snap = menubarSnapshot(families, rt.readContext().now, lang, hotkey)
    if (wantJson) json(io, snap)
    else {
      io.out(snap.title ? `${snap.title}  ${c.dim(snap.tooltip)}` : snap.tooltip)
      const line = (r: (typeof snap.sections)[number]['rows'][number], indent: string) =>
        io.out(
          `${indent}${r.label}${r.recommended ? ` (${snap.labels.recommended})` : ''}  ${c.dim(r.detail)}`,
        )
      for (const s of snap.sections) {
        io.out(c.bold(s.title))
        for (const r of s.rows) line(r, '  ')
        if (s.more) {
          io.out(`  ${s.more.title}`)
          for (const r of s.more.rows) line(r, '    ')
        }
      }
    }
    return 0
  }
  if (action === 'hotkey') {
    if (a.positionals.length > 2)
      throw new UsageError('usage: sideby menubar hotkey [<keys>|off|default] [--json]')
    const { hotkeyView, readHotkeyState, setMenubarHotkey } = await import('../menubar/hotkey.ts')
    const paths = resolvePaths()
    if (extra === undefined) {
      const { loadConfig } = await import('../core/config.ts')
      const v = hotkeyView(
        (await loadConfig(paths.configFile)).menubar?.hotkey,
        await readHotkeyState(paths.stateDir),
      )
      if (wantJson) json(io, v)
      else {
        io.out(
          !v.enabled
            ? 'Menu bar shortcut: off.'
            : `Menu bar shortcut: ${v.label}${v.isDefault ? ' (default)' : ''}${v.registered === false ? ', but macOS did not accept it (something else uses it)' : ''}.`,
        )
        if (v.registered === false)
          io.out(
            c.dim(
              'Pick another: sideby menubar hotkey ctrl+opt+s (or free it in System Settings › Keyboard › Keyboard Shortcuts)',
            ),
          )
        if (v.problem) io.out(c.dim(`It works, but a new choice would be refused: ${v.problem.message}.`))
        io.out(c.dim('Change it: sideby menubar hotkey <keys>|off|default, such as opt+x (one hand)'))
      }
      return 0
    }
    const r = await setMenubarHotkey({
      configFile: paths.configFile,
      stateDir: paths.stateDir,
      value: extra,
      ctx: { home: paths.home },
    })
    if (wantJson) json(io, r)
    else if (!r.changed) io.out('Nothing to change.')
    else
      io.out(
        r.hotkey.enabled
          ? `Menu bar shortcut: ${r.hotkey.label}.${r.nudged ? ' The menu bar item takes it within seconds.' : ''}`
          : 'Menu bar shortcut turned off.',
      )
    return 0
  }
  if (action === 'start') {
    if (!extra || a.positionals.length > 2)
      throw new UsageError('usage: sideby menubar start <account> [--json]')
    const { openRunInTerminal } = await import('../core/ask.ts')
    const rt = await createRuntime()
    const r = await openRunInTerminal(rt, extra)
    if (wantJson) json(io, r)
    else io.out(r.opened ? `Opened ${r.terminal} for ${r.account}.` : r.command)
    if (!r.opened) io.err(r.detail!)
    return r.opened ? 0 : 1
  }
  const { applyAutostart, autostartStatus, planAutostart, refreshAutostart } = await import(
    '../core/autostart.ts'
  )
  const { MENUBAR_AGENT } = await import('../menubar/agent.ts')
  if (extra !== undefined || (action !== undefined && action !== 'on' && action !== 'off'))
    throw new UsageError('usage: sideby menubar [on|off] [--yes] [--json]')
  if (a.flags.has('yes') && !action) throw new UsageError('--yes needs a change: sideby menubar on|off --yes')
  const home = resolvePaths().home
  const ctx = { home }
  if (a.flags.has('refresh')) {
    // After an update or a local build switch: point an existing agent at this sideby; never create one.
    const r = await refreshAutostart(ctx, MENUBAR_AGENT)
    const status = await autostartStatus(ctx, MENUBAR_AGENT)
    if (wantJson)
      json(io, {
        ...status,
        path: tilde(status.path, home),
        changed: r.rewritten,
        ...(r.note ? { note: r.note } : {}),
      })
    else io.out(r.rewritten ? 'The menu bar item now runs this sideby.' : (r.note ?? 'Nothing to change.'))
    return 0
  }
  if (!action) {
    const s = await autostartStatus(ctx, MENUBAR_AGENT)
    const { hotkeyView, iconView, readMenubarState } = await import('../menubar/hotkey.ts')
    const { loadConfig } = await import('../core/config.ts')
    const paths = resolvePaths()
    const kept = await readMenubarState(paths.stateDir)
    const hotkey = hotkeyView((await loadConfig(paths.configFile)).menubar?.hotkey, kept.hotkey ?? null)
    const icon = iconView(kept.icon, new Date())
    if (wantJson)
      json(io, {
        ...s,
        path: tilde(s.path, home),
        ...(s.supported ? { hotkey, ...(s.state === 'on' ? { icon } : {}) } : {}),
      })
    else if (!s.supported) io.out('The menu bar item is only available on macOS for now.')
    else if (s.state === 'off')
      io.out('Menu bar item: off. Run `sideby menubar on` to show quota in the menu bar.')
    else if (s.state === 'foreign')
      io.out(
        `${tilde(s.path, home)} is not sideby's, so sideby leaves it alone; remove or rename it yourself if it is not needed.`,
      )
    else if (s.state === 'stale')
      io.out(
        'Menu bar item: points to a sideby or Node that is no longer there. Run `sideby menubar on` to fix it.',
      )
    else if (s.loaded === false)
      io.out(
        'Menu bar item: on, but not running, so no icon shows. Run `sideby menubar on --yes` to start it again.',
      )
    else {
      io.out('Menu bar item: on.')
      if (icon.visible === false)
        io.out(
          'Its icon is hidden right now: click « in the menu bar to see it, or set it to always show in System Settings › Menu Bar.',
        )
      if (!s.current)
        io.out(c.dim('It runs another sideby than this one; `sideby menubar on` points it here.'))
      if (hotkey.registered === false)
        io.out(
          `macOS did not accept its shortcut ${hotkey.label}; pick another with \`sideby menubar hotkey <keys>\`.`,
        )
      else if (hotkey.enabled)
        io.out(c.dim(`Open it from anywhere with ${hotkey.label} (sideby menubar hotkey to change).`))
      io.out(c.dim('Turn it off: sideby menubar off'))
    }
    return 0
  }
  const plan = await planAutostart(ctx, action, MENUBAR_AGENT)
  if (plan.blocked)
    throw new UserError(
      plan.blocked.code === 'unsupported'
        ? 'The menu bar item is only available on macOS for now.'
        : plan.blocked.message,
      { code: plan.blocked.code },
    )
  const shown = {
    ...plan.status,
    path: tilde(plan.path, home),
    action,
    changed: plan.changed,
    applied: false,
    ...(plan.content ? { content: plan.content } : {}),
    ...(plan.programArguments ? { programArguments: plan.programArguments } : {}),
    commands: plan.commands,
  }
  if (!plan.changed) {
    if (wantJson) json(io, shown)
    else io.out(action === 'on' ? 'Already on.' : 'Already off.')
    return 0
  }
  const path = tilde(plan.path, home)
  if (!a.flags.has('yes')) {
    // The file holds the whole menu bar script, so only its path is printed; `--json` carries the content.
    if (wantJson) json(io, shown)
    else
      io.out(
        action === 'on'
          ? `This adds a login item at ${path} that shows your quota in the menu bar and starts at login. Run \`sideby menubar on --yes\` to turn it on.`
          : `This removes ${path} and hides the menu bar item. Run \`sideby menubar off --yes\` to turn it off.`,
      )
    return 10
  }
  const r = await applyAutostart(ctx, plan, MENUBAR_AGENT)
  if (wantJson)
    json(io, {
      ...shown,
      state: r.state,
      applied: true,
      loaded: r.loaded,
      ...(r.note ? { note: r.note } : {}),
    })
  else {
    io.out(
      action === 'on'
        ? 'The menu bar item is on and in your menu bar now. To turn it off later, run `sideby menubar off`.'
        : 'The menu bar item is off. Run `sideby menubar on` to turn it on again.',
    )
    if (r.note) io.out(c.dim(r.note))
  }
  return 0
}

/** The `accounts.<ref>.args` check of `sideby config set`: only the model and effort arguments, as `sideby model`. */
function modelArgsProblem(rt: Runtime): (ref: string, args: string[]) => string | null {
  return (ref, args) => {
    const family = ref.split(':')[0] ?? ''
    const f = rt.families.get(family)
    const mc = f?.modelChoice
    if (!mc) return `${f?.title ?? family} has no model choice in sideby`
    const { choice, rest } = mc.fromArgs(args)
    if (rest.length) return `${rest.join(' ')} is not a model or effort argument`
    if (choice.effort && !mc.efforts.includes(choice.effort))
      return `"${choice.effort}" is not an effort level for ${f!.title}; use one of: ${mc.efforts.join(', ')}`
    if (choice.model && !MODEL_NAME.test(choice.model))
      return `"${choice.model}" is not a model name sideby passes on`
    return null
  }
}

const shownValue = (v: unknown) => (v === undefined ? '(not set)' : JSON.stringify(v))

/** `sideby config get|set|unset` (spec §3.29): every setting has a command. */
export async function cmdConfig(a: ParsedArgs, io: Io): Promise<number> {
  const cfg = await import('../core/config.ts')
  const [sub = 'get', key, value, ...more] = a.positionals
  const wantJson = a.flags.has('json')
  const yes = a.flags.has('yes')
  const paths = resolvePaths()
  const file = paths.configFile
  const shownFile = tilde(file, paths.home)
  if (sub === 'get') {
    if (value !== undefined || yes) throw new UsageError('usage: sideby config get [<key>] [--json]')
    if (key === undefined) {
      const keys = cfg.settableKeys(await cfg.loadConfig(file))
      if (wantJson) json(io, { file: shownFile, keys })
      else {
        for (const k of keys) {
          const now =
            k.value !== undefined
              ? shownValue(k.value)
              : k.entries?.length
                ? k.entries.map((e) => `${e.key}=${JSON.stringify(e.value)}`).join(', ')
                : c.dim('(not set)')
          io.out(`${k.key} = ${now}`)
          io.out(c.dim(`    ${k.meaning} Takes ${k.takes}.`))
        }
        io.out(c.dim(`Change one: sideby config set <key> <value>. File: ${shownFile}`))
      }
      return 0
    }
    const d = cfg.describeConfigKey(key)
    const r = await cfg.configGet(file, key)
    if (wantJson)
      json(io, {
        key,
        set: r.value !== undefined,
        ...(r.value !== undefined ? { value: r.value } : {}),
        meaning: d.meaning,
        takes: d.takes,
      })
    else {
      io.out(r.value === undefined ? '(not set)' : JSON.stringify(r.value, null, 2))
      io.out(c.dim(`${d.meaning} Takes ${d.takes}.`))
    }
    return 0
  }
  if (sub !== 'set' && sub !== 'unset')
    throw new UsageError(
      'usage: sideby config get [<key>] | set <key> <value> | unset <key> [--yes] [--json]',
    )
  if (
    !key ||
    (sub === 'set' && value === undefined) ||
    (sub === 'unset' && value !== undefined) ||
    more.length
  )
    throw new UsageError(
      sub === 'set'
        ? 'usage: sideby config set <key> <value> [--yes] [--json]  (quote a value with spaces)'
        : 'usage: sideby config unset <key> [--yes] [--json]',
    )
  const next = sub === 'set' ? cfg.parseConfigValue(value!) : undefined
  const top = key.split('.')[0]
  const rt = top === 'accounts' || top === 'handoff' ? await createRuntime() : undefined
  const argsProblem = rt && top === 'accounts' ? modelArgsProblem(rt) : undefined
  const refs = rt && top === 'handoff' ? await handoffRefs(rt) : undefined
  const r = await cfg.editConfigPath(file, key, next, {
    dryRun: !yes,
    ...(argsProblem ? { argsProblem } : {}),
    ...(refs ? { checkHandoff: (before, after) => checkHandoffRefs(refs, before, after) } : {}),
  })
  const out = {
    action: sub,
    key,
    file: shownFile,
    changed: r.changed,
    applied: r.changed && yes,
    ...(r.before !== undefined ? { before: r.before } : {}),
    ...(r.after !== undefined ? { after: r.after } : {}),
  }
  if (wantJson) json(io, out)
  else if (!r.changed) io.out('Nothing to change.')
  else {
    io.out(`${key}: ${shownValue(r.before)} → ${shownValue(r.after)}`)
    io.out(yes ? `Saved to ${shownFile}.` : 'Run again with --yes to save it.')
  }
  return r.changed && !yes ? 10 : 0
}

const SESSION_STATUS: Record<string, string> = {
  'needs-you': 'needs you',
  busy: 'running',
  idle: 'idle',
  unknown: '—',
}

/** What the user does for a Session that needs them, when it is not the Host itself asking (spec §3.32 step 1). */
const NEEDS_YOU_FOR: Record<string, string> = {
  'pending-decision': 'a decision',
  'message-to-approve': 'approve a message',
  'message-to-paste': 'paste a message',
}

function sessionStatusText(s: { status: string; reason?: string }): string {
  const why = s.reason ? NEEDS_YOU_FOR[s.reason] : undefined
  const text = SESSION_STATUS[s.status] ?? SESSION_STATUS.unknown!
  return s.status === 'needs-you' ? c.yellow(why ? `${text}: ${why}` : text) : text
}

/** The language of a copied Session Reference: `--lang`, else the user's locale. */
function copyLang(a: ParsedArgs, env: Record<string, string | undefined>): 'en' | 'zh' {
  const flag = a.flags.get('lang')
  if (flag !== undefined) {
    if (flag !== 'en' && flag !== 'zh') throw new UsageError('--lang takes en or zh')
    return flag
  }
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'zh' : 'en'
}

/**
 * `sideby sessions [<account>|<family>]`: the Live Sessions of every Account (spec §3.32);
 * `sideby sessions copy <account|session-id> [--as reference|id|resume]` copies one of them for another AI;
 * `sideby sessions open-run <account|session-id>` opens the Run Board of one (spec §3.32 step 2b).
 */
export async function cmdSessions(a: ParsedArgs, io: Io, runtime?: Runtime): Promise<number> {
  const [first, ...more] = a.positionals
  if (first === 'copy') return sessionsCopy(a, more, io, runtime)
  if (first === 'open-run') return sessionsOpenRun(a, more, io, runtime)
  if (more.length || a.rest.length)
    throw new UsageError(
      'usage: sideby sessions [<account>|<family>] | sideby sessions copy <account|session-id> | sideby sessions open-run <account|session-id>',
    )
  const rt = runtime ?? (await createRuntime())
  const { listLiveSessions, sessionLabel } = await import('../core/live-sessions.ts')
  const { withRuns } = await import('../core/run-link.ts')
  const { readHandoffChains, withHandoffs } = await import('../core/session-handoffs.ts')
  const r = await listLiveSessions(rt, first ? { only: first } : {})
  // Where an Auto Handoff chain led to a Session, its earlier ids; the Run Link falls back to them (ADR-0057).
  const handed = withHandoffs(await readHandoffChains(rt.paths.stateDir), r.sessions)
  const sessions = await withRuns(rt.env, rt.paths.home, handed)
  if (a.flags.has('json')) {
    json(io, { sessions, problems: r.problems })
    return 0
  }
  for (const p of r.problems) io.err(c.yellow(`sideby: ${p}`))
  if (!sessions.length) {
    io.out(
      first
        ? `${first} has no running session now. Start one with \`sideby run <account>\` and it shows up here.`
        : 'No sessions are running now. Start an account with `sideby run <account>` and it shows up here.',
    )
    return 0
  }
  const now = rt.readContext().now
  const home = rt.paths.home
  // A long title (often in Chinese, two columns a character) is cut so the table stays readable.
  // The RUN column shows only when an orchestrator's Session Index ties a Session to a Run (spec §3.32 step 2b).
  const anyRun = sessions.some((s) => s.run)
  const rows = sessions.map((s) => [
    c.bold(sessionLabel(s.accountLabel, truncate(s.title, 40), s.sessionId)),
    sessionStatusText(s),
    s.cwd ? tildify(s.cwd, home) : '',
    s.startedAt ? clock(s.startedAt, now) : '',
    ...(anyRun
      ? [s.run ? truncate(s.run.title, 30) + (s.run.others ? ` +${s.run.others.length}` : '') : '']
      : []),
    s.guessed ? c.dim('newest session (guessed)') : '',
  ])
  io.out(table(rows, ['SESSION', 'STATUS', 'DIRECTORY', 'STARTED', ...(anyRun ? ['RUN'] : []), '']))
  // One line per Run board (each checked one, once), so the user can open it.
  const boards = new Map<string, string>()
  for (const s of sessions)
    for (const r of s.run ? [s.run, ...(s.run.others ?? [])] : [])
      if (!boards.has(r.board)) boards.set(r.board, r.title)
  for (const [board, title] of boards) io.out(c.dim(`Run: ${title}  ${tildify(board, home)}`))
  if (boards.size) io.out(c.dim('Open its run report: sideby sessions open-run <account|session-id>'))
  if (sessions.some((s) => s.reason === 'pending-decision'))
    io.out(c.dim('See the decisions waiting for you: sideby unattended pending'))
  if (sessions.some((s) => s.reason === 'message-to-paste' || s.reason === 'message-to-approve'))
    io.out(c.dim('See the messages waiting for you, with the line to paste: sideby messages'))
  io.out(c.dim('Copy one for another AI: sideby sessions copy <account|session-id>'))
  return 0
}

/** The line that says a session id was followed along its Handoff chain (ADR-0057). */
export function handedOverLine(from: string, label: string, doing: string): string {
  return c.dim(`${from.slice(0, 8)} was handed over to ${label}; ${doing}`)
}

/** Prints the listing's problems to stderr unless the output is JSON. */
const listedProblems =
  (a: ParsedArgs, io: Io) =>
  (l: { problems: string[] }): void => {
    if (!a.flags.has('json')) for (const p of l.problems) io.err(c.yellow(`sideby: ${p}`))
  }

async function sessionsOpenRun(a: ParsedArgs, args: string[], io: Io, runtime?: Runtime): Promise<number> {
  const [target, ...extra] = args
  if (!target || extra.length || a.rest.length)
    throw new UsageError('usage: sideby sessions open-run <account|session-id>')
  const rt = runtime ?? (await createRuntime())
  const { selectSession } = await import('../core/session-select.ts')
  const { openRunBoard } = await import('../core/run-link.ts')
  const { session: s, handedOverFrom } = await selectSession(rt, target, {
    next: { verb: 'open the run report of', command: (id) => `sideby sessions open-run ${id}` },
    onListed: listedProblems(a, io),
  })
  // The same checks and opener as the Panel's "Open run report": the board comes only from the Session Index.
  const r = await openRunBoard(rt, s.sessionId)
  const board = tildify(r.board, rt.paths.home)
  if (a.flags.has('json')) {
    json(io, {
      opened: true,
      board,
      sessionId: s.sessionId,
      label: s.label,
      ...(handedOverFrom ? { handedOverFrom } : {}),
    })
    return 0
  }
  if (handedOverFrom) io.out(handedOverLine(handedOverFrom, s.label, 'opening its run report'))
  io.out(`${c.green('✓')} opened the run report of ${c.bold(s.label)}`)
  io.out(c.dim(`  ${board}`))
  return 0
}

async function sessionsCopy(a: ParsedArgs, args: string[], io: Io, runtime?: Runtime): Promise<number> {
  const [target, ...extra] = args
  if (!target || extra.length || a.rest.length)
    throw new UsageError('usage: sideby sessions copy <account|session-id> [--as reference|id|resume]')
  const as = (a.flags.get('as') ?? 'reference') as string
  if (as !== 'reference' && as !== 'id' && as !== 'resume')
    throw new UsageError('--as takes reference, id or resume')
  const rt = runtime ?? (await createRuntime())
  const lang = copyLang(a, rt.env)
  const { sessionCopyText } = await import('../core/live-sessions.ts')
  const { copyToClipboard } = await import('../core/live-sessions-copy.ts')
  const { selectSession } = await import('../core/session-select.ts')
  const { session: s, handedOverFrom } = await selectSession(rt, target, { onListed: listedProblems(a, io) })
  const text = sessionCopyText(s, as, lang)
  const program = await copyToClipboard(text, rt.env)
  if (a.flags.has('json')) {
    json(io, {
      copied: program !== null,
      as,
      text,
      sessionId: s.sessionId,
      label: s.label,
      ...(handedOverFrom ? { handedOverFrom } : {}),
    })
    return 0
  }
  if (handedOverFrom) io.out(handedOverLine(handedOverFrom, s.label, 'copying that one'))
  const what = as === 'reference' ? 'a reference to' : as === 'id' ? 'the id of' : 'the resume command of'
  if (program) {
    io.out(`${c.green('✓')} copied ${what} ${c.bold(s.label)}; paste it into the other AI`)
    io.out(c.dim(text))
  } else {
    io.out(text)
    io.err(
      c.yellow(
        'sideby: no clipboard program found (pbcopy on macOS, wl-copy or xclip on Linux); copy the text above yourself',
      ),
    )
  }
  return 0
}

const HISTORY_USAGE =
  'usage: sideby history [<words>...] [--project <p>] [--family <id>] [--account <a>] [--since today|7d|30d|all] [--category <c>] [--group project|category|account|family|day|none] [--scripts] [--tools] [--limit <n>] [--offset <n>] | sideby history show <id> [--account <a>] | sideby history projects [--family <id>] [--account <a>] [--since <s>] [--scripts] | sideby history index [--clear]'

function positiveInt(a: ParsedArgs, name: string): number | undefined {
  const v = a.flags.get(name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} takes a whole number of 1 or more`)
  return n
}

/** Prints how far the first build of the History Index is, on stderr, while `work` runs. */
async function withIndexProgress<T>(rt: Runtime, io: Io, quiet: boolean, work: Promise<T>): Promise<T> {
  const { historyBuilt, historyIndexInfo } = await import('../core/history.ts')
  if (quiet || historyBuilt(rt) || !process.stderr.isTTY) return work
  const timer = setInterval(() => {
    historyIndexInfo(rt)
      .then((i) => {
        if (i.progress.total)
          io.err(c.dim(`Building the History Index: ${i.progress.done}/${i.progress.total} files…`))
      })
      .catch(() => {})
  }, 2_000)
  try {
    return await work
  } finally {
    clearInterval(timer)
  }
}

/**
 * `sideby history [<words>...]` (spec §3.33, ADR-0042): every Session of every Account, newest or best match first;
 * `history show <id>` reads one, `history projects` lists Projects, `history index [--clear]` shows or deletes the
 * History Index.
 */
const HISTORY_FLAGS = {
  search: [
    'json',
    'project',
    'category',
    'group',
    'family',
    'account',
    'since',
    'scripts',
    'tools',
    'limit',
    'offset',
  ],
  show: ['json', 'account', 'before', 'limit'],
  projects: ['json', 'family', 'account', 'since', 'scripts'],
  index: ['json', 'clear'],
} as const

/** The filters `history` and `history projects` share, from their flags. */
function historyFilters(a: ParsedArgs): Pick<HistoryQuery, 'family' | 'account' | 'since' | 'scripts'> {
  const since = a.flags.get('since') as string | undefined
  if (since !== undefined && !['today', '7d', '30d', 'all'].includes(since))
    throw new UsageError('--since takes today, 7d, 30d or all')
  return {
    ...(a.flags.has('family') ? { family: a.flags.get('family') as string } : {}),
    ...(a.flags.has('account') ? { account: a.flags.get('account') as string } : {}),
    ...(since ? { since: since as 'today' | '7d' | '30d' | 'all' } : {}),
    ...(a.flags.has('scripts') ? { scripts: true } : {}),
  }
}

export async function cmdHistory(a: ParsedArgs, io: Io): Promise<number> {
  const [first, ...more] = a.positionals
  const sub = first === 'show' || first === 'projects' || first === 'index' ? first : 'search'
  const allowed: readonly string[] = HISTORY_FLAGS[sub]
  const extra = [...a.flags.keys()].find((f) => !allowed.includes(f))
  if (extra)
    throw new UsageError(
      `${sub === 'search' ? 'sideby history' : `sideby history ${sub}`} does not take --${extra}. ${HISTORY_USAGE}`,
    )
  if (first === 'show') return historyShowCmd(a, more, io)
  if (first === 'projects' || first === 'index') {
    if (more.length || a.rest.length) throw new UsageError(HISTORY_USAGE)
    return first === 'projects' ? historyProjectsCmd(a, io) : historyIndexCmd(a, io)
  }
  const words = [...a.positionals, ...a.rest].join(' ')
  const limit = positiveInt(a, 'limit') ?? 30
  if (limit > HISTORY_PAGE_MAX)
    throw new UsageError(`--limit is at most ${HISTORY_PAGE_MAX}; page on with --offset ${HISTORY_PAGE_MAX}`)
  const offset = a.flags.has('offset') ? Number(a.flags.get('offset')) : 0
  if (!Number.isInteger(offset) || offset < 0)
    throw new UsageError('--offset takes a whole number of 0 or more')
  const asJson = a.flags.has('json')
  const filters = historyFilters(a)
  const rt = await createRuntime()
  const { scanToolOutput, searchHistory } = await import('../core/history.ts')
  const { listLiveSessions, liveKey } = await import('../core/live-sessions.ts')
  const group = a.flags.get('group') as string | undefined
  if (group !== undefined && !['project', 'category', 'account', 'family', 'day', 'none'].includes(group))
    throw new UsageError('--group takes project, category, account, family, day or none')
  if (group && group !== 'none' && a.flags.has('tools'))
    throw new UsageError('--tools lists its finds ungrouped; leave out --group to use it')
  const query: HistoryQuery = {
    q: words,
    limit,
    ...(offset ? { offset } : {}),
    ...(a.flags.has('project') ? { project: a.flags.get('project') as string } : {}),
    ...(a.flags.has('category') ? { category: a.flags.get('category') as string } : {}),
    ...(group ? { group: group as HistoryQuery['group'] } : {}),
    ...filters,
  }
  const [live, r] = await Promise.all([
    listLiveSessions(rt, { deadlineMs: 3_000 }).catch(() => ({ sessions: [], problems: [] })),
    withIndexProgress(rt, io, asJson, searchHistory(rt, query, { wait: true })),
  ])
  // The live list is read alongside the search, not before it, so the mark is set here rather than in the query.
  const running = new Set(live.sessions.map((s) => liveKey(s.account, s.sessionId)))
  for (const s of r.sessions) s.live = running.has(liveKey(s.account, s.sessionId))
  let toolHits = 0
  let toolsMore = false
  // Tool output is read only to fill a page the index left short; a full page needs none of it. It is searched as
  // the records are now and not paged, so the first page that is short gets its finds and later pages none.
  if (
    a.flags.has('tools') &&
    words.trim() &&
    r.sessions.length < limit &&
    offset + r.sessions.length >= r.total
  ) {
    const skip = new Set(r.sessions.map((s) => liveKey(s.account, s.sessionId)))
    for await (const hit of scanToolOutput(rt, query, { skip, live: running })) {
      if (r.sessions.length >= limit) {
        toolsMore = true
        break
      }
      r.sessions.push({ ...hit.session, foundIn: 'tools' })
      toolHits++
    }
    r.total += toolHits
  }
  if (asJson) {
    json(io, {
      sessions: r.sessions,
      total: r.total,
      ...(r.groups ? { groups: r.groups } : {}),
      ...(r.categories ? { categories: r.categories } : {}),
      ...(toolsMore ? { toolOutputMore: true } : {}),
      index: { state: r.state, progress: r.progress },
      sources: r.sources,
      problems: r.problems,
    })
    return 0
  }
  for (const p of r.problems) io.err(c.yellow(`sideby: ${p}`))
  if (!r.sessions.length) {
    io.out(historyEmptyHint(r, query, a.flags.has('tools'), (await rt.accounts()).length > 0))
    return 0
  }
  const now = rt.readContext().now
  const home = rt.paths.home
  const rows = r.sessions.map((s) => [
    s.updatedAt ? clock(s.updatedAt, now) : '',
    s.accountLabel,
    c.bold(truncate(s.title || '(no title)', 50)) +
      (s.live ? c.green(' ●') : '') +
      (s.children ? c.dim(` +${s.children}`) : ''),
    truncate(s.projectName ? s.projectName : tildify(s.cwd, home), 24) + (s.cwdGone ? c.dim(' (gone)') : ''),
    s.branch ? truncate(s.branch, 20) : '',
    c.dim(s.sessionId.slice(0, 8)),
  ])
  // A snippet goes on its own line under its row, so it does not widen the table; a group header goes above the
  // first row of its group.
  const lines = table(rows, ['UPDATED', 'ACCOUNT', 'SESSION', 'PROJECT', 'BRANCH', 'ID']).split('\n')
  const headers = new Map((r.groups ?? []).map((g) => [g.key, g]))
  io.out(
    [
      lines[0],
      ...r.sessions.flatMap((s, i) => {
        const g =
          s.group !== undefined && s.group !== r.sessions[i - 1]?.group ? headers.get(s.group) : undefined
        return [
          ...(g ? [c.bold(`${g.label} (${g.sessions})`)] : []),
          lines[i + 1] ?? '',
          ...(s.snippet ? [c.dim(`    ${truncate(s.snippet, 100)}`)] : []),
        ]
      }),
    ].join('\n'),
  )
  const legend = [
    r.sessions.some((s) => s.live) ? `${c.green('●')} running now` : '',
    r.sessions.some((s) => s.children) ? '+n subagents it started' : '',
  ].filter(Boolean)
  if (legend.length) io.out(c.dim(legend.join('; ')))
  const shown = r.sessions.length
  const next = offset + shown
  if (r.total > next)
    io.out(
      c.dim(
        `Sessions ${offset + 1}-${next} of ${r.total}; --offset ${next} shows the next ${Math.min(limit, r.total - next)}.`,
      ),
    )
  else if (offset) io.out(c.dim(`Sessions ${offset + 1}-${next} of ${r.total}.`))
  if (toolsMore)
    io.out(
      c.dim(
        `More sessions match in tool output; --limit ${Math.min(limit * 2, HISTORY_PAGE_MAX)} shows more of them.`,
      ),
    )
  if (r.state === 'building')
    io.out(
      c.dim(
        `The History Index is still being built (${r.progress.done}/${r.progress.total} files); run again for the rest.`,
      ),
    )
  if (toolHits) io.out(c.dim(`${toolHits} found only in tool output.`))
  io.out(c.dim('Read one, and get the command that continues it in its folder: sideby history show <id>'))
  return 0
}

/** The most Sessions one `sideby history` page lists. */
const HISTORY_PAGE_MAX = 500

/** What to try when a search lists nothing, by what the search was narrowed by. */
function historyEmptyHint(r: HistoryResult, q: HistoryQuery, tools: boolean, hasAccounts: boolean): string {
  if (!r.sources.some((s) => s.sessions)) {
    if (r.state === 'building') return 'The search index is still being built; run this again in a moment.'
    return hasAccounts
      ? 'No session records yet. Start an account with `sideby run <account>`, chat a little, and it shows up here.'
      : 'No accounts yet. Add one with `sideby new <family>` (see `sideby families`), then start it with `sideby run`.'
  }
  if (q.offset) return `No sessions after the first ${q.offset}; leave out --offset to see the first page.`
  const narrowed = [
    q.project !== undefined ? '--project' : '',
    q.category !== undefined ? '--category' : '',
    q.family ? '--family' : '',
    q.account ? '--account' : '',
  ].filter(Boolean)
  const tries = [
    q.since && q.since !== 'all' ? '--since all' : '',
    narrowed.length ? `without ${narrowed.join(', ')}` : '',
    q.q?.trim() ? 'fewer or shorter words' : '',
    q.q?.trim() && !tools ? '--tools to search tool output too' : '',
  ].filter(Boolean)
  const words = q.q?.trim() ?? ''
  // Words the user already quoted as a phrase are shown as they typed them.
  return `Nothing found${words ? ` for ${words.startsWith('"') ? words : `"${words}"`}` : ''}.${tries.length ? ` Try ${tries.join('; ')}.` : ''}`
}

async function historyShowCmd(a: ParsedArgs, args: string[], io: Io): Promise<number> {
  const [id, ...extra] = args
  if (!id || extra.length || a.rest.length)
    throw new UsageError(
      'usage: sideby history show <session-id> [--account <a>] [--before <n>] [--limit <n>]',
    )
  const rt = await createRuntime()
  const { historyShow } = await import('../core/history.ts')
  const before = positiveInt(a, 'before')
  const limit = positiveInt(a, 'limit')
  const r = await historyShow(rt, id, {
    ...(a.flags.has('account') ? { account: a.flags.get('account') as string } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  if (a.flags.has('json')) {
    json(io, r as unknown as Record<string, unknown>)
    return 0
  }
  const s = r.session
  const home = rt.paths.home
  io.out(c.bold(s.title || '(no title)'))
  io.out(
    c.dim(
      [s.accountLabel, s.projectName, s.branch, s.updatedAt ? clock(s.updatedAt, rt.readContext().now) : '']
        .filter(Boolean)
        .join(' · '),
    ),
  )
  if (s.cwd) io.out(c.dim(`${tildify(s.cwd, home)}${s.cwdGone ? ' (folder no longer exists)' : ''}`))
  if (r.before) io.out(c.dim(`Earlier messages: sideby history show ${s.sessionId} --before ${r.before}`))
  io.out('')
  for (const m of r.messages) {
    if (m.role === 'tool') io.out(c.dim(`  · ${m.tool ?? m.text}`))
    else if (m.role === 'user') io.out(`${c.bold(c.green('›'))} ${m.text}\n`)
    else io.out(`${c.bold('‹')} ${m.text}\n`)
  }
  io.out(c.dim(`Continue it: ${s.continueCommand}`))
  return 0
}

async function historyProjectsCmd(a: ParsedArgs, io: Io): Promise<number> {
  const filters = historyFilters(a)
  const rt = await createRuntime()
  const { historyProjects } = await import('../core/history.ts')
  const asJson = a.flags.has('json')
  const r = await withIndexProgress(rt, io, asJson, historyProjects(rt, filters, { wait: true }))
  if (asJson) {
    json(io, {
      projects: r.projects,
      ...(r.categories ? { categories: r.categories } : {}),
      ...(r.problems ? { problems: r.problems } : {}),
    })
    return 0
  }
  for (const p of r.problems ?? []) io.err(c.yellow(`sideby: ${p}`))
  if (!r.projects.length) {
    io.out(
      'No session records yet. Start an account with `sideby run <account>`, chat a little, and it shows up here.',
    )
    return 0
  }
  const now = rt.readContext().now
  io.out(
    table(
      r.projects.map((p) => [
        c.bold(p.name || '(no folder)'),
        ...(r.categories ? [p.category ?? ''] : []),
        String(p.sessions),
        p.updatedAt ? clock(p.updatedAt, now) : '',
        tildify(p.project, rt.paths.home) + (p.gone ? c.dim(' (gone)') : ''),
      ]),
      [
        'PROJECT',
        ...(r.categories ? [(r.categories.label || 'Category').toUpperCase()] : []),
        'SESSIONS',
        'UPDATED',
        'PATH',
      ],
    ),
  )
  io.out(
    c.dim(
      `Sessions of one: sideby history --project <name>${r.categories ? '; of a category: --category <name>' : ''}`,
    ),
  )
  return 0
}

async function historyIndexCmd(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const { historyIndexInfo } = await import('../core/history.ts')
  const clear = a.flags.has('clear')
  const asJson = a.flags.has('json')
  const r = await withIndexProgress(
    rt,
    io,
    asJson,
    historyIndexInfo(rt, { clear, wait: !clear, rebuild: !clear }),
  )
  if (asJson) {
    json(io, r as unknown as Record<string, unknown>)
    return 0
  }
  if (clear)
    io.out(
      r.cleared
        ? `${c.green('✓')} deleted the History Index; it is built again from the hosts' files the next time you look`
        : 'There was no History Index to delete.',
    )
  if (!r.enabled)
    io.out('The History Index is off (config history.index false): searches look at titles and folders only.')
  else if (!clear) {
    io.out(`${tildify(r.path, rt.paths.home)}  ${(r.bytes / 1e6).toFixed(1)} MB`)
    io.out(
      r.state === 'building'
        ? `Building: ${r.progress.done}/${r.progress.total} files read`
        : `${r.sessions} sessions from ${r.files} files`,
    )
  }
  if (!clear)
    for (const s of r.sources)
      io.out(
        `  ${s.accountLabel.padEnd(14)} ${String(s.sessions).padStart(5)} sessions${s.failed ? c.yellow(`, ${s.failed} unreadable`) : ''}${s.note ? c.dim(`  ${s.note}`) : ''}`,
      )
  return 0
}

export interface SendArgs extends ParsedArgs {
  /** Every `--image` given, in order (main.ts collects them; parseArgs keeps only the last). */
  images?: string[]
}

/**
 * `sideby send <account|session> "<text>" [--image <path>]...` (spec §3.32 step 2, ADR-0040): keeps the Message as a
 * file, delivers it through the Host's own channel where it has one (Claude Code), else copies the line to paste.
 */
export async function cmdSend(a: SendArgs, io: Io): Promise<number> {
  const [target, ...words] = a.positionals
  const text = [...words, ...a.rest].join(' ')
  if (!target || (!text.trim() && !a.images?.length))
    throw new UsageError('usage: sideby send <account|session> "<text>" [--image <path>]... [--json]')
  const rt = await createRuntime()
  const lang = copyLang(a, rt.env)
  const { sendMessage } = await import('../core/messages.ts')
  const { copyToClipboard } = await import('../core/live-sessions-copy.ts')
  const r = await sendMessage(rt, target, { text, images: a.images ?? [], lang })
  const copied = r.status === 'paste-needed' ? (await copyToClipboard(r.pasteText, rt.env)) !== null : false
  if (a.flags.has('json')) {
    json(io, { message: r, copied })
    return 0
  }
  const home = rt.paths.home
  if (r.handedOverFrom) io.out(handedOverLine(r.handedOverFrom, r.to, 'sending there'))
  if (r.status === 'delivered') {
    io.out(`${c.green('✓')} delivered to ${c.bold(r.to)} (message ${r.id})`)
    if (r.note) io.out(c.yellow(`  ${r.note}`))
    if (r.needsApproval)
      io.out(`  To receive messages without approving each one: ${c.bold('sideby messages inbound accept')}`)
  } else if (r.status === 'unknown') {
    // Not copied: it may already be there, and a paste on top would deliver it twice (ADR-0065).
    io.out(`${c.yellow('●')} sideby could not confirm that ${c.bold(r.to)} got message ${r.id}`)
    // The note says why, and ends with the same advice.
    io.out(`  ${r.note ?? UNCONFIRMED_ADVICE}`)
  } else {
    io.out(`${c.yellow('●')} kept message ${r.id} for ${c.bold(r.to)}; it needs a paste`)
    if (r.note) io.out(`  ${r.note}`)
    io.out(`  Paste this into the tab of ${c.bold(r.to)}${copied ? ' (it is on the clipboard)' : ''}:`)
    io.out(`  ${r.pasteText}`)
  }
  io.out(
    c.dim(
      `  Kept at ${tildify(r.file, home)}${r.attachments.length ? ` with ${r.attachments.length} screenshot(s)` : ''}`,
    ),
  )
  return 0
}

const MESSAGE_STATUS: Record<string, string> = {
  stored: 'kept',
  delivered: 'delivered',
  read: 'read',
  'paste-needed': 'needs paste',
  unknown: 'Not confirmed',
}

const UNCONFIRMED_ADVICE = 'It may still show up: look at that session before you send it again.'

/**
 * `sideby messages [--to <account|session>] [--limit <n>]`: the Messages sideby kept and how far each got;
 * `sideby messages inbound [accept|undo] [--yes]`: whether Claude sessions show them at once.
 */
export async function cmdMessages(a: ParsedArgs, io: Io, runtime?: Runtime): Promise<number> {
  const [first, ...more] = a.positionals
  if (first === 'inbound') return messagesInbound(a, more, io, runtime)
  if (first !== undefined || a.rest.length)
    throw new UsageError(
      'usage: sideby messages [--to <account|session>] [--limit <n>] | sideby messages inbound [accept|undo] [--yes]',
    )
  const to = a.flags.get('to')
  const limitFlag = a.flags.get('limit')
  const limit = limitFlag === undefined ? undefined : Number(limitFlag)
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
    throw new UsageError('--limit takes a whole number above 0')
  const rt = runtime ?? (await createRuntime())
  const { listMessages } = await import('../core/messages.ts')
  const list = await listMessages(rt, {
    ...(typeof to === 'string' ? { to } : {}),
    ...(limit ? { limit } : {}),
  })
  if (a.flags.has('json')) {
    json(io, { messages: list })
    return 0
  }
  if (!list.length) {
    io.out('No messages yet. Send one with `sideby send <account|session> "<text>"`.')
    return 0
  }
  const now = rt.readContext().now
  const rows = list.map((m) => [
    clock(m.sentAt, now),
    c.bold(m.to),
    m.status === 'paste-needed' || m.status === 'unknown'
      ? c.yellow(MESSAGE_STATUS[m.status]!)
      : m.needsApproval
        ? c.yellow('waits for approval')
        : MESSAGE_STATUS[m.status]!,
    m.id,
    m.from ?? c.dim('you'),
  ])
  io.out(table(rows, ['SENT', 'TO', 'STATUS', 'ID', 'FROM']))
  // A session whose latest Message waits for a paste gets the line to paste and why, newest first.
  const seen = new Set<string>()
  const waiting = list.filter(
    (m) => !seen.has(m.toSessionId) && seen.add(m.toSessionId) && m.status === 'paste-needed',
  )
  for (const m of waiting.slice(0, 5)) {
    io.out('')
    io.out(`${c.yellow('Paste this line into')} ${c.bold(m.to)}${m.note ? c.dim(` (${m.note})`) : ''}:`)
    io.out(`  ${m.pasteText}`)
  }
  if (list.some((m) => m.status === 'unknown')) {
    io.out('')
    io.out(
      `${c.yellow('Some messages are not confirmed:')} sideby could not tell if they arrived. ${UNCONFIRMED_ADVICE}`,
    )
  }
  if (list.some((m) => m.needsApproval)) {
    io.out('')
    io.out(
      `${c.yellow('Some messages wait for approval')} in the target's terminal and are dropped after about 5 minutes. To receive them directly: ${c.bold('sideby messages inbound accept')}`,
    )
  }
  return 0
}

const INBOUND_WORDS: Record<string, string> = {
  accept: 'accept',
  hold: 'hold',
  refuse: 'refuse',
  default: 'not set',
  other: 'unknown value',
  missing: 'no settings',
  blocked: 'blocked',
}

async function messagesInbound(a: ParsedArgs, args: string[], io: Io, runtime?: Runtime): Promise<number> {
  const [action, extra] = args
  if (extra !== undefined || (action !== undefined && action !== 'accept' && action !== 'undo'))
    throw new UsageError('usage: sideby messages inbound [accept|undo] [--yes] [--json]')
  const wantJson = a.flags.has('json')
  const rt = runtime ?? (await createRuntime())
  const home = rt.paths.home
  const inbound = await import('../core/inbound.ts')
  const accounts = await rt.accounts()
  const ctx = rt.readContext()
  const groups = await inbound.inboundGroups(accounts, ctx)
  type G = (typeof groups)[number]
  const show = (gs: G[]) => gs.map((g) => ({ ...g, file: tildify(g.file, home) }))
  const out = (data: object) => json(io, { action: action ?? 'status', ...data })
  if (!action) {
    if (wantJson) {
      out({ groups: show(groups) })
      return 0
    }
    if (!groups.length) {
      io.out('No Claude accounts found.')
      return 0
    }
    io.out('Messages from other sessions: whether Claude sessions show them at once')
    for (const g of groups) {
      const word = INBOUND_WORDS[g.state]!
      const paint = g.state === 'accept' ? c.green : g.state === 'blocked' ? c.red : c.yellow
      io.out(
        `  ${paint(word)} ${c.bold(g.accounts.join(', '))}  ${c.dim(g.reason ? tilde(g.reason, home) : tildify(g.file, home))}`,
      )
    }
    io.out(
      c.dim(
        '  accept: shown at once; hold or not set: a session in bypass permission mode waits for you to approve each one, and drops it after about 5 minutes; refuse: dropped',
      ),
    )
    if (inbound.groupsToAccept(groups).length)
      io.out(
        c.cyan(
          '\nRun `sideby messages inbound accept` so they are shown at once (it shows the change first).',
        ),
      )
    return 0
  }
  const todo = action === 'accept' ? inbound.groupsToAccept(groups) : inbound.inboundGroupsToUndo(groups)
  const apply = () =>
    action === 'accept' ? inbound.acceptInbound(accounts, ctx) : inbound.undoInbound(accounts, ctx)
  const verb = action === 'accept' ? 'set it' : 'undo'
  if (todo.length === 0) {
    // Only from what was read: a run without --yes never writes, even if a file changed since (exit 1).
    const r = inbound.inboundNothingToDo(action, groups)
    if (wantJson) out({ applied: false, groups: show(groups), message: r.message })
    else io.out(tilde(r.message, home))
    return 1
  }
  if (!a.flags.has('yes')) {
    if (wantJson) {
      // The same facts as the text preview: the key and value each file gets, and what is left alone and why.
      const preview =
        action === 'accept'
          ? show(todo).map((g) => ({
              ...g,
              change: {
                key: inbound.INBOUND_KEY,
                from: g.state === 'default' ? null : g.state,
                to: 'accept',
              },
            }))
          : show(todo)
      const leftAlone = inbound
        .inboundLeftAlone(groups)
        .map((g) => ({ ...g, file: tildify(g.file, home), reason: tilde(g.reason ?? '', home) }))
      out({ applied: false, groups: preview, leftAlone, message: `Run again with --yes to ${verb}.` })
    } else {
      io.out(
        action === 'accept'
          ? 'Show messages from other sessions at once?'
          : 'Put back the setting sideby replaced?',
      )
      for (const g of todo) {
        const from = g.state === 'default' ? 'not set' : `"${g.state}"`
        io.out(
          `  ${tildify(g.file, home)}: crossSessionInbound ${action === 'accept' ? `${from} -> "accept"` : '-> what it was before'}`,
        )
        io.out(c.dim(`    used by ${g.accounts.join(', ')}`))
      }
      for (const g of inbound.inboundLeftAlone(groups))
        io.out(c.dim(`  left alone, ${g.accounts.join(', ')}: ${tilde(g.reason ?? '', home)}`))
      if (action === 'accept')
        io.out(
          'A session then shows a message from another session of yours as soon as it arrives, also in bypass permission mode. Only your own sessions on this computer can send one. Undo it with `sideby messages inbound undo`.',
        )
      io.out(`Run again with --yes to ${verb}.`)
    }
    return 10
  }
  const r = await apply()
  const results = r.results.map((x) => ({ ...x, file: tildify(x.file, home) }))
  if (wantJson) out({ applied: r.ok, results, message: r.message })
  else {
    for (const x of results) io.out(`  ${x.ok ? c.green('ok') : c.red('failed')} ${x.file}: ${x.message}`)
    io.out(r.message)
  }
  return r.ok ? 0 : 1
}

/** `sideby theme` (spec §3.34): list, use, undo, check, preview, import, export and remove Themes. */
export async function cmdTheme(a: ParsedArgs, io: Io): Promise<number> {
  const t = await import('../core/themes.ts')
  const { loadConfig } = await import('../core/config.ts')
  const { DEFAULT_THEME_ID } = await import('../panel/themes.ts')
  const [sub = 'list', target, ...more] = a.positionals
  const wantJson = a.flags.has('json')
  const paths = resolvePaths()
  const usage =
    'usage: sideby theme [list] | use <name> | use --undo | check <name|file> | preview <name|file> | import <file> [--id <name>] [--yes] | export <name> [--out <file>] | remove <name> [--yes] [--json]'
  if (more.length) throw new UsageError(usage)
  const active = async () =>
    (await loadConfig(paths.configFile).catch(() => ({}) as { panel?: { colorTheme?: string } })).panel
      ?.colorTheme ?? DEFAULT_THEME_ID
  // A name, or a path to a Theme File not yet in the themes folder.
  const load = async (ref: string) => {
    if (t.THEME_ID_RE.test(ref) && !ref.endsWith('.json'))
      return { id: ref, theme: await t.exportTheme(paths, ref) }
    const r = await t.readThemeFile(resolve(ref))
    if (!r.theme) throw new UserError(`${ref} ${r.problems.join('; ')}`)
    for (const w of r.warnings) io.err(c.yellow(`! ${w}`))
    return { id: basename(ref, '.json'), theme: r.theme }
  }
  if (sub === 'list') {
    if (target) throw new UsageError(usage)
    const now = await active()
    const themes = (await t.listThemes(paths)).map((e) => ({
      id: e.id,
      name: e.name,
      source: e.source,
      ...(e.path ? { path: tilde(e.path, paths.home) } : {}),
      active: e.id === now,
      problems: e.problems,
      warnings: e.warnings,
    }))
    if (wantJson) json(io, { folder: tilde(t.themesDir(paths), paths.home), themes })
    else {
      for (const e of themes) {
        const mark = e.active ? c.green('●') : ' '
        io.out(`${mark} ${e.id.padEnd(14)} ${e.name}${e.source === 'builtin' ? c.dim(' (built in)') : ''}`)
        for (const p of e.problems) io.out(c.red(`    ✗ ${p}${e.path ? ` (${e.path})` : ''}`))
        for (const w of e.warnings) io.out(c.yellow(`    ! ${w}`))
      }
      io.out(
        c.dim(
          `Switch: sideby theme use <name>. Your Theme Files go in ${tilde(t.themesDir(paths), paths.home)}.`,
        ),
      )
    }
    return 0
  }
  if (sub === 'use') {
    const undo = a.flags.has('undo')
    if (undo === Boolean(target))
      throw new UsageError(
        'usage: sideby theme use <name> | sideby theme use --undo | sideby theme use default [--json]',
      )
    let r: { before: string; after: string; changed?: boolean }
    try {
      r = undo ? await t.undoTheme(paths) : await t.useTheme(paths, target!)
    } catch (e) {
      throw new UserError((e as Error).message)
    }
    if (wantJson) json(io, { before: r.before, after: r.after, changed: r.changed ?? true })
    else
      io.out(
        r.changed === false
          ? `Already using ${r.after}.`
          : `${c.green('✓')} Theme ${r.before} → ${r.after}. The Panel shows it on its next refresh${undo ? '.' : '; undo with `sideby theme use --undo`.'}`,
      )
    return 0
  }
  if (sub === 'check') {
    if (!target) throw new UsageError(usage)
    const { id, theme } = await load(target)
    const pairs = t.contrastPairs(t.themeColors(theme))
    const failing = pairs.filter((p) => !p.ok)
    if (wantJson) json(io, { id, ok: failing.length === 0, pairs, warnings: [] })
    else {
      for (const p of pairs)
        if (p.ratio !== undefined)
          io.out(
            `${p.ok ? c.green('✓') : c.red('✗')} ${p.mode.padEnd(5)} ${`${p.fg} on ${p.bg}`.padEnd(24)} ${p.ratio.toFixed(2)}:1 (needs ${p.min})${p.suggest ? c.dim(`  try ${p.fg}: ${p.suggest}`) : ''}`,
          )
      io.out(
        failing.length
          ? c.yellow(
              `${failing.length} pair(s) too faint. The Panel moves them to the value shown; set those values in the file to choose them yourself.`,
            )
          : `${c.green('✓')} Every pair is readable in light and dark.`,
      )
    }
    return failing.length ? 1 : 0
  }
  if (sub === 'preview') {
    if (!target) throw new UsageError(usage)
    const { theme } = await load(target)
    await t.setPreview(paths, theme)
    const { backgroundPanelPort, findRunningPanel } = await import('../panel/background.ts')
    const port = await backgroundPanelPort(paths)
    const url = port ? await findRunningPanel(paths, port) : undefined
    if (!url) {
      if (wantJson)
        json(io, {
          opened: false,
          hint: 'start the Panel with `sideby ui --background`, then run this again',
        })
      else
        io.err(
          c.yellow('The Panel is not running. Start it with `sideby ui --background`, then run this again.'),
        )
      return 1
    }
    const { openBrowser } = await import('../panel/server.ts')
    const opened = await openBrowser(`${url}?theme=preview`)
    if (wantJson) json(io, { opened, url: `${url}?theme=preview` })
    else
      io.out(
        `Showing ${theme.name} for this one look (${url}?theme=preview); your Theme stays the same. Keep it with \`sideby theme import\` and \`sideby theme use\`.`,
      )
    return 0
  }
  if (sub === 'import') {
    if (!target) throw new UsageError(usage)
    const { id: fromName, theme } = await load(target)
    const idFlag = a.flags.get('id')
    const id = typeof idFlag === 'string' ? idFlag : fromName
    const dest = join(t.themesDir(paths), `${id}.json`)
    const exists = await stat(dest).then(
      () => true,
      () => false,
    )
    if (exists && !a.flags.has('yes')) {
      if (wantJson) json(io, { id, path: tilde(dest, paths.home), replaced: false, exists: true })
      else
        io.out(
          `${tilde(dest, paths.home)} already exists. Replace it with \`sideby theme import ${target} --yes\`.`,
        )
      return 10
    }
    let path: string
    try {
      path = await t.saveThemeFile(paths, id, theme)
    } catch (e) {
      throw new UserError((e as Error).message)
    }
    if (wantJson) json(io, { id, path: tilde(path, paths.home), replaced: exists })
    else io.out(`${c.green('✓')} Saved ${theme.name} as ${id}. Use it with \`sideby theme use ${id}\`.`)
    return 0
  }
  if (sub === 'export') {
    if (!target) throw new UsageError(usage)
    let theme: Awaited<ReturnType<typeof t.exportTheme>>
    try {
      theme = await t.exportTheme(paths, target)
    } catch (e) {
      throw new UserError((e as Error).message)
    }
    const text = `${JSON.stringify(theme, null, 2)}\n`
    const out = a.flags.get('out')
    if (typeof out === 'string') {
      await writeFile(resolve(out), text, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        throw new UserError(
          e.code === 'EEXIST'
            ? `${out} already exists; pick another file`
            : `cannot write ${out} (${e.code})`,
        )
      })
      if (wantJson) json(io, { id: target, out })
      else
        io.out(
          `${c.green('✓')} Wrote ${out}. Edit it, then \`sideby theme check ${out}\` and \`sideby theme import ${out}\`.`,
        )
    } else if (wantJson) json(io, { id: target, theme })
    else io.out(text.trimEnd())
    return 0
  }
  if (sub === 'remove') {
    if (!target) throw new UsageError(usage)
    if (!a.flags.has('yes')) {
      if (wantJson) json(io, { id: target, removed: false })
      else
        io.out(`This deletes the Theme File ${target}. Run \`sideby theme remove ${target} --yes\` to do it.`)
      return 10
    }
    let r: { path: string; wasActive: boolean }
    try {
      r = await t.removeThemeFile(paths, target)
    } catch (e) {
      throw new UserError((e as Error).message)
    }
    if (wantJson) json(io, { id: target, removed: true, wasActive: r.wasActive })
    else
      io.out(
        `${c.green('✓')} Removed ${tilde(r.path, paths.home)}${r.wasActive ? '; the Panel is back on Sky' : ''}.`,
      )
    return 0
  }
  throw new UsageError(usage)
}

/**
 * `sideby network`: Network Guard (spec §3.35). Without a subcommand shows the switch, the allowed countries and the
 * newest result per address from the cache; `check` asks each address now; `on`, `off` and `allow` change config
 * `network` after a preview (exit 10 without `--yes`).
 */
export async function cmdNetwork(a: ParsedArgs, io: Io): Promise<number> {
  const [sub, ...rest] = a.positionals
  const { setNetwork } = await import('../core/network.ts')
  const rt = await createRuntime()
  const asJson = a.flags.has('json')
  if (sub === 'on' || sub === 'off' || sub === 'allow') {
    if (sub !== 'allow' && rest.length) throw new UsageError(`usage: sideby network ${sub} [--yes]`)
    if (sub === 'allow' && !rest.length)
      throw new UsageError(
        'usage: sideby network allow <country>... [--yes] (for example: sideby network allow US JP)',
      )
    const change = sub === 'allow' ? { allow: rest } : { guard: sub === 'on' }
    const r = await setNetwork(rt.paths.configFile, change, { apply: a.flags.has('yes') })
    if (asJson) json(io, r)
    else if (!r.changed) io.out('Nothing to change.')
    else if (!r.applied) {
      const show = (v: { guard: boolean; allow: string[] }) =>
        `${v.guard ? 'on' : 'off'}, allowed: ${v.allow.join(', ') || 'none'}`
      io.out(`Change to ${tildify(r.file, rt.paths.home)}: network ${show(r.before)} → ${show(r.after)}`)
      if (r.after.guard && !r.before.guard)
        io.out(
          c.dim(
            "Claude and Codex accounts started by sideby are then checked before starting and before each prompt and tool call; sideby asks the vendor's own /cdn-cgi/trace through the account's proxy, with no credential.",
          ),
        )
      io.out(c.cyan(`Apply it with \`sideby network ${[sub, ...rest].join(' ')} --yes\`.`))
    } else
      io.out(
        `${c.green('✓')} network check ${r.after.guard ? 'on' : 'off'}, allowed: ${r.after.allow.join(', ') || 'none'}.`,
      )
    return r.changed && !r.applied ? 10 : 0
  }
  if ((sub !== undefined && sub !== 'check') || rest.length || a.rest.length)
    throw new UsageError(
      'usage: sideby network [check] | sideby network on|off [--yes] | sideby network allow <country>... [--yes]',
    )
  const s = await rt.networkStatus(sub === 'check' ? { check: true } : {})
  if (asJson) {
    json(io, s)
    return 0
  }
  const state = s.active
    ? c.green('on')
    : s.guard
      ? c.yellow(s.ci ? 'on, but not in CI' : 'on')
      : c.dim('off')
  io.out(`Network check: ${state}${s.allow.length ? `, allowed: ${s.allow.join(', ')}` : ''}`)
  const now = rt.readContext().now
  const mark = {
    ok: c.green('ok'),
    blocked: c.red('blocked'),
    unknown: c.red('cannot tell'),
    'not-checked': c.dim('not checked yet'),
  }
  if (s.targets.length)
    io.out(
      table(
        s.targets.map((t) => [
          new URL(t.url).hostname,
          t.loc ?? '-',
          s.allow.length || t.status === 'not-checked'
            ? mark[t.status]
            : c.dim(t.loc ? 'seen' : 'not checked yet'),
          c.dim(
            [
              t.checkedAt ? `checked ${clock(t.checkedAt, now)}` : '',
              t.error ?? '',
              t.ipChanged ? 'exit address changed in the last day' : '',
              t.accounts.join(', '),
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ]),
        ['ADDRESS', 'COUNTRY', 'RESULT', 'NOTE'],
      ),
    )
  const skipped = s.accounts.filter((x) => x.skip)
  if (skipped.length) {
    const why = {
      'third-party': 'third-party endpoint, not checked',
      'at-launch': 'API account, checked when it starts',
      'not-covered': 'not covered',
    }
    for (const x of skipped) io.out(c.dim(`  ${x.ref}: ${why[x.skip!]}`))
  }
  if (!s.guard)
    io.out(
      c.cyan(
        s.allow.length
          ? 'Turn it on with `sideby network on --yes`.'
          : 'Choose the countries your requests may leave from, then turn it on: `sideby network allow US JP --yes` and `sideby network on --yes`.',
      ),
    )
  else if (sub !== 'check') io.out(c.dim('Check now with `sideby network check`.'))
  io.out(c.dim('Sessions started without sideby (running `claude` or `codex` directly) are not checked.'))
  return 0
}

/** The family a `defer` from inside a session comes from: its Account, else the Host's own variables. */
function deferFamily(env: NodeJS.ProcessEnv): string {
  const ref = env.SIDEBY_ACCOUNT
  if (ref?.includes(':')) return ref.slice(0, ref.indexOf(':'))
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) return 'claude'
  if (env.CODEX_THREAD_ID) return 'codex'
  return 'unknown'
}

/** One line for where Unattended Mode stands now. */
function unattendedLine(s: import('../core/unattended.ts').UnattendedStatus, now: Date): string {
  const at = (iso: string) => clock2(iso, now)
  const slot = s.slot ? ` · Slot "${s.slot}"` : ''
  if (s.reason === 'slot' || s.reason === 'manual')
    return `${c.green('on')}${s.reason === 'manual' ? ' · turned on by hand' : slot}${s.until ? ` · until ${at(s.until)}` : ' · no end: the Schedule covers every hour'}`
  if (s.reason === 'session') return `${c.green('on')} for this session only (started with --unattended)`
  if (s.reason === 'paused')
    return `${c.yellow('paused')}${slot}${s.until ? ` · until ${at(s.until)}, then the Schedule goes on` : ' · until you turn it on (`sideby unattended on`)'}`
  return `${c.dim('off')}${s.next ? ` · next ${at(s.next.at)}${s.next.slot ? ` (${s.next.slot})` : ''}` : ''}`
}

const clock2 = (iso: string, now: Date) => clockText(Date.parse(iso), now.getTime())

function printSchedule(io: Io, schedule: readonly import('../core/unattended-state.ts').UnattendedSlot[]) {
  if (!schedule.length) {
    io.out(
      c.dim(
        'Schedule: empty. Add weeknights 23:00-08:00 with `sideby unattended schedule preset weeknights`.',
      ),
    )
    return
  }
  io.out('Schedule:')
  schedule.forEach((s, i) => {
    const night = s.end <= s.start ? (s.end === s.start ? ' (whole day)' : ' (next day)') : ''
    io.out(`  ${i + 1}. ${s.name ? `${s.name}  ` : ''}${daysText(s.days)} ${s.start}-${s.end}${night}`)
  })
}

function printUnattended(
  io: Io,
  s: import('../core/unattended.ts').UnattendedStatus,
  now: Date,
  opts: { schedule?: boolean } = {},
) {
  io.out(`Unattended Mode: ${unattendedLine(s, now)}`)
  if (s.problem) io.out(c.red(s.problem))
  if (opts.schedule !== false) printSchedule(io, s.schedule)
  if (s.pending)
    io.out(
      `Pending decisions: ${c.yellow(String(s.pending))} open; see them with \`sideby unattended pending\`.`,
    )
  if (!s.configured)
    io.out(
      c.cyan(
        'Not set up yet: `sideby unattended on` or `sideby unattended schedule preset weeknights` sets it up, and Claude and Codex sessions sideby starts after that are covered.',
      ),
    )
  else
    io.out(
      c.dim(
        'Covers Claude sessions sideby starts (questions, permission prompts and MCP forms), and questions in Codex sessions once you trust both `unattended-hook` entries in /hooks; Codex approval prompts still wait. Not Grok, pi, desktop apps or sessions started without sideby.',
      ),
    )
}

/** `sideby unattended …` (spec §3.37, ADR-0058): status, on and off, the Schedule, Pending Decisions and `defer`. */
export async function cmdUnattended(a: ParsedArgs, io: Io): Promise<number> {
  const [sub, ...rest] = a.positionals
  const asJson = a.flags.has('json')
  const allow = (...names: string[]) => {
    for (const k of a.flags.keys())
      if (k !== 'json' && !names.includes(k))
        throw new UsageError(
          `--${k} does not go with \`sideby unattended ${sub ?? ''}\`; run \`sideby unattended --help\``,
        )
    if (a.rest.length) throw new UsageError('`sideby unattended` takes no arguments after `--`')
  }
  const u = await import('../core/unattended.ts')
  const rt = await createRuntime()
  const families = [...rt.families.keys()]
  const paths = rt.paths
  const now = () => rt.readContext().now
  const { checkUnattendedEnded } = await import('../core/unattended-ended.ts')
  // Turning it off or on may end a stretch: notice it now, not at the next command (spec §3.37).
  const noticeEnd = () => checkUnattendedEnded(paths, async (ctx) => void (await rt.unattendedEnded(ctx)))
  const show = (change: import('../core/unattended.ts').UnattendedChange, done: string) => {
    if (asJson) {
      json(io, { ...change.status, changed: change.changed, ...(change.undo ? { undo: change.undo } : {}) })
      return 0
    }
    io.out(change.changed ? `${c.green('✓')} ${done}` : done)
    printUnattended(io, change.status, now())
    if (change.undo) io.out(c.dim(`Undo: ${change.undo}`))
    return 0
  }

  if (sub === undefined || sub === 'status') {
    allow()
    if (rest.length) throw new UsageError('usage: sideby unattended [status] [--json]')
    const s = await rt.unattendedStatus()
    if (asJson) json(io, s)
    else printUnattended(io, s, now())
    return 0
  }

  if (sub === 'on') {
    allow('for', 'until', 'slot-end')
    if (rest.length)
      throw new UsageError(
        'usage: sideby unattended on [--for <n>h|<n>m | --until <HH:MM|date and time> | --slot-end]',
      )
    const status = await rt.unattendedStatus()
    const value = (k: string) => {
      const v = a.flags.get(k)
      return typeof v === 'string' ? v : undefined
    }
    const r = u.onUntil(
      {
        ...(a.flags.has('for') ? { for: value('for') ?? '' } : {}),
        ...(a.flags.has('until') ? { until: value('until') ?? '' } : {}),
        ...(a.flags.has('slot-end') ? { slotEnd: true } : {}),
      },
      status.schedule,
      now(),
    )
    if ('error' in r) throw new UsageError(r.error)
    const change = await u.turnUnattendedOn({ paths, families, until: r.until, now: now() })
    await noticeEnd()
    return show(change, `Unattended Mode is on until ${clock2(new Date(r.until).toISOString(), now())}.`)
  }

  if (sub === 'off') {
    allow()
    if (rest.length) throw new UsageError('usage: sideby unattended off [--json]')
    const change = await u.turnUnattendedOff({ paths, families, now: now() })
    await noticeEnd()
    const s = change.status
    return show(
      change,
      !change.changed
        ? s.reason === 'paused'
          ? s.until
            ? 'Unattended Mode is already paused until this Slot ends.'
            : 'Unattended Mode is already paused until you turn it on.'
          : s.reason === 'session'
            ? 'Unattended Mode is off for the computer; this session was started with --unattended and stays on.'
            : 'Unattended Mode is already off.'
        : s.reason === 'paused'
          ? s.until
            ? 'Unattended Mode is paused until this Slot ends; the next Slot turns it on as usual.'
            : 'Unattended Mode is paused until you turn it on: your Schedule covers every hour, so it has no end.'
          : 'Unattended Mode is off.',
    )
  }

  if (sub === 'schedule') {
    const [action, ...args] = rest
    if (action === undefined) {
      allow()
      const s = await rt.unattendedStatus()
      if (asJson) json(io, s)
      else printSchedule(io, s.schedule)
      return 0
    }
    if (action === 'add') {
      allow('days', 'from', 'to', 'name', 'at')
      if (args.length)
        throw new UsageError(
          'usage: sideby unattended schedule add --days <mon-fri|sat,sun|…> --from HH:MM --to HH:MM [--name <name>]',
        )
      const get = (k: string) => {
        const v = a.flags.get(k)
        return typeof v === 'string' ? v : undefined
      }
      const slot = u.slotFromOptions({
        ...(get('days') !== undefined ? { days: get('days')! } : {}),
        ...(get('from') !== undefined ? { from: get('from')! } : {}),
        ...(get('to') !== undefined ? { to: get('to')! } : {}),
        ...(get('name') !== undefined ? { name: get('name')! } : {}),
      })
      if ('error' in slot) throw new UsageError(slot.error)
      const at = get('at')
      if (at !== undefined && !/^[1-9]\d{0,2}$/.test(at))
        throw new UsageError(
          '--at takes a position such as 1 (the first Slot); leave it out to add at the end',
        )
      const change = await u.addUnattendedSlot({ paths, families, slot, ...(at ? { at: Number(at) } : {}) })
      await noticeEnd()
      return show(change, change.changed ? 'Added the Slot.' : 'That Slot is already in the Schedule.')
    }
    if (action === 'remove') {
      allow()
      const n = args[0]
      if (args.length !== 1 || !n || !/^[1-9]\d{0,2}$/.test(n))
        throw new UsageError(
          'usage: sideby unattended schedule remove <number>, the number `sideby unattended` shows (1 is the first)',
        )
      const change = await u.removeUnattendedSlot({ paths, families, n: Number(n) })
      await noticeEnd()
      return show(change, `Removed Slot ${n}.`)
    }
    if (action === 'preset') {
      allow()
      const preset = args[0] ? u.UNATTENDED_PRESETS[args[0]] : undefined
      if (args.length !== 1 || !preset)
        throw new UsageError(
          `usage: sideby unattended schedule preset weeknights (Monday to Friday, 23:00 to 08:00)`,
        )
      const change = await u.addUnattendedSlot({ paths, families, slot: preset })
      await noticeEnd()
      return show(
        change,
        change.changed
          ? `Added ${preset.name}: ${daysText(preset.days)} ${preset.start}-${preset.end}.`
          : `${preset.name} is already in the Schedule.`,
      )
    }
    throw new UsageError(
      'usage: sideby unattended schedule [add --days … --from … --to … [--name …] | remove <number> | preset weeknights]',
    )
  }

  if (sub === 'pending') {
    const { listPendingDecisions, markPendingDone } = await import('../core/unattended-pending.ts')
    const [action, ...args] = rest
    if (action === 'done') {
      allow('all')
      const all = a.flags.has('all')
      if (all === Boolean(args.length) || args.length > 1)
        throw new UsageError(
          'usage: sideby unattended pending done <id> | --all (the id is in `sideby unattended pending`)',
        )
      let done: import('../core/unattended-pending.ts').PendingDecision[]
      try {
        done = await markPendingDone(paths.stateDir, all ? 'all' : args[0]!, now())
      } catch (err) {
        throw new UserError((err as Error).message, { code: 'no-pending' })
      }
      const pending = await listPendingDecisions(paths.stateDir, { now: now() })
      if (asJson) json(io, { done: done.map((d) => d.id), pending })
      else
        io.out(
          `${c.green('✓')} marked ${done.length === 1 ? '1 decision' : `${done.length} decisions`} done; ${pending.length} still open.`,
        )
      return 0
    }
    allow('all')
    if (action !== undefined)
      throw new UsageError('usage: sideby unattended pending [--all] | pending done <id>|--all')
    const pending = await listPendingDecisions(paths.stateDir, { all: a.flags.has('all'), now: now() })
    if (asJson) {
      json(io, { pending })
      return 0
    }
    if (!pending.length) {
      io.out('Nothing is waiting for you.')
      return 0
    }
    for (const d of pending) {
      const where = [
        d.account ?? d.family,
        d.kind === 'question' ? 'question' : d.kind === 'permission' ? 'needed your OK' : 'left undone',
        d.agentType ? `subagent ${d.agentType}` : '',
        d.doneAt ? 'done' : '',
      ]
        .filter(Boolean)
        .join(' · ')
      io.out(`${c.bold(d.id)}  ${clock2(d.at, now())}  ${c.dim(where)}`)
      for (const line of d.text.split('\n')) io.out(`  ${line}`)
      if (d.sessionId)
        io.out(c.dim(`  session ${d.sessionId}${d.cwd ? ` in ${tildify(d.cwd, paths.home)}` : ''}`))
    }
    io.out(c.dim('Mark one done with `sideby unattended pending done <id>`, or all with `--all`.'))
    return 0
  }

  if (sub === 'defer') {
    allow()
    const text = rest.join(' ').trim()
    if (!text) throw new UsageError('usage: sideby unattended defer "<one sentence on what was left undone>"')
    const { addPendingDecision } = await import('../core/unattended-pending.ts')
    const env = process.env
    const sessionId = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID
    const decision = await addPendingDecision(
      paths.stateDir,
      {
        kind: 'deferred',
        family: deferFamily(env),
        ...(env.SIDEBY_ACCOUNT ? { account: env.SIDEBY_ACCOUNT } : {}),
        ...(sessionId ? { sessionId } : {}),
        cwd: process.cwd(),
        text,
      },
      now(),
    )
    if (asJson) json(io, { decision })
    else
      io.out(
        `${c.green('✓')} kept for the user (${decision.id}); they see it with \`sideby unattended pending\`. Go on with the rest of the task.`,
      )
    return 0
  }

  throw new UsageError(
    'usage: sideby unattended [status|on|off|schedule|pending|defer]; run `sideby unattended --help`',
  )
}

/**
 * `sideby commands <words>` (spec §3.36, ADR-0054): the Search Catalog the Panel's Command Palette searches, read-only.
 * Titles and places are in English, as every other command prints; the words may be English or Chinese.
 */
/** One command of the Command List as `sideby commands --json` gives it (spec §3.38). */
function commandOut(cmd: CliCommand) {
  const place = cmd.feature ? SEARCH_CATALOG.find((e) => e.id === cmd.feature) : undefined
  return {
    id: cmd.id,
    usage: cmd.usage,
    description: cmd.summary.en,
    example: cmd.example ?? null,
    featureId: place?.id ?? null,
    panel: place?.panel.en ?? null,
  }
}

/** Rows of `command  description`; a command too long for the column gets the description on the next line. */
function commandRows(rows: [string, string][]): string[] {
  const col = Math.min(44, Math.max(...rows.map(([u]) => u.length)) + 2)
  return rows.flatMap(([u, d]) =>
    u.length + 2 <= col ? [`  ${u.padEnd(col)}${d}`] : [`  ${u}`, `  ${' '.repeat(col)}${d}`],
  )
}

/** `sideby commands` with no words: every command by task, the common ones first, each with an example there. */
function listCommands(a: ParsedArgs, io: Io): number {
  const common = commonCommands()
  if (a.flags.has('json')) {
    json(io, {
      common: common.map((cmd) => cmd.id),
      groups: COMMAND_GROUPS.map((g) => ({
        id: g.id,
        title: g.title.en,
        commands: CLI_COMMANDS.filter((cmd) => cmd.group === g.id).map(commandOut),
      })).filter((g) => g.commands.length),
    })
    return 0
  }
  const out: string[] = [
    c.bold('Common'),
    ...commandRows(common.map((cmd) => [cmd.example ?? cmd.usage, cmd.summary.en])),
  ]
  for (const g of COMMAND_GROUPS) {
    const cmds = CLI_COMMANDS.filter((cmd) => cmd.group === g.id)
    if (cmds.length)
      out.push('', c.bold(g.title.en), ...commandRows(cmds.map((cmd) => [cmd.usage, cmd.summary.en])))
  }
  out.push(
    '',
    c.dim(
      '`sideby <command> --help` explains one; `sideby commands <words>` finds where a feature lives in the Panel. In the Panel: Commands, or press ?.',
    ),
  )
  io.out(out.join('\n'))
  return 0
}

export function cmdCommands(a: ParsedArgs, io: Io): number {
  const query = a.positionals.join(' ').trim()
  if (!query) return listCommands(a, io)
  const results = searchCatalog(query, SEARCH_CATALOG).map(({ entry }) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title.en,
    panel: entry.panel.en,
    cliCommand: entry.cliCommand,
  }))
  if (a.flags.has('json')) {
    json(io, { results })
    return 0
  }
  if (!results.length) {
    io.out(`No feature of sideby matches "${query}".`)
    io.out(
      c.dim(
        `Try other words (English or Chinese), \`sideby history ${query}\` to find a past session, or ask your AI.`,
      ),
    )
    return 0
  }
  io.out(
    table(
      results.map((r) => [r.title, r.kind, r.panel, r.cliCommand ?? c.dim('Panel only')]),
      ['Feature', 'Kind', 'In the Panel', 'Command'],
    ),
  )
  return 0
}
