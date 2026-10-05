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
    windows?: { label: string; windowMinutes: number; usedPercent: number; resetsAt: string }[]
    observedAt?: string
    plan?: string
  }
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
  let max = -1
  for (const w of q.windows) {
    const reset = Date.parse(w.resetsAt)
    if (Number.isFinite(reset) && reset <= now) continue
    max = Math.max(max, Math.max(0, Math.min(100, Number(w.usedPercent) || 0)))
  }
  return q.windows.length && max < 0 ? 0 : max
}

/**
 * Why an Account needs a look, most serious first: `error`, `health-fail`, `signed-out`, `not-installed`,
 * `quota-high` (a live window at or over the warning level), `health-warn`. Empty when all is well.
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
  if (q && q.status === 'ok' && q.windows)
    for (const w of q.windows) {
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

/** Sorted copy: `pressure` (fullest Quota first), `name`, or `recent` (last activity first). The Main Account leads ties. */
export function sortAccounts<T extends LogicAccount>(list: T[], mode: string, now: number): T[] {
  const byName = (x: LogicAccount, y: LogicAccount) =>
    Number(Boolean(y.isMain)) - Number(Boolean(x.isMain)) ||
    x.name.localeCompare(y.name, undefined, { numeric: true })
  const pressure = (a: LogicAccount) => {
    const q = a.quota
    if (q?.status !== 'ok' || !q.windows) return -1
    let max = q.windows.length ? 0 : -1
    for (const w of q.windows) {
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
  else if (mode === 'recent') out.sort((x, y) => last(y) - last(x) || byName(x, y))
  else out.sort((x, y) => pressure(y) - pressure(x) || byName(x, y))
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
  for (let i = 2; ; i++) if (!taken['work' + i]) return 'work' + i
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
