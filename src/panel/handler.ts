// HTTP handler for the local Panel. Mountable under any basePath; standalone and embedded use the same rules.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { aliasesByAccount } from '../core/accounts.ts'
import {
  type AppProfileStatus,
  listAppProfiles,
  openAppProfile,
  removeAppProfile,
} from '../core/app-profiles.ts'
import { FAVICON_SVG, ICON_SVG } from '../core/brand-mark.ts'
import {
  type BrowserReport,
  browserReport,
  openInBrowser,
  setBrowserSignIns,
} from '../core/browser-profiles.ts'
import {
  aliasArgs,
  aliasRefs,
  type DisplayConfig,
  editConfigUpdate,
  type HandoffSettings,
} from '../core/config.ts'
import { openDesktopApp, withDesktopApps } from '../core/desktop-app.ts'
import { UserError } from '../core/errors.ts'
import { planHandoff } from '../core/handoff.ts'
import { applyHandoffEnable, type EnablePlan, planHandoffEnable } from '../core/handoff-enable.ts'
import { handoffOverview } from '../core/handoff-overview.ts'
import { configureHandoff, type HandoffChange, handoffStatus } from '../core/handoff-status.ts'
import { type AccountModel, accountModel, setAccountModel } from '../core/model-choice.ts'
import { tildify } from '../core/paths.ts'
import type { RemoteControlGroup } from '../core/remote-control.ts'
import { SKILL_INSTALL } from '../core/skill-check.ts'
import { MIN_CALLS } from '../core/tuning.ts'
import type { TuneApplyPlan } from '../core/tuning-apply.ts'
import * as update from '../core/update.ts'
import { buildId, localBuild, packageVersion } from '../core/version.ts'
import { HOOK_FAMILIES } from '../handoff/hook.ts'
import type { AccountStatus, DoctorHistory, FamilyInfo, QuotaCheckInfo, Runtime } from '../runtime.ts'
import type { Account, FamilyLogo, QuotaResult, QuotaSetupPlan, UsageResult } from '../types.ts'
import { renderPage } from './page.ts'
import { type PanelTheme, resolveTheme } from './theme.ts'

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

/** A Family as the page sees it: FamilyInfo plus the mark from its FamilyDef. */
export type PanelFamily = FamilyInfo & { logo?: FamilyLogo }

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
  /**
   * Family → the Account `sideby next <family>` would pick (spec §3.13). Only Families with a Quota source,
   * at least two subscription Accounts, some Quota data and a pick; API Accounts are left out as in the CLI default.
   */
  handoff?: Record<string, string>
  /** Auto Handoff settings (spec §3.17) and the Families that can start one; readiness comes from /api/handoff/status. */
  autoHandoff: { settings: HandoffSettings; starters: string[] }
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
}

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
    const list = accounts.filter((a) => a.family === id)
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

async function buildState(
  rt: Runtime,
  opts: { version: string; build: string; readOnly: boolean; updates: boolean },
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
  const aliases = aliasesByAccount(aliasRefs(rt.config.aliases), accounts)
  // Desktop Apps (spec §3.20): one process listing for every Account, run alongside the per-Account reads.
  const [states, appProfiles] = await Promise.all([
    withDesktopApps(rt, accounts, Promise.all(accounts.map((a) => accountState(rt, a, families)))),
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
  const browser = await browserReport(rt, accounts).catch(() => undefined)
  const showBrowser = browser && (browser.families.matched.length || browser.families.openOnly.length)
  return {
    schemaVersion: 1,
    version: opts.version,
    build: opts.build,
    readOnly: opts.readOnly,
    generatedAt: ctx.now.toISOString(),
    families: families.map((f) => {
      const logo = rt.families.get(f.id)?.logo
      const g = f.brokenBin ? { ...f, brokenBin: tildify(f.brokenBin, ctx.home) } : f
      return logo ? { ...g, logo } : g
    }),
    accounts: list,
    pluginErrors: rt.pluginErrors.map((e) => ({ where: e.where, message: e.message })),
    quotaSetups,
    ...(history ? { history } : {}),
    ...(rt.config.aliases ? { configAliases: aliasRefs(rt.config.aliases) } : {}),
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
    },
    ...(upd ? { update: upd } : {}),
    ...(showBrowser ? { browser } : {}),
    display: rt.displayOrder(),
    ...(rt.quotaChecks().length ? { quotaChecks: rt.quotaChecks() } : {}),
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
    } else throw new HttpError(400, `unknown key "${k}"`)
  }
  return out
}

/** The `change` of a /api/handoff/configure body, with every field checked; unknown fields are refused. */
function handoffChange(body: Record<string, unknown>): HandoffChange {
  const c = body.change
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, '"change" must be an object')
  const out: HandoffChange = {}
  for (const [k, v] of Object.entries(c)) {
    if (k === 'auto' || k === 'sameFamily') {
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
  const token = randomBytes(32).toString('base64url')
  const serial = writeQueue()
  const getRuntime = typeof opts.runtime === 'function' ? opts.runtime : async () => opts.runtime as Runtime

  // Every route declares whether a request writes files. `writes` defaults to true, so a route that forgets
  // to declare it is refused by a read-only Panel instead of slipping through.
  interface Route {
    writes?: (body: Record<string, unknown>) => boolean
    run(body: Record<string, unknown>): Promise<unknown>
  }
  const routes: Record<string, Route> = {
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
    // into each Claude settings file that does not hold it yet; the page shows the files first, from the state.
    '/api/remote-control/off': {
      async run() {
        const rt = await getRuntime()
        const r = await rt.remoteControlOff()
        const home = rt.paths.home
        return { ...r, results: r.results.map((x) => ({ ...x, file: tildify(x.file, home) })) }
      },
    },
    '/api/remote-control/on': {
      async run() {
        const rt = await getRuntime()
        const r = await rt.remoteControlOn()
        const home = rt.paths.home
        return { ...r, results: r.results.map((x) => ({ ...x, file: tildify(x.file, home) })) }
      },
    },
    '/api/remote-control/undo': {
      async run() {
        const rt = await getRuntime()
        const r = await rt.remoteControlUndo()
        const home = rt.paths.home
        return { ...r, results: r.results.map((x) => ({ ...x, file: tildify(x.file, home) })) }
      },
    },
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
        return handoffOverview(await getRuntime())
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
        // The CLI is current and the skill is behind: `skill: true` updates it alone, as `sideby update --yes` does.
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
        })
        if (!r.ok) throw new UserError(r.message)
        return {
          ...shown,
          updated: true,
          message: r.message,
          restartedPanel: r.restartedPanel,
          refreshedApp: r.refreshedApp,
          ...(r.skillUpdated === undefined ? {} : { skillUpdated: r.skillUpdated }),
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
        const r = await lb.switchLocal(rt.paths, d, to, rt.env, {
          panelPort: () => backgroundPanelPort(rt.paths),
        })
        if (!r.ok) throw new UserError(r.message)
        return {
          ...(await lb.localStatus(d)),
          to,
          switched: !r.unchanged,
          message: r.message,
          restartedPanel: r.restartedPanel,
          ...(r.skillSynced === undefined ? {} : { skillSynced: r.skillSynced }),
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
              : renderPage({ basePath, token, nonce, version, build, local, readOnly, theme, lang, updates }),
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
        if (sub === '/api/state') {
          send(res, 200, await buildState(await getRuntime(), { version, build, readOnly, updates }))
          return true
        }
        if (Object.hasOwn(routes, sub)) throw new HttpError(405, 'use POST')
        throw new HttpError(404, 'not found')
      }

      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const route = Object.hasOwn(routes, sub) ? routes[sub] : undefined
      if (!route) throw new HttpError(404, 'not found')
      const origin = req.headers.origin
      if (!origin || origin.toLowerCase() !== `http://${host}`) throw new HttpError(403, 'origin not allowed')
      const given = req.headers['x-sideby-token']
      if (typeof given !== 'string' || !sameSecret(given, token))
        throw new HttpError(403, 'missing or wrong x-sideby-token; reload the page', 'bad-token')
      const body = (await readBody(req)) as Record<string, unknown>
      if (readOnly && (route.writes?.(body) ?? true)) throw new HttpError(403, 'this panel is read-only')
      // Reads that record history (doctor) also run in this queue, so overlapping checks merge in order.
      send(res, 200, await serial(() => route.run(body)))
      return true
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return true
      }
      if (err instanceof HttpError) {
        const body = err.code ? { error: err.message, code: err.code } : { error: err.message }
        send(res, err.status, body, err.status === 413 ? { connection: 'close' } : {})
        if (err.status === 413) req.resume()
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
