// Pure helpers for the Panel page. page-script.ts embeds them with Function.prototype.toString(), so the
// browser runs exactly the code these tests cover. Each function must be self-contained: no imports, no
// references to module scope or to each other except through parameters, and only type annotations as
// TypeScript (they are stripped by Node and by the build, leaving plain JavaScript).

import type { HandoffSettings } from '../core/config.ts'

/** The parts of a PanelAccount the helpers read. */
export interface LogicAccount {
  family: string
  name: string
  ref: string
  dir?: string
  isMain?: boolean
  kind?: string
  login?: string
  model?: string
  aliases?: string[]
  aliasArgs?: Record<string, string[]>
  identity?: { email?: string; org?: string }
  hostInstalled?: boolean
  error?: string
  quota?: {
    status: string
    windows?: { label: string; name?: string; windowMinutes: number; usedPercent: number; resetsAt: string }[]
    observedAt?: string
    plan?: string
    /** The Account the reading came from, when it is another Account of the same login (spec §3.21). */
    from?: string
  }
  /** The other Accounts of its Same Login (spec §3.21). */
  sameLogin?: string[]
  usage?: LogicUsage
}

/** The parts of an Account's usage the helpers read. */
export interface LogicUsage {
  status: string
  sessions?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  daily?: { date: string; totalTokens: number }[]
  lastActivityAt?: string
}

/** A short countdown such as `2h 05m`, `3d 4h` or `12m` (`2小时05分` in Chinese); fixed shape so it does not jump. */
export function formatDuration(ms: number, lang: string): string {
  const zh = lang === 'zh'
  if (!Number.isFinite(ms) || ms < 60000) return zh ? '不到1分钟' : '<1m'
  const total = Math.floor(ms / 60000)
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  const mm = String(m).padStart(2, '0')
  if (d > 0) return zh ? `${d}天${h}小时` : `${d}d ${h}h`
  if (h > 0) return zh ? `${h}小时${mm}分` : `${h}h ${mm}m`
  return zh ? `${m}分钟` : `${m}m`
}

/** One Quota window as the page draws it: percent used (0 after a reset passed) and its warning level. */
export function windowState(
  w: { usedPercent: number; resetsAt: string },
  now: number,
  warn: number,
  fail: number,
): { pct: number; passed: boolean; level: string } {
  const reset = Date.parse(w.resetsAt)
  const passed = Number.isFinite(reset) && reset <= now
  const raw = Math.max(0, Math.min(100, Math.round(Number(w.usedPercent) || 0)))
  const pct = passed ? 0 : raw
  const level = passed ? 'reset' : pct >= fail ? 'fail' : pct >= warn ? 'warn' : 'ok'
  return { pct, passed, level }
}

/**
 * The window that binds first among those sharing one column (a model group with a 5-hour and a weekly limit, as
 * Antigravity CLI reports): the most used as the page draws it, the first on a tie. Undefined for none.
 */
export function bindingWindow<W extends { usedPercent: number; resetsAt: string }>(
  list: W[],
  now: number,
  warn: number,
  fail: number,
): W | undefined {
  let best: W | undefined
  for (const w of list)
    if (!best || windowState(w, now, warn, fail).pct > windowState(best, now, warn, fail).pct) best = w
  return best
}

/**
 * A window whose reset time has passed: the numbers on record are from before the reset and nothing newer came
 * in. `since` is when they were last seen (the Quota's observation time, or the reset itself when that is
 * unknown). Null while the window is live, so the page shows a countdown instead.
 */
export function passedWindow(
  w: { resetsAt: string },
  observedAt: string | undefined,
  now: number,
): { since: string } | null {
  const reset = Date.parse(w.resetsAt)
  if (!(Number.isFinite(reset) && reset <= now)) return null
  const seen = Date.parse(observedAt || '')
  return { since: Number.isFinite(seen) ? new Date(seen).toISOString() : w.resetsAt }
}

/** The fullest live Quota window in percent, or -1 when the Account has no Quota data. */
export function quotaPressure(a: LogicAccount, now: number): number {
  const q = a.quota
  if (q?.status !== 'ok' || !q.windows) return -1
  // A named window covers only some models and never counts (spec §3.26).
  const windows = q.windows.filter((w) => !w.name)
  let max = -1
  for (const w of windows) {
    const reset = Date.parse(w.resetsAt)
    if (Number.isFinite(reset) && reset <= now) continue
    max = Math.max(max, Math.max(0, Math.min(100, Number(w.usedPercent) || 0)))
  }
  return windows.length && max < 0 ? 0 : max
}

/**
 * Why an Account needs a look, most serious first: `error`, `health-fail`, `signed-out`, `not-installed`,
 * `quota-high` (a live window at or over the warning level), `health-warn`. Empty when all is well. A Quota read from
 * another Account of the same login (`quota.from`, spec §3.21) is that Account's warning, so it counts once per group.
 */
export function attentionReasons(
  a: LogicAccount,
  health: { fail: number; warn: number } | null,
  now: number,
  warn: number,
): string[] {
  const out: string[] = []
  if (a.error) out.push('error')
  if (health && health.fail > 0) out.push('health-fail')
  if (a.login === 'logged-out' && a.kind !== 'api') out.push('signed-out')
  if (a.hostInstalled === false) out.push('not-installed')
  const q = a.quota
  if (q && q.status === 'ok' && q.windows && !q.from)
    for (const w of q.windows) {
      if (w.name) continue
      const reset = Date.parse(w.resetsAt)
      if (Number.isFinite(reset) && reset <= now) continue
      if ((Number(w.usedPercent) || 0) >= warn) {
        out.push('quota-high')
        break
      }
    }
  if (health && !health.fail && health.warn > 0) out.push('health-warn')
  return out
}

/**
 * How serious an Account's `quota-high` is: `fail` once its fullest live window reaches `fail` (the bar turns red),
 * else `warn`, so a running-low label takes the same color as the bar it speaks about.
 */
export function quotaHighLevel(a: LogicAccount, now: number, fail: number): 'warn' | 'fail' {
  const q = a.quota
  if (!q || q.status !== 'ok' || !q.windows || q.from) return 'warn'
  for (const w of q.windows) {
    if (w.name) continue
    const reset = Date.parse(w.resetsAt)
    if (Number.isFinite(reset) && reset <= now) continue
    if ((Number(w.usedPercent) || 0) >= fail) return 'fail'
  }
  return 'warn'
}

/**
 * The one status badge an account row shows after its name (spec §3.27), most important first: `health-fail`
 * (needs fixing), `quota-high` (running low), the other attention labels (`signed-out`, `not-installed`,
 * `health-warn`), then `next` (recommended) and last `api`. Null when none applies. `reasons` are attentionReasons'.
 */
export function rowBadge(reasons: string[], opts: { next?: boolean; api?: boolean }): string | null {
  for (const r of ['health-fail', 'quota-high', 'signed-out', 'not-installed', 'health-warn'])
    if (reasons.includes(r)) return r
  if (opts.next) return 'next'
  if (opts.api) return 'api'
  return null
}

/**
 * The most serious reason an Account needs a look, as a message key and its values for the Panel to show where the
 * attention count is: `why.<reason>`; for `quota-high` the fullest live window at or over `warn`, with its label and
 * rounded percentage. Null when all is well.
 */
export function attentionWhy(
  a: LogicAccount,
  health: { fail: number; warn: number } | null,
  now: number,
  warn: number,
): { key: string; vars: Record<string, string | number> } | null {
  const reason = attentionReasons(a, health, now, warn)[0]
  if (!reason) return null
  if (reason !== 'quota-high') return { key: `why.${reason}`, vars: {} }
  let top: { label: string; pct: number } | null = null
  for (const w of a.quota?.windows ?? []) {
    if (w.name) continue
    const reset = Date.parse(w.resetsAt)
    if (Number.isFinite(reset) && reset <= now) continue
    const pct = Number(w.usedPercent) || 0
    if (pct >= warn && (!top || pct > top.pct)) top = { label: w.label, pct }
  }
  return { key: 'why.quota-high', vars: { label: top?.label ?? '', pct: Math.round(top?.pct ?? 0), warn } }
}

/**
 * `items` in Display Order (spec §3.25): those whose key is in `order` first, in that order; the others after, in the
 * order they came. Names no longer there are simply not met.
 */
export function inDisplayOrder<T>(
  items: readonly T[],
  key: (t: T) => string,
  order?: readonly string[],
): T[] {
  const at = new Map((order ?? []).map((k, i) => [k, i]))
  return items
    .map((t, i) => ({ t, i, r: at.has(key(t)) ? (at.get(key(t)) as number) : (order?.length ?? 0) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.t)
}

/**
 * The categories of the History side list in the order the user dragged them to: the saved ones first, then the
 * others in the order `seen` gives (latest Session first). The empty category (Projects without one) stays last.
 */
export function categoryOrder(seen: readonly string[], saved: readonly string[]): string[] {
  const has = new Set(seen)
  const out: string[] = []
  for (const c of [...saved, ...seen]) if (c && has.has(c) && !out.includes(c)) out.push(c)
  if (has.has('')) out.push('')
  return out
}

/**
 * The Display Order after a drag (spec §3.25). `all` is every key of the list in the current Display Order, hidden
 * ones included; `shown` is what the screen showed, in its order, as units (one key, or a Same Login group that moves
 * as one). The unit at `from` moves to `to`; the shown keys then fill the places shown keys held in `all`, so keys a
 * filter hides keep their place among themselves.
 */
export function reorder(
  all: readonly string[],
  shown: readonly (readonly string[])[],
  from: number,
  to: number,
): string[] {
  const units = shown.slice()
  if (from < 0 || from >= units.length || to < 0 || to >= units.length) return all.slice()
  const [unit] = units.splice(from, 1)
  units.splice(to, 0, unit as readonly string[])
  const next = units.flat()
  const visible = new Set(next)
  const out = all.slice()
  for (const k of next) if (!out.includes(k)) out.push(k)
  let i = 0
  for (let at = 0; at < out.length; at++) if (visible.has(out[at] as string)) out[at] = next[i++] as string
  return out
}

/**
 * Sorted copy: `pressure` (fullest Quota first), `name`, `recent` (last activity first), or `manual` (the Family's
 * Display Order `order`, names not in it after). The Main Account leads ties.
 */
export function sortAccounts<T extends LogicAccount>(
  list: T[],
  mode: string,
  now: number,
  order?: readonly string[],
): T[] {
  const byName = (x: LogicAccount, y: LogicAccount) =>
    Number(Boolean(y.isMain)) - Number(Boolean(x.isMain)) ||
    x.name.localeCompare(y.name, undefined, { numeric: true })
  const pressure = (a: LogicAccount) => {
    const q = a.quota
    if (q?.status !== 'ok' || !q.windows) return -1
    const windows = q.windows.filter((w) => !w.name)
    let max = windows.length ? 0 : -1
    for (const w of windows) {
      const reset = Date.parse(w.resetsAt)
      if (!(Number.isFinite(reset) && reset <= now)) max = Math.max(max, Number(w.usedPercent) || 0)
    }
    return max
  }
  const last = (a: LogicAccount) => {
    const t = Date.parse(a.usage?.lastActivityAt || '')
    return Number.isFinite(t) ? t : -1
  }
  const out = list.slice()
  if (mode === 'name') out.sort(byName)
  else if (mode === 'manual') return inDisplayOrder(out.sort(byName), (a) => a.name, order)
  else if (mode === 'recent') out.sort((x, y) => last(y) - last(x) || byName(x, y))
  else out.sort((x, y) => pressure(y) - pressure(x) || byName(x, y))
  return out
}

/**
 * Whether an Account is pinned (spec §3.25): its name is in `pinned`, or, for a Same Login, the name of any of its
 * directories, so the login is pinned as a whole.
 */
export function pinnedIn(
  a: { name: string; sameLogin?: readonly string[] },
  pinned: readonly string[],
): boolean {
  return (
    pinned.includes(a.name) || (a.sameLogin ?? []).some((r) => pinned.includes(r.slice(r.indexOf(':') + 1)))
  )
}

/**
 * Whether an Account is Hidden (spec §3.25): its Family is in `hiddenFamilies`, or its name is in `hidden.<family>`,
 * or, for a Same Login, the name of any of its directories, so the login is hidden as a whole.
 */
export function hiddenIn(
  a: { family: string; name: string; sameLogin?: readonly string[] },
  display: { hiddenFamilies?: readonly string[]; hidden?: Record<string, readonly string[]> },
): boolean {
  if (display.hiddenFamilies?.includes(a.family)) return true
  const names = display.hidden?.[a.family] ?? []
  return (
    names.includes(a.name) || (a.sameLogin ?? []).some((r) => names.includes(r.slice(r.indexOf(':') + 1)))
  )
}

/**
 * Pinned Accounts first (spec §3.25): the names in `pinned`, in that order, then the rest in the order they came.
 * A Same Login follows any of its pinned directories, so it stays together. Names no longer there are simply not met.
 */
export function withPinned<T extends { name: string; sameLogin?: readonly string[] }>(
  list: readonly T[],
  pinned?: readonly string[],
): T[] {
  if (!pinned?.length) return list.slice()
  const top: T[] = []
  for (const n of pinned) for (const a of list) if (!top.includes(a) && pinnedIn(a, [n])) top.push(a)
  return top.concat(list.filter((a) => !top.includes(a)))
}

/**
 * The sorted list with each Same Login together (spec §3.21): an Account, or the shown members of one login, in
 * order, at the place of its first member. A login with one shown member stays a plain Account.
 */
export function loginClusters<T extends LogicAccount>(list: T[]): (T | T[])[] {
  const out: (T | T[])[] = []
  const placed = new Set<string>()
  for (const a of list) {
    if (placed.has(a.ref)) continue
    const peers = a.sameLogin || []
    const members = list.filter((b) => b.ref === a.ref || peers.includes(b.ref))
    for (const m of members) placed.add(m.ref)
    out.push(members.length > 1 ? members : a)
  }
  return out
}

/**
 * Whether every word of the query appears in the Account's name, ref, aliases (with their arguments), Family title,
 * model, plan, email or organization.
 */
export function matchesQuery(a: LogicAccount, query: string, familyTitle: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [
    a.name,
    a.ref,
    familyTitle,
    a.model || '',
    a.quota?.plan || '',
    a.identity?.email || '',
    a.identity?.org || '',
  ]
    .concat(a.aliases || [])
    .concat(Object.values(a.aliasArgs || {}).flat())
    .join(' ')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * The Host arguments the alias `name` of this Account adds, or null when it adds none. Reads only own keys, so an
 * alias named like an Object method (`constructor`, `toString`) is not mistaken for one with arguments.
 */
export function aliasArgsOf(a: LogicAccount, name: string): string[] | null {
  const args = a.aliasArgs && Object.hasOwn(a.aliasArgs, name) ? a.aliasArgs[name] : undefined
  return Array.isArray(args) && args.length ? args : null
}

/**
 * Where a new Account would live, derived from an existing one of the same Family (`…/.claude-work` gives
 * `…/.claude-<name>`, `…/.pi-work/agent` gives `…/.pi-<name>/agent`), or from a Main Account directory that is a
 * single dot folder (`…/.codex` gives `…/.codex-<name>`). Null when neither tells.
 */
export function newAccountDir(accounts: LogicAccount[], family: string, name: string): string | null {
  for (const a of accounts) {
    if (a.family !== family || a.isMain || !a.dir) continue
    const needle = `-${a.name}`
    let i = a.dir.lastIndexOf(needle)
    while (i >= 0) {
      const after = a.dir.charAt(i + needle.length)
      if (after === '' || after === '/' || after === '\\')
        return `${a.dir.slice(0, i)}-${name}${a.dir.slice(i + needle.length)}`
      i = a.dir.lastIndexOf(needle, i - 1)
    }
  }
  const main = accounts.find((a) => a.family === family && a.isMain && a.dir)
  if (main?.dir) {
    const seg = main.dir.split(/[\\/]/).pop() || ''
    if (/^\.[A-Za-z0-9_-]+$/.test(seg)) return `${main.dir}-${name}`
  }
  return null
}

/** Share of input served from the prompt cache (0 to 1), or null without usage. */
export function cacheHitRate(u: LogicAccount['usage']): number | null {
  if (u?.status !== 'ok') return null
  const read = Number(u.cacheReadTokens) || 0
  const total = (Number(u.inputTokens) || 0) + read + (Number(u.cacheWriteTokens) || 0)
  return total > 0 ? read / total : null
}

/** Tokens per day summed over Accounts, oldest first; days missing from an Account count as 0. */
export function mergeDaily(lists: ({ date: string; totalTokens: number }[] | undefined)[]): {
  date: string
  totalTokens: number
}[] {
  const sums: Record<string, number> = {}
  for (const list of lists)
    for (const d of list || []) {
      if (!d || typeof d.date !== 'string') continue
      sums[d.date] = (sums[d.date] || 0) + (Number(d.totalTokens) || 0)
    }
  return Object.keys(sums)
    .sort()
    .map((date) => ({ date, totalTokens: sums[date] || 0 }))
}

/**
 * One usage for the directories of a Same Login (spec §3.21): their token counts and days added up, their newest
 * use. Directories without readable usage are left out; with none readable it is the first one's usage as it is.
 */
export function mergeUsage(usages: (LogicUsage | undefined)[]): LogicUsage | undefined {
  const ok = usages.filter((u): u is LogicUsage => Boolean(u && u.status === 'ok'))
  if (ok.length < 2) return ok[0] || usages[0]
  const sum = (
    k: 'sessions' | 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens',
  ) => ok.reduce((n, u) => n + (Number(u[k]) || 0), 0)
  const at = (u: LogicUsage) => {
    const v = Date.parse(u.lastActivityAt || '')
    return Number.isFinite(v) ? v : -1
  }
  const newest = ok.reduce((x, y) => (at(y) > at(x) ? y : x))
  const days: Record<string, number> = {}
  for (const u of ok)
    for (const d of u.daily || [])
      if (d && typeof d.date === 'string') days[d.date] = (days[d.date] || 0) + (Number(d.totalTokens) || 0)
  return {
    ...ok[0],
    status: 'ok',
    sessions: sum('sessions'),
    totalTokens: sum('totalTokens'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    daily: Object.keys(days)
      .sort()
      .map((date) => ({ date, totalTokens: days[date] || 0 })),
    lastActivityAt: newest.lastActivityAt,
  }
}

/** The soonest Quota reset still ahead of `now`, with the window label and Account. */
export function nextReset(
  accounts: LogicAccount[],
  now: number,
): { at: number; label: string; ref: string; name: string; family: string } | null {
  let best: { at: number; label: string; ref: string; name: string; family: string } | null = null
  for (const a of accounts) {
    const q = a.quota
    if (q?.status !== 'ok' || !q.windows) continue
    for (const w of q.windows) {
      const at = Date.parse(w.resetsAt)
      if (!Number.isFinite(at) || at <= now) continue
      if (!best || at < best.at) best = { at, label: w.label, ref: a.ref, name: a.name, family: a.family }
    }
  }
  return best
}

/**
 * A name to offer for a new Account of a Family, given its existing Account names (`main` included or not).
 * Numbered names (`001` … `007`) continue after the highest number with the same width (`008`); otherwise
 * `work`, then `work2`, `work3`, … whichever is free.
 */
export function suggestName(names: string[]): string {
  const taken: Record<string, boolean> = {}
  for (const n of names) taken[n] = true
  let max = -1
  let width = 0
  for (const n of names) {
    if (!/^[0-9]{1,32}$/.test(n)) continue
    max = Math.max(max, Number(n))
    width = Math.max(width, n.length)
  }
  if (max >= 0) {
    for (let i = max + 1; ; i++) {
      const s = String(i).padStart(width, '0')
      if (s.length > 32) break
      if (!taken[s]) return s
    }
  }
  if (!taken.work) return 'work'
  for (let i = 2; ; i++) if (!taken[`work${i}`]) return `work${i}`
}

/**
 * A Finding's hint as the Panel shows it: for a fixable Finding, "run `sideby doctor --fix`" becomes the
 * Panel's own action (`action`, such as "use Fix all"), capitalized when it starts the hint. Hints of Findings
 * that are not fixable, and `--fix --force`, keep the command: Fix all would not do them.
 */
export function panelHint(hint: string, fixable: boolean, action: string): string {
  if (!fixable || !hint) return hint
  return hint.replace(/run `sideby doctor --fix`/g, (_m: string, at: number) =>
    at === 0 ? action.charAt(0).toUpperCase() + action.slice(1) : action,
  )
}

/**
 * Whether the Panel fixes Finding `f` with a button of its own: a sideby skill behind this version while the
 * Update plan says sideby may update it (`skillUpdatable`). Such Findings stay out of the prompt for an AI agent.
 */
/**
 * A Local Build the Panel can leave for npm itself (ADR-0024): the global `sideby` still runs it and the Panel may
 * write. Then switching to the release is the update, offered as a button instead of the `pnpm local --off` command.
 */
export function canLeaveLocal(
  u: { localSwitch?: { running: string | null } } | null,
  readOnly: boolean,
): boolean {
  return !readOnly && !!u?.localSwitch && u.localSwitch.running === 'local'
}
/**
 * What a failed Local Build switch request means (ADR-0024): a lost connection (a background Panel restarting) or a
 * Portal's 5xx (it moved to the new code mid-request) may follow a switch that happened, so the state decides;
 * anything else is the server saying it did not switch.
 */
export function switchFailure(e: { network?: boolean; status?: number }): 'wait' | 'check' | 'fail' {
  if (e.network) return 'wait'
  return (e.status ?? 0) >= 500 ? 'check' : 'fail'
}
/**
 * What a request that may swap the server's code (an Update, a Local Build switch; spec §3.23) has done. `failure` is
 * how the request failed (`switchFailure`), null for an answer. `landed` is what a fresh read of the state says
 * (the version runs, the switch is in place), null while the state cannot be read. `waitedOut`: the wait for the new
 * code is over. Without an answer only the state can confirm success; until the wait is over the page keeps reading.
 */
export function codeSwapOutcome(s: {
  failure: 'wait' | 'check' | 'fail' | null
  landed: boolean | null
  waitedOut: boolean
}): 'done' | 'waiting' | 'failed' | 'unknown' {
  if (s.failure === null) return 'done'
  if (s.failure === 'fail') return 'failed'
  if (s.landed === true) return 'done'
  if (!s.waitedOut) return 'waiting'
  return s.landed === false ? 'failed' : 'unknown'
}
/**
 * Runs a request that may swap the server's code (an Update, a Local Build switch; spec §3.23). A background Panel
 * restarting from the new code drops the answer, and a Portal moving to it may answer 5xx: without an answer only a
 * fresh read of the state that shows the change counts as success (`codeSwapOutcome`). Each wait starts when the
 * previous step ended, never before the request (an install can take longer than a wait): `windowMs` to confirm the
 * change, reading every `pollMs` and once more at the end, then `windowMs` for the new build, which `reload`s the
 * page. `done(answer)` returns false to stop after it; `stuck` when no new build came, `fail(error)` when the change
 * did not happen, `unknown` when the state never answered.
 */
export async function runCodeSwap(io: {
  send: () => Promise<unknown>
  /** Reads the state; true when this read answered. */
  readState: () => Promise<boolean>
  /** What the state just read says: the change is in place (true), is not (false), or cannot tell (null). */
  landed: () => boolean | null
  newBuild: () => boolean
  reload: () => void
  now: () => number
  pause: (ms: number) => Promise<void>
  windowMs: number
  pollMs: number
  confirming: () => void
  done: (answer: unknown) => boolean
  stuck: () => void
  fail: (error: unknown) => void
  unknown: () => void
}): Promise<void> {
  let answer: unknown = null
  let error: unknown = null
  let failure: 'wait' | 'check' | 'fail' | null = null
  try {
    answer = await io.send()
  } catch (e) {
    error = e
    failure = switchFailure((e ?? {}) as { network?: boolean; status?: number })
  }
  const cut = failure === 'wait' || failure === 'check'
  if (cut) io.confirming()
  let until = io.now() + io.windowMs
  for (;;) {
    const landed = cut ? ((await io.readState()) ? io.landed() : null) : null
    // The server runs another build: the change is in place, and this page reloads into it.
    if (io.newBuild()) return io.reload()
    const out = codeSwapOutcome({ failure, landed, waitedOut: io.now() > until })
    if (out === 'failed') return io.fail(error)
    if (out === 'unknown') return io.unknown()
    if (out === 'done') break
    await io.pause(io.pollMs)
  }
  if (!io.done(answer)) return
  until = io.now() + io.windowMs
  for (;;) {
    if (io.newBuild()) return io.reload()
    if (io.now() > until) return io.stuck()
    await io.pause(io.pollMs)
    await io.readState()
  }
}
export function panelFixes(f: { code?: string }, skillUpdatable: boolean): boolean {
  return skillUpdatable && f.code === 'skill.outdated'
}

/**
 * The prompt "Copy for AI" puts on the clipboard: `words.lead`, then each Finding that has no automatic fix
 * (numbered, with its account, item, level, message and hint), then `words.fixFirst` when some Findings do have
 * one, then `words.check`. Empty when every Finding has an automatic fix. `words.hint` labels a hint line.
 */
export function fixPrompt(
  findings: readonly {
    account: string
    item: string
    level: string
    message: string
    hint?: string
    fixable?: boolean
  }[],
  words: { lead: string; hint: string; fixFirst: string; check: string },
): string {
  const manual = findings.filter((f) => !f.fixable)
  if (!manual.length) return ''
  const items = manual.map((f, i) => {
    const lines = [i + 1 + '. [' + f.level + '] ' + f.account + ' · ' + f.item, '   ' + f.message]
    if (f.hint) lines.push('   ' + words.hint + f.hint)
    return lines.join('\n')
  })
  const tail = manual.length < findings.length ? [words.fixFirst, words.check] : [words.check]
  return [words.lead, items.join('\n\n'), ...tail].join('\n\n')
}

/**
 * A short command to offer for a new Account `name` of a Family, from the config aliases of its existing Accounts:
 * an alias that is a prefix plus its Account's name (`cc001` for `claude:001`) gives the prefix, the most common
 * one wins (then the longer, then the first alphabetically), and the offer is that prefix plus `name` (`cc008`).
 * Aliases that do not end in their Account's name (`codex001` for `codex:main`) are ignored. Empty when no
 * pattern shows, or without a name. The caller still checks the result like any alias.
 */
export function suggestAlias(accounts: LogicAccount[], family: string, name: string): string {
  if (!name) return ''
  const counts: Record<string, number> = {}
  for (const a of accounts) {
    if (a.family !== family) continue
    for (const alias of a.aliases || [])
      if (alias.length > a.name.length && alias.endsWith(a.name)) {
        const prefix = alias.slice(0, alias.length - a.name.length)
        counts[prefix] = (counts[prefix] || 0) + 1
      }
  }
  const best = Object.keys(counts).sort(
    (x, y) => (counts[y] || 0) - (counts[x] || 0) || y.length - x.length || (x < y ? -1 : x > y ? 1 : 0),
  )[0]
  return best ? best + name : ''
}

/**
 * Why `alias` cannot become the short command of `ref`, by the config rules: `pattern` (not a shell-safe name,
 * matched against the config's own pattern source), `reserved` (a shell keyword, builtin or `sideby`), `taken`
 * (the config already maps it to another Account). Empty when it is fine or empty.
 */
export function aliasIssue(
  alias: string,
  pattern: string,
  reserved: string[],
  configAliases: Record<string, string> | undefined,
  ref: string,
): string {
  if (!alias) return ''
  if (!new RegExp(pattern).test(alias)) return 'pattern'
  if (reserved.indexOf(alias) >= 0) return 'reserved'
  const target = configAliases && Object.hasOwn(configAliases, alias) ? configAliases[alias] : undefined
  if (target !== undefined && target !== ref) return 'taken'
  return ''
}

/**
 * An email with the local part hidden for screen sharing: its first character, three dots, then the domain
 * (`a•••@example.com`). Text without an `@` keeps only its first character.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  const first = Array.from(email)[0] || ''
  return at > 0 ? `${first}•••${email.slice(at)}` : first ? `${first}•••` : ''
}

/**
 * The header's "Updated …" age as a message key and count. The state reloads every 20 s, so the whole first minute
 * is "just now": a count of seconds would tick all the time and make an idle page look busy. After that, whole
 * minutes, hours and days, which only show when refreshes stopped (connection lost, page hidden, load failing).
 */
export function updatedAge(ms: number): { key: string; n?: number } {
  const m = Number.isFinite(ms) ? Math.floor(ms / 60000) : 0
  if (m < 1) return { key: 'time.justNow' }
  if (m < 60) return { key: 'time.minAgo', n: m }
  const h = Math.floor(m / 60)
  if (h < 24) return { key: 'time.hAgo', n: h }
  return { key: 'time.dAgo', n: Math.floor(h / 24) }
}

/** What the Sessions page needs of a Live Session (spec §3.32); the full shape is `LiveSession` in core/live-sessions.ts. */
export interface LogicSession {
  account: string
  accountLabel?: string
  sessionId: string
  title?: string
  label?: string
  status: string
  cwd?: string
  startedAt?: string
  updatedAt?: string
}

/**
 * The Sessions page order: a Session that needs the user first, then the most recent activity (`updatedAt`, else
 * `startedAt`), then the label, so two answers with the same Sessions keep the same order.
 */
export function sortSessions<T extends LogicSession>(list: readonly T[]): T[] {
  const at = (s: T) => {
    const ts = Date.parse(s.updatedAt || s.startedAt || '')
    return Number.isFinite(ts) ? ts : 0
  }
  const label = (s: T) => s.label || s.sessionId
  return list
    .slice()
    .sort(
      (a, b) =>
        (a.status === 'needs-you' ? 0 : 1) - (b.status === 'needs-you' ? 0 : 1) ||
        at(b) - at(a) ||
        (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0),
    )
}

/**
 * The order a refresh shows: Sessions already on screen keep their places (`shown`, their ids in screen order), so a
 * Session that just answered does not jump past another. A Session that needs the user still goes first, and one not
 * shown before comes ahead of the shown ones, in `sortSessions` order.
 */
export function steadyOrder<T extends LogicSession>(shown: readonly string[], list: readonly T[]): T[] {
  const sorted = sortSessions(list)
  if (!shown.length) return sorted
  const pos = new Map(shown.map((id, i) => [id, i]))
  const needs = (s: T) => (s.status === 'needs-you' ? 0 : 1)
  const rank = sorted.map((s, i) => ({
    s,
    seen: pos.has(s.sessionId) ? 1 : 0,
    at: pos.get(s.sessionId) ?? i,
  }))
  rank.sort((a, b) => needs(a.s) - needs(b.s) || a.seen - b.seen || a.at - b.at)
  return rank.map((x) => x.s)
}

/** How long ago a Session was last active, as a message key and count; null when it has no time at all. */
export function sessionAge(s: LogicSession, now: number): { key: string; n?: number } | null {
  const ts = Date.parse(s.updatedAt || s.startedAt || '')
  return Number.isFinite(ts) ? updatedAge(Math.max(0, now - ts)) : null
}

/**
 * The three parts of a Session Label as the row shows them: the Account's short name (bold), the Host's title (the
 * working directory's name when the Host gave none) and the first 8 characters of the id (monospace).
 */
export function sessionLabelParts(s: LogicSession): { account: string; title: string; id: string } {
  const dir = (s.cwd || '').replace(/\/+$/, '').split('/').pop() || ''
  return {
    account: s.accountLabel || s.account,
    title: (s.title || '').trim() || dir,
    id: s.sessionId.slice(0, 8),
  }
}

/** What "Send to it" needs of a Message receipt (spec §3.32 step 2); the full shape is `MessageReceipt` in core/messages.ts. */
export interface LogicMessage {
  status: string
  pasteText?: string
  note?: string
  needsApproval?: boolean
}

/**
 * What the "Send to it" dialog shows after a send: `done` (the Host took it; `hint` is any note, shown as a yellow
 * hint), `approve` (it took it, but the target shows it only once the user approves it there; `reason` says how, ADR-0045),
 * `paste` (the user pastes `pasteText`; `reason` says why, `jump` offers the
 * target's Orca tab) or `stored` (kept as a file only; `pasteText` for reference). `key` is the headline's message key.
 */
export function sendResultView(
  m: LogicMessage,
  orca: boolean,
): {
  kind: 'done' | 'approve' | 'paste' | 'stored'
  key: string
  pasteText: string
  reason: string
  hint: string
  jump: boolean
} {
  const pasteText = m.pasteText || ''
  const note = (m.note || '').trim()
  if (m.status === 'delivered' && m.needsApproval)
    return { kind: 'approve', key: 'send.approve', pasteText, reason: note, hint: '', jump: false }
  if (m.status === 'delivered' || m.status === 'read')
    return {
      kind: 'done',
      key: m.status === 'read' ? 'send.read' : 'send.done',
      pasteText,
      reason: '',
      hint: note,
      jump: false,
    }
  if (m.status === 'paste-needed')
    return {
      kind: 'paste',
      key: 'send.paste',
      pasteText,
      reason: note,
      hint: '',
      jump: Boolean(orca && pasteText),
    }
  return { kind: 'stored', key: 'send.stored', pasteText, reason: note, hint: '', jump: false }
}

/** The chip a Sessions row shows for the latest Message to it, or null when there is none worth showing. */
export function messageChip(
  status: string | undefined,
  needsApproval?: boolean,
): { key: string; tone: 'ok' | 'warn' | 'accent' } | null {
  // Taken by the Host, but shown only once the user approves it in the target's terminal (ADR-0045).
  if (status === 'delivered' && needsApproval) return { key: 'send.chip.approve', tone: 'warn' }
  if (status === 'delivered') return { key: 'send.chip.delivered', tone: 'accent' }
  if (status === 'read') return { key: 'send.chip.read', tone: 'ok' }
  if (status === 'paste-needed') return { key: 'send.chip.paste', tone: 'warn' }
  return null
}

/** The latest Message to one Session, as `/api/sessions/messages` gives it (`PanelMessageStatus` in handler.ts). */
export interface LogicMessageStatus {
  id: string
  status: string
  sentAt?: string
  to?: string
  from?: string
  needsApproval?: boolean
}

/** A Session Label without its short id: `cc002 · knip cleanup · 61230c3d` → `cc002 · knip cleanup`. */
export function shortSessionLabel(label: string | undefined): string {
  const parts = (label || '').split(' · ').filter(Boolean)
  if (parts.length > 1 && /^[0-9a-f]{8}$/i.test(parts[parts.length - 1]!)) parts.pop()
  return parts.join(' · ')
}

export type MessageNewsKind = 'new' | 'approve' | 'read' | 'paste'

/**
 * What changed between two readings of the latest Messages, for the Panel's notices (spec §3.32): `new` (a Message
 * reached a Session), `approve` (it reached one that shows it only once the user approves it, ADR-0045), `read` (its
 * Session read it) or `paste` (it waits for the user to paste it). The first reading (`before` null) only sets the
 * baseline, so opening the Panel announces nothing that was already there.
 */
export function messageNews(
  before: Record<string, LogicMessageStatus> | null,
  after: Record<string, LogicMessageStatus>,
): { kind: MessageNewsKind; sessionId: string; id: string; to: string; from: string }[] {
  if (!before) return []
  const out: { kind: MessageNewsKind; sessionId: string; id: string; to: string; from: string }[] = []
  for (const [sessionId, m] of Object.entries(after)) {
    // A kept Message that is not delivered yet says nothing; it is announced once it arrives or needs a paste.
    if (m.status === 'stored') continue
    const was = before[sessionId]
    const same = was && was.id === m.id
    if (same && was.status === m.status) continue
    const fresh = !same || was.status === 'stored'
    const kind: MessageNewsKind | null =
      m.status === 'paste-needed'
        ? 'paste'
        : fresh
          ? m.status === 'delivered' && m.needsApproval
            ? 'approve'
            : 'new'
          : m.status === 'read'
            ? 'read'
            : null
    if (kind)
      out.push({ kind, sessionId, id: m.id, to: shortSessionLabel(m.to), from: shortSessionLabel(m.from) })
  }
  return out
}

/**
 * Whether "Send to it" must wait: any screenshot that failed (refused, or its upload broke) stops the send, so a
 * message never goes without a picture the user added. `names` lists them for the note; null lets it go.
 */
export function sendBlock(
  files: readonly { name: string; status: string }[],
): { key: 'send.blocked'; names: string } | null {
  const failed = files.filter((f) => f.status === 'error').map((f) => f.name)
  return failed.length ? { key: 'send.blocked', names: failed.join(', ') } : null
}

/**
 * Why "Send to it" refuses a file before uploading it, as a message key, or null when it may go: images only (PNG,
 * JPEG, GIF, WebP), at most 20 MB each, at most 5. `kept` is how many the dialog already holds. The server checks all
 * three again; this only says it sooner.
 */
export function sendFileProblem(
  file: { type?: string; size: number },
  kept: number,
): 'send.max' | 'send.notImage' | 'send.tooBig' | null {
  if (kept >= 5) return 'send.max'
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type || ''))
    return 'send.notImage'
  if (file.size > 20 * 1024 * 1024) return 'send.tooBig'
  return null
}

/**
 * A working directory short enough for one row: whole when it fits in `max` characters, else its root (`~` or the
 * first folder) and its last two folders around an ellipsis, else only the end. Empty when there is none.
 */
export function shortCwd(cwd: string | undefined, max = 44): string {
  if (!cwd) return ''
  if (cwd.length <= max) return cwd
  const parts = cwd.split('/')
  const head = parts[0] === '' ? `/${parts[1] || ''}` : parts[0]
  const short = `${head}/…/${parts.slice(-2).join('/')}`
  return short.length <= max && parts.length > 4 ? short : `…${cwd.slice(-(max - 1))}`
}

/**
 * The Panel's language: a host `lang` of `en` or `zh` wins; `auto` uses the viewer's saved choice, then the browser
 * language (`zh*` gives Chinese, anything else English).
 */
export function panelLang(host: string, saved: string, browser: string): string {
  if (host === 'en' || host === 'zh') return host
  if (saved === 'en' || saved === 'zh') return saved
  return /^zh/i.test(browser || '') ? 'zh' : 'en'
}

/**
 * The Account that makes the Panel's Auto Handoff hint worth showing (spec §3.17): Auto Handoff is off and a
 * subscription Account of a Family that can start a Handoff is at or above the threshold. The fullest wins.
 */
export function handoffHintAccount(
  accounts: readonly LogicAccount[],
  settings: { auto: boolean; threshold: number },
  starters: readonly string[],
  now: number,
): { ref: string; pressure: number } | null {
  if (settings.auto) return null
  let best: { ref: string; pressure: number } | null = null
  for (const a of accounts) {
    if (a.kind === 'api' || !starters.includes(a.family)) continue
    const p = quotaPressure(a, now)
    if (p >= settings.threshold && (!best || p > best.pressure))
      best = { ref: a.ref, pressure: Math.round(p) }
  }
  return best
}

/** The settings `/api/handoff/*` sends, as `sideby handoff --json` prints them. */
export type HandoffSettingsView = HandoffSettings

export interface HandoffForm {
  auto: boolean
  sameFamily: boolean
  prepareAt: number
  threshold: number
  wait: number
  countdown: number
  orders: Record<string, { policy: string; order: string[] }>
  /** Left out: unchanged. */
  crossOrganization?: string[]
}

/** What the Panel's Auto Handoff form changed, as the `change` /api/handoff/configure takes; {} when nothing. */
export function handoffChangeOf(s: HandoffSettingsView, f: HandoffForm): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  if (f.auto !== s.auto) c.auto = f.auto
  if (f.sameFamily !== s.sameFamily) c.sameFamily = f.sameFamily
  if (f.prepareAt !== s.prepareAt) c.prepareAt = f.prepareAt
  if (f.threshold !== s.threshold) c.threshold = f.threshold
  if (f.wait !== s.waitIfResetWithinMinutes) c.waitIfResetWithinMinutes = f.wait
  if (f.countdown !== s.countdownSeconds) c.countdownSeconds = f.countdown
  const orders: { family: string; order: string[] }[] = []
  for (const family of Object.keys(f.orders)) {
    const o = f.orders[family]!
    const cur = s.families[family]
    const want = o.policy === 'order' ? o.order : []
    const have = cur && cur.policy === 'order' ? cur.order : []
    if (want.join('\n') !== have.join('\n')) orders.push({ family, order: want.slice() })
  }
  if (orders.length) c.orders = orders
  if (f.crossOrganization && f.crossOrganization.join('\n') !== s.crossOrganization.join('\n'))
    c.crossOrganization = f.crossOrganization.slice()
  return c
}

/**
 * What the Panel's Remote Control button says (spec §3.22): `on` when a group used by a subscription Account turns it
 * on, else `default` when one leaves it to Claude Code, else `off`; null without groups. Groups used only by API
 * Accounts do not count: those never sign in to claude.ai.
 */
export function remoteControlSummary(
  groups: readonly { accounts: readonly string[]; state: string }[],
  apiRefs: readonly string[],
): 'on' | 'default' | 'off' | null {
  if (!groups.length) return null
  const reach = groups.filter((g) => g.accounts.some((r) => !apiRefs.includes(r)))
  if (reach.some((g) => g.state === 'on')) return 'on'
  if (reach.some((g) => g.state === 'default')) return 'default'
  return 'off'
}

/**
 * Where a menu or popover goes next to its anchor, all in viewport pixels. It opens below when its whole height fits
 * there, else above when it fits there, else on the side with more room, its height capped at that room so it scrolls
 * inside. Below `margin` from each edge and `gap` from the anchor. When neither side has even `min` pixels (a tiny
 * window, an anchor near an edge), it takes the whole height of the window instead, over the anchor. Horizontally it
 * lines up with the anchor's left edge (`start`) or right edge (`end`), kept inside the window.
 */
export function menuPlacement(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  align: 'start' | 'end',
  gap = 4,
  margin = 8,
  min = 120,
): { left: number; top: number; maxHeight: number; above: boolean } {
  const x = align === 'start' ? anchor.left : anchor.right - size.width
  const left = Math.max(margin, Math.min(view.width - size.width - margin, x))
  const below = Math.floor(view.height - margin - anchor.bottom - gap)
  const above = Math.floor(anchor.top - gap - margin)
  if (size.height <= below) return { left, top: anchor.bottom + gap, maxHeight: below, above: false }
  if (size.height <= above)
    return { left, top: anchor.top - gap - size.height, maxHeight: above, above: true }
  if (Math.max(below, above) < Math.min(size.height, min)) {
    return { left, top: margin, maxHeight: Math.max(0, Math.floor(view.height - 2 * margin)), above: false }
  }
  if (below >= above) return { left, top: anchor.bottom + gap, maxHeight: below, above: false }
  return { left, top: margin, maxHeight: above, above: true }
}

/**
 * The option a key moves to in a row of radio buttons (WAI-ARIA radio group): the arrows step and wrap around, Home
 * and End go to the ends. -1 for any other key, or an empty row.
 */
export function radioStep(count: number, index: number, key: string): number {
  if (count < 1) return -1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return -1
}

/** The key a Same Login group keeps its folded state under: its members, in a fixed order. */
export function loginKey(refs: readonly string[]): string {
  return `login:${[...refs].sort().join(',')}`
}

/**
 * `text` without key-shaped strings (spec §3.28), each replaced by `[key removed]`. First, anywhere in a word, URLs
 * and query strings included: a known key prefix (`sk-`, which covers `sk-ant-` and `sk-proj-`, `xai-`, `gsk_`,
 * `AIza`, `ghp_`, `github_pat_`) followed by 16 or more token characters, an AWS access key id (`AKIA` or `ASIA` and
 * 16 capitals or digits), and a JWT (three base64url parts joined by dots, the first starting `eyJ`). Then any run of
 * 32 or more letters, digits, `_`, `-` or `+` that mixes letters and digits, unless the whitespace-free word it sits
 * in is a URL or a file path (it has a `/`); a 40-character git SHA is such a run. Everything else, whitespace and
 * newlines included, stays as it was. `removed` says whether anything was taken out, so the caller can point the
 * user to the key box.
 */
export function stripSecrets(text: string): { text: string; removed: boolean } {
  const mark = '[key removed]'
  let removed = false
  const out = String(text || '').replace(/\S+/g, (word) => {
    let w = word.replace(
      /(?<![A-Za-z0-9_-])(?:(?:sk-proj-|sk-|xai-|gsk_|AIza|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g,
      () => {
        removed = true
        return mark
      },
    )
    if (w.includes('/')) return w
    w = w.replace(/[A-Za-z0-9_+-]{32,}=*/g, (run) => {
      if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) return run
      removed = true
      return mark
    })
    return w
  })
  return { text: out, removed }
}

/** The kinds of AI Task (spec §3.28); anything else is refused. */
export const AI_TASK_KINDS = [
  'free',
  'fix',
  'quota',
  'account',
  'host',
  'plugin',
  'terminal',
  'theme',
  'handoff',
  'menubar',
  'hotkey',
] as const
export type AiTaskKind = (typeof AI_TASK_KINDS)[number]

/**
 * The message keys of the AI dialog for `task` (spec §3.28 "每个入口的提示"): its title, the text box placeholder and
 * the example chips. Each comes from the task's own key (`ask.title.<task>`, `ask.ph.<task>`, `ask.ex.<task>.1` to
 * `.3`) when `has` knows it, otherwise from `free`'s: `ask.title`, `ask.ph.free` and `freeChips`.
 */
export function askCopy(
  task: string,
  has: (key: string) => boolean,
  freeChips: readonly string[],
): { title: string; placeholder: string; chips: string[] } {
  const own = task !== 'free'
  const title = own && has('ask.title.' + task) ? 'ask.title.' + task : 'ask.title'
  const placeholder = own && has('ask.ph.' + task) ? 'ask.ph.' + task : 'ask.ph.free'
  const chips = own ? [1, 2, 3].map((n) => 'ask.ex.' + task + '.' + n).filter(has) : []
  return { title, placeholder, chips: chips.length ? chips : freeChips.slice() }
}

/**
 * Whether the Panel hands its AI Tasks to the Portal around it (ADR-0030): createPanelHandler was given
 * `ask: { bridge: 'postMessage' }` and the page sits in a frame. A Panel opened on its own is its own parent; it keeps
 * its header "Let AI do it" button and its own dialog. The page decides this when it loads.
 */
export function askBridged(boot: { ask?: { bridge?: string } | null }, win: { parent: unknown }): boolean {
  return boot.ask?.bridge === 'postMessage' && Boolean(win.parent) && win.parent !== win
}

/**
 * Hands an AI Task to the Portal around the Panel (ADR-0030) when `askBridged` says so: posts
 * `{ type: 'local-tools:ask', version: 1, preset, native: { task, text, context }, text }` to the parent with the
 * Panel's own origin as the target, and says it did, so the Panel opens no dialog of its own. Otherwise posts nothing
 * and returns false.
 */
export function askBridge(
  boot: { ask?: { bridge?: string } | null },
  opts: { task?: string; text?: string; context?: object | null } | undefined,
  win: {
    parent: { postMessage(message: unknown, targetOrigin: string): void } | null
    location: { origin: string }
  },
): boolean {
  if (!askBridged(boot, win) || !win.parent) return false
  const o = opts || {}
  const task = o.task || 'free'
  const text = o.text || ''
  win.parent.postMessage(
    {
      type: 'local-tools:ask',
      version: 1,
      preset: task,
      native: { task, text, context: o.context || {} },
      text,
    },
    win.location.origin,
  )
  return true
}

/**
 * The "Attached files" section of a Task Prompt (spec §3.28 "附件"), in `lang` (`zh`, otherwise English): one line
 * per file with its absolute path and kind, plus how to look at a video. Empty without files. `heading` goes before
 * the section title, so a prompt with Markdown headings (`## `, a Task Spec from a Portal) gets one of its level.
 * sideby's own Task Prompts and the ones a Portal hands over (ADR-0030) share it, word for word.
 */
export function attachedSection(
  files: readonly { path: string; kind: string }[],
  lang: string,
  heading = '',
): string {
  if (!files.length) return ''
  const L =
    lang === 'zh'
      ? {
          attached: '附件',
          image: '图片',
          video: '视频',
          videoHint:
            '需要看视频内容时，用 ffmpeg 抽几帧再看，例如 `ffmpeg -i <视频> -vf fps=1 -frames:v 5 frame-%d.png`。',
        }
      : {
          attached: 'Attached files',
          image: 'image',
          video: 'video',
          videoHint:
            'To see what a video shows, extract a few frames with ffmpeg first, for example `ffmpeg -i <video> -vf fps=1 -frames:v 5 frame-%d.png`.',
        }
  const lines = files.map((f) => '- ' + f.path + ' (' + (f.kind === 'video' ? L.video : L.image) + ')')
  if (files.some((f) => f.kind === 'video')) lines.push(L.videoHint)
  return heading + L.attached + '\n' + lines.join('\n')
}

/**
 * The Task Prompt of an AI Task (spec §3.28), in `lang` (`zh`, otherwise English): what to do, the context given,
 * the fixed rules, pointers for the task and the invitation to contribute. For `free` the user's `text` is what to
 * do; for the other tasks it follows the task's own sentence. `text` and every context string go through `strip`
 * (pass `stripSecrets`), so no key-shaped string reaches the prompt; the caller still checks `text` itself to warn
 * the user. Context carries only what the caller passes, never a credential value.
 */
export function taskPrompt(
  input: {
    task: string
    text?: string
    context?: {
      account?: string
      family?: string
      findings?: readonly { code?: string; account?: string; item?: string; message: string; hint?: string }[]
      quotaReason?: string
      version?: string
      /** The custom terminal command saved now (`terminal` task). */
      terminalCustom?: string
      /** The Theme in use, for `theme`. */
      theme?: string
      /** Names of the supported terminals installed on this computer (`terminal` task). */
      terminals?: readonly string[]
      /** Auto Handoff facts, one per line, as `handoffTaskFacts` gives them (`handoff` task). */
      handoff?: readonly string[]
    }
    /** Files saved for the task (spec §3.28 "附件"): absolute paths and their kind. */
    attachments?: readonly { path: string; kind: string }[]
    lang: string
  },
  strip: (text: string) => { text: string; removed: boolean },
): string {
  const zh = input.lang === 'zh'
  const clean = (s: string | undefined) => strip(String(s || '')).text.trim()
  const c = input.context || {}
  const text = clean(input.text)
  const account = clean(c.account)
  const family = clean(c.family)
  const L = zh
    ? {
        task: '要做的事',
        context: '上下文',
        rules: '规则',
        pointers: '提示',
        says: '我的原话：',
        free: '问我想用 sideby 做什么，然后帮我做。',
        fix: 'sideby 的体检发现了下面这些不能自动修复的问题，请帮我修好。',
        quota: '额度格没有显示' + (account ? ' ' + account + ' 的' : '') + '额度，请找出原因并让它显示出来。',
        account:
          '帮我在 sideby 里加一个' +
          (family ? ' ' + family + ' ' : '') +
          '账号（订阅账号，或者用 API 地址的账号）。',
        host: '帮我给 sideby 加一个它还不支持的 AI 编程工具（宿主），先做成本机的 Family 插件。',
        plugin: '帮我写一个 sideby 插件或 hook。',
        terminal: '帮我让 sideby 能在我用的终端里打开 AI 任务：写一条自定义终端命令。',
        theme: '帮我给 sideby 面板配一套颜色（主题）。',
        handoff: '帮我调好 sideby 的自动接力：根据我的账号推荐什么时候接力（阈值）和接力的顺序。',
        menubar: 'sideby 的状态栏额度图标在 macOS 顶栏里看不到，请帮我找出原因并让它显示出来。',
        hotkey: '帮我给 sideby 的状态栏菜单挑一个单手按着顺手、又没被别的程序占用的快捷键，并替我设好。',
        pHotkey:
          '先运行 `sideby menubar hotkey --json` 看现在用的组合。再查本机已经被占的组合：`defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys` 里 enabled 为 1 的系统快捷键，以及 `/Applications` 里装了哪些常用全局快捷键的 App（Raycast、Alfred、ChatGPT、Claude 等），按它们的默认快捷键判断；不要打开它们的配置文件（里面可能有密钥），拿不准就问我。问我习惯用哪只手、平时常按哪些快捷键，然后推荐 2 到 3 个按起来顺手、又没被占的组合（两个键最顺手，比如 ⌥X；必须带 ⌥、⌘ 或 ⌃），说清每个会占掉什么（比如 ⌥X 不能再打出 ≈）。我选定后运行 `sideby menubar hotkey <组合>`，几秒内生效，不用重启；再请我按一下，确认能打开菜单。按了没反应，说明别的 App 先占了，换下一个。不要改系统或别的 App 的快捷键设置。',
        pMenubar:
          '先运行 `sideby menubar --json`。`state` 为 `off`：它被关掉了（常见于菜单里的「从状态栏隐藏…」），给我看 `sideby menubar on` 的预览，我同意后加 `--yes`。`state` 为 `on` 但 `loaded` 为 `false`：macOS 没在运行它，`sideby menubar on --yes` 只是重新启动，不改文件。`loaded` 为 `true`：它在运行但被挡住了，依次查：状态栏是否太满或被刘海挡住（按住 ⌘ 拖动图标）；有没有 Ice、Bartender、Hidden Bar 这类菜单栏整理工具把它收起来了（查 `/Applications`，告诉我去它的设置里把 sideby（显示为 osascript）挪出来）；macOS 26 及以上要在「系统设置 › 菜单栏」里允许 osascript（`sideby menubar --json` 里的快捷键 `hotkey.label` 可以在任何地方打开菜单，用来确认它在运行）。不要结束或重启任何不是 sideby 的进程。',
        cHandoff: '自动接力现在的设置（来自 `sideby handoff status --json`）：',
        pHandoff:
          '先运行 `sideby handoff status --json` 和 `sideby quota --json`，看清每个账号的额度来源和用量。只用 `sideby handoff enable …` 或 `sideby config set handoff.<键> <值>` 改设置；先不加 `--yes` 给我看预览，我同意后再加 `--yes`。没有额度数据的账号排在顺序后面，并告诉我怎么让它显示额度。',
        cAccount: '账号：',
        cFamily: '家族：',
        cFindings: '体检发现：',
        cQuota: '额度原因：',
        cVersion: 'sideby 版本：',
        cTheme: '现在的主题：',
        cCustom: '现在的自定义终端命令：',
        cTerminals: '本机装了的、sideby 支持的终端：',
        cNoTerminals: '本机没找到 sideby 支持的终端',
        cLang: '面板语言：中文（请用中文和我交流）',
        r1: '先用 sideby skill，怎么做见它的 references/ai-tasks.md。没装 skill 就先问我，我同意后运行 `npx skills add Adonis0123/sideby -g`。',
        r2: '会改文件的命令先给我看预览，我同意后才加 `--yes`。',
        r3: '不要替我登录，也不要让我把密钥发给你：密钥由我自己用 `sideby key <账号>` 输入。',
        pFix: '先运行 `sideby doctor --json` 看清问题；能自动修的交给 `sideby doctor --fix`。修完再跑一次 `sideby doctor`，告诉我还剩什么。',
        pQuota: '用 `sideby quota --json` 和 `sideby doctor --json` 看原因。',
        pAccount:
          '地址、模型名、环境变量以厂商的官方文档为准。账号建好后，让我用 `sideby key <账号>` 输入密钥，再用 `sideby try <账号>` 试一次。订阅账号要登录时，让我点面板上的「登录」，或者自己运行 `sideby login <账号>`。',
        pHost:
          '用 `sideby plugins new <id>` 生成插件骨架；收集事实时写明宿主的版本和日期；用 `sideby plugins check <id>` 检查，并在演示 HOME 里试一遍。',
        pPlugin:
          '照 sideby 仓库的插件指南 docs/guide/plugins.zh-CN.md 写；写完用 `sideby plugins check <id>` 检查。',
        pTheme:
          '先跑 `sideby theme --json` 看现有主题和正在用的那套，再问我想要的感觉；我给了截图、网址或品牌色，就从里面取色。写一个主题文件（JSON，只放颜色，不放代码）：`{"schemaVersion":1,"name":"…","base":"teal"、"leaf"、"celeste"、"claude" 或 "codex","accent":"#rrggbb","light":{…},"dark":{…}}`；多数时候给 `base` 和 `accent` 就够了，`light` / `dark` 只写要改的 token（`sideby theme export teal` 能看到全部 token）。先放在当前目录，跑 `sideby theme check <文件>`，有不达标的就按建议值改到全部通过；再跑 `sideby theme preview <文件>` 让我在面板里看一眼。我满意后才 `sideby theme import <文件>` 和 `sideby theme use <名字>`；不满意就接着改。随时可以用 `sideby theme use --undo` 换回去。',
        pTerminal:
          "先问我用的是什么终端。只看这个终端的官方文档和它的 `--help`，找出「在指定目录新开一个窗口运行一条命令」的写法，写明你看的版本。写成一个模板：`{cmd}` 是要运行的命令，`{cwd}` 是文件夹，sideby 按参数填入，不经过 shell。保存要用 `sideby terminal --custom '<模板>'`，它会改 sideby 的设置，先问我。保存后让我在面板上点一次「让 AI 帮我」试一下，打不开就一起看错误再改。",
        share:
          '做好之后，问我愿不愿意把这次的改进分享给 sideby。我同意后，按 sideby 仓库的 CONTRIBUTING.md 提一个 pull request，提交前去掉我自己的账号名、路径和邮箱。',
        shareTerminal:
          '跑通之后，问我愿不愿意把这个终端做成 sideby 的内置终端。我同意后，在 sideby 仓库 src/core/terminal.ts 的终端表里加一行并补上测试，按 CONTRIBUTING.md 提一个 pull request，提交前去掉我自己的账号名、路径和邮箱。',
      }
    : {
        task: 'What to do',
        context: 'Context',
        rules: 'Rules',
        pointers: 'Pointers',
        says: 'In my words: ',
        free: 'Ask me what I want to do with sideby, then do it for me.',
        fix: "Fix the problems below that sideby's health check cannot fix by itself.",
        quota:
          'sideby shows no quota' + (account ? ' for ' + account : '') + '. Find out why and make it show.',
        account:
          'Help me add a ' +
          (family ? family + ' ' : '') +
          'account to sideby (a subscription, or an API address).',
        host: 'Help me add an AI coding tool (Host) that sideby does not support yet, first as a local Family Plugin.',
        plugin: 'Help me write a sideby plugin or hook.',
        theme: 'Help me pick a set of colors (a Theme) for the sideby Panel.',
        terminal: 'Help sideby open AI Tasks in the terminal I use: write a custom terminal command.',
        handoff:
          "Help me tune sideby's Auto Handoff: from my accounts, recommend when to hand over (the threshold) and in what order.",
        menubar: "I can't see sideby's quota icon in the macOS menu bar. Find out why and make it show.",
        hotkey:
          "Pick a shortcut for sideby's menu bar menu that is easy to press with one hand and that nothing else uses, and set it for me.",
        pHotkey:
          'Run `sideby menubar hotkey --json` first to see the current shortcut. Then find the combinations already taken on this Mac: the system shortcuts with enabled 1 in `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys`, and the apps in /Applications that usually hold a global shortcut (Raycast, Alfred, ChatGPT, Claude and the like), judged by their default shortcuts; do not open their config files (they may hold keys), and ask me when unsure. Ask which hand I use and which shortcuts I press often, then recommend 2 or 3 combinations that are easy to press and free (two keys are easiest, such as ⌥X; each needs ⌥, ⌘ or ⌃), and say what each takes away (⌥X no longer types ≈). Once I pick one, run `sideby menubar hotkey <keys>`: it works within seconds, with no restart; then ask me to press it and check the menu opens. If nothing happens another app took it first, so try the next. Never change the shortcuts of macOS or another app.',
        pMenubar:
          'Run `sideby menubar --json` first. `state` is `off`: it was turned off (often with "Hide from Menu Bar…" in its menu); show me the preview of `sideby menubar on`, and add `--yes` after I agree. `state` is `on` with `loaded: false`: macOS is not running it; `sideby menubar on --yes` only starts it again and changes no file. `loaded: true`: it runs but is hidden; check in turn whether the menu bar is too full or the notch covers it (hold ⌘ and drag icons), whether a menu bar organizer such as Ice, Bartender or Hidden Bar tucked it away (look in /Applications, and tell me where in its settings to move sideby, shown as osascript, out), and, on macOS 26 and later, whether osascript is allowed under System Settings › Menu Bar. The shortcut in `hotkey.label` opens the menu from anywhere, which shows it is running. Never end or restart a process that is not sideby\'s.',
        cHandoff: 'Auto Handoff now (from `sideby handoff status --json`):',
        pHandoff:
          'Run `sideby handoff status --json` and `sideby quota --json` first to see where each account gets its quota and how much is used. Change settings only with `sideby handoff enable …` or `sideby config set handoff.<key> <value>`; show me the preview without `--yes` first, and add `--yes` only after I agree. Put accounts without quota data last in the order, and tell me how to make them show it.',
        cAccount: 'Account: ',
        cFamily: 'Family: ',
        cFindings: 'Health check findings:',
        cQuota: 'Quota reason: ',
        cVersion: 'sideby version: ',
        cTheme: 'Theme now: ',
        cCustom: 'Custom terminal command now: ',
        cTerminals: 'Supported terminals installed here: ',
        cNoTerminals: 'No supported terminal is installed here',
        cLang: 'Panel language: English (talk to me in English)',
        r1: 'Use the sideby skill; its references/ai-tasks.md says how. If the skill is not installed, ask me first, and with my yes run `npx skills add Adonis0123/sideby -g`.',
        r2: 'Show me the preview of any command that changes files; add `--yes` only after I agree.',
        r3: 'Never sign in for me and never ask me to send you an API key: I enter keys myself with `sideby key <account>`.',
        pFix: 'Run `sideby doctor --json` first; `sideby doctor --fix` fixes what it can by itself. When you are done, run `sideby doctor` and tell me what is left.',
        pQuota: 'Use `sideby quota --json` and `sideby doctor --json` to see why.',
        pAccount:
          "Take addresses, model names and variables from the vendor's official docs. When the account exists, have me enter the key with `sideby key <account>`, then try it with `sideby try <account>`. For a subscription sign-in, have me click Sign in in the Panel or run `sideby login <account>` myself.",
        pHost:
          'Start with `sideby plugins new <id>`; note the Host version and the date with every fact you gather; check it with `sideby plugins check <id>` and try it in a demo HOME.',
        pPlugin:
          'Follow the plugins guide in the sideby repository (docs/guide/plugins.md); check it with `sideby plugins check <id>`.',
        pTheme:
          'Run `sideby theme --json` first to see the Themes and the one in use, then ask me what feel I want; if I give you a screenshot, a website or a brand color, take the colors from it. Write a Theme File (JSON, colors only, never code): `{"schemaVersion":1,"name":"…","base":"teal", "leaf", "celeste", "claude" or "codex","accent":"#rrggbb","light":{…},"dark":{…}}`; usually `base` and `accent` are enough, and `light` / `dark` hold only the tokens to change (`sideby theme export teal` shows them all). Keep it in the current folder, run `sideby theme check <file>` and change what fails to the suggested values until every pair passes, then run `sideby theme preview <file>` so I can look at it in the Panel. Only when I like it, run `sideby theme import <file>` and `sideby theme use <name>`; otherwise keep changing it. `sideby theme use --undo` goes back at any time.',
        pTerminal:
          "Ask me which terminal I use first. Read only that terminal's official docs and its `--help` to find how it opens a new window that runs one command in a given folder, and note the version you read. Write it as a template: `{cmd}` is the command and `{cwd}` the folder; sideby fills them in as separate arguments, no shell runs it. Save it with `sideby terminal --custom '<template>'`, which changes sideby's settings, so ask me first. Then have me click Let AI do it in the Panel once to try it; if it does not open, look at the error with me and fix the template.",
        share:
          'When it works, ask me whether to share the improvement with sideby. Only with my yes, follow the CONTRIBUTING.md of the sideby repository to open a pull request, and first remove my own account names, paths and emails.',
        shareTerminal:
          'When it works, ask me whether to make this terminal built into sideby. Only with my yes, add a row to the terminal table in src/core/terminal.ts of the sideby repository with tests, follow its CONTRIBUTING.md to open a pull request, and first remove my own account names, paths and emails.',
      }
  const task = AI_TASK_KINDS.indexOf(input.task as AiTaskKind) >= 0 ? input.task : 'free'
  const sentence = (L as Record<string, string>)[task] || L.free
  const what = task === 'free' ? text || sentence : text ? sentence + '\n' + L.says + text : sentence
  const facts: string[] = []
  if (account) facts.push('- ' + L.cAccount + account)
  if (family) facts.push('- ' + L.cFamily + family)
  const findings = c.findings || []
  if (findings.length) {
    facts.push('- ' + L.cFindings)
    findings.forEach((f, i) => {
      const where = [clean(f.account), clean(f.item)].filter(Boolean).join(' · ')
      const code = clean(f.code)
      facts.push(
        '  ' +
          (i + 1) +
          '. ' +
          (code ? '[' + code + '] ' : '') +
          (where ? where + ': ' : '') +
          clean(f.message),
      )
      const hint = clean(f.hint)
      if (hint) facts.push('     ' + hint)
    })
  }
  const reason = clean(c.quotaReason)
  if (reason) facts.push('- ' + L.cQuota + reason)
  if (task === 'terminal') {
    const custom = clean(c.terminalCustom)
    if (custom) facts.push('- ' + L.cCustom + custom)
    const terms = (c.terminals || []).map(clean).filter(Boolean)
    facts.push('- ' + (terms.length ? L.cTerminals + terms.join(', ') : L.cNoTerminals))
  }
  if (task === 'theme') {
    const now = clean(c.theme)
    if (now) facts.push('- ' + L.cTheme + now)
  }
  if (task === 'handoff') {
    const lines = (c.handoff || []).map(clean).filter(Boolean)
    if (lines.length) facts.push('- ' + L.cHandoff, ...lines.map((l) => '  - ' + l))
  }
  const version = clean(c.version)
  if (version) facts.push('- ' + L.cVersion + version)
  facts.push('- ' + L.cLang)
  const pointer = (L as Record<string, string>)['p' + task.charAt(0).toUpperCase() + task.slice(1)]
  const parts = [L.task + '\n' + what, L.context + '\n' + facts.join('\n')]
  const attached = attachedSection(input.attachments || [], input.lang)
  if (attached) parts.push(attached)
  parts.push(L.rules + '\n- ' + L.r1 + '\n- ' + L.r2 + '\n- ' + L.r3)
  if (pointer) parts.push(L.pointers + '\n' + pointer)
  parts.push(task === 'terminal' ? L.shareTerminal : L.share)
  return parts.join('\n\n')
}

/**
 * The accounts an AI Task can start (spec §3.28), in the order the dialog lists them: signed-in subscription
 * accounts first, then API accounts, each by ref. A subscription that is not signed in cannot start one.
 */
export function aiTaskAccounts<A extends { ref: string; kind?: string; login?: string }>(
  accounts: readonly A[],
): A[] {
  const by = (x: A, y: A) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0)
  const subs = accounts.filter((a) => a.kind !== 'api' && a.login === 'logged-in').sort(by)
  const apis = accounts.filter((a) => a.kind === 'api').sort(by)
  return subs.concat(apis)
}

/**
 * Whether a quota cell offers "Ask AI why" (spec §3.28): it shows no data or an error the user cannot fix with a
 * button of its own. Quota that is off (it has its own switch), an API account and a Family without a public source
 * do not.
 */
export function quotaAskable(reason: string | undefined): boolean {
  if (!reason) return false
  return ['not-enabled', 'api-account', 'no-source'].indexOf(reason) < 0
}

/** A file size for an attachment tile (spec §3.28 "附件"): KB below 1 MB, MB with one decimal from there. */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  const mb = bytes / (1024 * 1024)
  return (mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)) + ' MB'
}

/** Findings as an AI Task's context carries them: only the fields a Task Prompt shows. */
export function taskFindings(
  findings: readonly { code?: string; account?: string; item?: string; message: string; hint?: string }[],
): { code?: string; account?: string; item?: string; message: string; hint?: string }[] {
  return findings.map((f) => {
    const out: { code?: string; account?: string; item?: string; message: string; hint?: string } = {
      message: String(f.message),
    }
    if (f.code) out.code = f.code
    if (f.account) out.account = f.account
    if (f.item) out.item = f.item
    if (f.hint) out.hint = f.hint
    return out
  })
}

/**
 * The theme and language the Panel shows (spec §3.29). A Panel that can write takes them from config `panel`; a
 * read-only one from what this browser saved. `language` is empty for the browser's own language.
 */
export function panelPrefs(
  config: { theme?: string; language?: string },
  local: { theme: string; lang: string },
  fromConfig: boolean,
): { theme: string; language: string } {
  if (!fromConfig) return { theme: local.theme, language: local.lang }
  const theme = config.theme === 'light' || config.theme === 'dark' ? config.theme : 'system'
  const language = config.language === 'en' || config.language === 'zh' ? config.language : ''
  return { theme, language }
}

/**
 * What this browser's own choice adds to config `panel` the first time this version opens (spec §3.29): only keys
 * config does not have yet, and only a choice the person made, not a default. Null when nothing is to be written.
 */
export function panelMigration(
  config: { theme?: string; language?: string },
  local: { theme: string; lang: string },
): { theme?: string; language?: string } | null {
  const patch: { theme?: string; language?: string } = {}
  if (config.theme === undefined && (local.theme === 'light' || local.theme === 'dark'))
    patch.theme = local.theme
  if (config.language === undefined && (local.lang === 'en' || local.lang === 'zh'))
    patch.language = local.lang
  return patch.theme || patch.language ? patch : null
}

/**
 * The line under the start-at-login switch (spec §3.29) as a message key, whether it is on, whether the switch can
 * be moved, and the action beside it: `fix` turns it on again so it starts this sideby. Read-only: no switch, no action.
 */
/**
 * A key press in the Panel's shortcut recorder as config `menubar.hotkey` writes it (`ctrl+opt+s`), or null while only
 * modifiers are held or the key is not a letter or digit. Reads `code`, not `key`: on a Mac ⌥S types "ß".
 */
export function hotkeyFromKey(e: {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code)
  if (!m) return null
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'opt', e.shiftKey && 'shift', e.metaKey && 'cmd'].filter(
    Boolean,
  )
  if (!mods.length) return null
  return [...mods, (m[1] || m[2])!.toLowerCase()].join('+')
}

/**
 * Whether a key press in the shortcut recorder is only a modifier being held (`wait`: the letter is still to come) or
 * a key the menu bar shortcut cannot use (`unsupported`: an arrow, F-key, Space and the like), so the recorder can say
 * so at once instead of looking stuck. A letter or digit is neither (see `hotkeyFromKey`).
 */
export function hotkeyPressKind(code: string): 'key' | 'wait' | 'unsupported' {
  if (/^(?:Key[A-Z]|Digit[0-9])$/.test(code)) return 'key'
  if (/^(?:Meta|Control|Alt|Shift|OS|CapsLock|Fn)/.test(code) || code === '') return 'wait'
  return 'unsupported'
}

export function autostartNote(
  s: { supported: boolean; state: string; current: boolean; loaded?: boolean } | null,
  readOnly: boolean,
): { key: string; on: boolean; toggle: boolean; action: 'fix' | null } {
  if (!s) return { key: 'as.checking', on: false, toggle: false, action: null }
  if (!s.supported) return { key: 'as.unsupported', on: false, toggle: false, action: null }
  if (s.state === 'foreign') return { key: 'as.foreign', on: false, toggle: false, action: null }
  const on = s.state === 'on' || s.state === 'stale'
  // Not running comes after stale (that fix starts it too) and before another copy (the icon is what is missing).
  const fix =
    s.state === 'stale'
      ? 'as.stale'
      : on && s.loaded === false
        ? 'as.notRunning'
        : on && !s.current
          ? 'as.other'
          : null
  return { key: fix || 'as.hint', on, toggle: !readOnly, action: fix && !readOnly ? 'fix' : null }
}

/**
 * The facts an Auto Handoff AI Task carries (spec §3.29), one per line, named as `sideby handoff status --json`
 * names them: the settings, the order per Family, and where each account's quota comes from. Account refs only,
 * never an email. `status` is the readiness, when the page has it.
 */
export function handoffTaskFacts(
  settings: {
    auto: boolean
    sameFamily: boolean
    threshold: number
    prepareAt: number
    waitIfResetWithinMinutes?: number
    countdownSeconds?: number
    families?: Record<string, { policy: string; order: readonly string[] }>
  },
  starters: readonly string[],
  accounts: readonly LogicAccount[],
  now: number,
  status?: {
    families?: readonly { family: string; ready: boolean; problems: readonly string[] }[]
    nextSteps?: readonly string[]
  } | null,
): string[] {
  const out = [
    'auto: ' + settings.auto,
    'sameFamily: ' + settings.sameFamily,
    'threshold: ' + settings.threshold,
    'prepareAt: ' + settings.prepareAt,
  ]
  if (settings.waitIfResetWithinMinutes !== undefined)
    out.push('waitIfResetWithinMinutes: ' + settings.waitIfResetWithinMinutes)
  if (settings.countdownSeconds !== undefined) out.push('countdownSeconds: ' + settings.countdownSeconds)
  out.push('families that can start a handoff: ' + (starters.length ? starters.join(', ') : 'none'))
  const fams = settings.families || {}
  for (const f of Object.keys(fams).sort()) {
    const o = fams[f]!
    out.push('order of ' + f + ': ' + o.policy + (o.order.length ? ' [' + o.order.join(', ') + ']' : ''))
  }
  for (const a of accounts) {
    const q = a.quota as { status: string; source?: string; reason?: string } | undefined
    let line: string
    if (a.kind === 'api') line = 'API account, no quota'
    else if (q && q.status === 'ok') {
      const p = quotaPressure(a, now)
      line = 'quota from ' + (q.source || 'unknown') + (p >= 0 ? ', ' + Math.round(p) + '% used' : '')
    } else line = 'no quota data' + (q?.reason ? ' (' + q.reason + ')' : '')
    if (a.kind !== 'api' && a.login && a.login !== 'logged-in') line += ', ' + a.login
    out.push(a.ref + ': ' + line)
  }
  for (const f of status?.families || [])
    if (!f.ready && f.problems.length) out.push('not ready, ' + f.family + ': ' + f.problems.join('; '))
  if (status?.nextSteps?.length) out.push('next steps: ' + status.nextSteps.join('; '))
  return out
}

/**
 * Whether a click on `target` inside a foldable row leaves the row as it is: a control, a tooltip, or anything in
 * the open details, whose lines (a Same Login row's directories among them) are there to use, not to close the row.
 */
export function foldSkips(target: { closest(selector: string): unknown }): boolean {
  return Boolean(target.closest('button, a, input, select, textarea, .tip, .row-detail'))
}

/** The Panel's layout bands, widest first; page-styles.ts hangs its narrow-screen rules on them. */
export type WidthTier = 'wide' | 'medium' | 'narrow' | 'phone'

/** The layout band for a viewport `width` in CSS pixels: up to 560 phone, up to 760 narrow, up to 1100 medium. */
export function widthTier(width: number): WidthTier {
  return width <= 560 ? 'phone' : width <= 760 ? 'narrow' : width <= 1100 ? 'medium' : 'wide'
}

/**
 * Follows a viewport width that changes frame by frame (a window being dragged, a Portal's sidebar sliding open
 * around the Panel's frame) and calls `apply` with the new band as soon as the width crosses into one, so the layout
 * moves together with the sliding edge instead of after it. For `settleMs` after that (restarted while the width keeps
 * moving) it only notes further crossings, then applies the band the width came to rest in if that differs, so one
 * gesture changes the layout at most twice and never flickers on every frame. Returns the function to call with each
 * new width.
 */
export function widthFollower<T>(
  shown: T,
  tierOf: (width: number) => T,
  apply: (tier: T) => void,
  settleMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void },
): (width: number) => void {
  let current = shown
  let latest = shown
  let timer: unknown = null
  const settle = () => {
    timer = null
    if (latest === current) return
    current = latest
    apply(latest)
  }
  return (width) => {
    latest = tierOf(width)
    if (timer !== null) {
      timers.clear(timer)
      timer = timers.set(settle, settleMs)
      return
    }
    if (latest === current) return
    current = latest
    apply(latest)
    timer = timers.set(settle, settleMs)
  }
}

// ---------- Session History (spec §3.33) ----------

/** When a History row was last active: "x min ago" within a week, then its date (key `time.on`). */
/**
 * Whether the end of a list is close enough to load its next page: within `margin` px of the bottom of what can be
 * seen, which is the viewport where the list's box grows with its rows (the page scrolls, not the box).
 */
export function tailInView(tailTop: number, boxBottom: number, viewHeight: number, margin = 200): boolean {
  return tailTop < Math.min(boxBottom, viewHeight) + margin
}

export function historyWhen(
  iso: string | undefined,
  now: number,
): { key: string; n?: number; date?: string } | null {
  const ts = Date.parse(iso || '')
  if (!Number.isFinite(ts)) return null
  const ms = Math.max(0, now - ts)
  if (ms < 7 * 86_400_000) return updatedAge(ms)
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { key: 'time.on', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
}

/** `text` cut into the parts that match one of `words` (any case) and the parts between, for highlighting. */
export function highlightParts(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  const low = text.toLowerCase()
  const marks: [number, number][] = []
  for (const w of words) {
    const lw = w.toLowerCase()
    if (!lw) continue
    for (let at = low.indexOf(lw); at >= 0; at = low.indexOf(lw, at + lw.length))
      marks.push([at, at + lw.length])
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out: { text: string; hit: boolean }[] = []
  let pos = 0
  for (const [from, to] of marks) {
    if (to <= pos) continue
    const start = Math.max(from, pos)
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false })
    out.push({ text: text.slice(start, to), hit: true })
    pos = to
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}

/**
 * What an empty History list says, and which way out it offers: a wider time range, searching tool output too.
 * Null while there are rows.
 */
export function historyEmpty(v: {
  q: string
  since: string
  state: string
  total: number
  tools: boolean
  project: string
  /** Accounts sideby found, and the Sessions stored for all of them, in any time. */
  accounts: number
  stored: number
  /** The chosen AI is one sideby reads no past Sessions of. */
  unreadable?: boolean
}): { key: string; widen: boolean; tools: boolean; accounts?: boolean; everywhere?: boolean } | null {
  if (v.total > 0) return null
  const searching = v.q.trim() !== ''
  const widen = v.since !== 'all'
  if (v.state === 'building') return { key: 'hist.emptyBuilding', widen: false, tools: false }
  if (v.unreadable) return { key: 'hist.emptyUnreadable', widen: false, tools: false }
  if (v.accounts === 0) return { key: 'hist.emptyNoAccounts', widen: false, tools: false, accounts: true }
  if (v.stored === 0 && !searching) return { key: 'hist.emptyNone', widen: false, tools: false }
  if (searching && v.project)
    return { key: 'hist.emptyMatchProject', widen, tools: !v.tools, everywhere: true }
  if (searching) return { key: 'hist.emptyMatch', widen, tools: !v.tools }
  if (v.project) return { key: 'hist.emptyProject', widen, tools: false }
  return { key: widen ? 'hist.emptySince' : 'hist.emptyNone', widen, tools: false }
}

/** A Session's messages for reading, with each run of tool calls folded into one line naming the tools. */
export function foldToolCalls<
  T extends { role: string; text: string; tool?: string; n: number; at?: string },
>(messages: readonly T[]): (T | { role: 'tools'; tools: string[]; n: number; at?: string })[] {
  const out: (T | { role: 'tools'; tools: string[]; n: number; at?: string })[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.role !== 'tool') out.push(m)
    else if (last && last.role === 'tools') (last as { tools: string[] }).tools.push(m.tool || m.text)
    else
      out.push(
        m.at
          ? { role: 'tools', tools: [m.tool || m.text], n: m.n, at: m.at }
          : { role: 'tools', tools: [m.tool || m.text], n: m.n },
      )
  }
  return out
}

/** One block of a message read as Markdown, for the conversation viewer. Text stays text: the page builds nodes. */
export type MdBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; head: string[]; align: ('left' | 'center' | 'right' | '')[]; rows: string[][] }
  | { type: 'hr' }

/**
 * Splits a message into Markdown blocks: headings, fenced code, quotes, lists, GitHub tables, rules and paragraphs.
 * An unclosed fence (a message cut short) runs to the end. Anything else is a paragraph, line breaks kept.
 */
export function mdBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  const cells = (line: string) => {
    let s = line.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  }
  const isRule = (line: string) =>
    /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-')
  const listItem = (line: string) => /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ type: 'p', text: para.join('\n') })
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!)
      i++
      out.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    const head = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (head) {
      flush()
      out.push({ type: 'h', level: head[1]!.length, text: head[2]! })
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push({ type: 'hr' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]!)) {
      const headCells = cells(line)
      const align = cells(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':')
          ? 'center'
          : c.endsWith(':')
            ? 'right'
            : c.startsWith(':')
              ? 'left'
              : '',
      )
      if (align.length === headCells.length) {
        flush()
        const rows: string[][] = []
        i += 2
        while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
          const r = cells(lines[i++]!)
          rows.push(headCells.map((_, k) => r[k] ?? ''))
        }
        out.push({ type: 'table', head: headCells, align, rows })
        continue
      }
    }
    if (/^\s{0,3}>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''))
      out.push({ type: 'quote', text: body.join('\n') })
      continue
    }
    const item = listItem(line)
    // A list may start right under a paragraph line; a numbered one only from 1, as in CommonMark.
    if (item && (!para.length || !/\d/.test(item[1]!) || /^1\D/.test(item[1]!))) {
      flush()
      const ordered = /\d/.test(item[1]!)
      const items: string[] = []
      while (i < lines.length) {
        const m = listItem(lines[i]!)
        if (m && /\d/.test(m[1]!) === ordered) items.push(m[2]!)
        else if (items.length && lines[i]!.trim() && /^\s{2,}/.test(lines[i]!))
          items[items.length - 1] += '\n' + lines[i]!.trim()
        else break
        i++
      }
      out.push({ type: 'list', ordered, items })
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return out
}

/** Inline Markdown in one block: `code`, **bold**, *italic*, and [links](https://…) with a web address only. */
export function mdInline(
  text: string,
): { t: 'text' | 'code' | 'b' | 'i' | 'a'; text: string; href?: string }[] {
  const out: { t: 'text' | 'code' | 'b' | 'i' | 'a'; text: string; href?: string }[] = []
  const re =
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) })
    if (m[1]) out.push({ t: 'code', text: m[2]!.trim() || m[2]! })
    else if (m[3] || m[4]) out.push({ t: 'b', text: (m[3] || m[4])! })
    else if (m[5]) out.push({ t: 'i', text: m[5] })
    else out.push({ t: 'a', text: m[6]!, href: m[7]! })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) })
  return out
}

/** The History filters a reload keeps. A tool-output search is left out: it reads every file again. */
export type HistFilters = {
  q: string
  since: string
  family: string
  account: string
  project: string
  category: string
  scripts: boolean
}

/** The History filters saved before a reload, each dropped back to its default when it is missing or malformed. */
export function histFilters(raw: unknown): HistFilters {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 1000 ? v : '')
  const since = str(o.since)
  return {
    q: str(o.q),
    since: ['today', '7d', '30d', 'all'].includes(since) ? since : '30d',
    family: str(o.family),
    account: str(o.account),
    project: str(o.project),
    category: str(o.category),
    scripts: o.scripts === true,
  }
}

/**
 * Saves one Auto Handoff change from the Handoff page (spec §3.17 "接力规则"): every change applies at once, and
 * the toast offers the undo the server read from the config as it was. Undoing offers no undo of its own.
 */
export async function saveHandoffChange(
  post: (path: string, body: object) => Promise<{ undo?: Record<string, unknown> }>,
  change: Record<string, unknown>,
  opts: { noUndo?: boolean } = {},
): Promise<{ undo: Record<string, unknown> | null }> {
  const r = await post('/api/handoff/configure', { change, confirm: true })
  return { undo: opts.noUndo || !r.undo ? null : r.undo }
}

/**
 * What the Handoff page shows after confirming the plan that turns Auto Handoff on (ADR-0013): the plan again when
 * it changed since it was shown (unless nothing is left to do) or is blocked, the first step that failed, or done.
 */
export function enableOutcome<
  P extends { alreadyOn?: boolean; blocked?: unknown },
  S extends { ok: boolean },
>(r: {
  changed?: boolean
  plan: P
  results: S[]
}): { kind: 'changed' | 'blocked'; plan: P } | { kind: 'failed'; step: S; plan: P } | { kind: 'done' } {
  if (r.changed && !r.plan.alreadyOn) return { kind: 'changed', plan: r.plan }
  if (r.plan.blocked) return { kind: 'blocked', plan: r.plan }
  const bad = r.results.find((x) => !x.ok)
  return bad ? { kind: 'failed', step: bad, plan: r.plan } : { kind: 'done' }
}
