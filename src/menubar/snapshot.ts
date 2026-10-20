// What the Menu Bar Item shows (spec §3.31, ADR-0034), computed here so the menu bar script only draws it.
import type { HandoffPlan } from '../core/handoff.ts'
import { openWindows, quotaIsStale, quotaLevel } from '../core/quota-levels.ts'
import type { Account, FamilyLogo, LoginState, QuotaResult } from '../types.ts'
import { fill, MENUBAR_STRINGS, type MenubarLang, type MenubarStrings } from './strings.ts'

export type MenubarLevel = 'ok' | 'warn' | 'fail' | 'none'

/** One quota window drawn as a small bar. */
export interface MenubarBar {
  label: string
  percent: number
  level: MenubarLevel
}

export interface MenubarRow {
  ref: string
  label: string
  /** The whole row as one line of text, for readers that do not draw bars. */
  detail: string
  level: MenubarLevel
  /** The account `sideby next` would pick in this Family. */
  recommended: boolean
  /** When the quota was observed, independently of the menu's check time; null without quota. */
  observedAt: string | null
  /** An old or undated reading, or a failed quota query. */
  stale: boolean
  /** Hover text: when each window resets, and what a click does. */
  tip: string
  /**
   * The bars, in two columns: the shorter window, then the longer one. A Family with one window (such as `7d`) fills
   * the second, so the long windows of all Families line up. Null when the row has no Quota to draw.
   */
  bars: [MenubarBar | null, MenubarBar | null] | null
  /** How long until the fullest window resets, such as `4d 17h`; empty when nothing is used. */
  reset: string
  /** A no-quota explanation, or an old-reading warning beside the bars. */
  note: string
}

export interface MenubarSection {
  family: string
  title: string
  /**
   * The Family's mark before its title, as the Panel draws it: in its brand `color` when it has one, else in the
   * menu's text colour; null when the Family has no mark.
   */
  logo: { path: string; fillRule?: 'nonzero' | 'evenodd'; color?: string } | null
  /** The window names above the two bar columns, such as `5h` and `7d`; null where no row has that column. */
  columns: [string | null, string | null]
  /** The recommended account first, then the others in Display Order. */
  rows: MenubarRow[]
  /** API key and signed-out accounts, behind one submenu; null when there are none or nothing else to show. */
  more: { title: string; rows: MenubarRow[] } | null
}

export interface MenubarSnapshot {
  schemaVersion: 1
  /**
   * The words next to the icon, such as `Codex 62%`: only once the tightest Family's best account reaches the warning
   * level; empty while every Family has quota left, or without Quota data, so the icon stands alone.
   */
  title: string
  level: MenubarLevel
  tooltip: string
  /** The first line of the menu as one line of text: which account the title belongs to; empty without Quota data. */
  headline: string
  /** The card at the top of the menu: a bold status and a grey line naming the account; null without Quota data. */
  card: { status: string; detail: string; level: MenubarLevel } | null
  /** The shortcut that opens the menu from anywhere (config `menubar.hotkey`); null when turned off. */
  hotkey: MenubarHotkey | null
  /** When this snapshot was made (ISO). */
  updatedAt: string
  lang: MenubarLang
  sections: MenubarSection[]
  /** Footer words; the script fills `{n}` of `updatedMinutes` itself. */
  labels: Pick<
    MenubarStrings,
    | 'recommended'
    | 'empty'
    | 'loading'
    | 'addAccount'
    | 'resetsHeader'
    | 'updatedJustNow'
    | 'updatedMinutes'
    | 'refreshing'
    | 'refreshFailed'
    | 'refresh'
    | 'openPanel'
    | 'hide'
    | 'hideTitle'
    | 'hideBody'
    | 'hideYes'
    | 'cancel'
    | 'hotkeyTaken'
  >
}

export interface MenubarFamilyInput {
  id: string
  title: string
  logo?: FamilyLogo | null
  /** Its Handoff ranking (`sideby next`); null when the Family has no Quota source. */
  plan: HandoffPlan | null
  /** In Display Order. */
  accounts: {
    ref: string
    name: string
    kind: Account['kind']
    login: LoginState | 'not-needed'
    quota: QuotaResult
    /** The other refs of its Same Login: the same subscription, so one quota. */
    sameLogin?: readonly string[]
  }[]
}

/** A shortcut as the menu bar script registers it: a macOS virtual key code and Carbon modifier flags. */
export interface MenubarHotkey {
  keyCode: number
  modifiers: number
  /** How macOS writes it, such as `⌥⌘S`. */
  label: string
}

export const DEFAULT_MENUBAR_HOTKEY = 'opt+x'

// macOS virtual key codes of the ANSI letters and digits (HIToolbox Events.h, kVK_ANSI_*).
const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '9': 25,
  '7': 26,
  '8': 28,
  '0': 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
}
// Carbon modifier flags (cmdKey, shiftKey, optionKey, controlKey) and their signs, in the order macOS writes them.
const MODIFIERS = [
  ['ctrl', 4096, '⌃'],
  ['opt', 2048, '⌥'],
  ['shift', 512, '⇧'],
  ['cmd', 256, '⌘'],
] as const

/** Config `menubar.hotkey` (`opt+x`, `off`) as the script registers it; null for `off` or a bad value. */
export function menubarHotkey(value: string | undefined): MenubarHotkey | null {
  const parts = (value ?? DEFAULT_MENUBAR_HOTKEY).toLowerCase().split('+')
  const key = parts.pop()!
  const keyCode = KEY_CODES[key]
  if (keyCode === undefined || !parts.length) return null
  const mods = MODIFIERS.filter(([name]) => parts.includes(name))
  if (mods.length !== parts.length) return null
  return {
    keyCode,
    modifiers: mods.reduce((n, [, flag]) => n + flag, 0),
    label: mods.map(([, , sign]) => sign).join('') + key.toUpperCase(),
  }
}

/** `2h 5m`, `3d 4h` or `12m` until `at`; at least one minute. */
export function untilText(at: string, now: Date, s: MenubarStrings): string {
  const total = Math.max(1, Math.ceil((Date.parse(at) - now.getTime()) / 60000))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return fill(s.daysHours, { d, h })
  if (h > 0) return fill(s.hoursMinutes, { h, m })
  return fill(s.minutes, { m })
}

function row(
  a: MenubarFamilyInput['accounts'][number],
  plan: HandoffPlan | null,
  now: Date,
  s: MenubarStrings,
): MenubarRow {
  const recommended = Boolean(plan?.hasQuota && plan.pick === a.ref)
  const startTip = fill(s.startTip, { account: a.ref })
  const base = {
    ref: a.ref,
    label: a.name,
    recommended,
    tip: startTip,
    bars: null,
    reset: '',
    observedAt: null,
    stale: false,
  }
  const noted = (note: string): MenubarRow => ({ ...base, detail: note, note, level: 'none' })
  if (a.kind === 'api') return noted(s.api)
  if (a.login === 'logged-out') return noted(s.signedOut)
  const open = openWindows(a.quota, now)
  if (a.quota.status !== 'ok' || open === null) return noted(s.noData)
  const observedAt = a.quota.observedAt
  const at = Date.parse(observedAt)
  const stale = quotaIsStale(a.quota, now.getTime())
  const windows = a.quota.windows
    .filter((w) => !w.name)
    .sort((x, y) => (x.windowMinutes ?? 0) - (y.windowMinutes ?? 0))
  const bar = (w: (typeof windows)[number]): MenubarBar => {
    const percent = Math.round(open.find((o) => o.label === w.label)?.usedPercent ?? 0)
    return { label: w.label, percent, level: quotaLevel(percent) }
  }
  // Two columns: the shortest window, then the fullest of the others, so a third window that is used up still shows.
  const longer = windows
    .slice(1)
    .map(bar)
    .reduce<MenubarBar | null>((best, b) => (!best || b.percent > best.percent ? b : best), null)
  const bars: MenubarRow['bars'] = longer ? [bar(windows[0]!), longer] : [null, bar(windows[0]!)]
  const parts = windows.map((w) => fill(s.window, { label: w.label, p: bar(w).percent }))
  const fullest = open.reduce<(typeof open)[number] | null>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    null,
  )
  const reset = fullest && fullest.usedPercent > 0 ? untilText(fullest.resetsAt, now, s) : ''
  if (reset) parts.push(fill(s.resets, { time: reset }))
  if (stale) parts.push(s.olderReading)
  const tips = open
    .filter((w) => w.usedPercent > 0)
    .map((w) => fill(s.resetsTip, { label: w.label, time: untilText(w.resetsAt, now, s) }))
  return {
    ...base,
    observedAt,
    stale,
    detail: parts.join(s.sep),
    level: quotaLevel(fullest?.usedPercent ?? 0),
    tip: [
      fill(s.observedAt, { time: Number.isFinite(at) ? observedAt : '?' }),
      ...(stale ? [s.olderReading] : []),
      ...(a.quota.fetchError ? [a.quota.fetchError] : []),
      ...tips,
      startTip,
    ].join('\n'),
    bars,
    reset,
    note: stale ? s.olderReading : '',
  }
}

/** The recommended row first; API key and signed-out rows into `more` while other rows remain to show. */
function columns(rows: MenubarRow[]): MenubarSection['columns'] {
  const at = (i: 0 | 1) => rows.map((r) => r.bars?.[i]?.label).find((l) => l !== undefined) ?? null
  return [at(0), at(1)]
}

function section(f: MenubarFamilyInput, now: Date, s: MenubarStrings): MenubarSection {
  const logo = f.logo
    ? {
        path: f.logo.path,
        ...(f.logo.fillRule ? { fillRule: f.logo.fillRule } : {}),
        ...(f.logo.color ? { color: f.logo.color } : {}),
      }
    : null
  const all = f.accounts.map((a) => ({ a, r: row(a, f.plan, now, s) }))
  const aside = (a: MenubarFamilyInput['accounts'][number]) => a.kind === 'api' || a.login === 'logged-out'
  // A Same Login is one quota, so one row, named like the Panel's: after the directory first in Display Order (the
  // Panel's "Set as shown name" moves one there). It is recommended when any of its directories is. The other
  // directories move into the submenu, where a click still starts them.
  const shown: typeof all = []
  const same: typeof all = []
  const done = new Set<string>()
  for (const x of all.filter((y) => !aside(y.a))) {
    if (done.has(x.a.ref)) continue
    const peers = new Set(x.a.sameLogin ?? [])
    const group = all.filter((y) => y === x || (peers.has(y.a.ref) && !aside(y.a) && !done.has(y.a.ref)))
    for (const y of group) done.add(y.a.ref)
    const lead = x
    const others = group.filter((y) => y !== lead)
    shown.push(
      others.length
        ? {
            ...lead,
            r: {
              ...lead.r,
              recommended: group.some((y) => y.r.recommended),
              tip: [fill(s.sameLoginTip, { names: others.map((y) => y.a.name).join(', ') }), lead.r.tip].join(
                '\n',
              ),
            },
          }
        : lead,
    )
    for (const y of others) {
      const note = fill(s.sameLoginNote, { name: lead.a.name })
      same.push({
        ...y,
        r: { ...y.r, bars: null, reset: '', note, detail: note, level: 'none', recommended: false },
      })
    }
  }
  const main = shown
  const rest = [...same, ...all.filter((x) => aside(x.a))]
  const head = { family: f.id, title: f.title, logo }
  if (!main.length)
    return { ...head, columns: columns(rest.map((x) => x.r)), rows: rest.map((x) => x.r), more: null }
  const rows = [...main.filter((x) => x.r.recommended), ...main.filter((x) => !x.r.recommended)].map(
    (x) => x.r,
  )
  if (!rest.length) return { ...head, columns: columns(rows), rows, more: null }
  const api = rest.filter((x) => x.a.kind === 'api').length
  const out = rest.filter((x) => x.a.login === 'logged-out' && x.a.kind !== 'api').length
  const n = rest.length
  const title = fill(api === n ? s.moreApi : out === n ? s.moreSignedOut : s.moreMixed, { n })
  return { ...head, columns: columns(rows), rows, more: { title, rows: rest.map((x) => x.r) } }
}

/**
 * Each Family's number is the Quota Pressure of the account `sideby next` would pick, or, when every account is past
 * the fail level, the lowest of theirs; the title shows the highest of these, so it turns red when some tool has
 * nothing left to hand over to.
 */
export function menubarSnapshot(
  families: readonly MenubarFamilyInput[],
  now: Date,
  lang: MenubarLang,
  hotkey: MenubarHotkey | null = null,
): MenubarSnapshot {
  const s = MENUBAR_STRINGS[lang]
  let worst: { value: number; ref: string; tool: string } | null = null
  const sections: MenubarSection[] = []
  for (const f of families) {
    if (!f.accounts.length) continue
    sections.push(section(f, now, s))
    if (!f.plan?.hasQuota) continue
    // The plan lists the usable accounts first, least used first; past them, the least used of the full ones.
    // A pick without Quota of its own (`unknown`) says nothing about how much is left.
    const best = f.plan.pick
      ? f.plan.accounts.find((e) => e.ref === f.plan!.pick)
      : f.plan.accounts
          .filter((e) => e.state === 'full' && e.pressure !== null)
          .sort((x, y) => x.pressure! - y.pressure!)[0]
    const value = best?.pressure ?? null
    if (best && value !== null && (!worst || value > worst.value))
      worst = { value, ref: best.ref, tool: f.title }
  }
  const values: Record<string, string | number> = worst
    ? { account: worst.ref, tool: worst.tool, p: Math.round(worst.value) }
    : {}
  const low = worst !== null && quotaLevel(worst.value) !== 'ok'
  const old = sections.some((s) => s.rows.some((r) => r.stale))
  const {
    recommended,
    empty,
    loading,
    addAccount,
    resetsHeader,
    updatedJustNow,
    updatedMinutes,
    refreshing,
    refreshFailed,
    refresh,
    openPanel,
    hide,
    hideTitle,
    hideBody,
    hideYes,
    cancel,
    hotkeyTaken,
  } = s
  return {
    schemaVersion: 1,
    title: low ? fill(s.title, values) : '',
    level: worst && !old ? quotaLevel(worst.value) : 'none',
    tooltip: [
      old
        ? `${s.statusOld} · ${s.detailOld}`
        : worst
          ? fill(low ? s.tooltipLow : s.tooltipOk, values)
          : s.tooltipEmpty,
      ...(hotkey ? [fill(s.hotkeyTip, { key: hotkey.label })] : []),
    ].join('\n'),
    hotkey,
    headline: worst ? (old ? s.statusOld : fill(low ? s.headlineLow : s.headlineOk, values)) : '',
    card: worst
      ? {
          status: old ? s.statusOld : fill(low ? s.statusLow : s.statusOk, values),
          detail: old ? s.detailOld : fill(low ? s.detailLow : s.detailOk, values),
          level: old ? 'none' : quotaLevel(worst.value),
        }
      : null,
    updatedAt: now.toISOString(),
    lang,
    sections,
    labels: {
      recommended,
      empty,
      loading,
      addAccount,
      resetsHeader,
      updatedJustNow,
      updatedMinutes,
      refreshing,
      refreshFailed,
      refresh,
      openPanel,
      hide,
      hideTitle,
      hideBody,
      hideYes,
      cancel,
      hotkeyTaken,
    },
  }
}

/** The language of the menu: config `panel.language`, else the system language the script passes, else English. */
export function menubarLang(configured: string | undefined, system: string | undefined): MenubarLang {
  if (configured === 'en' || configured === 'zh') return configured
  return /^zh/i.test(system ?? '') ? 'zh' : 'en'
}
