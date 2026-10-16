import { fileURLToPath } from 'node:url'
import { aliasesByAccount } from '../core/accounts.ts'
import { listAppProfiles, openAppProfile, parseProfileRef, removeAppProfile } from '../core/app-profiles.ts'
import { browserReport, openInBrowser, setBrowserSignIns } from '../core/browser-profiles.ts'
import { aliasRefs } from '../core/config.ts'
import { openDesktopApp, withDesktopApps } from '../core/desktop-app.ts'
import type { DoctorReport } from '../core/doctor.ts'
import { UserError } from '../core/errors.ts'
import { requestHandoff } from '../core/handoff-chain.ts'
import { explain, type HandoffIo, readyDecision, runWithHandoff } from '../core/handoff-run.ts'
import { configureHandoff, type HandoffChange, handoffHint, handoffStatus } from '../core/handoff-status.ts'
import { installHint, runHost } from '../core/launch.ts'
import { accountModel, type ModelChange, setAccountModel } from '../core/model-choice.ts'
import { resolvePaths, tildify } from '../core/paths.ts'
import { USAGE_DAYS } from '../core/quota-levels.ts'
import {
  groupsToTurnOff,
  groupsToUndo,
  type RemoteControlGroup,
  type RemoteControlState,
} from '../core/remote-control.ts'
import { SHELLS, type Shell, type ShellInitWrite } from '../core/shell-init.ts'
import type { TuneApplyPlan } from '../core/tuning-apply.ts'
import { suggestAlias, suggestName } from '../panel/page-logic.ts'
import { createRuntime, type Runtime, UnknownFamilyError } from '../runtime.ts'
import type { Finding } from '../types.ts'
import { type ParsedArgs, UsageError } from './args.ts'
import { c, clock, compactNumber, quotaText, table, tuningLines, usageText } from './format.ts'

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
async function runAccount(rt: Runtime, ref: string, args: readonly string[], io: Io): Promise<number> {
  return whileRunning(rt, () => runAccountNow(rt, ref, args, io))
}

async function runAccountNow(rt: Runtime, ref: string, args: readonly string[], io: Io): Promise<number> {
  const handed = await runWithHandoff(rt, ref, args, {
    err: (l) => io.err(c.dim(l)),
    stdin: io.stdin ?? process.stdin,
  })
  if (handed !== null) return handed
  const prepared = await rt.prepareLaunch(ref, args, 'run')
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  const code = await runHost(prepared)
  if ((io.stdin ?? process.stdin).isTTY) {
    const hint = await handoffHint(rt, ref)
    if (hint) io.err(c.dim(`sideby: ${hint}`))
  }
  return code
}

const json = (io: Io, data: object) => io.out(JSON.stringify({ schemaVersion: 1, ...data }, null, 2))

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

export async function cmdList(a: ParsedArgs, io: Io): Promise<number> {
  const rt = await createRuntime()
  const accounts = await rt.accounts()
  const [statuses, appProfiles] = await Promise.all([
    withDesktopApps(rt, accounts, Promise.all(accounts.map((x) => rt.status(x)))),
    listAppProfiles(rt),
  ])
  const hasDesktop = statuses.some((s) => s.desktopApp)
  const families = await rt.familyInfo()
  if (a.flags.has('json')) {
    json(io, { families, accounts: statuses, appProfiles, pluginErrors: [...rt.pluginErrors] })
    return 0
  }
  const home = rt.paths.home
  if (statuses.length === 0) {
    io.out('No accounts found yet.')
    const installed = families.filter((f) => f.installed)
    if (installed.length === 0)
      io.out(`Install a host first: ${families.map((f) => `${f.title} (${installHint(f)})`).join(', ')}`)
    else io.out(`Run ${installed.map((f) => f.bin).join(' or ')} once, then \`sideby new <family> <name>\`.`)
  } else {
    // `= main`: the other Accounts of its Same Login, which share its Quota (spec §3.21).
    const brokenOf = (id: string) => families.find((f) => f.id === id)?.brokenBin
    const sameMark = (refs: readonly string[] | undefined) =>
      refs?.length ? ` ${c.dim(`= ${refs.map((r) => r.slice(r.indexOf(':') + 1)).join(', ')}`)}` : ''
    const rows = statuses.map((s) => [
      `${c.bold(s.ref)}${sameMark(s.sameLogin)}`,
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
    for (const f of families.filter((x) => !x.installed && statuses.some((s) => s.family === x.id)))
      io.out(
        c.yellow(
          f.brokenBin
            ? `\n${f.title}'s install is broken (${tildify(f.brokenBin, home)} cannot run, often after an interrupted upgrade); reinstall it: ${installHint(f)}`
            : `\n${f.title} is not installed; install it: ${installHint(f)}`,
        ),
      )
    if (statuses.some((s) => s.sameLogin?.length))
      io.out(c.dim('\n= <account>: signed in as the same login as that account, so they share one quota.'))
    io.out(c.dim('\nsideby run <account>  ·  sideby new <family> <name>  ·  sideby quota  ·  sideby ui'))
  }
  // App Profiles (ADR-0019): windows of an app that signs in apart from the Accounts above.
  for (const app of new Set(appProfiles.map((p) => p.app))) {
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
  for (const s of statuses) for (const p of s.problems ?? []) io.err(c.yellow(`${s.ref}: ${p}`))
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
  if (a.flags.has('json')) {
    json(io, suggestion ? { ...res, suggestion } : res)
    return res.ok ? 0 : 1
  }
  if (suggestion?.aliasProblem)
    io.out(`${c.yellow('!')} no short command: the pattern suggests ${suggestion.aliasProblem}`)
  const home = rt.paths.home
  const where = tildify(res.account.dir, home)
  if (res.ok) io.out(`${c.green('✓')} created ${c.bold(res.account.ref)} at ${where}`)
  else io.out(`${c.yellow('!')} created ${c.bold(res.account.ref)} at ${where} with problems; see below`)
  for (const s of res.steps.filter((x) => !x.ok || x.action === 'skipped'))
    io.out(`  ${s.ok ? c.dim('·') : c.red('✗')} ${s.item}: ${s.message ?? s.action}`)
  for (const e of res.hookErrors) io.err(c.red(`  ${e.message}`))
  if (res.alias?.added) io.out(`${c.green('✓')} short command ${c.bold(res.alias.name)} (in a new shell)`)
  else if (res.alias) io.out(`  ${c.red('✗')} ${res.alias.message}`)
  printShellInitWrites(io, res.shellInitFiles ?? [], home)
  io.out('\nNext:')
  for (const n of res.nextSteps) io.out(`  ${n}`)
  return res.ok ? 0 : 1
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
  if (command === 'run') return runAccount(rt, ref, [...extra, ...a.rest], io)
  const prepared = await rt.prepareLaunch(ref, [...extra, ...a.rest], command)
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  return whileRunning(rt, () => runHost(prepared))
}

/**
 * `sideby resume <family>`: what the Host-named shell function calls (spec §3.15). Starts the Account that holds the
 * session the arguments resume by id, a new session where a never-saved one started (ADR-0009), or the Host unchanged.
 */
export async function cmdResume(a: ParsedArgs, io: Io): Promise<number> {
  const [family, ...extra] = a.positionals
  if (!family) throw new UsageError('usage: sideby resume <family> [-- host args]')
  const rt = await createRuntime()
  const route = await rt.resumeLaunch(family, [...extra, ...a.rest])
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
    throw new UsageError('usage: sideby next <family> [--dry-run] [--include-api] [-- host args]')
  const includeApi = a.flags.has('include-api')
  const rt = await createRuntime()
  const plan = await rt.handoff(family, { includeApi })
  if (a.flags.has('json')) {
    json(io, plan)
    return plan.pick && plan.hasQuota ? 0 : 1
  }
  const now = rt.readContext().now
  const note = (e: (typeof plan.accounts)[number]): string => {
    if (e.sameLoginAs) return `same login as ${e.sameLoginAs}, which shares its quota; skipped`
    if (e.state === 'ready') return `fullest window ${Math.round(e.pressure ?? 0)}%`
    if (e.state === 'unknown') return 'no quota data yet'
    if (e.state === 'api')
      return includeApi ? 'API account, pay per use' : 'left out; add --include-api to use it'
    if (e.state === 'full') return e.resetsAt ? `back at ${clock(e.resetsAt, now)}` : 'at its limit'
    return `signed out; sign in with \`sideby login ${e.ref}\``
  }
  const mark = { ready: c.green, unknown: c.yellow, api: c.cyan, full: c.red, 'logged-out': c.dim } as const
  io.out(
    table(
      plan.accounts.map((e) => [
        e.ref === plan.pick ? c.green('→') : ' ',
        c.bold(e.ref),
        mark[e.state](e.state === 'logged-out' ? 'signed out' : e.state),
        c.dim(note(e)),
      ]),
      ['', 'ACCOUNT', 'STATE', 'NOTE'],
    ),
  )
  if (!plan.pick) {
    const out = plan.accounts.filter((e) => e.state === 'logged-out').map((e) => `sideby login ${e.ref}`)
    const apiLeft = !includeApi && plan.accounts.some((e) => e.state === 'api')
    const why = plan.earliestReset
      ? `every ${family} account is at its limit; ${plan.earliestReset.ref} is back at ${clock(plan.earliestReset.at, now)}`
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
    const setup = (await rt.quotaSetups()).some((s) => s.family === family && s.plan.status === 'ready')
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
      ? `lowest quota pressure, ${Math.round(picked.pressure ?? 0)}%`
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
  return runAccount(rt, plan.pick, a.rest, io)
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
 * `sideby remote-control [off|undo] [--yes] [--json]` (spec §3.22, ADR-0017): whether Claude sessions connect to
 * claude.ai by themselves, and turning that off for every Account (a preview with exit 10 until --yes).
 */
export async function cmdRemoteControl(a: ParsedArgs, io: Io): Promise<number> {
  const [action, extra] = a.positionals
  if (extra !== undefined || (action !== undefined && action !== 'off' && action !== 'undo'))
    throw new UsageError('usage: sideby remote-control [off|undo] [--yes] [--json]')
  const wantJson = a.flags.has('json')
  const rt = await createRuntime()
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
    if (groupsToTurnOff(groups).length)
      io.out(
        c.cyan(
          '\nRun `sideby remote-control off` so no session connects by itself (it shows the change first).',
        ),
      )
    return 0
  }
  const todo = action === 'off' ? groupsToTurnOff(groups) : groupsToUndo(groups)
  if (todo.length === 0) {
    const r = action === 'off' ? await rt.remoteControlOff() : await rt.remoteControlUndo()
    if (wantJson) out({ applied: false, groups: show(groups), message: r.message })
    else io.out(tilde(r.message, home))
    return r.ok ? 0 : 1
  }
  if (!a.flags.has('yes')) {
    if (wantJson)
      out({
        applied: false,
        groups: show(todo),
        message: `Run again with --yes to ${action === 'off' ? 'turn it off' : 'undo'}.`,
      })
    else {
      io.out(
        action === 'off'
          ? 'Turn off Remote Control at startup?'
          : 'Put back the Remote Control setting sideby replaced?',
      )
      for (const g of todo) {
        const to = action === 'off' ? 'false' : 'what it was before'
        const from = g.state === 'default' ? 'not set' : g.state === 'on' ? 'true' : 'false'
        io.out(`  ${tildify(g.file, home)}: remoteControlAtStartup ${from} -> ${to}`)
        io.out(c.dim(`    used by ${g.accounts.join(', ')}`))
      }
      io.out(
        action === 'off'
          ? 'Sessions already running stay connected until you restart them. You can still start it in a session with /remote-control, and undo this with `sideby remote-control undo`.'
          : 'New sessions go back to the previous setting.',
      )
      io.out(`Run again with --yes to ${action === 'off' ? 'turn it off' : 'undo'}.`)
    }
    return 10
  }
  const r = action === 'off' ? await rt.remoteControlOff() : await rt.remoteControlUndo()
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
  if (sub === 'setup' || sub === 'teardown') return cmdQuotaSetup(a, io, sub)
  const rt = await createRuntime()
  const accounts = sub ? [await rt.resolve(sub)] : await rt.accounts()
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
  for (const r of rows)
    if (r.quota.status === 'unavailable' && r.quota.detail) io.out(c.dim(`${r.ref}: ${r.quota.detail}`))
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
        io.out(`\n${setup.summary}\nChange to ${tildify(plan.file, rt.paths.home)}:\n`)
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
  const st = await handoffStatus(await createRuntime())
  if (a.flags.has('json')) {
    json(io, st)
    return 0
  }
  io.out(
    `Auto Handoff: ${st.auto ? c.green('on') : c.yellow('off')} (same family ${st.sameFamily ? 'on' : 'off'}; brief at ${st.prepareAt}%, hand over at ${st.threshold}%)`,
  )
  if (st.sideby.problem) io.out(c.red(`sideby on PATH: ${st.sideby.problem}`))
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
  if (sub === 'enable' || sub === 'disable') return cmdHandoffSwitch(a, io, sub)
  if (sub !== 'ready')
    throw new UsageError(
      'usage: sideby handoff status | enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes] | disable [--yes] | ready [--to <account>] [--brief <file>] | setup|teardown <family> [--yes]',
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
          p.families.join(', ') || c.dim('hooks'),
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
  await new Promise<void>((resolve) => {
    const stop = () => {
      void srv.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

/**
 * `sideby update [--yes] [--json]` (spec §3.23): asks the registry now, shows what an Update runs, and runs it with
 * `--yes` (exit 10 before). An install sideby cannot update gets the command to run and exit 1.
 */
export async function cmdUpdate(a: ParsedArgs, io: Io): Promise<number> {
  if (a.positionals.length) throw new UsageError('usage: sideby update [--yes] [--json]')
  const u = await import('../core/update.ts')
  const { SKILL_INSTALL } = await import('../core/skill-check.ts')
  const { backgroundPanelPort } = await import('../panel/background.ts')
  const paths = resolvePaths(process.env)
  const asJson = a.flags.has('json')
  const plan = await u.planUpdate(paths, process.env)
  const shown = u.shownPlan(plan)
  if (!plan.available) {
    if (asJson) json(io, { ...shown, updated: false })
    else io.out(`${c.green('✓')} sideby ${plan.current} is the latest version.`)
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
      skill: SKILL_INSTALL,
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
  io.out(
    '  A `sideby ui` running in a terminal and sessions already running keep the old version until you restart them.',
  )
  io.out(`  If you use the sideby skill, update it too: ${SKILL_INSTALL}`)
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
  if (sub !== undefined || a.rest.length)
    throw new UsageError('usage: sideby browser [--enable|--disable] [--yes] | sideby browser open <account>')
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
    io.out('Google Chrome has no data on this Mac yet; open it once, then try again.')
    return 0
  }
  const signedIn = new Set(r.profiles.flatMap((p) => p.signIns))
  const now = new Date()
  io.out(
    table(
      r.profiles.map((p) => [
        p.name,
        p.dir,
        p.signIns.join(', ') || c.dim('-'),
        p.changedAt ? clock(p.changedAt, now) : '-',
      ]),
      ['Browser user', 'Folder', 'Signed in to', 'Changed'],
    ),
  )
  const missing = accounts.filter(
    (x) => r.families.matched.includes(x.family) && x.kind !== 'api' && !signedIn.has(x.ref),
  )
  if (missing.length) io.out(c.dim(`\nNo browser user found for: ${missing.map((x) => x.ref).join(', ')}`))
  if (r.families.openOnly.length)
    io.out(
      c.dim(`${r.families.openOnly.join(', ')}: the website keeps no id to match; open it with --profile.`),
    )
  io.out(c.dim('\nRead from Chrome on this computer only; a browser user that signed out may still show.'))
  io.out(c.dim('Open one: sideby browser open <account> [--profile <name>]'))
  return 0
}

export async function cmdAlias(a: ParsedArgs, io: Io): Promise<number> {
  const [sub, alias, target, ...more] = a.positionals
  const usage =
    'usage: sideby alias add <short-command> <account> [-- host args]  |  sideby alias rm <short-command>'
  const add = sub === 'add' && alias !== undefined && target !== undefined && more.length === 0
  const rm = sub === 'rm' && alias !== undefined && target === undefined && a.rest.length === 0
  if (!add && !rm) throw new UsageError(usage)
  const rt = await createRuntime()
  const res = add ? await rt.addAlias(alias, target, a.rest) : await rt.removeAlias(alias)
  if (a.flags.has('json')) {
    json(io, res)
    return res.ok ? 0 : 1
  }
  const starts = res.account ? ` → ${res.account}${res.args ? ` ${res.args.join(' ')}` : ''}` : ''
  const said = {
    added: `${c.green('✓')} short command ${c.bold(res.alias)}${starts} (in a new shell)`,
    exists: `${c.green('✓')} short command ${c.bold(res.alias)}${starts} was already in the config`,
    removed: `${c.green('✓')} removed short command ${c.bold(res.alias)}${starts}`,
    absent: `${c.dim('·')} no short command ${res.alias} in the config; nothing to remove`,
  }
  io.out(said[res.status])
  printShellInitWrites(io, res.shellInitFiles ?? [], rt.paths.home)
  return res.ok ? 0 : 1
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
    io.out(`  Accounts   ~/${f.layout.main} (main), ~/${f.layout.account}; selected with ${f.selectVar}`)
    io.out(
      `  Sign in    sideby login ${f.id}:<name>  ${c.dim(f.login.args ? `(runs ${[f.bin, ...f.login.args].join(' ')})` : `(${f.login.hint})`)}`,
    )
    const yes = (b: boolean) => (b ? c.green('yes') : c.dim('no public source'))
    io.out(
      `  Quota      ${yes(f.quota)}${f.quotaSetup ? c.dim(`, after \`sideby quota setup ${f.id}\``) : ''}   Usage ${yes(f.usage)}`,
    )
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
