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
  type DisplayConfig,
  editConfigDisplay,
  editConfigQuotaCheck,
  type HandoffSettings,
  handoffSettings,
  loadConfig,
  removeConfigAlias,
} from './core/config.ts'
import { type CreateResult, createAccount } from './core/create.ts'
import { bindDesktopDeps, checkAppData, type DesktopDeps } from './core/desktop-app.ts'
import { applyFixes, type DoctorReport, runDoctor } from './core/doctor.ts'
import { UserError } from './core/errors.ts'
import { type HandoffPlan, planHandoff } from './core/handoff.ts'
import { handoffFindings } from './core/handoff-doctor.ts'
import { type HandoffDecision, type SelectCandidate, selectNext } from './core/handoff-select.ts'
import { identityOf } from './core/identity.ts'
import {
  type DoctorHistory,
  type DoctorScope,
  mergeDoctorHistory,
  readDoctorHistory,
  writeDoctorHistory,
} from './core/last-doctor.ts'
import {
  accountEnv,
  brokenOnPath,
  type HostLaunch,
  type PreparedLaunch,
  prepareLaunch,
  which,
} from './core/launch.ts'
import { memoStore } from './core/memo-store.ts'
import { type Paths, resolvePaths } from './core/paths.ts'
import { fetchedQuota, type QuotaFetchMode, quotaCheckOff, shownQuota } from './core/quota-fetch.ts'
import {
  type RemoteControlChange,
  type RemoteControlGroup,
  remoteControlGroups,
  turnRemoteControlOff,
  turnRemoteControlOn,
  undoRemoteControlOff,
} from './core/remote-control.ts'
import { findResumeRoute } from './core/resume.ts'
import { SAME_LOGIN_FAMILIES, sameLoginGroups, sharedQuota } from './core/same-login.ts'
import { shareMeaning } from './core/share-meaning.ts'
import {
  SHELLS,
  type Shell,
  type ShellInitWrite,
  shellInitScript,
  writeShellInitFile,
} from './core/shell-init.ts'
import {
  groupSuggestion,
  MAX_COMPACT_WINDOW,
  MIN_COMPACT_WINDOW,
  type TuneEntry,
  type TuneGroup,
} from './core/tuning.ts'
import {
  applyTune,
  planTuneApply,
  readTuneSettings,
  settingsFileOf,
  type TuneApplyPlan,
  type TuneChange,
  type TuneUndoRecord,
  tuneUndoInfo,
  undoTune,
} from './core/tuning-apply.ts'
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
  QuotaSetup,
  QuotaSetupPlan,
  ReadContext,
  ShareMode,
  TuningResult,
  UsageResult,
} from './types.ts'

export type { AccountIdentity, AccountRefError, DoctorHistory, Shell, ShellInitWrite }

/** How `sideby resume` starts the Host (spec §3.15). */
export interface ResumeLaunch {
  launch: HostLaunch
  /** The session the Host arguments resume by id, when they name one. */
  sessionId?: string
  /**
   * Set when the session lives in a non-main Account and `launch` starts that Account as `run` would, or with
   * `newSession` the Account (main included) that started a session the Host never saved.
   */
  account?: Account
  /** Set when the session was never saved: `launch` starts a new session in `account` without the resume (ADR-0009). */
  newSession?: true
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
  installCommand?: string
  installed: boolean
  /** A `bin` on PATH that exists but cannot run (an interrupted upgrade); set only when `installed` is false. */
  brokenBin?: string
  /** Plugin that provides the Family. */
  plugin: string
  /** The Family can estimate a Compaction Threshold (spec §3.18). */
  tuning: boolean
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
  /**
   * The other Accounts signed in as the same login, which share its Quota (spec §3.21); absent when there are none.
   */
  sameLogin?: string[]
  /** Pinned to the top of its Family (spec §3.25); set by `sideby list` only, absent when not pinned. */
  pinned?: true
  /** Plugin errors met while reading this Account (for example an unreadable settings file). */
  problems?: string[]
  /**
   * The Family's Desktop App for this Account (spec §3.20): macOS only, Subscription Accounts of claude and codex.
   * Filled by `sideby list` and the Panel, which list processes once for all Accounts; `status()` leaves it out.
   */
  desktopApp?: { app: string; installed: boolean; running: boolean }
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
  /** One Family's handoff hook setup (spec §3.17, Grok); throws a UserError when the Family needs none. */
  handoffSetup(familyId: string): BoundQuotaSetup
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
  /**
   * The Account's Quota. For an Account of a Same Login (spec §3.21) it is the group's freshest reading, with `from`
   * naming the Account it was read from when that is another one.
   */
  quota(account: Account, opts?: { fetch?: QuotaFetchMode }): Promise<QuotaResult>
  /**
   * Asks every Family that fetches Quota (spec §3.26) again now, for `only` or every signed-in subscription Account,
   * and waits for the answers. Fetching that is turned off stays off.
   */
  refreshQuota(only?: readonly Account[]): Promise<void>
  /** Families that fetch Quota, with their switch (config `quota.check.<family>`) and why it is off, if it is. */
  quotaChecks(): QuotaCheckInfo[]
  /** Turns a Family's Quota fetching on (removes the key) or off (`quota.check.<family>: false`). */
  setQuotaCheck(family: string, on: boolean): Promise<{ changed: boolean }>
  /** The config `display` (spec §3.25), or an empty object. */
  displayOrder(): DisplayConfig
  /** Replaces the config `display`; undefined or empty removes it. Returns what the file now holds. */
  setDisplayOrder(display: DisplayConfig | undefined): Promise<DisplayConfig>
  /** The other Accounts signed in as the same login as this one (spec §3.21), in discovery order; empty when none. */
  sameLogin(account: Account): Promise<string[]>
  usage(account: Account): Promise<UsageResult>
  /** Estimated Compaction Threshold per model for one Account (spec §3.18); read-only. */
  tuning(account: Account): Promise<TuningResult>
  /** Suggestions grouped by settings file (Accounts sharing a file share one), with every listed Account's details. */
  tuneGroups(only?: Account): Promise<{ accounts: TuneEntry[]; groups: TuneGroup[] }>
  /** What using a suggested size would change in the Account's settings; writes nothing (spec §3.18, ADR-0012). */
  tuneApplyPlan(account: Account, value: number | null): Promise<TuneApplyPlan>
  /** Writes the size into the Account's settings (one key; null goes back to the default), and remembers how to undo it. */
  tuneApply(account: Account, value: number | null): Promise<TuneChange>
  /** Puts the setting back as it was, only while it still holds what sideby wrote. */
  tuneUndo(account: Account): Promise<{ ok: boolean; message: string }>
  /** What could be undone for the Account, or null. */
  tuneUndoInfo(account: Account): Promise<TuneUndoRecord | null>
  /** Whether each Claude settings file starts Remote Control by itself (spec §3.22, ADR-0017); grouped by file. */
  remoteControl(): Promise<RemoteControlGroup[]>
  /** Sets `remoteControlAtStartup` to false wherever it is on or left to the default, remembering how to undo it. */
  remoteControlOff(): Promise<RemoteControlChange>
  /** Sets `remoteControlAtStartup` to true wherever it is off or left to the default, remembering how to undo it. */
  remoteControlOn(): Promise<RemoteControlChange>
  /** Puts back what `remoteControlOff` or `remoteControlOn` replaced, only where the key still holds what it wrote. */
  remoteControlUndo(): Promise<RemoteControlChange>
  /**
   * Which Account of a Family to move on to (spec §3.13). Throws a UserError with code `no-quota-source`
   * when the Family cannot tell, `no-accounts` when it has none.
   */
  handoff(familyId: string, opts?: { includeApi?: boolean }): Promise<HandoffPlan>
  /** The config `handoff` settings with every default filled in (spec §3.17). */
  handoffSettings(): HandoffSettings
  /**
   * Where an Auto Handoff from `origin` would go now (spec §3.17 "选号"): every Account of every Family is a
   * candidate; `used` lists the chain's Accounts so far. `ahead` decides early what happens once the origin's fullest
   * window reaches the threshold, as plan.json and the Panel need. `to` names the only candidate (`handoff ready --to`);
   * `manual` (`handoff ready`) never waits for a reset.
   */
  handoffDecision(
    origin: Account,
    used: readonly string[],
    opts?: { ahead?: boolean; to?: string; manual?: boolean },
  ): Promise<HandoffDecision>
  readContext(): ReadContext
}

export class UnknownFamilyError extends UserError {}

export interface QuotaCheckInfo {
  family: string
  title: string
  summary: string
  everyMinutes: number
  /** False when config `quota.check.<family>` is false. */
  on: boolean
  /** Why no fetch happens even though it is on (CI), or undefined. */
  blocked?: string
}

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
  opts: {
    env?: Env
    builtins?: BuiltinPlugin[]
    now?: () => Date
    /**
     * Internal, for tests: replaces the machine the Desktop App calls use (platform, app folders and the programs
     * `open`, `ps`, `osascript`, `plutil`, `mdfind`; spec §3.20). Omitted, the real machine is used. Not part of
     * the plugin or Portal contract; it may change without notice.
     */
    desktop?: Partial<DesktopDeps>
  } = {},
): Promise<Runtime> {
  const env = opts.env ?? process.env
  const paths = resolvePaths(env)
  const memos = memoStore(paths.stateDir)
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

  /** Same Login groups (spec §3.21) among `list`: ref → the other refs. Only Families that group take part. */
  const groupsOf = async (list: readonly Account[]): Promise<Map<string, string[]>> => {
    const members = await Promise.all(
      list
        .filter(
          (a) => a.kind === 'subscription' && SAME_LOGIN_FAMILIES.has(a.family) && families.has(a.family),
        )
        .map(async (a) => {
          const identity = await readIdentity(familyOf(a.family), a)
          return { ref: a.ref, family: a.family, kind: a.kind, ...(identity ? { identity } : {}) }
        }),
    )
    return sameLoginGroups(members)
  }

  /** The Accounts of `account`'s Same Login, other than itself; reads only its own Family. */
  const peersOf = async (account: Account): Promise<Account[]> => {
    const f = families.get(account.family)
    if (!f || account.kind === 'api' || !SAME_LOGIN_FAMILIES.has(f.id)) return []
    const list = await discoverAccounts(f, paths.home, ignore)
    const peers = (await groupsOf(list)).get(account.ref) ?? []
    return list.filter((a) => peers.includes(a.ref))
  }

  /** Every Account's Quota as shown (shared within a Same Login), reading each Account's own cache once. */
  const quotasOf = async (
    list: readonly Account[],
    mode: QuotaFetchMode = 'wait',
  ): Promise<Map<string, QuotaResult>> => {
    const [own, groups] = await Promise.all([
      Promise.all(list.map(async (a) => [a.ref, await ownQuota(a, mode)] as const)).then((e) => new Map(e)),
      groupsOf(list),
    ])
    return new Map(list.map((a) => [a.ref, sharedQuota(a.ref, own, groups.get(a.ref) ?? [])]))
  }

  /** A reader's own `from`, `fetched` and `fetchError` are dropped: only sideby sets them (spec §3.21, §3.26). */
  const readerOnly = (q: QuotaResult): QuotaResult => {
    if (q.status !== 'ok') return q
    const { from: _from, fetched: _fetched, fetchError: _error, ...own } = q
    return own
  }

  const ownQuota = async (account: Account, mode: QuotaFetchMode = 'wait'): Promise<QuotaResult> => {
    if (account.kind === 'api') return { status: 'unavailable', reason: 'api-account' }
    const f = familyOf(account.family)
    if (!f.readQuota && !f.fetchQuota) return { status: 'unavailable', reason: 'no-source' }
    await memos.ready()
    try {
      let local: QuotaResult | null = null
      if (f.readQuota)
        try {
          local = readerOnly(await f.readQuota(account, readContext()))
        } catch (err) {
          local = { status: 'unavailable', reason: 'unrecognized', detail: (err as Error).message }
        }
      if (!f.fetchQuota) return local!
      const off = quotaCheckOff(f.id, config, env)
      // A signed-out Account has nothing to ask about; its kept answer still shows.
      const ask = off || mode === 'never' || (await loginOf(account)) === 'logged-out' ? 'never' : mode
      const kept = await fetchedQuota(f.fetchQuota, account, readContext(), accountEnv(f, account, env), ask)
      return shownQuota(local, kept, off)
    } finally {
      memos.saveSoon()
    }
  }

  const loginOf = async (a: Account): Promise<LoginState | 'not-needed'> => {
    if (a.kind === 'api') return 'not-needed'
    try {
      return (await familyOf(a.family).loginState?.(a)) ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /** A Family's one-time setup bound to this Runtime; a setup that throws is reported, never crashes the caller. */
  const bindSetup = (f: FamilyDef, setup: QuotaSetup): BoundQuotaSetup => {
    // The message is the error's own text; setup implementations must not put file contents into it.
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
          .catch((err: unknown) => ({ ok: false, message: (err as Error)?.message ?? String(err) })),
    }
  }

  // Only Claude Code has a suggestion to use; Codex only observes (spec §3.18).
  const onlyClaude = (account: Account): void => {
    if (account.family !== 'claude')
      throw new UserError(
        `${account.ref} has no suggested size to use yet: only Claude Code accounts do. Run \`sideby tune ${account.ref}\` to see what is observed`,
        { code: 'no-suggestion' },
      )
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
        [...families.values()].map(async (f) => {
          const installed = (await which(f.bin, env)) !== null
          const broken = installed ? null : await brokenOnPath(f.bin, env)
          return {
            id: f.id,
            title: f.title,
            bin: f.bin,
            installUrl: f.installUrl,
            ...(typeof f.installCommand === 'string' && f.installCommand.trim()
              ? { installCommand: f.installCommand.trim() }
              : {}),
            installed,
            ...(broken ? { brokenBin: broken } : {}),
            plugin: loaded.familyOwner.get(f.id) ?? 'unknown',
            tuning: Boolean(f.readTuning),
          }
        }),
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
          quota: Boolean(f.readQuota || f.fetchQuota),
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
      const [installed, login, model, identity, peers] = await Promise.all([
        which(f.bin, env),
        account.kind === 'api'
          ? undefined
          : safe('login state', f.loginState && (() => f.loginState!(account))),
        safe('model', f.model && (() => f.model!(account))),
        readIdentity(f, account),
        peersOf(account).catch(() => []),
      ])
      return {
        ...account,
        familyTitle: f.title,
        hostInstalled: installed !== null,
        login: account.kind === 'api' ? 'not-needed' : (login ?? 'unknown'),
        ...(model ? { model } : {}),
        ...(identity ? { identity } : {}),
        ...(peers.length ? { sameLogin: peers.map((p) => p.ref) } : {}),
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
        // Desktop App data folders sideby made for an Account (spec §3.20).
        extraChecks: (a: Account) => checkAppData(loaded.plugins, paths.home, a),
      }
      // Auto Handoff warnings (spec §3.17) join the general Findings; they never fail Doctor.
      const all = await accounts()
      const withHandoff = async (r: DoctorReport): Promise<DoctorReport> => {
        const claude = fams.get('claude')
        const extra = await handoffFindings({
          settings: handoffSettings(config),
          families: [...fams.keys()],
          accounts: all,
          aliases: aliasRefs(config.aliases),
          ...(claude?.quotaSetup
            ? { claudeTap: (await bindSetup(claude, claude.quotaSetup).plan()).status === 'enabled' }
            : {}),
          home: paths.home,
        })
        return extra.length ? { ...r, general: [...r.general, ...extra] } : r
      }
      let report = await withHandoff(await runDoctor(input))
      if (o.fix) {
        const fixes = await applyFixes(report)
        report = { ...(await withHandoff(await runDoctor(input))), fixes }
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
      if (!f.quotaSetup) throw new UserError(`${f.title} needs no quota setup`)
      return bindSetup(f, f.quotaSetup)
    },
    handoffSetup(familyId) {
      const f = familyOf(familyId)
      if (!f.handoff?.hookSetup)
        throw new UserError(
          `${f.title} needs no handoff setup: ${f.handoff?.starts.length ? 'sideby adds its hooks when it starts the account' : 'it cannot start a handoff, only take one over'}`,
        )
      return bindSetup(f, f.handoff.hookSetup)
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
      if (route.neverSaved && route.account && family.withoutResume) {
        const args = family.withoutResume(userArgs)
        const launch = route.account.isMain
          ? { ...host, args }
          : await rt.prepareLaunch(route.account.ref, args, 'run')
        return { launch, ...id, account: route.account, newSession: true }
      }
      if (!route.account || route.account.isMain || route.neverSaved) return { launch: host, ...id }
      return {
        launch: await rt.prepareLaunch(route.account.ref, userArgs, 'run'),
        ...id,
        account: route.account,
      }
    },
    async quota(account, o = {}) {
      const peers = await peersOf(account)
      if (!peers.length) return ownQuota(account, o.fetch)
      return (await quotasOf([account, ...peers], o.fetch)).get(account.ref)!
    },
    async refreshQuota(only) {
      const list = (only ?? (await accounts())).filter(
        (a) => a.kind === 'subscription' && families.get(a.family)?.fetchQuota,
      )
      await Promise.all(list.map((a) => ownQuota(a, 'force')))
    },
    quotaChecks() {
      const ci = quotaCheckOff('', {}, env)
      return [...families.values()]
        .filter((f) => f.fetchQuota)
        .map((f) => ({
          family: f.id,
          title: f.title,
          summary: f.fetchQuota!.summary,
          everyMinutes: f.fetchQuota!.everyMinutes,
          on: config.quota?.check?.[f.id] !== false,
          ...(ci ? { blocked: ci } : {}),
        }))
    },
    async setQuotaCheck(family, on) {
      if (!families.get(family)?.fetchQuota)
        throw new UserError(`${family} does not ask for quota, so there is nothing to turn on or off`)
      const r = await editConfigQuotaCheck(paths.configFile, family, on)
      config.quota = r.after
      return { changed: r.changed }
    },
    displayOrder: () => config.display ?? {},
    async setDisplayOrder(display) {
      const r = await editConfigDisplay(paths.configFile, display)
      config.display = r.after
      return r.after ?? {}
    },
    async sameLogin(account) {
      return (await peersOf(account)).map((a) => a.ref)
    },
    async usage(account) {
      const f = familyOf(account.family)
      if (!f.readUsage) return { status: 'unavailable', reason: 'no-source' }
      await memos.ready()
      try {
        return await f.readUsage(account, readContext())
      } catch (err) {
        return { status: 'unavailable', reason: 'unrecognized', detail: (err as Error).message }
      } finally {
        memos.saveSoon()
      }
    },
    async tuneGroups(only) {
      const tunable = new Set((await rt.familyInfo()).filter((f) => f.tuning).map((f) => f.id))
      const all = (await accounts()).filter((a) => tunable.has(a.family))
      const files = new Map<string, Account[]>()
      for (const a of all) {
        if (a.family !== 'claude') continue
        const file = await settingsFileOf(a)
        files.set(file, [...(files.get(file) ?? []), a])
      }
      const wanted = only
        ? [...files.entries()].filter(([, m]) => m.some((a) => a.ref === only.ref))
        : [...files.entries()]
      const entries = new Map<string, TuneEntry>()
      const entryOf = async (a: Account): Promise<TuneEntry> => {
        const have = entries.get(a.ref)
        if (have) return have
        const made = { ref: a.ref, family: a.family, tuning: await rt.tuning(a) }
        entries.set(a.ref, made)
        return made
      }
      const groups: TuneGroup[] = []
      for (const [file, members] of wanted) {
        const list: TuneEntry[] = []
        for (const m of members) list.push(await entryOf(m))
        const pick = groupSuggestion(list)
        const { current, overrides } = await readTuneSettings(members[0] as Account)
        const target = members.find((m) => m.ref === pick?.ref) ?? (members[0] as Account)
        const undo = await tuneUndoInfo(target, readContext())
        groups.push({
          file,
          members: members.map((m) => m.ref),
          target: target.ref,
          current,
          outOfRange: current !== null && (current < MIN_COMPACT_WINDOW || current > MAX_COMPACT_WINDOW),
          overrides,
          pick,
          undo: undo ? { value: undo.applied, previous: undo.previous } : null,
        })
      }
      const shown: TuneEntry[] = []
      // Asking about one Account also lists the others that share its file: the suggestion is for the whole group.
      const refs = only ? new Set([only.ref, ...wanted.flatMap(([, m]) => m.map((a) => a.ref))]) : null
      for (const a of all) if (!refs || refs.has(a.ref)) shown.push(await entryOf(a))
      return { accounts: shown, groups }
    },
    async tuneApplyPlan(account, value) {
      onlyClaude(account)
      return planTuneApply(account, value, await accounts())
    },
    async tuneApply(account, value) {
      onlyClaude(account)
      return applyTune(account, value, await accounts(), readContext())
    },
    async tuneUndo(account) {
      onlyClaude(account)
      return undoTune(account, readContext())
    },
    async remoteControl() {
      return remoteControlGroups(await accounts(), readContext())
    },
    async remoteControlOff() {
      return turnRemoteControlOff(await accounts(), readContext())
    },
    async remoteControlOn() {
      return turnRemoteControlOn(await accounts(), readContext())
    },
    async remoteControlUndo() {
      return undoRemoteControlOff(await accounts(), readContext())
    },
    async tuneUndoInfo(account) {
      return account.family === 'claude' ? tuneUndoInfo(account, readContext()) : null
    },
    async tuning(account) {
      const f = familyOf(account.family)
      if (!f.readTuning) return { status: 'unavailable', reason: 'no-source' }
      await memos.ready()
      try {
        return await f.readTuning(account, readContext())
      } catch (err) {
        return { status: 'unavailable', reason: 'unrecognized', detail: (err as Error).message }
      } finally {
        memos.saveSoon()
      }
    },
    async handoff(familyId, o = {}) {
      const f = familyOf(familyId)
      const list = (await accounts()).filter((a) => a.family === f.id)
      if (!f.readQuota && !f.fetchQuota)
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
      // Login state, Quota and Same Login (spec §3.21): no model or Host lookups are needed to rank.
      const [quotas, groups] = await Promise.all([quotasOf(list), groupsOf(list)])
      const candidates = await Promise.all(
        list.map(async (a) => {
          const peers = groups.get(a.ref)
          return {
            ref: a.ref,
            name: a.name,
            isMain: a.isMain,
            kind: a.kind,
            login: await loginOf(a),
            quota: quotas.get(a.ref)!,
            ...(peers ? { sameLogin: peers } : {}),
          }
        }),
      )
      // The current Account: the one sideby started this process from, when it belongs to this Family.
      const current = env.SIDEBY_ACCOUNT
      const from = current && list.some((a) => a.ref === current) ? current : undefined
      return planHandoff(f.id, candidates, readContext().now, { ...o, ...(from ? { from } : {}) })
    },
    handoffSettings: () => handoffSettings(config),
    async handoffDecision(origin, used, opts = {}) {
      const all = await accounts()
      const [quotas, groups] = await Promise.all([quotasOf(all), groupsOf(all)])
      const candidates = await Promise.all(
        all.map(async (a): Promise<SelectCandidate> => {
          const f = familyOf(a.family)
          const quota = quotas.get(a.ref)!
          const peers = groups.get(a.ref)
          const [installed, login, identity] = await Promise.all([
            which(f.bin, env),
            loginOf(a),
            readIdentity(f, a),
          ])
          let receive = false
          try {
            receive = Boolean(
              f.handoff &&
                (await f.handoff.eligibility(config.accounts?.[a.ref]?.args ?? [], a, env)).receive,
            )
          } catch {
            // a Family that cannot tell does not take over
          }
          return {
            ref: a.ref,
            family: a.family,
            name: a.name,
            isMain: a.isMain,
            kind: a.kind,
            login,
            quota,
            ...(identity ? { identity } : {}),
            ...(peers ? { sameLogin: peers } : {}),
            installed: installed !== null,
            receive,
          }
        }),
      )
      const self = candidates.find((c) => c.ref === origin.ref)
      if (!self) throw new UserError(`${origin.ref} is not an account sideby can find; run \`sideby list\``)
      try {
        self.resumesAtReset = (await familyOf(origin.family).handoff?.resumesAtReset?.(origin)) === true
      } catch {
        // cannot tell: do not wait
      }
      return selectNext({
        origin: self,
        candidates,
        settings: handoffSettings(config),
        aliases: aliasRefs(config.aliases),
        used,
        now: now(),
        ...(opts.ahead ? { ahead: true } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.manual ? { manual: true } : {}),
      })
    },
    readContext,
  }
  if (opts.desktop) bindDesktopDeps(rt, opts.desktop)
  return rt
}
