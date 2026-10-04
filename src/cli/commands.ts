import { aliasProblem } from '../core/config.ts'
import type { DoctorReport } from '../core/doctor.ts'
import { runHost } from '../core/launch.ts'
import { tildify } from '../core/paths.ts'
import { USAGE_DAYS } from '../core/quota-levels.ts'
import { createRuntime } from '../runtime.ts'
import type { Finding } from '../types.ts'
import { type ParsedArgs, UsageError } from './args.ts'
import { c, quotaText, table, usageText } from './format.ts'

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
      s.model ?? c.dim('—'),
      s.hostInstalled ? tildify(s.dir, home) : `${tildify(s.dir, home)} ${c.yellow('(host not installed)')}`,
    ])
    io.out(table(rows, ['ACCOUNT', 'TYPE', 'LOGIN', 'MODEL', 'DIR']))
    io.out(c.dim('\nsideby run <account>  ·  sideby new <family> <name>  ·  sideby quota  ·  sideby ui'))
  }
  for (const s of statuses) for (const p of s.problems ?? []) io.err(c.yellow(`${s.ref}: ${p}`))
  for (const e of rt.pluginErrors) io.err(c.yellow(`plugin ${e.where}: ${e.message}`))
  return 0
}

export async function cmdNew(a: ParsedArgs, io: Io): Promise<number> {
  const [family, name] = a.positionals
  if (!family || !name) throw new UsageError('usage: sideby new <family> <name> [--api]')
  const rt = await createRuntime()
  const res = await rt.createAccount(family, name, { api: a.flags.has('api') })
  if (a.flags.has('json')) {
    json(io, res)
    return res.ok ? 0 : 1
  }
  const where = tildify(res.account.dir, rt.paths.home)
  if (res.ok) io.out(`${c.green('✓')} created ${c.bold(res.account.ref)} at ${where}`)
  else io.out(`${c.yellow('!')} created ${c.bold(res.account.ref)} at ${where} with problems; see below`)
  for (const s of res.steps.filter((x) => !x.ok || x.action === 'skipped'))
    io.out(`  ${s.ok ? c.dim('·') : c.red('✗')} ${s.item}: ${s.message ?? s.action}`)
  for (const e of res.hookErrors) io.err(c.red(`  ${e.message}`))
  io.out('\nNext:')
  for (const n of res.nextSteps) io.out(`  ${n}`)
  return res.ok ? 0 : 1
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
  for (const f of report.general) io.out(`${c.red('✗')} ${f.message}${f.hint ? c.dim(` — ${f.hint}`) : ''}`)
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
    return plan.status === 'blocked' ? 1 : 0
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
  if (shell !== 'zsh' && shell !== 'bash') throw new UsageError('usage: sideby shell-init zsh|bash')
  const rt = await createRuntime()
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const lines = ['# sideby shell-init: one function per account, plus aliases from the sideby config']
  for (const acc of await rt.accounts())
    lines.push(`sideby-${acc.family}-${acc.name}() { command sideby run ${q(acc.ref)} -- "$@"; }`)
  for (const [alias, ref] of Object.entries(rt.config.aliases ?? {}))
    if (!aliasProblem(alias)) lines.push(`${alias}() { command sideby run ${q(ref)} -- "$@"; }`)
  io.out(lines.join('\n'))
  return 0
}

export async function cmdUi(a: ParsedArgs, io: Io): Promise<number> {
  const portFlag = a.flags.get('port')
  const port = typeof portFlag === 'string' ? Number(portFlag) : undefined
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
    throw new UsageError('--port must be a number between 1 and 65535')
  const { startPanelServer } = await import('../panel/server.ts')
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
