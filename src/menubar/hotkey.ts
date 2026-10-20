// The Menu Bar Item's shortcut (spec §3.31, ADR-0034): which combinations a user may choose, and whether the menu bar
// script could register the one chosen. The script reports that through `menubar snapshot --hotkey ok|taken`, and
// only Node writes it down, to `<state>/menubar.json`.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AutostartContext, defaultExec, launchctlNote } from '../core/autostart.ts'
import { editConfigPath, loadConfig } from '../core/config.ts'
import { UserError } from '../core/errors.ts'
import { writeFileAtomic } from '../core/fs-safe.ts'
import { MENUBAR_RELOAD } from './script.ts'
import { DEFAULT_MENUBAR_HOTKEY, type MenubarHotkey, menubarHotkey } from './snapshot.ts'

/**
 * Combinations macOS or nearly every app already uses, in the order `checkHotkey` writes them; a menu shortcut there
 * would take them away. A list, because macOS tells no one: `RegisterEventHotKey` accepts even ⌘⇧3 from a second
 * process (macOS 27, 2026-10-20), and its own shortcuts are in `com.apple.symbolichotkeys` only once changed.
 */
const RESERVED: Record<string, string> = {
  'cmd+q': 'quits the app in front',
  'cmd+w': 'closes the window in front',
  'cmd+h': 'hides the app in front',
  'cmd+m': 'minimizes the window in front',
  'cmd+c': 'copies',
  'cmd+v': 'pastes',
  'cmd+x': 'cuts',
  'cmd+z': 'undoes',
  'cmd+a': 'selects all',
  'cmd+s': 'saves',
  'shift+cmd+3': 'takes a screenshot',
  'shift+cmd+4': 'takes a screenshot',
  'shift+cmd+5': 'opens the screenshot tool',
  'opt+cmd+d': 'shows and hides the Dock',
  'opt+cmd+h': 'hides the other apps',
  'ctrl+cmd+q': 'locks the screen',
  'ctrl+cmd+f': 'turns full screen on and off',
}

const ORDER = ['ctrl', 'opt', 'shift', 'cmd'] as const

export type HotkeyProblemCode = 'hotkey.invalid' | 'hotkey.needs-modifier' | 'hotkey.reserved'

export type HotkeyCheck =
  | { ok: true; keys: string; hotkey: MenubarHotkey | null }
  | { ok: false; code: HotkeyProblemCode; message: string }

/**
 * A value for config `menubar.hotkey`, as typed by a user or sent by the Panel: `off`, `default`, or modifiers and one
 * letter or digit in any order and case (`Cmd+Opt+K`). Returns it in the written order (`opt+cmd+k`), or why not.
 */
export function checkHotkey(value: string): HotkeyCheck {
  const v = value.trim().toLowerCase().replace(/\s+/g, '')
  if (v === 'off') return { ok: true, keys: 'off', hotkey: null }
  if (v === 'default' || v === DEFAULT_MENUBAR_HOTKEY)
    return { ok: true, keys: DEFAULT_MENUBAR_HOTKEY, hotkey: menubarHotkey(DEFAULT_MENUBAR_HOTKEY) }
  const parts = v.split('+').map((p) => (p === 'option' || p === 'alt' ? 'opt' : p === 'command' ? 'cmd' : p))
  const key = parts.pop() ?? ''
  const mods = ORDER.filter((m) => parts.includes(m))
  const keys = [...mods, key].join('+')
  const hotkey = parts.length && mods.length === parts.length ? menubarHotkey(keys) : null
  if (!hotkey)
    return {
      ok: false,
      code: 'hotkey.invalid',
      message: `"${value}" is not a shortcut sideby can use; write modifiers and one letter or digit, such as opt+x, or off`,
    }
  // ⌥ alone is allowed: it only types a rare symbol (⌥X types ≈), and two keys are what one hand presses easily.
  if (!mods.includes('cmd') && !mods.includes('ctrl') && !mods.includes('opt'))
    return {
      ok: false,
      code: 'hotkey.needs-modifier',
      message: `${hotkey.label} would fire while you type; add opt, cmd or ctrl, such as opt+${key}`,
    }
  const reserved = RESERVED[keys]
  if (reserved)
    return {
      ok: false,
      code: 'hotkey.reserved',
      message: `${hotkey.label} ${reserved} in macOS; pick another, such as ctrl+opt+${key}`,
    }
  return { ok: true, keys, hotkey }
}

/** What the menu bar script last said about registering the shortcut; kept so the Panel and CLI can say it. */
export interface HotkeyState {
  /** The shortcut it tried, as macOS writes it (`⌥⌘S`). */
  label: string
  /** False: macOS did not take it (another app or macOS holds it). Another app's same keys usually go unnoticed. */
  registered: boolean
  at: string
}

/** What the menu bar script last said about its icon: whether macOS shows it in the menu bar right now. */
export interface IconState {
  /** False: the menu bar has room for it no longer (it sits behind «), or another app covers it. */
  visible: boolean
  at: string
}

/** Everything the menu bar script reports, kept by Node in `<state>/menubar.json`; the script itself writes no file. */
export interface MenubarState {
  hotkey?: HotkeyState
  icon?: IconState
}

const stateFile = (stateDir: string) => join(stateDir, 'menubar.json')

export async function readMenubarState(stateDir: string): Promise<MenubarState> {
  try {
    const v = JSON.parse(await readFile(stateFile(stateDir), 'utf8')) as MenubarState
    const h = v.hotkey
    const i = v.icon
    return {
      ...(h && typeof h.label === 'string' && typeof h.registered === 'boolean' ? { hotkey: h } : {}),
      ...(i && typeof i.visible === 'boolean' && typeof i.at === 'string' ? { icon: i } : {}),
    }
  } catch {
    return {}
  }
}

/** Merges `patch` into the kept state. */
export async function writeMenubarState(stateDir: string, patch: MenubarState): Promise<void> {
  const next = { ...(await readMenubarState(stateDir)), ...patch }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFileAtomic(stateFile(stateDir), `${JSON.stringify(next, null, 2)}\n`)
}

export async function readHotkeyState(stateDir: string): Promise<HotkeyState | null> {
  return (await readMenubarState(stateDir)).hotkey ?? null
}

export function writeHotkeyState(stateDir: string, state: HotkeyState): Promise<void> {
  return writeMenubarState(stateDir, { hotkey: state })
}

/** The icon as the Panel and `sideby menubar --json` show it; null when the script has not said (or said long ago). */
export function iconView(state: IconState | undefined, now: Date): { visible: boolean | null } {
  // A report older than a few refreshes may no longer hold (the item was turned off, the Mac slept).
  const fresh = state && now.getTime() - Date.parse(state.at) < 15 * 60_000
  return { visible: fresh ? state.visible : null }
}

/**
 * Tells a running menu bar item to take a changed setting now (such as its shortcut), through a macOS distributed
 * notification: it reads its snapshot again within a second or two, with no restart. Posted by the system's
 * `osascript`, only for the login user's own session (never from a test or a demo HOME). True when it was posted.
 */
export async function nudgeMenubar(ctx: AutostartContext): Promise<boolean> {
  if ((ctx.platform ?? process.platform) !== 'darwin' || launchctlNote(ctx)) return false
  const post = `ObjC.import('Foundation'); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately($('${MENUBAR_RELOAD}'), $(), $(), true); ''`
  const r = await (ctx.exec ?? defaultExec)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', post])
  return r.code === 0
}

/** The shortcut as `sideby menubar hotkey --json` and the Panel show it. */
export interface HotkeyView {
  /** As config holds it, or the default: `opt+x`, `off`. */
  keys: string
  /** As macOS writes it (`⌥⌘S`); empty when off. */
  label: string
  enabled: boolean
  isDefault: boolean
  /** Whether the menu bar item could register it; null when it has not said yet (or it is off). */
  registered: boolean | null
  /** A value config allows but a new choice would not (such as shift alone); it still works. */
  problem?: { code: HotkeyProblemCode; message: string }
}

export function hotkeyView(configured: string | undefined, state: HotkeyState | null): HotkeyView {
  const keys = configured ?? DEFAULT_MENUBAR_HOTKEY
  const hotkey = menubarHotkey(keys)
  const label = hotkey?.label ?? ''
  const check = keys === 'off' ? null : checkHotkey(keys)
  return {
    keys,
    label,
    enabled: hotkey !== null,
    isDefault: keys === DEFAULT_MENUBAR_HOTKEY,
    registered: hotkey && state && state.label === label ? state.registered : null,
    ...(check && !check.ok ? { problem: { code: check.code, message: check.message } } : {}),
  }
}

/** System Settings › Menu Bar, where macOS 26 and later let each app's menu bar item show (or not). */
export const MENU_BAR_SETTINGS_URL = 'x-apple.systempreferences:com.apple.ControlCenter-Settings.extension'

/** Opens System Settings at the Menu Bar page with `/usr/bin/open`; true when it opened. */
export async function openMenuBarSettings(ctx: AutostartContext): Promise<boolean> {
  if ((ctx.platform ?? process.platform) !== 'darwin') return false
  const r = await (ctx.exec ?? defaultExec)('/usr/bin/open', [MENU_BAR_SETTINGS_URL])
  return r.code === 0
}

/**
 * `sideby menubar hotkey <keys|off|default>` and the Panel's recorder: checks the value, writes config
 * `menubar.hotkey` (removes it for the default), and tells a running menu bar item, which takes the new key within seconds.
 */
export async function setMenubarHotkey(opts: {
  configFile: string
  stateDir: string
  value: string
  ctx: AutostartContext
}): Promise<{ changed: boolean; nudged: boolean; hotkey: HotkeyView }> {
  const check = checkHotkey(opts.value)
  if (!check.ok) throw new UserError(check.message, { code: check.code })
  const next = check.keys === DEFAULT_MENUBAR_HOTKEY ? undefined : check.keys
  const r = await editConfigPath(opts.configFile, 'menubar.hotkey', next)
  const nudged = r.changed ? await nudgeMenubar(opts.ctx) : false
  const config = await loadConfig(opts.configFile)
  return {
    changed: r.changed,
    nudged,
    hotkey: hotkeyView(config.menubar?.hotkey, await readHotkeyState(opts.stateDir)),
  }
}
