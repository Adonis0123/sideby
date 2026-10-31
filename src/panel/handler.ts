// HTTP handler for the local Panel. Mountable under any basePath; standalone and embedded use the same rules.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { aliasesByAccount, startArgsOf } from '../core/accounts.ts'
import {
  type AppProfileStatus,
  listAppProfiles,
  openAppProfile,
  removeAppProfile,
} from '../core/app-profiles.ts'
import {
  type AiTaskInput,
  openLoginInTerminal,
  openPickInTerminal,
  pickTaskAccount,
  previewAttachments,
  promptForTask,
  setCustomTerminal,
  setPreferredTerminal,
  startAiTask,
  taskContext,
  terminals,
  tryAccount,
} from '../core/ask.ts'
import {
  ATTACHMENT_LIMITS,
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  removeStaged,
  stagedAttachments,
  stageUpload,
} from '../core/attachments.ts'
import {
  type AutostartContext,
  type AutostartPlan,
  type AutostartStatus,
  applyAutostart,
  autostartStatus,
  type LoginAgent,
  PANEL_AGENT,
  planAutostart,
} from '../core/autostart.ts'
import { FAVICON_SVG, ICON_SVG } from '../core/brand-mark.ts'
import {
  type BrowserReport,
  browserReport,
  openInBrowser,
  setBrowserChoice,
  setBrowserSignIns,
} from '../core/browser-profiles.ts'
import {
  aliasArgs,
  aliasRefs,
  type DisplayConfig,
  editConfigPanel,
  editConfigTerminal,
  editConfigUpdate,
  type HandoffSettings,
  loadConfig,
  type PanelConfig,
} from '../core/config.ts'
import { openDesktopApp, withDesktopApps } from '../core/desktop-app.ts'
import { editSettings } from '../core/edit-settings.ts'
import { UserError } from '../core/errors.ts'
import { planHandoff } from '../core/handoff.ts'
import { applyHandoffEnable, type EnablePlan, planHandoffEnable } from '../core/handoff-enable.ts'
import { handoffOverview } from '../core/handoff-overview.ts'
import { apiUndecided, handoffRulesView } from '../core/handoff-rules.ts'
import { configureHandoff, type HandoffChange, handoffStatus } from '../core/handoff-status.ts'
import {
  acceptInbound,
  groupsToAccept,
  type InboundGroup,
  inboundGroups,
  undoInbound,
  waitingFiles,
} from '../core/inbound.ts'
import {
  accountLabels,
  type LiveSession,
  type LiveSessionsResult,
  listLiveSessions,
  liveKey,
  referenceText,
  resumeCommandFor,
  sessionCopyText,
} from '../core/live-sessions.ts'
import { listMessages, type MessageReceipt, sendMessage } from '../core/messages.ts'
import { type AccountModel, accountModel, setAccountModel } from '../core/model-choice.ts'
import { GUARDED_FAMILIES, type NetworkChange, type NetworkOverview, setNetwork } from '../core/network.ts'
import { tildify } from '../core/paths.ts'
import { takeoverLimits } from '../core/quota-levels.ts'
import { type RemoteControlGroup, remoteControlTodo } from '../core/remote-control.ts'
import { openRunBoard, withRuns } from '../core/run-link.ts'
import { SECRET_VAR_NAME, secretVarFor, setSecret } from '../core/secret-file.ts'
import { readHandoffChains, withHandoffs } from '../core/session-handoffs.ts'
import { SKILL_INSTALL } from '../core/skill-check.ts'
import { launchArgs, TERMINALS } from '../core/terminal.ts'
import {
  checkThemeData,
  listThemes,
  NO_THEME,
  previewColors,
  type ResolvedColors,
  removeThemeFile,
  resolveColors,
  saveThemeFile,
  undoTheme,
  useTheme,
} from '../core/themes.ts'
import { MIN_CALLS } from '../core/tuning.ts'
import type { TuneApplyPlan } from '../core/tuning-apply.ts'
import {
  onUntil,
  setUnattendedSchedule,
  turnUnattendedOff,
  turnUnattendedOn,
  type UnattendedChange,
  type UnattendedStatus,
  unattendedStatus,
} from '../core/unattended.ts'
import { checkUnattendedEnded } from '../core/unattended-ended.ts'
import {
  listPendingDecisions,
  markPendingDone,
  type PendingDecision,
  reopenPendingDecision,
} from '../core/unattended-pending.ts'
import { readUnattendedConfig } from '../core/unattended-state.ts'
import * as update from '../core/update.ts'
import { buildId, localBuild, packageVersion } from '../core/version.ts'
import { HOOK_FAMILIES } from '../handoff/hook.ts'
import { MENUBAR_AGENT } from '../menubar/agent.ts'
import {
  hotkeyView,
  iconView,
  openMenuBarSettings,
  readMenubarState,
  setMenubarHotkey,
} from '../menubar/hotkey.ts'
import { MENUBAR_SCRIPT } from '../menubar/script.ts'
import type { AccountStatus, DoctorHistory, FamilyInfo, QuotaCheckInfo, Runtime } from '../runtime.ts'
import type { Account, FamilyDef, FamilyLogo, QuotaResult, QuotaSetupPlan, UsageResult } from '../types.ts'
import { type OrcaDeps, orcaTabs, switchOrcaTab, systemOrca } from './orca.ts'
import { renderPage } from './page.ts'
import { AI_TASK_KINDS } from './page-logic.ts'
import { tokenStyles } from './page-styles.ts'
import { type PanelTheme, type ResolvedTheme, resolveTheme } from './theme.ts'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './themes.ts'

export const PANEL_VERSION = packageVersion()
export const MAX_BODY_BYTES = 64 * 1024
/** Write requests allowed to wait behind the running one; more get 409. */
export const MAX_QUEUED_WRITES = 4

export interface PanelHandlerOptions {
  /** A Runtime, or a factory called per request so every response reflects the disk. */
  runtime: Runtime | (() => Promise<Runtime>)
  /** Mount point such as `/accounts`; empty or `/` for the root. */
  basePath?: string
  /** Accepted `Host` header values, for example `127.0.0.1:17420`. */
  allowedHosts: string[]
  /** Rejects changes (fix, create, quota setup apply and teardown) with 403. */
  readOnly?: boolean
  version?: string
  /**
   * Design tokens that make the page match the embedding page. Checked when the handler is created: an unknown
   * token or a value that could leave its CSS declaration throws a TypeError.
   */
  theme?: PanelTheme
  /**
   * The Panel's language. `en` or `zh` wins over what the viewer saved and hides the Panel's own switch; `auto`
   * (the default) uses the viewer's saved choice, then the browser language. Checked when the handler is created:
   * any other value throws a TypeError. A Portal that changes language creates the handler again.
   */
  lang?: 'auto' | 'en' | 'zh'
  /**
   * Whether the Panel offers sideby updates (spec §3.23, ADR-0021): the "new version" label, the Update button and
   * the Auto Update switch. Default true; a Portal that manages sideby's version itself passes false, and the
   * Panel then refuses `/api/update*` with 403.
   */
  updates?: boolean
  /**
   * How the Panel's AI Tasks start (spec §3.28, ADR-0030). `{ bridge: 'postMessage' }` is for a Portal that offers
   * AI Tasks on every page itself: inside a frame, the Panel hides its header "Let AI do it" button and every AI Task entry posts
   * `{ type: 'local-tools:ask', version: 1, preset, native: { task, text, context }, text }` to `window.parent`, with
   * the Panel's own origin as the target origin, instead of opening its dialog. Without it the Panel opens its own
   * dialog. Checked when the handler is created: anything else throws a TypeError.
   */
  ask?: { bridge: 'postMessage' }
}

/**
 * Internal, for tests and screenshots: a property under this key of the handler options replaces where the Sessions
 * page reads Live Sessions and their copy texts from (spec §3.32). Not part of the Portal contract (`src/index.ts`
 * does not export it); it may change without notice.
 */
export const LIVE_SESSIONS_SOURCE: unique symbol = Symbol('sideby.panel.liveSessions')
export interface LiveSessionsSource {
  list?: (rt: Runtime) => Promise<LiveSessionsResult>
  copyText?: typeof sessionCopyText
  /** The Orca CLI and process reader; tests pass a fake so they never call the real Orca. */
  orca?: OrcaDeps
  /** Sends a Message and lists them (spec §3.32 step 2); tests pass fakes so they never reach a real Session. */
  send?: typeof sendMessage
  messages?: typeof listMessages
}

/** The longest text "Send to it" takes; the page's text box has the same limit. */
export const MAX_MESSAGE_TEXT = 8000

/** The latest Message to one Session, for the status chip on its row. */
export interface PanelMessageStatus {
  id: string
  status: MessageReceipt['status']
  sentAt: string
  /** The target's Session Label, and the sender's when sideby could tell it, for the Panel's message notices. */
  to: string
  from?: string
  /** For `paste-needed`: the line to paste into the target's tab; for `unknown`, the same line behind a click (ADR-0065). */
  pasteText?: string
  /** Why a paste is needed, what the target must still do, or why the delivery could not be confirmed. */
  note?: string
  /** Delivered, but the target shows it only once the user approves it in its terminal (ADR-0045). */
  needsApproval?: true
}

/** A Claude settings file and whether its sessions show Messages at once, for the "Receiving messages" dialog. */
export interface PanelInboundGroup {
  /** The file, with `~`. */
  file: string
  accounts: string[]
  state: InboundGroup['state']
  reason?: string
  undo: boolean
  /** Its sessions hold a Message for approval: `hold`, or not set while an Account starts in bypass mode. */
  waits: boolean
}

/** A Live Session as the Sessions page gets it: the working directory with `~`, and the three texts it can copy. */
export interface PanelSession extends LiveSession {
  copy: { reference: string; id: string; resume: string }
  /** True when the Session runs in a live Orca terminal tab the Panel can bring to the front. */
  orca?: true
}

function resolveAsk(ask: unknown): { bridge: 'postMessage' } | undefined {
  if (ask === undefined) return undefined
  if (
    !ask ||
    typeof ask !== 'object' ||
    (ask as { bridge?: unknown }).bridge !== 'postMessage' ||
    Object.keys(ask).length !== 1
  )
    throw new TypeError('panel ask must be { bridge: "postMessage" } or left out')
  return { bridge: 'postMessage' }
}

const PANEL_LANGS = ['auto', 'en', 'zh'] as const

function resolveLang(lang: unknown): (typeof PANEL_LANGS)[number] {
  if (lang === undefined) return 'auto'
  const found = PANEL_LANGS.find((l) => l === lang)
  if (!found) throw new TypeError('panel lang must be "auto", "en" or "zh"')
  return found
}

export type PanelHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & {
  /** Per-instance secret the page sends as `x-sideby-token`. */
  readonly token: string
}

export type PanelAccount = (AccountStatus | (Account & Partial<AccountStatus>)) & {
  quota?: QuotaResult
  usage?: UsageResult
  error?: string
  /** Latest Doctor result for this Account; absent when it was never checked. */
  health?: { at: string; fail: number; warn: number }
  /** Config `aliases` that point at this Account, sorted; absent when none do. */
  aliases?: string[]
  /** Host arguments of those aliases that add any (alias → arguments); absent when none do. */
  aliasArgs?: Record<string, string[]>
  /** The model and effort it starts with and where each comes from (spec §3.19); absent for Families without a choice. */
  modelInfo?: Omit<AccountModel, 'ref' | 'family'>
  /** Its reads take longer than the state waits (`readBudget`); they go on, and a later state carries them. */
  pending?: true
}

export type { DoctorHistory }

/** Counts of failing and warning Findings per checked Account, from the Doctor history. */
export function healthByAccount(
  history: DoctorHistory | undefined,
): Map<string, { at: string; fail: number; warn: number }> {
  const out = new Map<string, { at: string; fail: number; warn: number }>()
  for (const [ref, entry] of Object.entries(history?.accounts ?? {}))
    out.set(ref, {
      at: entry.at,
      fail: entry.findings.filter((f) => f.level === 'fail').length,
      warn: entry.findings.filter((f) => f.level === 'warn').length,
    })
  return out
}

/** A Family as the page sees it: FamilyInfo plus the mark from its FamilyDef, and what the key box needs. */
export type PanelFamily = FamilyInfo & {
  logo?: FamilyLogo
  /** The variable the key box writes by default (spec §3.28); null when the Family names none. */
  keyVar?: string | null
  /** The Secret File holds keys even for a subscription (pi), so its accounts offer the key box too. */
  keyAlways?: boolean
  /** What "Try it" runs (`sideby try`): the Host and the probe arguments; absent when it cannot be tried. */
  tryCommand?: string[]
  /** AI Tasks start this Host with its permission checks on (`aiTaskArgs`, ADR-0031), so the AI dialog says so. */
  aiTaskSafe?: true
  /** "Refresh" can ask the Host for its Quota (`fetchQuota`); without it old numbers wait for a session (spec §3.31). */
  quotaRefresh?: true
}

function keyFacts(
  def: FamilyDef,
): Pick<PanelFamily, 'keyVar' | 'keyAlways' | 'tryCommand' | 'aiTaskSafe' | 'quotaRefresh'> {
  let keyVar: string | null = null
  try {
    keyVar = secretVarFor(def)
  } catch {}
  return {
    keyVar,
    ...(def.secretFileMeansApi === false ? { keyAlways: true } : {}),
    ...(def.probe ? { tryCommand: [def.bin, ...def.probe.args] } : {}),
    ...(def.aiTaskArgs ? { aiTaskSafe: true as const } : {}),
    ...(def.fetchQuota ? { quotaRefresh: true as const } : {}),
  }
}

/** What the Panel shows about updates (spec §3.23); absent when the handler was created with `updates: false`. */
export interface PanelUpdate {
  current: string
  /** The newest version the last Update Check saw; absent before the first one. */
  latest?: string
  available: boolean
  checkedAt?: string
  /** Why Update Checks are off; absent when they are on. */
  checksOff?: string
  checksOffCode?: update.ChecksOffCode
  /** Config `update.auto`. */
  auto: boolean
  method: {
    kind: update.InstallKind
    canUpdate: boolean
    reason?: string
    reasonCode?: update.ReasonCode
    reasonAt?: string
  }
  /** The command an Update runs, or the one to run by hand when `canRun` is false. */
  command?: string
  canRun: boolean
  releaseNotes?: string
  /** The command that installs the sideby skill by hand. */
  skill: string
  /**
   * The installed sideby skill, which an Update brings along (spec §3.23); absent when none is installed, and for a
   * Local Build, which `pnpm local --off` brings back to npm together with the skill.
   */
  skillUpdate?: import('../core/update.ts').SkillUpdatePlan
  /**
   * The switch between a Local Build and the npm package (ADR-0024): present only while a Local Build runs or one is
   * kept next to an npm install, so a plain install never sees it.
   */
  localSwitch?: import('../core/local-build.ts').LocalStatus
}

export interface PanelState {
  schemaVersion: 1
  version: string
  /** buildId() of the process serving the Panel: a page from another build reloads itself. */
  build: string
  readOnly: boolean
  generatedAt: string
  families: PanelFamily[]
  accounts: PanelAccount[]
  pluginErrors: { where: string; message: string }[]
  quotaSetups: { family: string; summary: string; plan: QuotaSetupPlan }[]
  /** Latest Doctor result per Account and per Family. */
  history?: DoctorHistory
  /** The config `aliases` as alias → Account ref (arguments left out), so the page can tell which names are taken. */
  configAliases?: Record<string, string>
  /** The config `pickCommands`, name → Family (spec §3.13, ADR-0035). */
  pickCommands?: Record<string, string>
  /**
   * Family → the Pick Command the page offers to add: a Family with two or more Subscription Accounts and none yet,
   * with the command on PATH the name would hide; `name: null` when no default name is free (the user types one).
   */
  pickOffers?: Record<string, { name: string | null; shadows?: string }>
  /** Whether new terminals load the short commands (`sideby shell-init setup`, ADR-0036), and the rc file it would edit. */
  shellSetup: { shell: 'zsh' | 'bash'; rc: string; loaded: boolean; added: boolean; block: string }
  /**
   * Family → the Account `sideby next <family>` would pick (spec §3.13). Only Families with a Quota source,
   * at least two subscription Accounts, some Quota data and a pick; API Accounts are left out as in the CLI default.
   */
  handoff?: Record<string, string>
  /** Auto Handoff settings (spec §3.17) and the Families that can start one; readiness comes from /api/handoff/status. */
  autoHandoff: { settings: HandoffSettings; starters: string[]; apiUndecided: boolean }
  /** Claude settings files grouped as `sideby remote-control` shows them (spec §3.22); absent without Claude Accounts. */
  remoteControl?: RemoteControlView[]
  /** Grok Bot windows (ADR-0019), data folders shown as `~/…`; absent when there are none to show. */
  appProfiles?: AppProfileStatus[]
  /** Update Check result and Auto Update setting (spec §3.23); absent with `updates: false`. */
  update?: PanelUpdate
  /**
   * Browser Sign-ins (spec §3.24): which Chrome browser user signed in to which Account, read on this computer only.
   * Absent without Claude, Codex or Grok subscription Accounts. Nothing of the browser is read while `enabled` is false.
   */
  browser?: BrowserReport
  /** Display Order (spec §3.25): config `display` as it is, an empty object when the user never dragged. */
  display: DisplayConfig
  /** Families that ask for Quota in a way that costs a request (spec §3.26), with their switch; absent when none. */
  quotaChecks?: QuotaCheckInfo[]
  /** Config `panel` (spec §3.29): the theme and language the Panel shows; absent when neither is set. */
  panel?: PanelConfig
  /** Network Guard (spec §3.35): the setting and the cached result per address; absent without Claude or Codex Accounts. */
  network?: NetworkOverview
  /** Unattended Mode (spec §3.37): whether it is on for the computer, why, until when, the Schedule; absent when unreadable. */
  unattended?: PanelUnattendedStatus
}

/** One Pending Decision as the Panel's Unattended page lists it, with the way back to its Session. */
export interface PanelPendingDecision extends PendingDecision {
  /** The Account's short name (its Alias when it has one). */
  accountLabel?: string
  /** The Session still runs: its label, so the Sessions page finds it. */
  live?: { label: string; accountLabel: string }
  /** The command that resumes the Session, from its folder when that is known; only for an id safe in a shell. */
  resume?: string
}

/**
 * The status as the Panel gets it: with the ids of the open Pending Decisions, so a page that marked some done and
 * waits for the answer subtracts only those a newer status still lists. `pending` is their number.
 */
export type PanelUnattendedStatus = UnattendedStatus & { pendingIds: string[] }

/** The Unattended page: the status and every open Pending Decision. */
export interface PanelUnattended {
  status: PanelUnattendedStatus
  pending: PanelPendingDecision[]
}

/** What a change on the Unattended page did, and the request that puts back what was there. */
export interface PanelUnattendedChange {
  changed: boolean
  status: PanelUnattendedStatus
  undo?: { route: '/api/unattended/on' | '/api/unattended/off'; body: Record<string, unknown> }
}

let autostartOverride: Partial<AutostartContext> = {}
/**
 * Internal, for tests: replaces parts of the machine the Panel's start-at-login switch uses (platform, launcher,
 * `exec`, login home). Not part of the plugin or Portal contract.
 */
export function bindPanelAutostart(ctx: Partial<AutostartContext>): () => void {
  const before = autostartOverride
  autostartOverride = { ...autostartOverride, ...ctx }
  return () => {
    autostartOverride = before
  }
}
/**
 * The menu bar shortcut as config holds it now (read again: the Panel's Runtime may hold an older config), and what
 * the item last said about its icon.
 */
async function menubarExtras(rt: Runtime) {
  const configured = (await loadConfig(rt.paths.configFile).catch(() => rt.config)).menubar?.hotkey
  const kept = await readMenubarState(rt.paths.stateDir)
  return { hotkey: hotkeyView(configured, kept.hotkey ?? null), icon: iconView(kept.icon, new Date()) }
}

/**
 * A login item's state as the page shows it; the menu bar item's carries its shortcut too. Every answer that hands the
 * page a new state goes through here, so turning it on never drops the shortcut row.
 */
async function loginItemView(rt: Runtime, agent: LoginAgent) {
  const view = autostartView(await autostartStatus(autostartCtx(rt), agent), rt.paths.home)
  return agent === MENUBAR_AGENT && view.supported ? { ...view, ...(await menubarExtras(rt)) } : view
}

const autostartCtx = (rt: Runtime): AutostartContext => ({
  home: rt.paths.home,
  env: rt.env,
  ...autostartOverride,
})

/**
 * The start-at-login state as the page shows it (spec §3.29): the agent's path and what it starts, with the home
 * folder as `~`, and nothing else of the machine.
 */
export function autostartView(s: AutostartStatus, home: string) {
  const t = shownArg(home)
  return {
    supported: s.supported,
    ...(s.reason ? { reason: s.reason } : {}),
    state: s.state,
    path: t(s.path),
    ...(s.mechanism ? { mechanism: s.mechanism } : {}),
    current: s.current,
    ...(s.programArguments ? { programArguments: s.programArguments.map(t) } : {}),
    ...(s.missing ? { missing: s.missing.map(t) } : {}),
    ...(s.loaded === undefined ? {} : { loaded: s.loaded }),
  }
}

/** A program argument as the page shows it: the home folder as `~`, and the menu bar script by name only. */
const shownArg = (home: string) => (a: string) =>
  a === MENUBAR_SCRIPT ? '(menu bar script)' : tildify(a, home)

function autostartPlanView(p: AutostartPlan, home: string) {
  return {
    action: p.action,
    changed: p.changed,
    path: tildify(p.path, home),
    ...(p.programArguments ? { programArguments: p.programArguments.map(shownArg(home)) } : {}),
    ...(p.blocked ? { blocked: p.blocked } : {}),
    // Only starts the agent again: the file stays as it is (on, current, but launchd let it go).
    ...(p.action === 'on' &&
    p.changed &&
    p.status.state === 'on' &&
    p.status.current &&
    p.status.loaded === false
      ? { restartOnly: true }
      : {}),
    status: autostartView(p.status, home),
  }
}

const PANEL_THEMES = ['system', 'light', 'dark'] as const
const PANEL_LANGUAGES = ['auto', 'en', 'zh'] as const

// One Update Check at a time per process, started by a state read when one is due (the cache also keeps a failed
// one from being tried again within the hour, though the page asks every 20 s).
let checking: Promise<unknown> | null = null

/**
 * The `update` part of the state. A Panel that may write starts an Update Check in the background when one is due;
 * a read-only one only shows what the cache holds.
 */
async function updateState(rt: Runtime, readOnly: boolean): Promise<PanelUpdate> {
  const current = packageVersion()
  const off = update.checksOffWhy(rt.env, rt.config)
  const cache = await update.readUpdateCache(rt.paths)
  if (!off && !readOnly && !checking && update.checkDue(cache, new Date()))
    checking = update.refreshUpdateCheck(rt.paths, rt.env).finally(() => {
      checking = null
    })
  const method = await update.installMethod(rt.env)
  const plan = cache.latest ? update.shownPlan(update.planFrom(method, current, cache.latest, rt.env)) : null
  const skillUpdate =
    method.kind === 'local'
      ? null
      : await update.skillUpdatePlan(rt.paths.home, plan?.available ? plan.latest : current).catch(() => null)
  return {
    current,
    ...(cache.latest ? { latest: cache.latest } : {}),
    available: Boolean(plan?.available),
    ...(cache.checkedAt ? { checkedAt: cache.checkedAt } : {}),
    ...(off ? { checksOff: off.text, checksOffCode: off.code } : {}),
    auto: rt.config.update?.auto === true,
    method: update.shownMethod(method),
    ...(plan ? { command: plan.command, releaseNotes: plan.releaseNotes } : {}),
    canRun: Boolean(plan?.canRun),
    skill: SKILL_INSTALL,
    ...(skillUpdate ? { skillUpdate } : {}),
    ...(await localSwitchState(rt, method)),
  }
}

// npm's global prefix, asked once per process: the page reads the state every 20 s and `npm prefix -g` takes a while.
let localDirsMemo: Promise<import('../core/local-build.ts').LocalDirs | null> | null = null
async function localDirsFor(rt: Runtime) {
  const lb = await import('../core/local-build.ts')
  localDirsMemo ??= lb.localDirs(rt.env).then((d) => {
    if (!d) localDirsMemo = null // ask again next time
    return d
  })
  return localDirsMemo
}
// An npm install knows its prefix; only a running Local Build needs npm asked where the global package is.
async function switchDirs(rt: Runtime, method: update.InstallMethod) {
  const lb = await import('../core/local-build.ts')
  return method.prefix ? { dev: lb.devDir(rt.env), prefix: method.prefix } : localDirsFor(rt)
}
async function localSwitchState(
  rt: Runtime,
  method: update.InstallMethod,
): Promise<{ localSwitch?: PanelUpdate['localSwitch'] }> {
  if (method.kind !== 'local' && method.kind !== 'npm') return {}
  try {
    const lb = await import('../core/local-build.ts')
    const d = await switchDirs(rt, method)
    if (!d) return {}
    const s = await lb.localStatus(d)
    return s.running === 'local' || (s.running === 'npm' && s.local) ? { localSwitch: s } : {}
  } catch {
    return {}
  }
}

/** The `handoff` map of the Panel state, from the statuses and Quota already read for the page. */
export function handoffByFamily(
  rt: Runtime,
  accounts: readonly PanelAccount[],
  now: Date,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, f] of rt.families) {
    // An Account still being read has no Quota yet; it is neither a pick nor an alternative until it has.
    const list = accounts.filter((a) => a.family === id && !a.pending)
    // Count logins, not directories: a Same Login group (spec §3.21) is one Quota, so it alone is no alternative.
    const subs = list.filter((a) => a.kind === 'subscription')
    const logins = subs.filter((a, i) => !subs.slice(0, i).some((b) => a.sameLogin?.includes(b.ref))).length
    if ((!f.readQuota && !f.fetchQuota) || logins < 2) continue
    const plan = planHandoff(
      id,
      list.map((a) => ({
        ref: a.ref,
        name: a.name,
        isMain: a.isMain,
        kind: a.kind,
        login: a.login ?? 'unknown',
        quota: a.quota ?? { status: 'unavailable', reason: 'unrecognized' },
      })),
      now,
      // The same plan as `sideby next`: the same Takeover Limits, and past them the least used Account (a Last Resort).
      { limits: takeoverLimits(rt.handoffSettings().threshold), lastResort: true },
    )
    if (plan.pick && plan.hasQuota) out[id] = plan.pick
  }
  return out
}

class HttpError extends Error {
  readonly status: number
  /** Machine-readable reason the page acts on, such as `bad-token`. */
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

function normalizeBase(p: string | undefined): string {
  if (!p || p === '/') return ''
  const withSlash = p.startsWith('/') ? p : `/${p}`
  return withSlash.replace(/\/+$/, '')
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return Promise.reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('error', (err) => {
      if (!failed) reject(err)
    })
    req.on('end', () => {
      if (failed) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return reject(new HttpError(400, 'request body must be a JSON object'))
        resolve(parsed)
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'))
      }
    })
  })
}

// Session History (spec §3.33, ADR-0042): the page's filters, checked here, and the rows it gets with `~` paths and
// a Session Reference in the Panel's language. The continue command stays as typed, so a paste works anywhere.
const HISTORY_SINCE = new Set(['today', '7d', '30d', 'all'])
const HISTORY_GROUPS = new Set(['project', 'category', 'account', 'family', 'day', 'none'])
type HistoryModule = typeof import('../core/history.ts')
type HistoryQueryIn = import('../core/history.ts').HistoryQuery
type HistorySessionOut = import('../core/history.ts').HistorySession

function historyQuery(body: Record<string, unknown>): HistoryQueryIn {
  const since = optString(body, 'since')
  if (since !== undefined && !HISTORY_SINCE.has(since))
    throw new HttpError(400, '"since" must be today, 7d, 30d or all')
  const num = (key: string, max: number): number | undefined => {
    const v = body[key]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max)
      throw new HttpError(400, `"${key}" must be a whole number from 0 to ${max}`)
    return v
  }
  const project = optString(body, 'project')
  const q: HistoryQueryIn = { scripts: optBool(body, 'scripts') }
  const words = optString(body, 'q')
  if (words !== undefined) q.q = words.slice(0, 200)
  if (project !== undefined) q.project = project
  const family = optString(body, 'family')
  if (family !== undefined) q.family = family
  const account = optString(body, 'account')
  if (account !== undefined) q.account = account
  if (since !== undefined) q.since = since as HistoryQueryIn['since']
  const limit = num('limit', 500)
  if (limit !== undefined) q.limit = Math.max(1, limit)
  const offset = num('offset', 1_000_000)
  if (offset !== undefined) q.offset = offset
  const group = optString(body, 'group')
  if (group !== undefined) {
    if (!HISTORY_GROUPS.has(group))
      throw new HttpError(400, '"group" must be project, category, account, family, day or none')
    q.group = group as HistoryQueryIn['group']
  }
  const category = optString(body, 'category')
  if (category !== undefined) q.category = category
  if (body.collapsed !== undefined) {
    const c = body.collapsed
    if (!Array.isArray(c) || c.length > 500 || c.some((k) => typeof k !== 'string' || k.length > 1024))
      throw new HttpError(400, '"collapsed" must be a list of at most 500 group keys')
    q.collapsed = c as string[]
  }
  return q
}

/** Project group keys go out with `~` like every path on the page, and come back the same way. */
const untildify = (p: string, home: string) => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p)

function historyView(s: HistorySessionOut, home: string, lang: 'en' | 'zh'): HistorySessionOut {
  return {
    ...s,
    cwd: tildify(s.cwd, home),
    project: tildify(s.project, home),
    transcript: tildify(s.transcript, home),
    reference: referenceText(
      {
        accountLabel: s.accountLabel,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        transcript: s.transcript,
        guessed: false,
        resumeCommand: s.resumeCommand,
      },
      lang,
    ),
  }
}

/** A search of tool output the page started; it runs while the page polls it, and stops when asked or forgotten. */
interface ToolScan {
  ctrl: AbortController
  hits: HistorySessionOut[]
  done: number
  total: number
  finished: boolean
  error?: string
  /** When the page last asked; a scan nobody polls for TOOL_SCAN_IDLE_MS stops. */
  seen: number
}
const TOOL_SCAN_IDLE_MS = 15_000
const TOOL_SCAN_MAX_HITS = 100
/** The longest one scan of tool output runs, polled or not. */
const TOOL_SCAN_MAX_MS = 120_000

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`)
  return v
}

function optBool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`)
  return v
}

async function accountState(rt: Runtime, account: Account, families: FamilyInfo[]): Promise<PanelAccount> {
  const errors: string[] = []
  const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p
    } catch (err) {
      errors.push((err as Error).message)
      return undefined
    }
  }
  const [status, quota, usage] = await Promise.all([
    guard(rt.status(account)),
    // The kept answer of a Quota check shows now; a stale one is asked again behind it (spec §3.26).
    guard(rt.quota(account, { fetch: 'background' })),
    guard(rt.usage(account)),
  ])
  const fam = families.find((f) => f.id === account.family)
  const base: PanelAccount = status ?? {
    ...account,
    familyTitle: fam?.title ?? account.family,
    hostInstalled: fam?.installed ?? false,
    login: 'unknown',
  }
  errors.push(...(status?.problems ?? []))
  let modelInfo: PanelAccount['modelInfo']
  if (rt.families.get(account.family)?.modelChoice) {
    const last =
      usage?.status === 'ok'
        ? {
            ...(usage.lastModel ? { model: usage.lastModel } : {}),
            ...(usage.lastEffort ? { effort: usage.lastEffort } : {}),
          }
        : {}
    const info = await guard(accountModel(rt, account, last))
    if (info) {
      const { ref: _r, family: _f, ...rest } = info
      modelInfo = rest
    }
  }
  return {
    ...base,
    ...(modelInfo ? { modelInfo } : {}),
    ...(quota ? { quota } : {}),
    ...(usage ? { usage } : {}),
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

export type RemoteControlView = Omit<RemoteControlGroup, 'file'> & { file: string }

function rcView(groups: readonly RemoteControlGroup[], home: string): RemoteControlView[] {
  return groups.map((g) => ({ ...g, file: tildify(g.file, home) }))
}

/**
 * How long one state waits for an Account's reads. A slower Account (a plugin reader that hangs, a Host that answers
 * late) is sent as pending, so it does not hold up every other row; its reads go on and the next state picks up the
 * answer. Mutable for tests only.
 */
export const readBudget = { ms: 2000, hungMs: 60_000 }
/** An answer kept longer than this is not used: the next state reads the Account again. */
const KEPT_MS = 30_000
type Reading = { promise: Promise<PanelAccount>; started: number; done?: { state: PanelAccount; at: number } }
/** Reads still going on, by Account ref; one map per Panel, since a Runtime may be made anew for every request. */
type Readings = Map<string, Reading>

/** The Account's state within `readBudget`, or a pending placeholder while its reads go on. */
async function timedAccountState(
  rt: Runtime,
  account: Account,
  families: FamilyInfo[],
  mine: Readings,
): Promise<PanelAccount> {
  const fam = families.find((f) => f.id === account.family)
  const placeholder = async (extra: Partial<PanelAccount>): Promise<PanelAccount> => {
    // Its Same Login is known without the slow reads, so its rows stay grouped meanwhile.
    const sameLogin = await rt.sameLogin(account).catch(() => [] as string[])
    return {
      ...account,
      familyTitle: fam?.title ?? account.family,
      hostInstalled: fam?.installed ?? false,
      login: 'unknown',
      ...(sameLogin.length ? { sameLogin } : {}),
      ...extra,
    }
  }
  let r = mine.get(account.ref)
  if (r?.done && Date.now() - r.done.at > KEPT_MS) r = undefined
  // A read still going after `readBudget.hungMs` has hung (a plugin reader, a Host that never answers).
  if (r && !r.done && Date.now() - r.started > readBudget.hungMs) {
    // Dropped, so the next state starts a new read; this one says what happened instead of spinning on.
    mine.delete(account.ref)
    return placeholder({
      error: `reading this account took longer than ${Math.round(readBudget.hungMs / 1000)} s; refresh to try again`,
    })
  }
  if (!r) {
    const fresh: Reading = { promise: accountState(rt, account, families), started: Date.now() }
    fresh.promise.then(
      (state) => {
        fresh.done = { state, at: Date.now() }
      },
      () => undefined,
    )
    mine.set(account.ref, fresh)
    r = fresh
  }
  const reading = r
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), readBudget.ms)
  })
  let state: PanelAccount | null
  try {
    state = await Promise.race([reading.promise, late])
  } catch (err) {
    if (mine.get(account.ref) === reading) mine.delete(account.ref)
    return placeholder({ error: (err as Error).message })
  } finally {
    clearTimeout(timer)
  }
  if (state) {
    // Only this reading: another request may already have started a newer one.
    if (mine.get(account.ref) === reading) mine.delete(account.ref)
    return state
  }
  return placeholder({ pending: true })
}

async function buildState(
  rt: Runtime,
  opts: { version: string; build: string; readOnly: boolean; updates: boolean; readings: Readings },
): Promise<PanelState> {
  const ctx = rt.readContext()
  const [families, accounts, history, quotaSetups, remoteControl, upd] = await Promise.all([
    rt.familyInfo(),
    rt.accounts(),
    rt.doctorHistory(),
    rt.quotaSetups(),
    rt.remoteControl(),
    opts.updates ? updateState(rt, opts.readOnly).catch(() => undefined) : Promise.resolve(undefined),
  ])
  const health = healthByAccount(history)
  const network = accounts.some((a) => (GUARDED_FAMILIES as readonly string[]).includes(a.family))
    ? await rt.networkStatus().catch(() => undefined)
    : undefined
  // Reads of Accounts that are gone are dropped.
  for (const ref of opts.readings.keys()) if (!accounts.some((a) => a.ref === ref)) opts.readings.delete(ref)
  const aliases = aliasesByAccount(aliasRefs(rt.config.aliases), accounts)
  // Desktop Apps (spec §3.20): one process listing for every Account, run alongside the per-Account reads.
  const [states, appProfiles] = await Promise.all([
    withDesktopApps(
      rt,
      accounts,
      Promise.all(accounts.map((a) => timedAccountState(rt, a, families, opts.readings))),
    ),
    listAppProfiles(rt),
  ])
  const list = states.map((st): PanelAccount => {
    const h = health.get(st.ref)
    const names = aliases.get(st.ref)
    const withArgs = (names ?? [])
      .map((n) => [n, aliasArgs(rt.config.aliases?.[n])] as const)
      .filter(([, args]) => args.length)
    return {
      ...st,
      ...(h ? { health: h } : {}),
      ...(names ? { aliases: names } : {}),
      ...(withArgs.length ? { aliasArgs: Object.fromEntries(withArgs) } : {}),
    }
  })
  const handoff = handoffByFamily(rt, list, ctx.now)
  const pickOffers: Record<string, { name: string | null; shadows?: string }> = {}
  for (const f of families) {
    const offer = await rt.pickSuggestion(f.id, accounts).catch(() => null)
    if (offer && !offer.exists)
      pickOffers[f.id] = { name: offer.name, ...(offer.shadows ? { shadows: offer.shadows } : {}) }
  }
  const { setupBlock, shellSetupStatus, userShell } = await import('../core/shell-setup.ts')
  const shellSt = await shellSetupStatus(userShell(rt.env), ctx.home, rt.env, rt.config.shellInitFile)
  const browser = await browserReport(rt, accounts).catch(() => undefined)
  // The Panel's own status leaves out a `--unattended` session the server itself may run in: it shows the computer.
  const unattended = await unattendedStatus({
    paths: rt.paths,
    families: [...rt.families.keys()],
    now: ctx.now,
    readOnly: opts.readOnly,
  })
    .then((st) => withPendingIds(st, rt.paths.stateDir))
    .catch(() => undefined)
  const showBrowser = browser && (browser.families.matched.length || browser.families.openOnly.length)
  return {
    schemaVersion: 1,
    version: opts.version,
    build: opts.build,
    readOnly: opts.readOnly,
    generatedAt: ctx.now.toISOString(),
    families: families.map((f) => {
      const def = rt.families.get(f.id)
      const logo = def?.logo
      const g = f.brokenBin ? { ...f, brokenBin: tildify(f.brokenBin, ctx.home) } : f
      return { ...g, ...(logo ? { logo } : {}), ...(def ? keyFacts(def) : {}) }
    }),
    accounts: list,
    pluginErrors: rt.pluginErrors.map((e) => ({ where: e.where, message: e.message })),
    quotaSetups,
    ...(history ? { history } : {}),
    ...(rt.config.aliases ? { configAliases: aliasRefs(rt.config.aliases) } : {}),
    ...(rt.config.pickCommands ? { pickCommands: { ...rt.config.pickCommands } } : {}),
    ...(Object.keys(pickOffers).length ? { pickOffers } : {}),
    shellSetup: { ...shellSt, rc: tildify(shellSt.rc, ctx.home), block: setupBlock(shellSt.shell) },
    ...(Object.keys(handoff).length ? { handoff } : {}),
    ...(remoteControl.length ? { remoteControl: rcView(remoteControl, ctx.home) } : {}),
    ...(appProfiles.length
      ? {
          appProfiles: appProfiles.map((p) =>
            p.appData ? { ...p, appData: tildify(p.appData, rt.paths.home) } : p,
          ),
        }
      : {}),
    autoHandoff: {
      settings: rt.handoffSettings(),
      starters: [...rt.families.values()]
        .filter((f) => f.handoff?.starts.length && HOOK_FAMILIES.includes(f.id))
        .map((f) => f.id),
      apiUndecided: apiUndecided(rt, accounts.filter((a) => a.kind === 'api').length),
    },
    ...(upd ? { update: upd } : {}),
    ...(showBrowser ? { browser } : {}),
    display: rt.displayOrder(),
    ...(rt.quotaChecks().length ? { quotaChecks: rt.quotaChecks() } : {}),
    ...(rt.config.panel && Object.keys(rt.config.panel).length ? { panel: rt.config.panel } : {}),
    ...(network ? { network } : {}),
    ...(unattended ? { unattended } : {}),
  }
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const shellArg = (v: string) => (SHELL_SAFE.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`)
/** A Session id a hook reported is text from the Host: only a plain one goes into a command. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** The `undo` command a change printed, as the request the page sends for it. */
function undoRequest(undo: string | undefined): PanelUnattendedChange['undo'] {
  if (undo === 'sideby unattended off') return { route: '/api/unattended/off', body: {} }
  if (undo === 'sideby unattended on') return { route: '/api/unattended/on', body: {} }
  const until = undo?.startsWith('sideby unattended on --until ') ? undo.slice(29) : undefined
  return until ? { route: '/api/unattended/on', body: { until } } : undefined
}

/** A status with the ids of the open Pending Decisions, read once more (read only: nothing is deleted here). */
async function withPendingIds(status: UnattendedStatus, stateDir: string): Promise<PanelUnattendedStatus> {
  const ids = (await listPendingDecisions(stateDir, { prune: false })).map((d) => d.id)
  return { ...status, pending: ids.length, pendingIds: ids }
}

async function panelChange(c: UnattendedChange, stateDir: string): Promise<PanelUnattendedChange> {
  const undo = undoRequest(c.undo)
  return { changed: c.changed, status: await withPendingIds(c.status, stateDir), ...(undo ? { undo } : {}) }
}

async function unattendedView(
  rt: Runtime,
  readOnly: boolean,
  live: (rt: Runtime) => Promise<LiveSessionsResult>,
): Promise<PanelUnattended> {
  const families = [...rt.families.keys()]
  const [status, decisions, accounts] = await Promise.all([
    unattendedStatus({ paths: rt.paths, families, readOnly }),
    listPendingDecisions(rt.paths.stateDir, { prune: !readOnly }),
    rt.accounts(),
  ])
  const labels = accountLabels(rt, accounts)
  const running = decisions.some((d) => d.sessionId)
    ? (await live(rt).catch(() => ({ sessions: [], problems: [] }))).sessions
    : []
  const home = rt.paths.home
  return {
    status: { ...status, pending: decisions.length, pendingIds: decisions.map((d) => d.id) },
    pending: decisions.map((d): PanelPendingDecision => {
      const label = d.account ? labels.get(d.account) : undefined
      const session = d.sessionId ? running.find((s) => s.sessionId === d.sessionId) : undefined
      const known = d.account && accounts.some((a) => a.ref === d.account)
      const resume =
        d.sessionId && SAFE_SESSION_ID.test(d.sessionId) && known
          ? resumeCommandFor(d.family, d.account!, d.sessionId)
          : undefined
      return {
        ...d,
        ...(d.cwd ? { cwd: tildify(d.cwd, home) } : {}),
        ...(label ? { accountLabel: label } : {}),
        ...(session ? { live: { label: session.label, accountLabel: session.accountLabel } } : {}),
        ...(resume ? { resume: d.cwd ? `cd ${shellArg(d.cwd)} && ${resume}` : resume } : {}),
      }
    }),
  }
}

/** The `display` of a /api/display-order body: null, or string lists only; anything else is refused. */
function displayBody(body: Record<string, unknown>): DisplayConfig | undefined {
  const d = body.display
  if (d === null) return undefined
  const names = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x))
      throw new HttpError(400, `${what} must be a list of names`)
    return [...v]
  }
  if (!d || typeof d !== 'object' || Array.isArray(d))
    throw new HttpError(400, '"display" must be an object or null')
  const out: DisplayConfig = {}
  for (const [k, v] of Object.entries(d)) {
    if (k === 'families') out.families = names(v, '"families"')
    else if (k === 'hiddenFamilies') out.hiddenFamilies = names(v, '"hiddenFamilies"')
    else if (k === 'accounts') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new HttpError(400, '"accounts" must be an object')
      out.accounts = Object.fromEntries(
        Object.entries(v).map(([f, list]) => [f, names(list, `"accounts.${f}"`)]),
      )
    } else if (k === 'pinned') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new HttpError(400, '"pinned" must be an object')
      out.pinned = Object.fromEntries(Object.entries(v).map(([f, list]) => [f, names(list, `"pinned.${f}"`)]))
    } else if (k === 'hidden') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new HttpError(400, '"hidden" must be an object')
      out.hidden = Object.fromEntries(Object.entries(v).map(([f, list]) => [f, names(list, `"hidden.${f}"`)]))
    } else throw new HttpError(400, `unknown key "${k}"`)
  }
  return out
}

/**
 * The `change` of a /api/handoff/configure body, with every field checked; unknown fields are refused. Null for a
 * single setting removes it, as the `undo` of an earlier answer asks.
 */
const HANDOFF_SINGLE_KEYS = new Set([
  'auto',
  'sameFamily',
  'otherFamilies',
  'api',
  'adaptive',
  'prepareAt',
  'threshold',
  'waitIfResetWithinMinutes',
  'countdownSeconds',
])

function handoffChange(body: Record<string, unknown>): HandoffChange {
  const c = body.change
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, '"change" must be an object')
  const out: HandoffChange = {}
  for (const [k, v] of Object.entries(c)) {
    if (v === null && k !== 'familyOrder' && k !== 'crossOrganization' && k !== 'orders') {
      if (!HANDOFF_SINGLE_KEYS.has(k)) throw new HttpError(400, `unknown setting "${k}"`)
      ;(out as Record<string, unknown>)[k] = null
    } else if (
      k === 'auto' ||
      k === 'sameFamily' ||
      k === 'otherFamilies' ||
      k === 'api' ||
      k === 'adaptive'
    ) {
      if (typeof v !== 'boolean') throw new HttpError(400, `"${k}" must be true or false`)
      out[k] = v
    } else if (
      k === 'prepareAt' ||
      k === 'threshold' ||
      k === 'waitIfResetWithinMinutes' ||
      k === 'countdownSeconds'
    ) {
      if (!Number.isInteger(v) || (v as number) < 0) throw new HttpError(400, `"${k}" must be a whole number`)
      out[k] = v as number
    } else if (k === 'familyOrder' || k === 'crossOrganization') {
      if (!Array.isArray(v) || !v.every((n) => typeof n === 'string'))
        throw new HttpError(400, `"${k}" must be a list of names`)
      out[k] = [...v]
    } else if (k === 'orders') {
      if (
        !Array.isArray(v) ||
        !v.every(
          (o) =>
            o &&
            typeof o.family === 'string' &&
            Array.isArray(o.order) &&
            o.order.every((n: unknown) => typeof n === 'string'),
        )
      )
        throw new HttpError(400, '"orders" must be a list of { family, order: [account] }')
      out.orders = v.map((o) => ({ family: o.family, order: [...o.order] }))
    } else throw new HttpError(400, `unknown setting "${k}"`)
  }
  return out
}

/** The terminals for Settings and the confirm area: installed paths stay on the server. */
async function terminalsView(rt: Runtime) {
  const r = await terminals(rt)
  return {
    installed: r.installed.map((t) => t.id),
    preferred: r.preferred,
    guess: r.guess,
    custom: rt.config.terminal?.custom ?? null,
    terminals: r.terminals.map((t) => ({ id: t.id, name: t.name, installed: t.installed })),
  }
}

const AI_TASKS: readonly string[] = AI_TASK_KINDS

/** The `context` of an AI Task body (spec §3.28): only the strings and findings a Task Prompt shows. */
function askContext(body: Record<string, unknown>): AiTaskInput['context'] {
  return taskContext(body.context, (message) => new HttpError(400, message))
}

/** Task, text, context, language and account of an /api/ask body; unknown tasks are refused. */
function askInput(body: Record<string, unknown>): AiTaskInput {
  const task = optString(body, 'task') ?? 'free'
  if (!AI_TASKS.includes(task)) throw new HttpError(400, `"task" must be one of ${AI_TASKS.join(', ')}`)
  const text = optString(body, 'text')
  if (text && text.length > 8000)
    throw new HttpError(400, '"text" is too long; keep it under 8000 characters')
  const lang = optString(body, 'lang')
  if (lang && lang !== 'en' && lang !== 'zh') throw new HttpError(400, '"lang" must be "en" or "zh"')
  const account = optString(body, 'account')
  const terminal = optString(body, 'terminal')
  if (terminal && !TERMINALS.some((t) => t.id === terminal))
    throw new HttpError(400, 'unknown terminal; pick one from the list')
  const context = askContext(body)
  const uploads = body.attachments
  if (
    uploads !== undefined &&
    !(
      Array.isArray(uploads) &&
      uploads.length <= MAX_ATTACHMENTS &&
      uploads.every((u) => typeof u === 'string' && /^[a-f0-9]{16}$/.test(u))
    )
  )
    throw new HttpError(400, `"attachments" must list at most ${MAX_ATTACHMENTS} upload ids`)
  return {
    ...(uploads?.length ? { uploads: uploads as string[] } : {}),
    task,
    ...(text ? { text } : {}),
    ...(context ? { context } : {}),
    ...(lang ? { lang } : {}),
    ...(account ? { account } : {}),
    ...(terminal ? { terminal } : {}),
  }
}

/** A terminal open result as the page needs it: macOS refusing Automation gets its own flag (spec §3.28). */
function opened<T extends { opened: boolean; reason?: string }>(r: T): T & { automation: boolean } {
  return { ...r, automation: !r.opened && r.reason === 'automation-denied' }
}

/** The AI Task upload route; its body is a file, not a JSON object, so it sits outside the route table. */
const ATTACH_ROUTE = '/api/ask/attach'
/** The "Send to it" screenshot upload (spec §3.32 step 2): images only, each at most the image limit. */
const SEND_ATTACH_ROUTE = '/api/sessions/attach'
const IMAGE_ONLY = 'Only images can be sent to a session: add a PNG, JPEG, GIF or WebP screenshot.'
const IMAGE_TOO_BIG = `This image is over ${ATTACHMENT_LIMITS.image / 1024 / 1024} MB; send a smaller screenshot.`

/** Stops a stream once it passes `max` bytes, so a file that is no image cannot run on to the larger video limit. */
async function* capped(source: AsyncIterable<Uint8Array>, max: number, message: string) {
  let n = 0
  for await (const chunk of source) {
    n += chunk.length
    if (n > max) throw new HttpError(413, message)
    yield chunk
  }
}

/** The ids of staged uploads a request lists, checked as `/api/ask` checks them. */
function uploadIds(body: Record<string, unknown>): string[] {
  const ids = body.attachments
  if (ids === undefined) return []
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_ATTACHMENTS ||
    !ids.every((u) => typeof u === 'string' && /^[a-f0-9]{16}$/.test(u))
  )
    throw new HttpError(400, `"attachments" must list at most ${MAX_ATTACHMENTS} upload ids`)
  return ids as string[]
}

/** A Message as the Panel returns it: its files with `~`. */
function messageView(m: MessageReceipt, home: string): MessageReceipt {
  return { ...m, file: tildify(m.file, home), attachments: m.attachments.map((a) => tildify(a, home)) }
}

/** Runs write requests one at a time; a few may wait, the rest are told to retry. */
function writeQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  let inFlight = 0
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight > MAX_QUEUED_WRITES)
      return Promise.reject(new HttpError(409, 'another change is still running; try again in a moment'))
    inFlight++
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run.finally(() => {
      inFlight--
    })
  }
}

/** What the Theme dialog shows (spec §3.34); the config is read again, so a switch from the CLI shows at once. */
async function themesView(rt: Runtime, portal: ResolvedTheme) {
  const chosen = (await loadConfig(rt.paths.configFile).catch(() => rt.config)).panel?.colorTheme ?? NO_THEME
  const colors = await resolveColors(rt.paths, chosen)
  const portalColors = portal.light.length + portal.dark.length > 0
  // Inside a Portal, no Theme chosen means the Portal's colors: a card of their own, in use.
  const pageCard = portalColors
    ? [
        {
          id: NO_THEME,
          name: "This page's colors",
          source: 'portal',
          swatches: portalSwatches(portal),
          problems: [],
          warnings: [],
        },
      ]
    : []
  const listed = (await listThemes(rt.paths)).map((t) => ({
    id: t.id,
    name: t.name,
    ...(t.source === 'builtin' ? { nameZh: BUILTIN_THEMES.find((b) => b.id === t.id)?.name.zh } : {}),
    source: t.source,
    swatches: t.swatches,
    problems: t.problems,
    warnings: t.warnings,
  }))
  const page = chosen === NO_THEME && portalColors
  return {
    active: page ? NO_THEME : colors.id,
    chosen,
    adjusted: colors.adjusted,
    ...(colors.fallback ? { fallback: colors.fallback } : {}),
    portalColors,
    // The token CSS the page swaps in.
    css: tokenStyles(page ? portal : layerTheme(colors, portal)),
    themes: [...pageCard, ...listed],
  }
}

/** A Portal's own page, card, accent tint, main button and dark page, over the Default Theme's where it leaves one out. */
function portalSwatches(portal: ResolvedTheme): string[] {
  const value = (decls: string[], name: string) =>
    decls
      .findLast((d) => d.startsWith(`--${name}:`))
      ?.slice(name.length + 3)
      .trim()
  const sky = BUILTIN_THEMES.find((b) => b.id === DEFAULT_THEME_ID)?.swatches ?? []
  return [
    value(portal.light, 'bg') ?? sky[0],
    value(portal.light, 'accent-soft') ?? sky[1],
    value(portal.light, 'primary') ?? sky[2],
    value(portal.dark, 'bg') ?? sky[3],
  ].filter((c): c is string => typeof c === 'string')
}

/**
 * A Theme the user picked over the Portal's tokens (ADR-0050): its colors win over the Portal's, and what the Theme
 * does not name (font, sizes, header) stays the Portal's.
 */
function layerTheme(colors: ResolvedColors, portal: ResolvedTheme): ResolvedTheme {
  const own = resolveTheme({ light: colors.light, dark: colors.dark })
  return { ...portal, light: [...portal.light, ...own.light], dark: [...portal.dark, ...own.dark] }
}

export function createPanelHandler(opts: PanelHandlerOptions): PanelHandler {
  const basePath = normalizeBase(opts.basePath)
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()))
  const readOnly = Boolean(opts.readOnly)
  const version = opts.version ?? PANEL_VERSION
  const build = buildId()
  const local = localBuild()
  const theme = resolveTheme(opts.theme)
  const lang = resolveLang(opts.lang)
  const updates = opts.updates !== false
  const ask = resolveAsk(opts.ask)
  const token = randomBytes(32).toString('base64url')
  const serial = writeQueue()
  const readings: Readings = new Map()
  const getRuntime = typeof opts.runtime === 'function' ? opts.runtime : async () => opts.runtime as Runtime
  const sessionsSource = (opts as { [LIVE_SESSIONS_SOURCE]?: LiveSessionsSource })[LIVE_SESSIONS_SOURCE]
  const liveSessions = sessionsSource?.list ?? listLiveSessions
  // A change from this page can end a stretch of Unattended Mode: the plugins hear of it now, as after the CLI. The
  // answer waits for that (two small reads when nothing ended), but at most 1 s; a slower plugin finishes on its own.
  const noticeUnattendedEnd = (rt: Runtime) =>
    Promise.race([
      checkUnattendedEnded(rt.paths, async (ctx) => void (await rt.unattendedEnded(ctx))),
      new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
    ])
  const copyText = sessionsSource?.copyText ?? sessionCopyText
  const orcaOf = (rt: Runtime) => sessionsSource?.orca ?? systemOrca(rt.env)
  const sendTo = sessionsSource?.send ?? sendMessage
  const messages = sessionsSource?.messages ?? listMessages
  // Session History loads node:sqlite only when the page first asks for it.
  let historyMod: Promise<HistoryModule> | undefined
  const history = () => (historyMod ??= import('../core/history.ts'))
  // Which Sessions run now, for the "running" mark of History rows: read at most every 5 s, given 3 s.
  const LIVE_FIRST_MS = 300
  let liveMark: { at: number; ids: Promise<Set<string>>; last?: Set<string> } | undefined
  // Which past Sessions run now. A search never waits for that list once one is known: it answers with the last
  // one while a fresh one is read, and waits at most LIVE_FIRST_MS for the very first.
  const liveIds = async (rt: Runtime): Promise<Set<string>> => {
    if (!liveMark || Date.now() - liveMark.at > 5_000) {
      const ids = (
        sessionsSource?.list ? sessionsSource.list(rt) : listLiveSessions(rt, { deadlineMs: 3_000 })
      )
        .then((r) => new Set(r.sessions.map((x) => liveKey(x.account, x.sessionId))))
        .catch(() => new Set<string>())
      const last = liveMark?.last
      liveMark = { at: Date.now(), ids, ...(last ? { last } : {}) }
      const mark = liveMark
      void ids.then((v) => {
        mark.last = v
      })
    }
    if (liveMark.last) return liveMark.last
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<Set<string>>((r) => {
      timer = setTimeout(() => r(new Set()), LIVE_FIRST_MS)
    })
    try {
      return await Promise.race([liveMark.ids, late])
    } finally {
      clearTimeout(timer)
    }
  }
  const toolScans = new Map<string, ToolScan>()
  const dropIdleScans = () => {
    for (const [id, scan] of toolScans)
      if (Date.now() - scan.seen > TOOL_SCAN_IDLE_MS) {
        scan.ctrl.abort()
        toolScans.delete(id)
      }
  }

  // Every route declares whether a request writes files. `writes` defaults to true, so a route that forgets
  // to declare it is refused by a read-only Panel instead of slipping through.
  interface Route {
    writes?: (body: Record<string, unknown>) => boolean
    /** False runs it beside the write queue: a slow read or a probe must not hold other changes back. */
    queued?: boolean
    run(body: Record<string, unknown>): Promise<unknown>
  }
  /**
   * A change of one key in Claude's settings files that the page showed file by file before the user confirmed
   * (Remote Control, spec §3.22; receiving Messages, ADR-0045). Without `confirm` it writes nothing and names the
   * files; with it, `files` must be exactly the files the page showed, or nothing is written and `changedSince` says
   * so, because a file the user never saw in the preview must not change. Undo passes no `todo`: it only puts back
   * what sideby wrote, and its toast runs before the page has read the new state.
   */
  const previewedChange = (change: {
    todo?: (rt: Runtime) => Promise<readonly { file: string }[]>
    apply: (rt: Runtime) => Promise<{ ok: boolean; message: string; results: { file: string }[] }>
  }): Route => ({
    writes: (body) => body.confirm === true,
    async run(body) {
      const rt = await getRuntime()
      const home = rt.paths.home
      const files = change.todo ? (await change.todo(rt)).map((g) => tildify(g.file, home)) : undefined
      if (!optBool(body, 'confirm')) return { applied: false, ...(files ? { files } : {}) }
      if (files) {
        const saw = body.files
        const same = Array.isArray(saw) && saw.length === files.length && files.every((f) => saw.includes(f))
        if (!same) return { applied: false, changedSince: true, files }
      }
      const r = await change.apply(rt)
      return { ...r, applied: true, results: r.results.map((x) => ({ ...x, file: tildify(x.file, home) })) }
    },
  })
  /** The switch of one LaunchAgent sideby writes: the Panel's login item or the Menu Bar Item. */
  const loginItemRoute = (agent: LoginAgent): Route => ({
    writes: (body) => body.confirm === true,
    async run(body) {
      if (typeof body.on !== 'boolean') throw new HttpError(400, '"on" must be true or false')
      const rt = await getRuntime()
      const ctx = autostartCtx(rt)
      const home = rt.paths.home
      const plan = await planAutostart(ctx, body.on ? 'on' : 'off', agent)
      const shown = autostartPlanView(plan, home)
      if (!optBool(body, 'confirm') || plan.blocked) return { plan: shown, applied: false }
      const saw = body.programArguments
      const want = shown.programArguments ?? []
      if (
        plan.action === 'on' &&
        (!Array.isArray(saw) || saw.length !== want.length || saw.some((x, i) => x !== want[i]))
      )
        return { plan: shown, applied: false, changedSince: true }
      const r = await applyAutostart(ctx, plan, agent)
      return {
        applied: true,
        changed: r.changed,
        loaded: r.loaded,
        ...(r.note ? { note: r.note.split(home).join('~') } : {}),
        status: await loginItemView(rt, agent),
      }
    },
  })
  const routes: Record<string, Route> = {
    // AI Tasks (spec §3.28, ADR-0027). The prompt and the account it would use, read only: for the confirm area,
    // the copy fallback and the read-only Panel.
    // Frees a staged upload the person removed from the dialog, so it stops counting toward the staging limit.
    '/api/ask/attach/remove': {
      async run(body) {
        const ids = body.ids
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((x) => typeof x !== 'string'))
          throw new HttpError(400, `"ids" must be a list of at most ${MAX_ATTACHMENTS} upload ids`)
        const rt = await getRuntime()
        return { removed: await removeStaged(rt.paths, ids as string[]) }
      },
    },
    '/api/ask/prompt': {
      writes: () => false,
      queued: false,
      async run(body) {
        const input = askInput(body)
        const rt = await getRuntime()
        const { prompt, removedSecrets } = promptForTask(rt, input, await previewAttachments(rt, input))
        const pick = await pickTaskAccount(rt, input)
        return {
          prompt,
          removedSecrets,
          account: 'account' in pick ? pick.account.ref : null,
          ...('reason' in pick ? { reason: pick.reason } : {}),
        }
      },
    },
    // Writes the task file and opens the terminal. An account the person picked, API ones too, is kept as `ask.account`.
    '/api/ask': {
      async run(body) {
        const input = askInput(body)
        const rt = await getRuntime()
        return opened(await startAiTask(rt, { ...input, remember: Boolean(input.account || input.terminal) }))
      },
    },
    // Runs `sideby login <ref>` in the person's terminal; no AI is involved (spec §3.28 "登录").
    '/api/login': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        return opened(await openLoginInTerminal(await getRuntime(), account))
      },
    },
    // The key box: writes one variable of an API Account's proxy.env. The value is never returned or logged.
    '/api/key': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const value = body.value
        if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'enter the key')
        const name = optString(body, 'var')
        if (name !== undefined && !SECRET_VAR_NAME.test(name))
          throw new HttpError(400, 'use an uppercase variable name such as API_KEY')
        const rt = await getRuntime()
        const found = await rt.resolve(account)
        const family = rt.families.get(found.family)
        if (!family) throw new HttpError(400, 'unknown family')
        if (found.kind !== 'api' && family.secretFileMeansApi !== false)
          throw new UserError(
            'This is a subscription account; sign in instead, or create an API account in New account.',
          )
        const v = name ?? secretVarFor(family)
        const { join } = await import('node:path')
        const r = await setSecret(found.secretFile ?? join(found.dir, 'proxy.env'), v, value.trim())
        return { account: found.ref, var: v, written: true, path: tildify(r.path, rt.paths.home) }
      },
    },
    // `sideby try`: the page has said it spends a few tokens. It starts a program, so it is a write; it runs beside
    // the queue because the Host may take up to a minute.
    '/api/try': {
      queued: false,
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        return tryAccount(await getRuntime(), account, undefined, optString(body, 'model'))
      },
    },
    // Themes (spec §3.34): `use` a Theme, `undo` the last switch, `accent` saves and uses the Theme File custom.json
    // (the current Built-in Theme with that accent), `remove` deletes a Theme File. Answers what GET /api/themes does.
    '/api/theme': {
      async run(body) {
        const rt = await getRuntime()
        try {
          if (typeof body.use === 'string') await useTheme(rt.paths, body.use)
          else if (body.undo === true) await undoTheme(rt.paths)
          else if (typeof body.accent === 'string') {
            const current = (await loadConfig(rt.paths.configFile)).panel?.colorTheme
            const base = BUILTIN_THEMES.some((t) => t.id === current) ? current : undefined
            const checked = checkThemeData({
              schemaVersion: 1,
              name: 'Custom',
              ...(base ? { base } : {}),
              accent: body.accent,
            })
            if (!checked.theme) throw new Error(checked.problems[0])
            await saveThemeFile(rt.paths, 'custom', checked.theme)
            await useTheme(rt.paths, 'custom')
          } else if (typeof body.remove === 'string') await removeThemeFile(rt.paths, body.remove)
          else throw new Error('send "use", "undo", "accent" or "remove"')
        } catch (err) {
          throw new HttpError(400, (err as Error).message)
        }
        return themesView(await getRuntime(), theme)
      },
    },
    // Preferred Terminal and Custom terminal command (spec §3.28): `id` null or left out goes back to the guess;
    // `custom` an empty string removes the template.
    '/api/terminal': {
      async run(body) {
        const id = body.id === undefined ? undefined : optString(body, 'id')
        if (id && !TERMINALS.some((t) => t.id === id))
          throw new HttpError(400, 'unknown terminal; pick one from the list')
        const rt = await getRuntime()
        if (body.custom !== undefined) {
          // Same rules as `sideby terminal --custom`: a saved command is also the one chosen; clearing it drops that choice.
          const custom = optString(body, 'custom')?.trim()
          if (custom) {
            try {
              await setCustomTerminal(rt, custom)
            } catch (err) {
              throw new HttpError(400, (err as Error).message)
            }
          } else {
            const wasChosen = rt.config.terminal?.preferred === 'custom'
            const r = await editConfigTerminal(rt.paths.configFile, {
              custom: undefined,
              ...(wasChosen ? { preferred: undefined } : {}),
            })
            rt.config.terminal = r.after
          }
        }
        if (body.id !== undefined || body.custom === undefined) await setPreferredTerminal(rt, id)
        return terminalsView(rt)
      },
    },
    '/api/doctor': {
      // Only the record of the check is written, and a read-only Panel skips that (persist: false).
      writes: () => false,
      async run(body) {
        const target = optString(body, 'target')
        const rt = await getRuntime()
        return rt.doctorWithHistory({ persist: !readOnly, ...(target ? { target } : {}) })
      },
    },
    '/api/fix': {
      async run(body) {
        const target = optString(body, 'target')
        const force = optBool(body, 'force')
        const rt = await getRuntime()
        return rt.doctorWithHistory({ fix: true, force, ...(target ? { target } : {}) })
      },
    },
    '/api/accounts': {
      async run(body) {
        const family = optString(body, 'family')
        const name = optString(body, 'name')
        if (!family || !name) throw new HttpError(400, 'pick a family and enter a name')
        const api = optBool(body, 'api')
        const alias = optString(body, 'alias')
        const rt = await getRuntime()
        return rt.createAccount(family, name, { api, ...(alias ? { alias } : {}) })
      },
    },
    // Pick Commands (spec §3.13, ADR-0035): start the Account with the most room in the Preferred Terminal, add one
    // (a name that hides a command on PATH comes back as `confirm` until the page sends confirm: true), remove one.
    '/api/pick/start': {
      async run(body) {
        const name = optString(body, 'name')
        if (!name) throw new HttpError(400, '"name" is required')
        const rt = await getRuntime()
        const { family, choice } = await rt.pickChoice(name)
        if (choice.ref === null)
          throw new UserError(
            choice.earliestReset
              ? `Every signed-in ${family} account has used up its quota; ${choice.earliestReset.ref} is back first.`
              : `No ${family} account can be used now; sign one in first.`,
            { code: 'none-usable' },
          )
        // The terminal runs the Pick Command itself, so it picks again as it starts and prints which and why.
        const r = opened(await openPickInTerminal(rt, name))
        return {
          ...r,
          name,
          family,
          picked: choice.ref,
          reason: choice.reason,
          ...('pressure' in choice ? { pressure: choice.pressure, window: choice.window } : {}),
          ...('limit' in choice ? { limit: choice.limit, longLimit: choice.longLimit } : {}),
        }
      },
    },
    '/api/pick/add': {
      async run(body) {
        const name = optString(body, 'name')?.trim()
        const family = optString(body, 'family')
        if (!name || !family) throw new HttpError(400, 'enter a name and pick a family')
        const rt = await getRuntime()
        return rt.addPickCommand(name, family, { yes: optBool(body, 'confirm') })
      },
    },
    '/api/pick/remove': {
      async run(body) {
        const name = optString(body, 'name')
        if (!name) throw new HttpError(400, '"name" is required')
        const rt = await getRuntime()
        if (rt.pickCommandFamily(name) === undefined) throw new HttpError(400, `no pick command "${name}"`)
        return rt.removeAlias(name)
      },
    },
    // `sideby shell-init setup` (ADR-0036): the page has shown the line and the file; undo takes out only that line.
    '/api/shell-init/setup': {
      async run(body) {
        const rt = await getRuntime()
        const { applyShellSetup, userShell } = await import('../core/shell-setup.ts')
        const r = await applyShellSetup(userShell(rt.env), rt.paths.home, rt.env, rt.config.shellInitFile, {
          undo: optBool(body, 'undo'),
        })
        return { status: r.status, shell: r.shell, rc: tildify(r.rc, rt.paths.home) }
      },
    },
    '/api/quota/setup': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const family = optString(body, 'family')
        const confirm = optBool(body, 'confirm')
        if (!family) throw new HttpError(400, '"family" is required')
        const rt = await getRuntime()
        const setup = rt.quotaSetup(family)
        const plan = confirm ? await setup.apply() : await setup.plan()
        return { family, summary: setup.summary, plan }
      },
    },
    // Context tuning (spec §3.18): replays recent local sessions; reads only, so a read-only Panel allows it.
    // The setting lives in a settings file that Accounts often share, so the answer comes grouped by file: one
    // suggestion and one thing to apply per group, with every Account's details alongside.
    '/api/tuning': {
      writes: () => false,
      async run(body) {
        const account = optString(body, 'account')
        const rt = await getRuntime()
        const home = rt.paths.home
        const { accounts, groups } = await rt.tuneGroups(account ? await rt.resolve(account) : undefined)
        return {
          minCalls: MIN_CALLS,
          accounts,
          groups: groups.map((g) => ({ ...g, id: g.file, file: tildify(g.file, home) })),
        }
      },
    },
    // Using a suggestion writes one key of the Account's settings (ADR-0012): without `confirm` it only shows the plan.
    '/api/tuning/apply': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const value = body.value
        if (typeof value !== 'number' && value !== null)
          throw new HttpError(400, '"value" must be a number of tokens, or null for the default')
        const rt = await getRuntime()
        const found = await rt.resolve(account)
        const home = rt.paths.home
        const show = (p: TuneApplyPlan) => ({ ...p, file: tildify(p.file, home) })
        if (!optBool(body, 'confirm')) {
          const plan = await rt.tuneApplyPlan(found, value)
          return { ref: found.ref, applied: false, plan: show(plan), message: plan.reason ?? '' }
        }
        const r = await rt.tuneApply(found, value)
        return { ref: found.ref, applied: r.ok, plan: show(r.plan), message: r.message }
      },
    },
    '/api/tuning/undo': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const rt = await getRuntime()
        const found = await rt.resolve(account)
        const r = await rt.tuneUndo(found)
        return { ref: found.ref, undone: r.ok, message: r.message }
      },
    },
    // Remote Control at startup (spec §3.22, ADR-0017): writes `remoteControlAtStartup` (false for off, true for on)
    // into each Claude settings file that does not hold it yet, only the files the page showed (`previewedChange`).
    '/api/remote-control/off': previewedChange({
      todo: async (rt) => remoteControlTodo(await rt.remoteControl(), 'off'),
      apply: (rt) => rt.remoteControlOff(),
    }),
    '/api/remote-control/on': previewedChange({
      todo: async (rt) => remoteControlTodo(await rt.remoteControl(), 'on'),
      apply: (rt) => rt.remoteControlOn(),
    }),
    '/api/remote-control/undo': previewedChange({ apply: (rt) => rt.remoteControlUndo() }),
    // Sessions (spec §3.32, ADR-0039): what every Account is running now, read only, with the texts its copy buttons
    // copy in the Panel's language. Polled every few seconds, so it runs beside the write queue.
    '/api/sessions': {
      writes: () => false,
      queued: false,
      async run(body) {
        const lang = body.lang === 'zh' ? 'zh' : 'en'
        const rt = await getRuntime()
        const listed = await liveSessions(rt)
        const home = rt.paths.home
        // The Run each Session works for, only where the Session Index and its board file check out (ADR-0041).
        const [sessions, tabs] = await Promise.all([
          // A Session an Auto Handoff chain led to stays linked to its Run under the earlier ids (ADR-0057).
          readHandoffChains(rt.paths.stateDir).then((chains) =>
            withRuns(rt.env, home, withHandoffs(chains, listed.sessions)),
          ),
          orcaTabs(orcaOf(rt), listed.sessions),
        ])
        const problems = listed.problems
        return {
          sessions: sessions.map(
            (s): PanelSession => ({
              ...s,
              ...(s.cwd ? { cwd: tildify(s.cwd, home) } : {}),
              ...(s.run
                ? {
                    run: {
                      ...s.run,
                      board: tildify(s.run.board, home),
                      ...(s.run.others
                        ? { others: s.run.others.map((o) => ({ ...o, board: tildify(o.board, home) })) }
                        : {}),
                    },
                  }
                : {}),
              ...(tabs.has(s.sessionId) ? { orca: true as const } : {}),
              copy: {
                reference: copyText(s, 'reference', lang),
                id: copyText(s, 'id', lang),
                resume: copyText(s, 'resume', lang),
              },
            }),
          ),
          problems: problems.map((p) => p.split(home).join('~')),
        }
      },
    },
    // Session History (spec §3.33): every past Session of every Account, from the History Index sideby keeps in its
    // own state folder. Read only for the Host folders; it answers from what is built and builds the rest behind.
    '/api/history': {
      writes: () => false,
      queued: false,
      async run(body) {
        const lang = body.lang === 'zh' ? 'zh' : 'en'
        const rt = await getRuntime()
        const home = rt.paths.home
        const h = await history()
        const q = historyQuery(body)
        const paths = q.group === 'project'
        if (paths && q.collapsed) q.collapsed = q.collapsed.map((k) => untildify(k, home))
        const r = await h.searchHistory(rt, q, { live: await liveIds(rt) })
        h.syncHistoryInBackground(rt)
        const key = (k: string) => (paths ? tildify(k, home) : k)
        return {
          ...r,
          sessions: r.sessions.map((x) => {
            const v = historyView(x, home, lang)
            return v.group === undefined ? v : { ...v, group: key(v.group) }
          }),
          ...(r.groups ? { groups: r.groups.map((g) => ({ ...g, key: key(g.key) })) } : {}),
          problems: r.problems.map((p) => p.split(home).join('~')),
        }
      },
    },
    '/api/history/projects': {
      writes: () => false,
      queued: false,
      async run(body) {
        const rt = await getRuntime()
        const home = rt.paths.home
        const r = await (await history()).historyProjects(rt, historyQuery(body))
        return {
          ...r,
          projects: r.projects.map((p) => ({ ...p, project: tildify(p.project, home) })),
          ...(r.problems ? { problems: r.problems.map((p) => p.split(home).join('~')) } : {}),
        }
      },
    },
    '/api/history/show': {
      writes: () => false,
      queued: false,
      async run(body) {
        const id = optString(body, 'id')
        if (!id) throw new HttpError(400, '"id" is required')
        const before = body.before
        if (before !== undefined && (typeof before !== 'number' || !Number.isInteger(before) || before < 0))
          throw new HttpError(400, '"before" must be a whole number')
        const lang = body.lang === 'zh' ? 'zh' : 'en'
        const rt = await getRuntime()
        const home = rt.paths.home
        const account = optString(body, 'account')
        const r = await (await history()).historyShow(rt, id, {
          ...(before === undefined ? {} : { before }),
          ...(account ? { account } : {}),
        })
        return { ...r, session: historyView(r.session, home, lang) }
      },
    },
    // "Also search tool output": reads the record files at that moment and keeps nothing (ADR-0042). The page starts
    // one scan, polls it with its id and stops it; a new scan stops the one before.
    '/api/history/tools': {
      writes: () => false,
      queued: false,
      async run(body) {
        dropIdleScans()
        const lang = body.lang === 'zh' ? 'zh' : 'en'
        const rt = await getRuntime()
        const home = rt.paths.home
        const job = optString(body, 'job')
        if (job) {
          const scan = toolScans.get(job)
          if (!scan) throw new HttpError(404, 'This search of tool output has stopped; search again.')
          if (optBool(body, 'cancel')) {
            scan.ctrl.abort()
            toolScans.delete(job)
            return { job, stopped: true }
          }
          scan.seen = Date.now()
          if (scan.finished) toolScans.delete(job)
          return {
            job,
            hits: scan.hits.map((x) => historyView(x, home, lang)),
            done: scan.done,
            total: scan.total,
            finished: scan.finished,
            ...(scan.error ? { error: scan.error } : {}),
          }
        }
        const q = historyQuery(body)
        if (!q.q?.trim()) throw new HttpError(400, 'Type the words to look for first.')
        for (const scan of toolScans.values()) scan.ctrl.abort()
        toolScans.clear()
        const skip = Array.isArray(body.skip)
          ? new Set(body.skip.filter((x): x is string => typeof x === 'string').slice(0, 500))
          : undefined
        const id = randomBytes(8).toString('hex')
        const scan: ToolScan = {
          ctrl: new AbortController(),
          hits: [],
          done: 0,
          total: 0,
          finished: false,
          seen: Date.now(),
        }
        toolScans.set(id, scan)
        const h = await history()
        const started = Date.now()
        void (async () => {
          try {
            for await (const hit of h.scanToolOutput(rt, q, {
              signal: scan.ctrl.signal,
              live: await liveIds(rt),
              ...(skip ? { skip } : {}),
              onProgress: (done, total) => {
                scan.done = done
                scan.total = total
                // A scan stops by itself once the page stops asking, or after TOOL_SCAN_MAX_MS.
                const now = Date.now()
                if (now - scan.seen > TOOL_SCAN_IDLE_MS || now - started > TOOL_SCAN_MAX_MS) scan.ctrl.abort()
              },
            })) {
              scan.hits.push(hit.session)
              if (scan.hits.length >= TOOL_SCAN_MAX_HITS) break
            }
          } catch (err) {
            scan.error = (err instanceof Error ? err.message : String(err)).split(home).join('~')
          }
          scan.finished = true
        })()
        return { job: id, hits: [], done: 0, total: 0, finished: false }
      },
    },
    // How far the History Index is built, and "Delete the index" (it is built again on the next search). Deleting
    // writes only sideby's own state folder, but a read-only Panel still refuses it.
    '/api/history/index': {
      writes: (body) => body.clear === true,
      queued: false,
      async run(body) {
        const rt = await getRuntime()
        const home = rt.paths.home
        const r = await (await history()).historyIndexInfo(rt, { clear: optBool(body, 'clear') })
        return { ...r, path: tildify(r.path, home) }
      },
    },
    // Brings the Orca tab a Session runs in to the front (ADR-0039). The page sends only the Session id: the handle is
    // found again here, from the running process and Orca's own list. It starts a program, so a read-only Panel
    // refuses it (writes defaults to true).
    '/api/sessions/orca': {
      queued: false,
      async run(body) {
        const id = optString(body, 'sessionId')
        if (!id) throw new HttpError(400, '"sessionId" is required')
        const rt = await getRuntime()
        const session = (await liveSessions(rt)).sessions.find((s) => s.sessionId === id)
        if (!session) throw new HttpError(404, 'This session is no longer running; refresh the list.')
        const orca = orcaOf(rt)
        const handle = (await orcaTabs(orca, [session])).get(id)
        if (!handle)
          throw new HttpError(409, 'This session is not in an Orca tab any more; refresh the list.')
        await switchOrcaTab(orca, handle)
        return { switched: true }
      },
    },
    // "Send to it" (spec §3.32 step 2): text and the screenshots staged through SEND_ATTACH_ROUTE go to one Live
    // Session through sendMessage, which keeps the Message as a file before any delivery. The page sends only the
    // Session id. It writes files, so a read-only Panel refuses it (writes defaults to true); it runs beside the
    // write queue because a delivery may wait on the Host.
    // Opens the Run Board of a Session (spec §3.32 step 2b, ADR-0041). The page sends only the Session id: the board
    // file is found again here, from the Session Index, and checked again. It starts a program, so a read-only Panel
    // refuses it (writes defaults to true).
    '/api/sessions/run': {
      queued: false,
      async run(body) {
        const id = optString(body, 'sessionId')
        if (!id) throw new HttpError(400, '"sessionId" is required')
        const rt = await getRuntime()
        const r = await openRunBoard(rt, id)
        return { opened: true, board: tildify(r.board, rt.paths.home) }
      },
    },
    '/api/sessions/send': {
      queued: false,
      async run(body) {
        const id = optString(body, 'sessionId')
        if (!id) throw new HttpError(400, '"sessionId" is required')
        if (body.text !== undefined && typeof body.text !== 'string')
          throw new HttpError(400, '"text" must be text')
        const text = ((body.text as string | undefined) ?? '').trim()
        if (text.length > MAX_MESSAGE_TEXT)
          throw new HttpError(400, `The message is over ${MAX_MESSAGE_TEXT} characters; shorten it.`)
        const ids = uploadIds(body)
        if (!text && !ids.length) throw new HttpError(400, 'Write a message or add a screenshot first.')
        const lang = body.lang === 'zh' ? 'zh' : 'en'
        const rt = await getRuntime()
        const images = ids.length ? await stagedAttachments(rt.paths, ids) : []
        if (images.some((f) => f.kind !== 'image')) throw new HttpError(415, IMAGE_ONLY)
        const session = (await liveSessions(rt)).sessions.find((s) => s.sessionId === id)
        if (!session) throw new HttpError(404, 'This session is no longer running; refresh the list.')
        // The person at the Panel sends it, never a Session the server happens to run under.
        const receipt = await sendTo(rt, id, {
          text,
          images: images.map((f) => f.path),
          lang,
          fromUser: true,
        })
        // The Message has its own copies now; the staged ones would only wait a day to be cleared.
        await removeStaged(rt.paths, ids).catch(() => 0)
        // Only a Message the user pastes needs the way to the target's tab.
        const tabs =
          receipt.status === 'paste-needed'
            ? await orcaTabs(orcaOf(rt), [session])
            : new Map<string, string>()
        return {
          message: messageView(receipt, rt.paths.home),
          ...(tabs.has(id) ? { orca: true as const } : {}),
        }
      },
    },
    // The latest Message to each Session, for the chips on the Sessions page; polled with the list, read only.
    '/api/sessions/messages': {
      writes: () => false,
      queued: false,
      async run() {
        const latest: Record<string, PanelMessageStatus> = {}
        // Newest first: the first one met for a Session is its latest.
        for (const m of await messages(await getRuntime(), { limit: 200, persist: !readOnly }))
          latest[m.toSessionId] ??= {
            id: m.id,
            status: m.status,
            sentAt: m.sentAt,
            to: m.to,
            ...(m.from ? { from: m.from } : {}),
            ...(m.status === 'paste-needed' || m.status === 'unknown' ? { pasteText: m.pasteText } : {}),
            ...(m.note ? { note: m.note } : {}),
            ...(m.needsApproval ? { needsApproval: true as const } : {}),
          }
        return { latest }
      },
    },
    // Receiving Messages (ADR-0045): whether each Claude settings file lets its sessions show a Message at once, and
    // the same change as `sideby messages inbound accept|undo`; the page shows each file's change before it asks.
    '/api/messages/inbound': {
      writes: () => false,
      queued: false,
      async run() {
        const rt = await getRuntime()
        const accounts = await rt.accounts()
        const groups = await inboundGroups(accounts, rt.readContext())
        const waits = await waitingFiles(groups, accounts, startArgsOf(rt.config, accounts))
        const home = rt.paths.home
        return {
          groups: groups.map(
            (g): PanelInboundGroup => ({
              ...g,
              file: tildify(g.file, home),
              ...(g.reason ? { reason: g.reason.split(home).join('~') } : {}),
              waits: waits.has(g.file),
            }),
          ),
        }
      },
    },
    '/api/messages/inbound/accept': previewedChange({
      todo: async (rt) => groupsToAccept(await inboundGroups(await rt.accounts(), rt.readContext())),
      apply: async (rt) => acceptInbound(await rt.accounts(), rt.readContext()),
    }),
    '/api/messages/inbound/undo': previewedChange({
      apply: async (rt) => undoInbound(await rt.accounts(), rt.readContext()),
    }),
    // Auto Handoff (spec §3.17): readiness reads only; configure shows the config change unless `confirm`.
    '/api/handoff/status': {
      writes: () => false,
      async run() {
        return handoffStatus(await getRuntime())
      },
    },
    '/api/handoff/configure': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const change = handoffChange(body)
        const rt = await getRuntime()
        const r = await configureHandoff(rt, change, { apply: optBool(body, 'confirm') })
        return { ...r, file: tildify(r.file, rt.paths.home) }
      },
    },
    // Model and effort per Account (spec §3.19, ADR-0014): without `confirm` only the config diff.
    // `model` / `effort`: left out keeps it, null goes back to the Host's default, a string sets it.
    '/api/account/model': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const change: { model?: string | null; effort?: string | null } = {}
        for (const k of ['model', 'effort'] as const) {
          const v = body[k]
          if (v === undefined) continue
          if (v !== null && typeof v !== 'string')
            throw new HttpError(400, `"${k}" must be a string, or null for the default`)
          change[k] = v
        }
        const rt = await getRuntime()
        const found = await rt.resolve(account)
        const r = await setAccountModel(rt, found, change, { apply: optBool(body, 'confirm') })
        return { ref: found.ref, ...r, file: tildify(r.file, rt.paths.home) }
      },
    },
    // Opens the Account's Desktop App, or brings its window to the front (spec §3.20). It creates the Account's
    // app data folder and starts a program, so a read-only Panel refuses it (writes defaults to true).
    '/api/account/desktop': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const rt = await getRuntime()
        const r = await openDesktopApp(rt, account)
        const home = rt.paths.home
        return {
          ...r,
          appPath: tildify(r.appPath, home),
          ...(r.appData ? { appData: tildify(r.appData, home) } : {}),
        }
      },
    },
    // Opens the Account's Host settings file with the system's default program (spec §3.30, ADR-0033). It reads none
    // of the file but starts a program, so a read-only Panel refuses it (writes defaults to true).
    '/api/account/edit-settings': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const rt = await getRuntime()
        const r = await editSettings(rt, account)
        const home = rt.paths.home
        return { ...r, path: tildify(r.path, home), ...(r.target ? { target: tildify(r.target, home) } : {}) }
      },
    },
    // Unattended Mode (spec §3.37): the page's status and Pending Decisions. A read-only Panel reads them too.
    '/api/unattended': {
      writes: () => false,
      queued: false,
      async run() {
        return unattendedView(await getRuntime(), readOnly, liveSessions)
      },
    },
    // Turns it on now: `slotEnd`, `for` (4h, 12h) or `until` (07:30, the next time it is 07:30; or a date and time).
    '/api/unattended/on': {
      async run(body) {
        const choice = {
          ...(body.slotEnd === true ? { slotEnd: true } : {}),
          ...(optString(body, 'for') ? { for: optString(body, 'for') } : {}),
          ...(optString(body, 'until') ? { until: optString(body, 'until') } : {}),
        }
        const rt = await getRuntime()
        const now = new Date()
        const { schedule } = await readUnattendedConfig(rt.paths.configFile)
        const r = onUntil(choice, schedule, now)
        if ('error' in r) throw new HttpError(400, r.error, 'bad-time')
        const change = await turnUnattendedOn({
          paths: rt.paths,
          families: [...rt.families.keys()],
          until: r.until,
          now,
        })
        await noticeUnattendedEnd(rt)
        return panelChange(change, rt.paths.stateDir)
      },
    },
    // Off now; inside a Slot, a pause until that Slot ends.
    '/api/unattended/off': {
      async run() {
        const rt = await getRuntime()
        const change = await turnUnattendedOff({ paths: rt.paths, families: [...rt.families.keys()] })
        await noticeUnattendedEnd(rt)
        return panelChange(change, rt.paths.stateDir)
      },
    },
    // The whole Schedule at once: every edit on the page writes it, and its Undo writes `previous` back.
    '/api/unattended/schedule': {
      async run(body) {
        if (!Array.isArray(body.schedule)) throw new HttpError(400, '"schedule" must be a list of Slots')
        const rt = await getRuntime()
        const r = await setUnattendedSchedule({
          paths: rt.paths,
          families: [...rt.families.keys()],
          schedule: body.schedule,
        })
        await noticeUnattendedEnd(rt)
        return {
          changed: r.changed,
          status: await withPendingIds(r.status, rt.paths.stateDir),
          previous: r.previous,
        }
      },
    },
    // Marks one Pending Decision done (or every open one with `all`), or with `done: false` opens one again.
    '/api/unattended/pending': {
      async run(body) {
        const id = optString(body, 'id')
        const all = body.all === true
        if (!id && !all) throw new HttpError(400, '"id" or "all" is required')
        const rt = await getRuntime()
        try {
          const changed =
            body.done === false && id
              ? [await reopenPendingDecision(rt.paths.stateDir, id)]
              : await markPendingDone(rt.paths.stateDir, all ? 'all' : id!)
          return { ids: changed.map((d) => d.id) }
        } catch (err) {
          throw new HttpError(400, (err as Error).message, 'no-pending')
        }
      },
    },
    // Network Guard (spec §3.35): asks every address now. Only sideby's own cache changes, so a read-only Panel may.
    '/api/network/check': {
      writes: () => false,
      async run() {
        return (await getRuntime()).networkStatus({ check: true })
      },
    },
    // Network Guard's switch and countries (spec §3.35): config `network`, shown first like every config change.
    '/api/network/settings': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const change: NetworkChange = {}
        if (body.guard !== undefined) {
          if (typeof body.guard !== 'boolean') throw new HttpError(400, '"guard" must be true or false')
          change.guard = body.guard
        }
        if (body.allow !== undefined) {
          if (!Array.isArray(body.allow) || !body.allow.every((x) => typeof x === 'string'))
            throw new HttpError(400, '"allow" must be a list of country codes')
          change.allow = body.allow as string[]
        }
        const rt = await getRuntime()
        const r = await setNetwork(rt.paths.configFile, change, { apply: optBool(body, 'confirm') })
        return { ...r, file: tildify(r.file, rt.paths.home) }
      },
    },
    // Browser Sign-ins on or off (spec §3.24): config `browser.signIns`, shown first like every config change.
    '/api/browser/settings': {
      writes: (body) => body.confirm === true,
      async run(body) {
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false')
        const rt = await getRuntime()
        const r = await setBrowserSignIns(rt, body.enabled, { apply: optBool(body, 'confirm') })
        return { ...r, file: tildify(r.file, rt.paths.home) }
      },
    },
    // Opens the Account's website in one Chrome browser user (spec §3.24). It starts a program, so a read-only Panel
    // refuses it (writes defaults to true).
    '/api/browser/open': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        const rt = await getRuntime()
        const profile = optString(body, 'profile')
        return openInBrowser(rt, await rt.resolve(account), profile)
      },
    },
    // Chooses the Chrome browser user of an Account, or with profile null lets sideby find it again (spec §3.24 "手动指定").
    // It writes sideby's config only.
    '/api/browser/choose': {
      async run(body) {
        const account = optString(body, 'account')
        if (!account) throw new HttpError(400, '"account" is required')
        if (body.profile !== null && typeof body.profile !== 'string')
          throw new HttpError(400, '"profile" must be a browser user folder or null')
        const rt = await getRuntime()
        return setBrowserChoice(rt, await rt.resolve(account), body.profile)
      },
    },
    // Opens a Grok Bot window, creating it when the name is new, or brings it to the front (ADR-0019).
    '/api/app-profile/open': {
      async run(body) {
        const ref = optString(body, 'ref')
        if (!ref) throw new HttpError(400, '"ref" is required')
        const rt = await getRuntime()
        const r = await openAppProfile(rt, ref)
        const home = rt.paths.home
        return {
          ...r,
          appPath: tildify(r.appPath, home),
          ...(r.appData ? { appData: tildify(r.appData, home) } : {}),
        }
      },
    },
    // Removes a Grok Bot window's data folder (ADR-0019). The page asks first, so this call is the confirmation.
    '/api/app-profile/remove': {
      async run(body) {
        const ref = optString(body, 'ref')
        if (!ref) throw new HttpError(400, '"ref" is required')
        const rt = await getRuntime()
        const r = await removeAppProfile(rt, ref, { yes: true })
        return { ...r, appData: tildify(r.appData, rt.paths.home) }
      },
    },
    // The Auto Handoff page (spec §3.17): where work would go next and the last hand-overs. Reads only.
    '/api/handoff/overview': {
      writes: () => false,
      async run() {
        const rt = await getRuntime()
        // The Handoff Rules and where work would go now, also while it is off (spec §3.17 "接力规则").
        const overview = await handoffOverview(rt, { always: true })
        const { rules, apiUndecided } = await handoffRulesView(rt, overview)
        return { ...overview, rules, apiUndecided }
      },
    },
    // Turning it on in one step (ADR-0013): without `confirm` only the plan; with it, every step in order.
    '/api/handoff/enable': {
      writes: (body) => body.confirm === true,
      async run(body) {
        // Left out keeps the current setting; true or false sets it.
        const sameFamily = body.sameFamily === undefined ? undefined : optBool(body, 'sameFamily')
        const rt = await getRuntime()
        const home = rt.paths.home
        const show = (p: EnablePlan): EnablePlan => ({
          ...p,
          steps: p.steps.map((s) => (s.file ? { ...s, file: tildify(s.file, home) } : s)),
        })
        const opts = sameFamily === undefined ? {} : { sameFamily }
        if (!optBool(body, 'confirm')) return show(await planHandoffEnable(rt, opts))
        // `expect`: the key of the plan the person saw; a different plan now is shown again, not applied.
        const expect = optString(body, 'expect')
        const r = await applyHandoffEnable(rt, expect === undefined ? opts : { ...opts, expect })
        return { ...r, plan: show(r.plan) }
      },
    },
    // Update (spec §3.23, ADR-0021): asks the registry, and runs the plan only with `confirm` and the `version` the
    // person saw. When the registry names another version now, nothing runs and the new plan comes back (`changed`).
    // It writes the cache even without `confirm`, so a read-only Panel refuses it (writes defaults to true).
    '/api/update': {
      async run(body) {
        if (!updates) throw new HttpError(403, 'updates are managed by the page that shows this panel')
        const rt = await getRuntime()
        const plan = await update.planUpdate(rt.paths, rt.env)
        const shown = update.shownPlan(plan)
        if (!optBool(body, 'confirm')) return { ...shown, updated: false }
        // The CLI is current and the skill is behind: `skill: true` updates it alone, as `sideby update --skill --yes` does.
        if (optBool(body, 'skill')) {
          if (plan.available || plan.method.kind === 'local')
            return { ...shown, updated: false, changed: true }
          const r = await update.applySkillOnly(rt.paths, plan.skill, rt.env)
          if (!r) return { ...shown, updated: false, changed: true }
          if (!r.ok) throw new UserError(r.message)
          return { ...shown, updated: false, skillUpdated: true, message: r.message }
        }
        // A confirmation that runs nothing always says why: the registry names another version (or none newer) now.
        if (body.version !== plan.latest || !plan.available)
          return { ...shown, updated: false, changed: true }
        const { backgroundPanelPort } = await import('./background.ts')
        const r = await update.applyUpdate(rt.paths, plan, rt.env, {
          panelPort: () => backgroundPanelPort(rt.paths),
          skillSync: 'background',
        })
        if (!r.ok) throw new UserError(r.message)
        return {
          ...shown,
          updated: true,
          message: r.message,
          restartedPanel: r.restartedPanel,
          refreshedApp: r.refreshedApp,
          ...(r.skillUpdated === undefined ? {} : { skillUpdated: r.skillUpdated }),
          ...(r.skillSyncStarted === undefined ? {} : { skillSyncStarted: r.skillSyncStarted }),
        }
      },
    },
    // The Local Build switch (ADR-0024): without `confirm` the current status; with it, `to` goes behind the global
    // `sideby` and a background Panel restarts from it. The page then waits for the new build and reloads.
    '/api/local': {
      async run(body) {
        if (!updates) throw new HttpError(403, 'updates are managed by the page that shows this panel')
        const to = body.to
        if (to !== 'local' && to !== 'npm') throw new HttpError(400, '"to" must be "local" or "npm"')
        const rt = await getRuntime()
        const lb = await import('../core/local-build.ts')
        const d = await switchDirs(rt, await update.installMethod(rt.env))
        if (!d)
          throw new UserError('`npm prefix -g` failed; switching needs npm on PATH and an npm global install')
        if (!optBool(body, 'confirm')) return { ...(await lb.localStatus(d)), to, switched: false }
        const { backgroundPanelPort } = await import('./background.ts')
        // The skill fetch can outlast what a Portal waits for: it runs on its own, and the answer comes at once.
        const r = await lb.switchLocal(rt.paths, d, to, rt.env, {
          panelPort: () => backgroundPanelPort(rt.paths),
          skillSync: 'background',
        })
        if (!r.ok) throw new UserError(r.message)
        return {
          ...(await lb.localStatus(d)),
          to,
          switched: !r.unchanged,
          message: r.message,
          restartedPanel: r.restartedPanel,
          ...(r.skillSyncStarted === undefined ? {} : { skillSyncStarted: r.skillSyncStarted }),
        }
      },
    },
    // The Auto Update switch: config `update.auto`, shown as a diff first like every config change.
    '/api/update/settings': {
      writes: (body) => body.confirm === true,
      async run(body) {
        if (!updates) throw new HttpError(403, 'updates are managed by the page that shows this panel')
        if (typeof body.auto !== 'boolean') throw new HttpError(400, '"auto" must be true or false')
        const auto = body.auto
        const rt = await getRuntime()
        const r = await editConfigUpdate(rt.paths.configFile, (cur) => ({ ...cur, auto }), {
          dryRun: !optBool(body, 'confirm'),
        })
        return {
          ...r,
          applied: optBool(body, 'confirm') && r.changed,
          file: tildify(rt.paths.configFile, rt.paths.home),
        }
      },
    },
    // Display Order (spec §3.25): replaces config `display`, or removes it for null. The drag itself is the preview.
    '/api/display-order': {
      async run(body) {
        const display = displayBody(body)
        const rt = await getRuntime()
        return { display: await rt.setDisplayOrder(display) }
      },
    },
    // Asks every Family that fetches Quota again now, and waits (spec §3.26); the page reloads its state after.
    '/api/quota/refresh': {
      async run() {
        const rt = await getRuntime()
        await rt.refreshQuota()
        return { ok: true }
      },
    },
    // A Family's Quota check on or off: config `quota.check.<family>` (spec §3.26).
    '/api/quota/check': {
      async run(body) {
        const family = optString(body, 'family')
        if (!family) throw new HttpError(400, '"family" is required')
        if (typeof body.on !== 'boolean') throw new HttpError(400, '"on" must be true or false')
        const rt = await getRuntime()
        return { family, ...(await rt.setQuotaCheck(family, body.on)) }
      },
    },
    // The Panel's theme and language (spec §3.29): config `panel.theme` and `panel.language`; null removes one.
    '/api/panel/settings': {
      async run(body) {
        const patch: Parameters<typeof editConfigPanel>[1] = {}
        for (const [k, v] of Object.entries(body)) {
          if (k === 'theme') {
            if (v !== null && !PANEL_THEMES.some((x) => x === v))
              throw new HttpError(400, '"theme" must be "system", "light", "dark" or null')
            patch.theme = v as PanelConfig['theme'] | null
          } else if (k === 'language') {
            if (v !== null && !PANEL_LANGUAGES.some((x) => x === v))
              throw new HttpError(400, '"language" must be "auto", "en", "zh" or null')
            patch.language = v as PanelConfig['language'] | null
          } else throw new HttpError(400, `unknown setting "${k}"`)
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'send "theme" or "language"')
        const rt = await getRuntime()
        const r = await editConfigPanel(rt.paths.configFile, patch)
        return { changed: r.changed, panel: r.after ?? {} }
      },
    },
    // Start at login (spec §3.29, ADR-0029) and the Menu Bar Item (spec §3.31, ADR-0034). Without `confirm` the plan:
    // the file and what it starts, nothing is written. With it, a fresh plan runs only while it starts what the person
    // saw (`programArguments`).
    '/api/autostart': loginItemRoute(PANEL_AGENT),
    '/api/menubar': loginItemRoute(MENUBAR_AGENT),
    // "Can't see the icon?": System Settings › Menu Bar, where macOS 26 and later ask to allow it.
    '/api/menubar/settings': {
      async run() {
        const rt = await getRuntime()
        if (!(await openMenuBarSettings(autostartCtx(rt))))
          throw new UserError('Could not open System Settings; open it yourself and choose Menu Bar')
        return { opened: true }
      },
    },
    // The shortcut that opens the menu bar item (spec §3.31): `keys` as `sideby menubar hotkey` takes it.
    '/api/menubar/hotkey': {
      async run(body) {
        const keys = optString(body, 'keys')
        if (!keys) throw new HttpError(400, '"keys" is required, such as "ctrl+opt+s", "off" or "default"')
        const rt = await getRuntime()
        const r = await setMenubarHotkey({
          configFile: rt.paths.configFile,
          stateDir: rt.paths.stateDir,
          value: keys,
          ctx: autostartCtx(rt),
        })
        return r
      },
    },
    // Undo for the quota setup above; the Runtime turns a teardown that throws into `{ ok: false, message }`.
    '/api/quota/teardown': {
      async run(body) {
        const family = optString(body, 'family')
        if (!family) throw new HttpError(400, '"family" is required')
        const rt = await getRuntime()
        return { family, result: await rt.quotaSetup(family).teardown() }
      },
    },
  }

  // An AI Task attachment (spec §3.28 "附件"): the body is the file itself, streamed into the staging folder rather than
  // read into memory, with its own size limit. The type comes from its first bytes; `Content-Type` is not trusted.
  const receiveAttachment = async (req: IncomingMessage) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
      throw new HttpError(413, 'This file is over 200 MB; attach a smaller one.')
    try {
      // Stopping early (a wrong type, too big) must not destroy the socket the answer goes out on.
      const { id, kind, bytes } = await stageUpload(
        (await getRuntime()).paths,
        req.iterator({ destroyOnReturn: false }),
      )
      return { id, kind, bytes }
    } catch (err) {
      const code = (err as UserError).code
      if (code === 'attachment-too-large') throw new HttpError(413, (err as Error).message)
      if (code === 'attachment-type') throw new HttpError(415, (err as Error).message)
      // The staging folder is full: the server's own limit, whatever the page allows.
      if (code === 'attachment-quota') throw new HttpError(507, (err as Error).message, code)
      throw err
    }
  }

  // A "Send to it" screenshot: staged like an AI Task attachment, but only an image is kept, and the stream stops at
  // the image limit whatever the file turns out to be.
  const receiveImage = async (req: IncomingMessage) => {
    const max = ATTACHMENT_LIMITS.image
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) throw new HttpError(413, IMAGE_TOO_BIG)
    const rt = await getRuntime()
    let staged: Awaited<ReturnType<typeof stageUpload>>
    try {
      staged = await stageUpload(
        rt.paths,
        capped(req.iterator({ destroyOnReturn: false }), max, IMAGE_TOO_BIG),
      )
    } catch (err) {
      const code = (err as UserError).code
      if (code === 'attachment-too-large') throw new HttpError(413, IMAGE_TOO_BIG)
      if (code === 'attachment-type') throw new HttpError(415, IMAGE_ONLY)
      if (code === 'attachment-quota') throw new HttpError(507, (err as Error).message, code)
      throw err
    }
    if (staged.kind !== 'image') {
      await removeStaged(rt.paths, [staged.id])
      throw new HttpError(415, IMAGE_ONLY)
    }
    return { id: staged.id, kind: staged.kind, bytes: staged.bytes }
  }
  // Routes whose body is a file rather than a JSON object.
  const uploads: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    [ATTACH_ROUTE]: receiveAttachment,
    [SEND_ATTACH_ROUTE]: receiveImage,
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      return false
    }
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false
    const sub = pathname.slice(basePath.length) || '/'

    try {
      const host = (req.headers.host ?? '').toLowerCase()
      if (!allowed.has(host)) throw new HttpError(403, 'host not allowed')
      const method = req.method ?? 'GET'

      if (method === 'GET' || method === 'HEAD') {
        if (sub === '/' || sub === '/index.html') {
          const nonce = randomBytes(16).toString('base64')
          // The theme and language in config (spec §3.29), so the first paint has them; a config that cannot be
          // read leaves the defaults, and /api/state reports the problem.
          const panel =
            method === 'HEAD'
              ? undefined
              : await getRuntime().then(
                  (rt) => rt.config.panel,
                  () => undefined,
                )
          // The user's Theme under the Portal's colors (spec §3.34): `?theme=preview` shows the Theme `sideby theme
          // preview` set, for this load only. A Theme that cannot be read leaves the default and Settings says why.
          const preview = new URL(req.url ?? '/', 'http://x').searchParams.get('theme') === 'preview'
          const colors =
            method === 'HEAD'
              ? undefined
              : await getRuntime().then(
                  async (rt) =>
                    (preview ? await previewColors(rt.paths) : undefined) ??
                    (rt.config.panel?.colorTheme && rt.config.panel.colorTheme !== NO_THEME
                      ? await resolveColors(rt.paths, rt.config.panel.colorTheme)
                      : undefined),
                  () => undefined,
                )
          // No Theme chosen: the page's own tokens (the Default Theme) under the Portal's. A chosen Theme, even the
          // Default one, wins over the Portal's colors.
          const pageTheme = colors ? layerTheme(colors, theme) : theme
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'content-security-policy': [
              "default-src 'none'",
              `script-src 'nonce-${nonce}'`,
              `style-src 'nonce-${nonce}'`,
              "connect-src 'self'",
              "img-src 'self' data:",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'self'",
            ].join('; '),
          })
          res.end(
            method === 'HEAD'
              ? undefined
              : renderPage({
                  basePath,
                  token,
                  nonce,
                  version,
                  build,
                  local,
                  readOnly,
                  theme: pageTheme,
                  lang,
                  updates,
                  ...(ask ? { ask } : {}),
                  ...(panel ? { panel } : {}),
                }),
          )
          return true
        }
        // The mark, for a Portal's tab and for this page's favicon (ADR-0006 amendment).
        if (sub === '/icon.svg' || sub === '/favicon.svg') {
          res.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
          })
          res.end(method === 'HEAD' ? undefined : sub === '/icon.svg' ? ICON_SVG : FAVICON_SVG)
          return true
        }
        if (sub === '/api/health') {
          send(res, 200, { app: 'sideby', version, build })
          return true
        }
        // The page fetches a fresh token here after the server restarted (a new process, a new token).
        // It reveals nothing a same-origin read of the page does not; a cross-site page cannot read it.
        if (sub === '/api/session') {
          if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'origin not allowed')
          send(res, 200, { token })
          return true
        }
        // Themes (spec §3.34): every Theme with its swatches and problems, and the one in use.
        if (sub === '/api/themes') {
          send(res, 200, await themesView(await getRuntime(), theme))
          return true
        }
        if (sub === '/api/terminals') {
          send(res, 200, await terminalsView(await getRuntime()))
          return true
        }
        // Start at login (spec §3.29): its state only; turning it on or off is the POST of the same path.
        if (sub === '/api/autostart' || sub === '/api/menubar') {
          const rt = await getRuntime()
          send(res, 200, await loginItemView(rt, sub === '/api/menubar' ? MENUBAR_AGENT : PANEL_AGENT))
          return true
        }
        if (sub === '/api/state') {
          send(
            res,
            200,
            await buildState(await getRuntime(), { version, build, readOnly, updates, readings }),
          )
          return true
        }
        if (Object.hasOwn(routes, sub) || Object.hasOwn(uploads, sub)) throw new HttpError(405, 'use POST')
        throw new HttpError(404, 'not found')
      }

      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const route = Object.hasOwn(routes, sub) ? routes[sub] : undefined
      const upload = Object.hasOwn(uploads, sub) ? uploads[sub] : undefined
      if (!route && !upload) throw new HttpError(404, 'not found')
      const origin = req.headers.origin
      if (!origin || origin.toLowerCase() !== `http://${host}`) throw new HttpError(403, 'origin not allowed')
      const given = req.headers['x-sideby-token']
      if (typeof given !== 'string' || !sameSecret(given, token))
        throw new HttpError(403, 'missing or wrong x-sideby-token; reload the page', 'bad-token')
      if (!route) {
        // An upload writes a file: a read-only Panel refuses it before reading a byte.
        if (readOnly) throw new HttpError(403, 'this panel is read-only')
        send(res, 200, await upload!(req))
        return true
      }
      const body = (await readBody(req)) as Record<string, unknown>
      if (readOnly && (route.writes?.(body) ?? true)) throw new HttpError(403, 'this panel is read-only')
      // Reads that record history (doctor) also run in this queue, so overlapping checks merge in order.
      const result = await (route.queued === false ? route.run(body) : serial(() => route.run(body)))
      // A change may concern an Account whose read began before it: the next state reads again.
      if (route.writes?.(body) ?? true) readings.clear()
      send(res, 200, result)
      return true
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return true
      }
      if (err instanceof HttpError) {
        const body = err.code ? { error: err.message, code: err.code } : { error: err.message }
        // A refused body (too big, or an upload stopped early) is left unread: close the connection after answering.
        const unread = err.status === 413 || (Object.hasOwn(uploads, sub) && !req.readableEnded)
        send(res, err.status, body, unread ? { connection: 'close' } : {})
        if (unread) req.resume()
      } else if (err instanceof UserError) {
        send(res, 400, err.code ? { error: err.message, code: err.code } : { error: err.message })
      } else {
        send(res, 500, { error: (err as Error)?.message || 'internal error' })
      }
      return true
    }
  }
  return Object.assign(handle, { token })
}
