// Public contract shared by sideby core, built-in Families and third-party Plugins.
// Plugins may only `import type` from this module (ADR-0002); values reach them through PluginApi.

export type ShareMode =
  | 'link'
  | 'copy'
  | 'link-or-copy'
  | 'link-or-local'
  | 'local'
  | 'local-if-api'
  | 'info'
  | 'json-key'

export interface SharedItemDef {
  /** Path inside the Account directory, for example `skills` or `.claude.json`. */
  path: string
  mode: ShareMode
  /** Main-side source relative to HOME, when it does not live in the Main Account directory (`.claude.json`). */
  mainPath?: string
  /** For `json-key`: the top-level key mirrored from the main file. */
  key?: string
  /** The Host refuses to start when this path is a symlink (Grok sandbox). */
  noSymlink?: boolean
  /** Holds credentials: must be a regular file with mode 600. Contents are never read. */
  credential?: boolean
  /** Host message quoted when the item breaks a Host rule. */
  hostMessage?: string
}

export interface FamilyLayout {
  /** Main Account directory relative to HOME, for example `.claude` or `.pi/agent`. */
  main: string
  /** Other Accounts relative to HOME, with `<name>` in the first path segment: `.claude-<name>`, `.pi-<name>/agent`. */
  account: string
}

export type LoginState = 'logged-in' | 'logged-out' | 'unknown'

/**
 * A Family's mark for the Panel: one SVG path in a 24x24 view box, drawn inline. sideby checks it when the
 * Plugin registers; an invalid logo is dropped with a plugin error and the Panel shows the Family's initials.
 */
export interface FamilyLogo {
  /** SVG path data: only commands, numbers, spaces, commas, dots, `+` and `-`. At most 20000 characters. */
  path: string
  /** Hex brand color such as `#D97757`. Without one the mark uses the text color, so it works in light and dark mode. */
  color?: string
  /** Name of the mark for tooltips; defaults to the Family title. */
  title?: string
  fillRule?: 'nonzero' | 'evenodd'
}

export interface FamilyDef {
  id: string
  title: string
  /** Mark shown on the Panel's cards, lists and the Tool select; without one the Panel shows the id's initials. */
  logo?: FamilyLogo
  /** Host executable looked up on PATH. */
  bin: string
  installUrl: string
  /** Environment variable that selects the Account directory. Not set for the Main Account. */
  selectVar: string
  layout: FamilyLayout
  /**
   * Entries that prove a directory is this Family's Account (besides a Secret File or an empty directory).
   * Defaults to the Shared Item paths; set it when a shared name is generic, like Claude's `plugins`.
   */
  markers?: string[]
  /**
   * Whether a Secret File makes an Account an API Account (default true). pi keeps `proxy.env` in every
   * Account for provider keys, so for pi it is loaded at Launch but says nothing about the login.
   */
  secretFileMeansApi?: boolean
  /** Cleared before every Launch, for every Account. */
  hijackVars: string[]
  /** Variables written, commented out, into a new API Account's Secret File. */
  apiVars: string[]
  sharedItems: SharedItemDef[]
  /** Arguments for the Host's sign-in command, or null when sign-in happens inside the Host. */
  login: { args: string[] | null; hint: string }
  /** Arguments sideby adds before the Account's and the user's arguments. */
  defaultArgs?(account: Account, userArgs: readonly string[]): string[]
  loginState?(account: Account): Promise<LoginState>
  model?(account: Account): Promise<string | undefined>
  /**
   * Who the Account is signed in as, from the Host's own login file: identity fields such as the email and the
   * organization only, never a token or any other credential value (ADR-0003). Return undefined when unknown; an
   * error is treated the same way and never shown as a problem.
   */
  identity?(account: Account): Promise<AccountIdentity | undefined>
  readQuota?(account: Account, ctx: ReadContext): Promise<QuotaResult>
  readUsage?(account: Account, ctx: ReadContext): Promise<UsageResult>
  /** One-time, reversible change that lets the Host report Quota (Claude: status line wrapper). */
  quotaSetup?: QuotaSetup
}

/** Identity fields of a signed-in Account. */
export interface AccountIdentity {
  email?: string
  /** Organization or team, when it is not just the personal default. */
  org?: string
}

export interface QuotaSetupPlan {
  /** `enabled`: already on; `ready`: apply would make `diff`; `blocked`: cannot apply, see `message`. */
  status: 'enabled' | 'ready' | 'blocked'
  /** File the change touches. */
  file: string
  /** Unified diff of the change, empty when nothing would change. */
  diff: string
  message: string
}

export interface QuotaSetup {
  /** One sentence shown before the user confirms. */
  summary: string
  plan(ctx: ReadContext): Promise<QuotaSetupPlan>
  /** Re-plans and applies only when the plan is `ready`. */
  apply(ctx: ReadContext): Promise<QuotaSetupPlan>
  /** Restores the original bytes only if the file is still exactly what `apply` wrote. */
  teardown(ctx: ReadContext): Promise<{ ok: boolean; message: string; diff?: string }>
}

export interface Account {
  family: string
  /** `main` for the Main Account. */
  name: string
  /** `<family>:<name>` */
  ref: string
  dir: string
  isMain: boolean
  kind: 'subscription' | 'api'
  /** Path of the Secret File for API Accounts. */
  secretFile?: string
}

export interface ReadContext {
  home: string
  now: Date
  /** sideby state directory (quota caches live here). */
  stateDir: string
  /** sideby's own environment (PATH lookups); never the Host's. */
  env: Env
}

export interface QuotaWindow {
  /** `5h`, `7d`, or `<n>m` for unknown window lengths. */
  label: string
  windowMinutes: number
  usedPercent: number
  /** ISO timestamp. */
  resetsAt: string
}

export type QuotaUnavailableReason =
  | 'not-enabled'
  | 'no-session'
  | 'unrecognized'
  | 'no-source'
  | 'api-account'

export type QuotaResult =
  | { status: 'ok'; windows: QuotaWindow[]; observedAt: string; source: string; plan?: string }
  | { status: 'unavailable'; reason: QuotaUnavailableReason; detail?: string }

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export type UsageResult =
  | ({
      status: 'ok'
      days: number
      sessions: number
      /**
       * Tokens per local calendar day (`YYYY-MM-DD`), `days` entries ending today, oldest first, days without
       * records as 0. It can sum to less than `totalTokens`, which also covers the part of the oldest day
       * inside the rolling window.
       */
      daily?: { date: string; totalTokens: number }[]
      /** ISO time of the newest record the reader saw, not later than now. */
      lastActivityAt?: string
    } & TokenTotals)
  | { status: 'unavailable'; reason: 'no-source' | 'no-session' | 'unrecognized'; detail?: string }

export type FindingLevel = 'ok' | 'warn' | 'fail'

export interface FixResult {
  ok: boolean
  message: string
}

export interface Finding {
  level: FindingLevel
  /** Account ref the Finding is about. */
  account: string
  /** Shared Item path or check name. */
  item: string
  /** Stable machine code such as `link.real-file`. */
  code: string
  message: string
  /** What the user should do; never contains credential values. */
  hint?: string
  /** `core` or the Plugin name. */
  source: string
  fixable: boolean
  /** Present when `fixable`; not serialized. */
  fix?: () => Promise<FixResult>
}

/** What a `doctor.check` hook returns; sideby fills `account` and `source`. */
export type CheckResult = Omit<Finding, 'account' | 'source' | 'fixable'> & { fixable?: boolean }

export type Env = Record<string, string | undefined>

export interface LaunchContext {
  account: Account
  family: FamilyDef
  /** Environment the Host will receive; mutate to change it. */
  env: Env
  /** Arguments the Host will receive; mutate to change them. */
  args: string[]
  config: Record<string, unknown>
  /** `run` or `login`. */
  command: 'run' | 'login'
}

export interface CreateBeforeContext {
  family: FamilyDef
  /** Name of the Account about to be created, already checked against the name rules. */
  name: string
  /** Whether it will be an API Account (`sideby new --api`, or "API key account" in the Panel). */
  api: boolean
  /** The Family's existing Accounts, the Main Account included. */
  accounts: Account[]
  config: Record<string, unknown>
}

export interface CreatedContext {
  account: Account
  family: FamilyDef
  config: Record<string, unknown>
  log(message: string): void
}

export interface DoctorContext {
  account: Account
  family: FamilyDef
  config: Record<string, unknown>
}

export interface HookFilter {
  family?: string
}

export interface HookEvents {
  'launch.before': { ctx: LaunchContext; result: void }
  'account.create.before': { ctx: CreateBeforeContext; result: void }
  'account.created': { ctx: CreatedContext; result: void }
  'doctor.check': { ctx: DoctorContext; result: CheckResult[] | undefined }
}

export type HookEvent = keyof HookEvents

export type HookHandler<E extends HookEvent> = (
  ctx: HookEvents[E]['ctx'],
) => HookEvents[E]['result'] | Promise<HookEvents[E]['result']>

export interface PluginFs {
  /** Atomic write via a temp file in the same directory; `mode` defaults to 0o600. */
  writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void>
}

export interface PluginApi {
  family(def: FamilyDef): void
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): void
  on<E extends HookEvent>(event: E, filter: HookFilter, handler: HookHandler<E>): void
  /**
   * Returns an error that, when thrown from `launch.before` or `account.create.before`, stops the Launch or the
   * new Account with this message. Say what to do instead: the CLI and the Panel show it as is.
   */
  abort(message: string): Error
  fs: PluginFs
}

export interface Plugin {
  name: string
  register(api: PluginApi): void | Promise<void>
}
