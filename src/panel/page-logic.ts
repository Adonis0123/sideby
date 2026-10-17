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

/** The key a Same Login group keeps its folded state under: its members, in a fixed order. */
export function loginKey(refs: readonly string[]): string {
  return `login:${[...refs].sort().join(',')}`
}
