// The one service layer the CLI and the Panel share. Frozen contract for v0.1 (plan: 审核修订).

import { type AccountRefError, aliasesByAccount, discoverAccounts, resolveRef } from './core/accounts.ts'
import {
  type AliasValue,
  addConfigAlias,
  aliasAccount,
  aliasArgs,
  aliasProblem,
  aliasRefs,
  type Config,
  loadConfig,
  removeConfigAlias,
} from './core/config.ts'
import { type CreateResult, createAccount } from './core/create.ts'
import { applyFixes, type DoctorReport, runDoctor } from './core/doctor.ts'
import { UserError } from './core/errors.ts'
import { type HandoffPlan, planHandoff } from './core/handoff.ts'
import { identityOf } from './core/identity.ts'
import {
  type DoctorHistory,
  type DoctorScope,
  mergeDoctorHistory,
  readDoctorHistory,
  writeDoctorHistory,
} from './core/last-doctor.ts'
import { type HostLaunch, type PreparedLaunch, prepareLaunch, which } from './core/launch.ts'
import { type Paths, resolvePaths } from './core/paths.ts'
import { findResumeRoute } from './core/resume.ts'
import { shareMeaning } from './core/share-meaning.ts'
import {
  SHELLS,
  type Shell,
  type ShellInitWrite,
  shellInitScript,
  writeShellInitFile,
} from './core/shell-init.ts'
import { packageVersion } from './core/version.ts'
import { BUILTIN_PLUGINS } from './families/index.ts'
import { HookBus } from './plugins/bus.ts'
import { type BuiltinPlugin, type LoadedPlugin, loadPlugins, type PluginLoadError } from './plugins/loader.ts'
import type {
  Account,
  AccountIdentity,
  Env,
  FamilyDef,
  LoginState,
  QuotaResult,
  QuotaSetupPlan,
  ReadContext,
  ShareMode,
  UsageResult,
} from './types.ts'

export type { AccountIdentity, AccountRefError, DoctorHistory, Shell, ShellInitWrite }

/** How `sideby resume` starts the Host (spec §3.15). */
export interface ResumeLaunch {
  launch: HostLaunch
  /** The session the Host arguments resume by id, when they name one. */
  sessionId?: string
  /** Set when the session lives in a non-main Account and `launch` starts that Account as `run` would. */
  account?: Account
}

/** What happened to the alias asked for with a new Account. */
export interface AliasResult {
  name: string
  /** True when the config now maps the alias to the new Account (also when it already did). */
  added: boolean
  message?: string
}

/** What `sideby alias add|rm` did; `ok` is false when a shell-init file was not rewritten. */
export interface AliasEditResult {
  ok: boolean
  alias: string
  status: 'added' | 'exists' | 'removed' | 'absent'
  /** The Account ref the alias starts (for `rm`, started before it was removed). */
  account?: string
  /** Host arguments the alias adds to `sideby run`; absent when there are none. */
  args?: string[]
  /** One entry per file in config `shellInitFile`; absent when none is configured. */
  shellInitFiles?: ShellInitWrite[]
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

/** One Shared Item as `sideby families` reports it (spec §3.16). */
export interface SharedItemInfo {
  path: string
  mode: ShareMode
  key?: string
  mainPath?: string
  credential?: boolean
  noSymlink?: boolean
  /** `family` from the FamilyDef, `config` from `extraSharedItems`. */
  source: 'family' | 'config'
  /** What the item looks like in an Account, in one fixed sentence. */
  meaning: string
}

/** A Family's facts for agents and docs: FamilyInfo plus layout, sign-in, sources and Shared Items (spec §3.16). */
export interface FamilyDetail extends FamilyInfo {
  /** Relative to HOME: `{ main: '.claude', account: '.claude-<name>' }`. */
  layout: { main: string; account: string }
  selectVar: string
  /** `args` is null when sign-in happens inside the Host. */
  login: { args: string[] | null; hint: string }
  quota: boolean
  usage: boolean
  quotaSetup: boolean
  shared: SharedItemInfo[]
}

export interface AccountStatus extends Account {
  familyTitle: string
  hostInstalled: boolean
  /** `not-needed` for API Accounts, which authenticate with their Secret File. */
  login: LoginState | 'not-needed'
  model?: string
  /** Who the Account is signed in as (email, organization), when its Family can tell. */
  identity?: AccountIdentity
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
  /** Every loaded Family with its layout, sign-in, quota support and Shared Items (config extras included). */
  familyDetails(): Promise<FamilyDetail[]>
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
  /**
   * Adds a short command for an existing Account (`target` is a ref, a unique name or an alias, saved as the ref),
   * with Host arguments for `sideby run`, then rewrites every `shellInitFile`. Refuses a taken name.
   */
  addAlias(alias: string, target: string, args?: readonly string[]): Promise<AliasEditResult>
  /** Removes a short command from the config, then rewrites every `shellInitFile`. */
  removeAlias(alias: string): Promise<AliasEditResult>
  /** Why `alias` cannot start `ref` (shell-safe, not reserved, not taken by another Account), or null. */
  aliasProblem(alias: string, ref: string): string | null
  /** What `sideby shell-init <shell>` prints, from the Accounts on disk and the config aliases. */
  shellInitScript(shell: Shell): Promise<string>
  /** Rewrites the configured `shellInitFile` of each shell (all configured ones by default). */
  writeShellInitFiles(shells?: readonly Shell[]): Promise<ShellInitWrite[]>
  prepareLaunch(ref: string, userArgs: readonly string[], command: 'run' | 'login'): Promise<PreparedLaunch>
  /**
   * Starts the non-main Account that holds the session the Host arguments resume, or else the Host unchanged
   * (spec §3.15). Throws UnknownFamilyError, or a UserError when the Family cannot route sessions.
   */
  resumeLaunch(familyId: string, userArgs: readonly string[]): Promise<ResumeLaunch>
  quota(account: Account): Promise<QuotaResult>
  usage(account: Account): Promise<UsageResult>
  /**
   * Which Account of a Family to move on to (spec §3.13). Throws a UserError with code `no-quota-source`
   * when the Family cannot tell, `no-accounts` when it has none.
   */
  handoff(familyId: string, opts?: { includeApi?: boolean }): Promise<HandoffPlan>
  readContext(): ReadContext
}

export class UnknownFamilyError extends UserError {}

/**
 * A Family's identity reader, kept to the identity fields with the expected types. A reader that throws, or returns
 * anything else, gives undefined: identity is a display nicety and never a problem of the Account.
 */
async function readIdentity(f: FamilyDef, account: Account): Promise<AccountIdentity | undefined> {
  if (!f.identity || account.kind === 'api') return undefined
  try {
    const r = await f.identity(account)
    return identityOf(r?.email, r?.org)
  } catch {
    return undefined
  }
}

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

  /**
   * `SIDEBY_LABEL` for a Launch: the alias it was started through; else the Account's aliases, those without Host
   * arguments first, then by name; else the ref.
   */
  const launchLabel = (ref: string, account: Account, all: readonly Account[]): string => {
    if (!ref.includes(':') && ownAlias(ref) !== undefined) return ref
    const names = aliasesByAccount(aliasRefs(config.aliases), all).get(account.ref) ?? []
    const plain = names.filter((n) => aliasArgs(ownAlias(n)).length === 0)
    return plain[0] ?? names[0] ?? account.ref
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

  /** The config value of the alias `name`, from own keys only (`constructor` is not an alias unless configured). */
  const ownAlias = (name: string): AliasValue | undefined =>
    config.aliases && Object.hasOwn(config.aliases, name) ? config.aliases[name] : undefined
  /** The config value of `ref` when it names an alias (no colon), as `resolveRef` reads it. */
  const aliasValue = (ref: string): AliasValue | undefined => (ref.includes(':') ? undefined : ownAlias(ref))

  const aliasEdit = async (
    alias: string,
    status: AliasEditResult['status'],
    value: AliasValue | undefined,
  ): Promise<AliasEditResult> => {
    const args = aliasArgs(value)
    const files = await rt.writeShellInitFiles()
    return {
      ok: files.every((f) => f.ok),
      alias,
      status,
      ...(value === undefined ? {} : { account: aliasAccount(value) }),
      ...(args.length ? { args } : {}),
      ...(files.length ? { shellInitFiles: files } : {}),
    }
  }

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
    async familyDetails() {
      const info = new Map((await rt.familyInfo()).map((f) => [f.id, f]))
      return [...families.values()].map((f) => {
        // The merged list holds the config's own objects, so identity tells which ones came from `extraSharedItems`.
        const fromConfig = new Set<unknown>(config.extraSharedItems?.[f.id] ?? [])
        return {
          ...info.get(f.id)!,
          layout: { main: f.layout.main, account: f.layout.account },
          selectVar: f.selectVar,
          login: { args: f.login.args ? [...f.login.args] : null, hint: f.login.hint },
          quota: Boolean(f.readQuota),
          usage: Boolean(f.readUsage),
          quotaSetup: Boolean(f.quotaSetup),
          shared: f.sharedItems.map((item) => ({
            path: item.path,
            mode: item.mode,
            ...(item.key ? { key: item.key } : {}),
            ...(item.mainPath ? { mainPath: item.mainPath } : {}),
            ...(item.credential ? { credential: true } : {}),
            ...(item.noSymlink ? { noSymlink: true } : {}),
            source: fromConfig.has(item) ? ('config' as const) : ('family' as const),
            meaning: shareMeaning(item),
          })),
        }
      })
    },
    accounts,
    async resolve(ref) {
      return resolveRef(ref, await accounts(), aliasRefs(config.aliases))
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
      const [installed, login, model, identity] = await Promise.all([
        which(f.bin, env),
        account.kind === 'api'
          ? undefined
          : safe('login state', f.loginState && (() => f.loginState!(account))),
        safe('model', f.model && (() => f.model!(account))),
        readIdentity(f, account),
      ])
      return {
        ...account,
        familyTitle: f.title,
        hostInstalled: installed !== null,
        login: account.kind === 'api' ? 'not-needed' : (login ?? 'unknown'),
        ...(model ? { model } : {}),
        ...(identity ? { identity } : {}),
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
          const one = resolveRef(o.target, list, aliasRefs(config.aliases))
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
        // Checked for every Family in the run, also when Doctor is aimed at one Account, so the saved result
        // of that Family keeps its skill warning.
        skillVersion: packageVersion(),
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
          // An alias that already starts this Account keeps its arguments; creating the Account does not change them.
          const r = await addConfigAlias(
            paths.configFile,
            alias,
            created.account.ref,
            aliasArgs(ownAlias(alias)),
          )
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
    async addAlias(alias, target, args = []) {
      const bad = aliasProblem(alias)
      if (bad) throw new UserError(`alias "${alias}" ${bad} (it becomes a shell function name)`)
      // Resolve first so the config only ever names an Account that exists, by its ref.
      const account = resolveRef(target, await accounts(), aliasRefs(config.aliases))
      const r = await addConfigAlias(paths.configFile, alias, account.ref, args)
      config.aliases = r.aliases
      return aliasEdit(alias, r.status, r.aliases[alias])
    },
    async removeAlias(alias) {
      const before = ownAlias(alias)
      const r = await removeConfigAlias(paths.configFile, alias)
      config.aliases = r.aliases
      return aliasEdit(alias, r.status, r.status === 'removed' ? before : undefined)
    },
    aliasProblem(alias, ref) {
      const bad = aliasProblem(alias)
      if (bad) return `alias "${alias}" ${bad} (it becomes a shell function name)`
      const value = ownAlias(alias)
      const taken = value === undefined ? undefined : aliasAccount(value)
      if (taken !== undefined && taken !== ref)
        return `alias "${alias}" already starts ${taken}; pick another name`
      return null
    },
    async shellInitScript() {
      const list = await accounts()
      // Routing helps only a Family that can route and has somewhere else to route to (spec §3.15).
      const routes = config.resumeRouting
        ? [...families.values()]
            .filter(
              (f) =>
                f.resumedSession && f.sessionWrittenAt && list.some((a) => a.family === f.id && !a.isMain),
            )
            .map((f) => ({ family: f.id, bin: f.bin, selectVar: f.selectVar }))
        : []
      return shellInitScript(list, config.aliases, routes)
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
      const all = await accounts()
      const account = resolveRef(ref, all, aliasRefs(config.aliases))
      return prepareLaunch({
        label: launchLabel(ref, account, all),
        title: config.accountTitle === true,
        account,
        family: familyOf(account.family),
        baseEnv: env,
        accountArgs: config.accounts?.[account.ref]?.args ?? [],
        // An alias's arguments come before the user's; the Family sees both as the user's choice (ADR-0005).
        userArgs: command === 'run' ? [...aliasArgs(aliasValue(ref)), ...userArgs] : userArgs,
        command,
        bus,
      })
    },
    async resumeLaunch(familyId, userArgs) {
      const family = familyOf(familyId)
      if (!family.resumedSession || !family.sessionWrittenAt)
        throw new UserError(
          `${family.title} sessions cannot be routed; start an account yourself with \`sideby run <account> -- …\``,
        )
      const host: HostLaunch = { family, bin: family.bin, args: [...userArgs], env }
      // A select variable already set means an Account was chosen on purpose: run the Host as it is.
      if (env[family.selectVar]) return { launch: host }
      const route = await findResumeRoute(family, await accounts(), userArgs)
      const id = route.sessionId ? { sessionId: route.sessionId } : {}
      if (!route.account || route.account.isMain) return { launch: host, ...id }
      return {
        launch: await rt.prepareLaunch(route.account.ref, userArgs, 'run'),
        ...id,
        account: route.account,
      }
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
    async handoff(familyId, o = {}) {
      const f = familyOf(familyId)
      const list = (await accounts()).filter((a) => a.family === f.id)
      if (!f.readQuota)
        throw new UserError(
          `${f.title} has no public quota source, so sideby cannot tell which account has room; pick one yourself: ${
            list.map((a) => `sideby run ${a.ref}`).join(', ') || `sideby new ${f.id} <name>`
          }`,
          { code: 'no-quota-source' },
        )
      if (list.length === 0)
        throw new UserError(`no ${f.title} accounts yet; create one with \`sideby new ${f.id} <name>\``, {
          code: 'no-accounts',
        })
      // Only the login state and Quota: no identity, model or Host lookups are needed to rank.
      const loginOf = async (a: Account): Promise<LoginState | 'not-needed'> => {
        if (a.kind === 'api') return 'not-needed'
        try {
          return (await f.loginState?.(a)) ?? 'unknown'
        } catch {
          return 'unknown'
        }
      }
      const candidates = await Promise.all(
        list.map(async (a) => {
          const [login, quota] = await Promise.all([loginOf(a), rt.quota(a)])
          return { ref: a.ref, name: a.name, isMain: a.isMain, kind: a.kind, login, quota }
        }),
      )
      return planHandoff(f.id, candidates, readContext().now, o)
    },
    readContext,
  }
  return rt
}
