// Pure helpers for the Panel page. page-script.ts embeds them with Function.prototype.toString(), so the
// browser runs exactly the code these tests cover. Each function must be self-contained: no imports, no
// references to module scope or to each other except through parameters, and only type annotations as
// TypeScript (they are stripped by Node and by the build, leaving plain JavaScript).

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
  usage?: {
    status: string
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
    daily?: { date: string; totalTokens: number }[]
    lastActivityAt?: string
  }
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

export interface HandoffSettingsView {
  auto: boolean
  sameFamily: boolean
  prepareAt: number
  threshold: number
  waitIfResetWithinMinutes: number
  countdownSeconds: number
  families: Record<string, { policy: string; order: string[] }>
}

export interface HandoffForm {
  auto: boolean
  sameFamily: boolean
  prepareAt: number
  threshold: number
  wait: number
  countdown: number
  orders: Record<string, { policy: string; order: string[] }>
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
 * The groups that turning Remote Control `to` on or off changes (spec §3.22): those that do not hold it yet, a
 * default counting as either. A file that is missing or cannot be read is never changed.
 */
export function remoteControlTodo<G extends { state: string }>(groups: readonly G[], to: 'on' | 'off'): G[] {
  return groups.filter((g) => g.state === 'default' || g.state === (to === 'on' ? 'off' : 'on'))
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
  'handoff',
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
        handoff: '帮我调好 sideby 的自动接力：根据我的账号推荐什么时候接力（阈值）和接力的顺序。',
        cHandoff: '自动接力现在的设置（来自 `sideby handoff status --json`）：',
        pHandoff:
          '先运行 `sideby handoff status --json` 和 `sideby quota --json`，看清每个账号的额度来源和用量。只用 `sideby handoff enable …` 或 `sideby config set handoff.<键> <值>` 改设置；先不加 `--yes` 给我看预览，我同意后再加 `--yes`。没有额度数据的账号排在顺序后面，并告诉我怎么让它显示额度。',
        cAccount: '账号：',
        cFamily: '家族：',
        cFindings: '体检发现：',
        cQuota: '额度原因：',
        cVersion: 'sideby 版本：',
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
        terminal: 'Help sideby open AI Tasks in the terminal I use: write a custom terminal command.',
        handoff:
          "Help me tune sideby's Auto Handoff: from my accounts, recommend when to hand over (the threshold) and in what order.",
        cHandoff: 'Auto Handoff now (from `sideby handoff status --json`):',
        pHandoff:
          'Run `sideby handoff status --json` and `sideby quota --json` first to see where each account gets its quota and how much is used. Change settings only with `sideby handoff enable …` or `sideby config set handoff.<key> <value>`; show me the preview without `--yes` first, and add `--yes` only after I agree. Put accounts without quota data last in the order, and tell me how to make them show it.',
        cAccount: 'Account: ',
        cFamily: 'Family: ',
        cFindings: 'Health check findings:',
        cQuota: 'Quota reason: ',
        cVersion: 'sideby version: ',
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
export function autostartNote(
  s: { supported: boolean; state: string; current: boolean } | null,
  readOnly: boolean,
): { key: string; on: boolean; toggle: boolean; action: 'fix' | null } {
  if (!s) return { key: 'as.checking', on: false, toggle: false, action: null }
  if (!s.supported) return { key: 'as.unsupported', on: false, toggle: false, action: null }
  if (s.state === 'foreign') return { key: 'as.foreign', on: false, toggle: false, action: null }
  const on = s.state === 'on' || s.state === 'stale'
  const fix = s.state === 'stale' ? 'as.stale' : on && !s.current ? 'as.other' : null
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
