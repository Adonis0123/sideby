import { fileURLToPath } from 'node:url'
import { aliasesByAccount } from '../core/accounts.ts'
import { aliasRefs } from '../core/config.ts'
import type { DoctorReport } from '../core/doctor.ts'
import { UserError } from '../core/errors.ts'
import { runHost } from '../core/launch.ts'
import { resolvePaths, tildify } from '../core/paths.ts'
import { USAGE_DAYS } from '../core/quota-levels.ts'
import { SHELLS, type Shell, type ShellInitWrite } from '../core/shell-init.ts'
import { suggestAlias, suggestName } from '../panel/page-logic.ts'
import { createRuntime, type Runtime, UnknownFamilyError } from '../runtime.ts'
import type { Finding } from '../types.ts'
import { type ParsedArgs, UsageError } from './args.ts'
import { c, clock, quotaText, table, usageText } from './format.ts'

export interface Io {
  out(s: string): void
  err(s: string): void
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
  const statuses = await Promise.all(accounts.map((x) => rt.status(x)))
  const families = await rt.familyInfo()
  if (a.flags.has('json')) {
    json(io, { families, accounts: statuses, pluginErrors: [...rt.pluginErrors] })
    return 0
  }
  const home = rt.paths.home
  if (statuses.length === 0) {
    io.out('No accounts found yet.')
    const installed = families.filter((f) => f.installed)
    if (installed.length === 0)
      io.out(`Install a host first: ${families.map((f) => `${f.title} (${f.installUrl})`).join(', ')}`)
    else io.out(`Run ${installed.map((f) => f.bin).join(' or ')} once, then \`sideby new <family> <name>\`.`)
  } else {
    const rows = statuses.map((s) => [
      c.bold(s.ref),
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
      s.hostInstalled ? tildify(s.dir, home) : `${tildify(s.dir, home)} ${c.yellow('(host not installed)')}`,
    ])
    io.out(table(rows, ['ACCOUNT', 'TYPE', 'LOGIN', 'EMAIL', 'MODEL', 'DIR']))
    io.out(c.dim('\nsideby run <account>  ·  sideby new <family> <name>  ·  sideby quota  ·  sideby ui'))
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
  const prepared = await rt.prepareLaunch(ref, [...extra, ...a.rest], command)
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  return runHost(prepared)
}

/**
 * `sideby resume <family>`: what the Host-named shell function calls (spec §3.15). Starts the Account that holds the
 * session the arguments resume by id, or runs the Host unchanged.
 */
export async function cmdResume(a: ParsedArgs, io: Io): Promise<number> {
  const [family, ...extra] = a.positionals
  if (!family) throw new UsageError('usage: sideby resume <family> [-- host args]')
  const rt = await createRuntime()
  const route = await rt.resumeLaunch(family, [...extra, ...a.rest])
  if (route.account)
    io.err(c.dim(`sideby: session ${route.sessionId} is in ${route.account.ref}; starting it there`))
  return runHost(route.launch)
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
    const next = [
      ...(out.length ? [`sign in with \`${out.join('` or `')}\``] : []),
      ...(apiLeft ? ['add --include-api to use an API account'] : []),
    ]
    io.err(c.yellow(`\n${why}${next.length ? `; ${next.join(', or ')}` : ''}.`))
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
  const prepared = await rt.prepareLaunch(plan.pick, a.rest, 'run')
  if (prepared.notice) io.err(c.cyan(prepared.notice))
  return runHost(prepared)
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
      rows.map((r) => [c.bold(r.ref), quotaText(r.quota, now), usageText(r.usage)]),
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
  const setup = rt.quotaSetup(familyId)
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
            `\nApply it with \`sideby quota setup ${familyId} --yes\`; undo any time with \`sideby quota teardown ${familyId}\`.`,
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
      `${c.bold(f.title)} (${f.id})  ${f.installed ? c.green('installed') : c.yellow(`not installed: ${f.installUrl}`)}`,
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
