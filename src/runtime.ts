// The one service layer the CLI and the Panel share. Frozen contract for v0.1 (plan: 审核修订).

import { type AccountRefError, discoverAccounts, resolveRef } from './core/accounts.ts'
import { addConfigAlias, aliasProblem, type Config, loadConfig } from './core/config.ts'
import { type CreateResult, createAccount } from './core/create.ts'
import { applyFixes, type DoctorReport, runDoctor } from './core/doctor.ts'
import { UserError } from './core/errors.ts'
import {
  type DoctorHistory,
  type DoctorScope,
  mergeDoctorHistory,
  readDoctorHistory,
  writeDoctorHistory,
} from './core/last-doctor.ts'
import { type PreparedLaunch, prepareLaunch, which } from './core/launch.ts'
import { type Paths, resolvePaths } from './core/paths.ts'
import {
  SHELLS,
  type Shell,
  type ShellInitWrite,
  shellInitScript,
  writeShellInitFile,
} from './core/shell-init.ts'
import { BUILTIN_PLUGINS } from './families/index.ts'
import { HookBus } from './plugins/bus.ts'
import { type BuiltinPlugin, type LoadedPlugin, loadPlugins, type PluginLoadError } from './plugins/loader.ts'
import type {
  Account,
  Env,
  FamilyDef,
  LoginState,
  QuotaResult,
  QuotaSetupPlan,
  ReadContext,
  UsageResult,
} from './types.ts'

export type { AccountRefError, DoctorHistory, Shell, ShellInitWrite }

/** What happened to the alias asked for with a new Account. */
export interface AliasResult {
  name: string
  /** True when the config now maps the alias to the new Account (also when it already did). */
  added: boolean
  message?: string
}

/** `createAccount` plus the alias and shell-init files it wrote; `ok` is false when either failed. */
export interface CreateAccountResult extends CreateResult {
  alias?: AliasResult
  /** One entry per file in config `shellInitFile`; absent when none is configured. */
  shellInitFiles?: ShellInitWrite[]
}

export interface FamilyInfo {
  id: string
  title: string
  bin: string
  installUrl: string
  installed: boolean
  /** Plugin that provides the Family. */
  plugin: string
}

export interface AccountStatus extends Account {
  familyTitle: string
  hostInstalled: boolean
  /** `not-needed` for API Accounts, which authenticate with their Secret File. */
  login: LoginState | 'not-needed'
  model?: string
  /** Plugin errors met while reading this Account (for example an unreadable settings file). */
  problems?: string[]
}

export interface DoctorOptions {
  /** Family id or Account ref; all Accounts when omitted. */
  target?: string
  fix?: boolean
  force?: boolean
  /** Record this run as the last Doctor run (default true). A read-only Panel passes false. */
  persist?: boolean
}

/** A Family's one-time quota setup, bound to this Runtime's context. */
export interface BoundQuotaSetup {
  family: string
  summary: string
  plan(): Promise<QuotaSetupPlan>
  apply(): Promise<QuotaSetupPlan>
  teardown(): Promise<{ ok: boolean; message: string; diff?: string }>
}

export interface Runtime {
  paths: Paths
  config: Config
  env: Env
  families: ReadonlyMap<string, FamilyDef>
  plugins: readonly LoadedPlugin[]
  pluginErrors: readonly PluginLoadError[]
  familyInfo(): Promise<FamilyInfo[]>
  accounts(): Promise<Account[]>
  resolve(ref: string): Promise<Account>
  status(account: Account): Promise<AccountStatus>
  doctor(opts?: DoctorOptions): Promise<DoctorReport>
  /**
   * Doctor plus the merged history it produces (written unless `persist: false`), so a read-only caller
   * still sees the result in context.
   */
  doctorWithHistory(opts?: DoctorOptions): Promise<{ report: DoctorReport; history: DoctorHistory }>
  /** Latest Doctor result per Account and per Family, if any check was recorded. */
  doctorHistory(): Promise<DoctorHistory | undefined>
  /** Every Family's quota setup with its current plan; a plan that throws is reported as `blocked`. */
  quotaSetups(): Promise<{ family: string; summary: string; plan: QuotaSetupPlan }[]>
  /** One Family's quota setup; throws UnknownFamilyError or a UserError when the Family has none. */
  quotaSetup(familyId: string): BoundQuotaSetup
  /**
   * Creates the Account, then (when `alias` is given) adds it to the config `aliases`, then rewrites every
   * `shellInitFile`. An alias that is invalid or taken is refused before anything is created; a failure to write
   * it afterwards leaves the Account in place and is reported in `alias`.
   */
  createAccount(
    family: string,
    name: string,
    opts?: { api?: boolean; alias?: string },
  ): Promise<CreateAccountResult>
  /** Why `alias` cannot start `ref` (shell-safe, not reserved, not taken by another Account), or null. */
  aliasProblem(alias: string, ref: string): string | null
  /** What `sideby shell-init <shell>` prints, from the Accounts on disk and the config aliases. */
  shellInitScript(shell: Shell): Promise<string>
  /** Rewrites the configured `shellInitFile` of each shell (all configured ones by default). */
  writeShellInitFiles(shells?: readonly Shell[]): Promise<ShellInitWrite[]>
  prepareLaunch(ref: string, userArgs: readonly string[], command: 'run' | 'login'): Promise<PreparedLaunch>
  quota(account: Account): Promise<QuotaResult>
  usage(account: Account): Promise<UsageResult>
  readContext(): ReadContext
}

export class UnknownFamilyError extends UserError {}

export async function createRuntime(
  opts: { env?: Env; builtins?: BuiltinPlugin[]; now?: () => Date } = {},
): Promise<Runtime> {
  const env = opts.env ?? process.env
  const paths = resolvePaths(env)
  const config = await loadConfig(paths.configFile)
  const bus = new HookBus()
  const loaded = await loadPlugins({
    builtins: opts.builtins ?? BUILTIN_PLUGINS,
    config,
    bus,
    userPluginsDir: paths.userPluginsDir,
    home: paths.home,
  })
  const families = loaded.families
  const ignore = new Set(config.ignore ?? [])
  const now = opts.now ?? (() => new Date())

  const familyOf = (id: string): FamilyDef => {
    const f = families.get(id)
    if (!f)
      throw new UnknownFamilyError(
        `unknown family "${id}"; available: ${[...families.keys()].join(', ') || 'none (check `sideby plugins`)'}`,
      )
    return f
  }

  // Merge `extraSharedItems` from the config into each Family's list.
  for (const [id, extra] of Object.entries(config.extraSharedItems ?? {})) {
    const f = families.get(id)
    if (f) families.set(id, { ...f, sharedItems: [...f.sharedItems, ...extra] })
  }

  const accounts = async (): Promise<Account[]> => {
    const out: Account[] = []
    for (const f of families.values()) out.push(...(await discoverAccounts(f, paths.home, ignore)))
    return out
  }

  const readContext = (): ReadContext => ({
    home: paths.home,
    now: now(),
    stateDir: paths.stateDir,
    env,
  })

  const rt: Runtime = {
    paths,
    config,
    env,
    families,
    plugins: loaded.plugins,
    pluginErrors: loaded.errors,
    async familyInfo() {
      return Promise.all(
        [...families.values()].map(async (f) => ({
          id: f.id,
          title: f.title,
          bin: f.bin,
          installUrl: f.installUrl,
          installed: (await which(f.bin, env)) !== null,
          plugin: loaded.familyOwner.get(f.id) ?? 'unknown',
        })),
      )
    },
    accounts,
    async resolve(ref) {
      return resolveRef(ref, await accounts(), config.aliases)
    },
    async status(account) {
      const f = familyOf(account.family)
      const problems: string[] = []
      // Plugin readers may throw synchronously or reject; either way the Account still gets a status.
      const safe = async <T>(what: string, fn: (() => Promise<T>) | undefined): Promise<T | undefined> => {
        if (!fn) return undefined
        try {
          return await fn()
        } catch (err) {
          problems.push(`${what}: ${(err as Error)?.message ?? String(err)}`)
          return undefined
        }
      }
      const [installed, login, model] = await Promise.all([
        which(f.bin, env),
        account.kind === 'api'
          ? undefined
          : safe('login state', f.loginState && (() => f.loginState!(account))),
        safe('model', f.model && (() => f.model!(account))),
      ])
      return {
        ...account,
        familyTitle: f.title,
        hostInstalled: installed !== null,
        login: account.kind === 'api' ? 'not-needed' : (login ?? 'unknown'),
        ...(model ? { model } : {}),
        ...(problems.length ? { problems } : {}),
      }
    },
    async doctor(o = {}) {
      return (await rt.doctorWithHistory(o)).report
    },
    async doctorWithHistory(o = {}) {
      let list = await accounts()
      let fams: ReadonlyMap<string, FamilyDef> = families
      let scope: DoctorScope = { kind: 'all' }
      if (o.target) {
        if (families.has(o.target)) {
          list = list.filter((a) => a.family === o.target)
          fams = new Map([[o.target, families.get(o.target)!]])
          scope = { kind: 'family', family: o.target }
        } else {
          const one = resolveRef(o.target, list, config.aliases)
          list = [one]
          fams = new Map([[one.family, familyOf(one.family)]])
          scope = { kind: 'account', ref: one.ref }
        }
      }
      const input = {
        home: paths.home,
        families: fams,
        accounts: list,
        bus,
        force: Boolean(o.force),
      }
      let report = await runDoctor(input)
      if (o.fix) {
        const fixes = await applyFixes(report)
        report = { ...(await runDoctor(input)), fixes }
      }
      const history = mergeDoctorHistory(await readDoctorHistory(paths.stateDir), report, scope, now())
      if (o.persist !== false) await writeDoctorHistory(paths.stateDir, history)
      return { report, history }
    },
    doctorHistory: () => readDoctorHistory(paths.stateDir),
    async quotaSetups() {
      const out: { family: string; summary: string; plan: QuotaSetupPlan }[] = []
      for (const f of families.values()) {
        if (!f.quotaSetup) continue
        const setup = rt.quotaSetup(f.id)
        out.push({ family: f.id, summary: setup.summary, plan: await setup.plan() })
      }
      return out
    },
    quotaSetup(familyId) {
      const f = familyOf(familyId)
      const setup = f.quotaSetup
      if (!setup) throw new UserError(`${f.title} needs no quota setup`)
      // One rule for every adapter: a setup that throws is reported, never crashes the caller. The message
      // is the error's own text; setup implementations must not put file contents into it.
      const blocked = (err: unknown): QuotaSetupPlan => ({
        status: 'blocked',
        file: '',
        diff: '',
        message: (err as Error)?.message ?? String(err),
      })
      return {
        family: f.id,
        summary: setup.summary,
        // Promise.resolve().then also catches a setup that throws synchronously.
        plan: () =>
          Promise.resolve()
            .then(() => setup.plan(readContext()))
            .catch(blocked),
        apply: () =>
          Promise.resolve()
            .then(() => setup.apply(readContext()))
            .catch(blocked),
        teardown: () =>
          Promise.resolve()
            .then(() => setup.teardown(readContext()))
            .catch((err: unknown) => ({
              ok: false,
              message: (err as Error)?.message ?? String(err),
            })),
      }
    },
    async createAccount(familyId, name, o = {}) {
      const family = familyOf(familyId)
      const alias = o.alias?.trim() || undefined
      const ref = `${family.id}:${name}`
      if (alias) {
        const problem = rt.aliasProblem(alias, ref)
        if (problem) throw new UserError(`${problem}; nothing was created`, { code: 'alias-invalid' })
      }
      const created: CreateAccountResult = await createAccount({
        family,
        name,
        api: Boolean(o.api),
        home: paths.home,
        bus,
        accounts: await discoverAccounts(family, paths.home, ignore),
      })
      if (alias) {
        try {
          const r = await addConfigAlias(paths.configFile, alias, created.account.ref)
          config.aliases = r.aliases
          created.alias = {
            name: alias,
            added: true,
            ...(r.status === 'exists' ? { message: 'already in the config' } : {}),
          }
        } catch (err) {
          created.alias = {
            name: alias,
            added: false,
            message: `${created.account.ref} was created, but the alias was not added: ${(err as Error).message}`,
          }
        }
      }
      const files = await rt.writeShellInitFiles()
      if (files.length) created.shellInitFiles = files
      created.ok = created.ok && created.alias?.added !== false && files.every((f) => f.ok)
      return created
    },
    aliasProblem(alias, ref) {
      const bad = aliasProblem(alias)
      if (bad) return `alias "${alias}" ${bad} (it becomes a shell function name)`
      const taken = config.aliases?.[alias]
      if (taken !== undefined && taken !== ref)
        return `alias "${alias}" already starts ${taken}; pick another name`
      return null
    },
    async shellInitScript() {
      return shellInitScript(await accounts(), config.aliases)
    },
    async writeShellInitFiles(shells = SHELLS) {
      const out: ShellInitWrite[] = []
      for (const shell of shells) {
        const file = config.shellInitFile?.[shell]
        if (file) out.push(await writeShellInitFile(shell, file, paths.home, await rt.shellInitScript(shell)))
      }
      return out
    },
    async prepareLaunch(ref, userArgs, command) {
      const account = resolveRef(ref, await accounts(), config.aliases)
      return prepareLaunch({
        account,
        family: familyOf(account.family),
        baseEnv: env,
        accountArgs: config.accounts?.[account.ref]?.args ?? [],
        userArgs,
        command,
        bus,
      })
    },
    async quota(account) {
      if (account.kind === 'api') return { status: 'unavailable', reason: 'api-account' }
      const f = familyOf(account.family)
      if (!f.readQuota) return { status: 'unavailable', reason: 'no-source' }
      try {
        return await f.readQuota(account, readContext())
      } catch (err) {
        return { status: 'unavailable', reason: 'unrecognized', detail: (err as Error).message }
      }
    },
    async usage(account) {
      const f = familyOf(account.family)
      if (!f.readUsage) return { status: 'unavailable', reason: 'no-source' }
      try {
        return await f.readUsage(account, readContext())
      } catch (err) {
        return { status: 'unavailable', reason: 'unrecognized', detail: (err as Error).message }
      }
    },
    readContext,
  }
  return rt
}
