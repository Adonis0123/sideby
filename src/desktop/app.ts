// `sideby app install|uninstall`: a double-clickable launcher for the Panel. macOS gets ~/Applications/sideby.app,
// Linux a .desktop entry. The launcher runs the recorded Node and sideby entry with `ui --background`, or with
// `--url` just opens that address. Every file carries APP_MARKER, and uninstall removes only marked files.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { UserError } from '../core/errors.ts'
import { lstatOrNull, writeFileAtomic } from '../core/fs-safe.ts'
import type { Env } from '../types.ts'
import { APP_MARKER, encodeIcns, ICONSET, iconPng, iconSvg } from './icon.ts'

export const BUNDLE_ID = 'dev.sideby.panel'
const APP_NAME = 'sideby'

export type AppPlatform = 'darwin' | 'linux'

/** Runs a helper program; resolves false (never rejects) when it is missing or fails. */
export type Runner = (cmd: string, args: string[]) => Promise<boolean>

export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 60_000 }, (err) => resolve(!err)))

export interface AppContext {
  home: string
  env: Env
  platform: NodeJS.Platform
  run?: Runner
}

export interface InstallOptions {
  /** Absolute path of the Node binary the launcher runs (normally `process.execPath`). */
  node: string
  /** Absolute path of the sideby CLI entry. */
  entry: string
  /** Open this address instead of starting the Panel, for a portal that embeds it. */
  url?: string
  version: string
}

export interface InstallResult {
  platform: AppPlatform
  /** The app bundle (macOS) or the .desktop file (Linux). */
  path: string
  files: string[]
  mode: 'panel' | 'url'
  url?: string
  node: string
  entry: string
  updated: boolean
  hints: string[]
}

export interface UninstallResult {
  platform: AppPlatform
  removed: string[]
  skipped: { path: string; reason: string }[]
}

function platformOf(ctx: AppContext): AppPlatform {
  if (ctx.platform === 'darwin' || ctx.platform === 'linux') return ctx.platform
  throw new UserError(
    `sideby app supports macOS and Linux; on ${ctx.platform} run \`sideby ui --background\` from a shortcut instead`,
  )
}

/** Checks a `--url` value: an http or https address. */
export function checkAppUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new UserError(`--url must be a full address such as http://localhost:17333/ (got "${url}")`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new UserError(`--url must start with http:// or https:// (got "${url}")`)
  return u.href
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface LauncherSpec {
  node: string
  entry: string
  url?: string
  platform: AppPlatform
  /** XDG directories set when installing, so the app reads the same config and state as the terminal. */
  xdg: { XDG_CONFIG_HOME?: string; XDG_STATE_HOME?: string }
}

/** The POSIX shell launcher. It records absolute paths and falls back to `sideby` from the login shell. */
export function launcherScript(s: LauncherSpec): string {
  const opener = s.platform === 'darwin' ? 'open' : 'xdg-open'
  const alert =
    s.platform === 'darwin'
      ? `/usr/bin/osascript -e 'display alert "sideby could not start" message "Run sideby app install again in a terminal. Details: '"$LOG"'"' >/dev/null 2>&1`
      : `command -v notify-send >/dev/null 2>&1 && notify-send "sideby could not start" "Run sideby app install again in a terminal. Details: $LOG"`
  const lines = [
    '#!/bin/sh',
    `# ${APP_MARKER}: written by \`sideby app install\`. Run that again after upgrading sideby or Node.`,
    `NODE=${shq(s.node)}`,
    `ENTRY=${shq(s.entry)}`,
    `URL=${shq(s.url ?? '')}`,
  ]
  for (const [k, v] of Object.entries(s.xdg)) if (v) lines.push(`export ${k}=${shq(v)}`)
  lines.push(
    `LOG="\${XDG_STATE_HOME:-$HOME/.local/state}/sideby/launcher.log"`,
    'mkdir -p "$(dirname "$LOG")" 2>/dev/null',
    'if [ -n "$URL" ]; then',
    `  exec ${opener} "$URL"`,
    'fi',
    'if [ -x "$NODE" ] && [ -f "$ENTRY" ]; then',
    '  "$NODE" "$ENTRY" ui --background >>"$LOG" 2>&1 && exit 0',
    'else',
    '  # The recorded Node or sideby moved (an upgrade, a version manager): ask the login shell for `sideby`.',
    `  "\${SHELL:-/bin/sh}" -ilc 'sideby ui --background' >>"$LOG" 2>&1 </dev/null && exit 0`,
    'fi',
    alert,
    'exit 1',
    '',
  )
  return lines.join('\n')
}

export function infoPlist(version: string): string {
  const entries: [string, string][] = [
    ['CFBundleName', APP_NAME],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', APP_NAME],
    ['CFBundleIconFile', 'AppIcon'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['LSMinimumSystemVersion', '10.13'],
    ['SidebyInstalledBy', APP_MARKER],
  ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...entries.flatMap(([k, v]) => [`  <key>${k}</key>`, `  <string>${xml(v)}</string>`]),
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** Desktop Entry `Exec` value; refuses characters that would need the spec's double escaping. */
function execArg(p: string): string {
  if (/["`$\\%\n\r]/.test(p))
    throw new UserError(`cannot write a desktop entry for a path with ", \`, $, \\ or %: ${p}`)
  return `"${p}"`
}

export function desktopEntry(launcher: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Every AI coding account side by side',
    `Exec=${execArg(launcher)}`,
    `Icon=${APP_NAME}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    `X-Sideby-Installed-By=${APP_MARKER}`,
    '',
  ].join('\n')
}

interface Layout {
  /** What install writes, top-level entries only (the macOS bundle is one directory). */
  entries: string[]
  primary: string
}

function layout(ctx: AppContext, platform: AppPlatform): Layout & { linux?: Record<string, string> } {
  if (platform === 'darwin') {
    const app = join(ctx.home, 'Applications', `${APP_NAME}.app`)
    return { entries: [app], primary: app }
  }
  const dataHome =
    ctx.env.XDG_DATA_HOME && isAbsolute(ctx.env.XDG_DATA_HOME)
      ? ctx.env.XDG_DATA_HOME
      : join(ctx.home, '.local', 'share')
  const linux = {
    desktop: join(dataHome, 'applications', `${APP_NAME}.desktop`),
    launcher: join(dataHome, APP_NAME, 'sideby-launcher'),
    svg: join(dataHome, 'icons', 'hicolor', 'scalable', 'apps', `${APP_NAME}.svg`),
    png: join(dataHome, 'icons', 'hicolor', '256x256', 'apps', `${APP_NAME}.png`),
  }
  return { entries: Object.values(linux), primary: linux.desktop, linux }
}

/** How each kind of install target carries APP_MARKER; anything that merely mentions it elsewhere is foreign. */
function markerTest(entry: string): (data: Buffer) => boolean {
  if (entry.endsWith('.app'))
    return (d) =>
      new RegExp(`<key>SidebyInstalledBy</key>\\s*<string>${APP_MARKER}</string>`).test(d.toString('utf8'))
  if (entry.endsWith('.desktop'))
    return (d) => new RegExp(`^X-Sideby-Installed-By=${APP_MARKER}$`, 'm').test(d.toString('utf8'))
  if (entry.endsWith('.svg')) return (d) => d.includes(`<!-- ${APP_MARKER} -->`)
  if (entry.endsWith('.png')) return (d) => d.includes(`tEXtSoftware\0${APP_MARKER}`, 0, 'latin1')
  // The launcher script: the marker comment is its second line.
  return (d) => d.toString('utf8').split('\n', 2)[1]?.startsWith(`# ${APP_MARKER}: `) === true
}

/** Reads a regular file without following a symlink, however the path changed since it was checked. */
async function readNoFollow(path: string): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

type Ownership = { state: 'absent' } | { state: 'ours' } | { state: 'foreign'; path: string; reason: string }

const LINK = 'is a symbolic link'
const NOT_OURS = 'exists and was not created by `sideby app install`'

/**
 * Whether `entry` is something `sideby app install` wrote. Never follows a symlink: a link at the target, or
 * (for the macOS bundle) anywhere among the bundle's own paths, is foreign even when it leads to a marked file,
 * so install never writes through it and uninstall never removes it.
 */
async function ownership(entry: string): Promise<Ownership> {
  const top = await lstatOrNull(entry)
  if (!top) return { state: 'absent' }
  const foreign = (path: string, reason: string): Ownership => ({ state: 'foreign', path, reason })
  if (top.isSymbolicLink()) return foreign(entry, LINK)
  let markerPath = entry
  if (entry.endsWith('.app')) {
    if (!top.isDirectory()) return foreign(entry, 'is not a directory')
    const parts: [string, 'dir' | 'file', boolean][] = [
      ['Contents', 'dir', true],
      ['Contents/Info.plist', 'file', true],
      ['Contents/MacOS', 'dir', false],
      [`Contents/MacOS/${APP_NAME}`, 'file', false],
      ['Contents/Resources', 'dir', false],
      ['Contents/Resources/AppIcon.icns', 'file', false],
    ]
    for (const [rel, kind, required] of parts) {
      const p = join(entry, rel)
      const st = await lstatOrNull(p)
      if (!st) {
        if (required) return foreign(entry, NOT_OURS)
        continue
      }
      if (st.isSymbolicLink()) return foreign(p, LINK)
      if (kind === 'dir' ? !st.isDirectory() : !st.isFile())
        return foreign(p, kind === 'dir' ? 'is not a directory' : 'is not a regular file')
    }
    markerPath = join(entry, 'Contents', 'Info.plist')
  } else if (!top.isFile()) return foreign(entry, 'is not a regular file')
  let data: Buffer
  try {
    data = await readNoFollow(markerPath)
  } catch {
    return foreign(entry, NOT_OURS)
  }
  return markerTest(entry)(data) ? { state: 'ours' } : foreign(entry, NOT_OURS)
}

/** Refuses to replace anything at `entry` that `sideby app install` did not write; true when it is ours. */
async function assertOwned(entry: string, verb: string): Promise<boolean> {
  const o = await ownership(entry)
  if (o.state === 'absent') return false
  if (o.state === 'ours') return true
  throw new UserError(`${o.path} ${o.reason}; move it away first, then ${verb} again`)
}

export async function installApp(ctx: AppContext, opts: InstallOptions): Promise<InstallResult> {
  const platform = platformOf(ctx)
  const run = ctx.run ?? defaultRunner
  if (!isAbsolute(opts.node) || !isAbsolute(opts.entry))
    throw new UserError('node and the sideby entry must be absolute paths')
  const url = opts.url === undefined ? undefined : checkAppUrl(opts.url)
  const l = layout(ctx, platform)
  let updated = false
  for (const e of l.entries) if (await assertOwned(e, 'install')) updated = true
  const xdg: LauncherSpec['xdg'] = {}
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const) {
    const v = ctx.env[k]
    if (v && isAbsolute(v)) xdg[k] = v
  }
  const script = launcherScript({
    node: opts.node,
    entry: opts.entry,
    platform,
    xdg,
    ...(url ? { url } : {}),
  })
  const files: string[] = []
  const hints: string[] = []

  if (platform === 'darwin') {
    const app = l.primary
    await mkdir(dirname(app), { recursive: true })
    // Build next to the target, then swap it in, so a failed install never leaves half a bundle.
    const tmp = await mkdtemp(join(dirname(app), '.sideby.app.tmp-'))
    try {
      await chmod(tmp, 0o755)
      const contents = join(tmp, 'Contents')
      await mkdir(join(contents, 'MacOS'), { recursive: true })
      await mkdir(join(contents, 'Resources'), { recursive: true })
      await writeFile(join(contents, 'Info.plist'), infoPlist(opts.version))
      await writeFile(join(contents, 'MacOS', APP_NAME), script, { mode: 0o755 })
      await chmod(join(contents, 'MacOS', APP_NAME), 0o755)
      const iconset = join(tmp, 'AppIcon.iconset')
      await mkdir(iconset)
      const pngs = new Map<string, Buffer>()
      for (const { name, size } of ICONSET) {
        const png = iconPng(size)
        pngs.set(name, png)
        await writeFile(join(iconset, name), png)
      }
      const icns = join(contents, 'Resources', 'AppIcon.icns')
      if (!(await run('iconutil', ['-c', 'icns', iconset, '-o', icns])))
        await writeFile(icns, encodeIcns(pngs))
      await rm(iconset, { recursive: true, force: true })
      await rm(app, { recursive: true, force: true })
      await rename(tmp, app)
    } catch (err) {
      await rm(tmp, { recursive: true, force: true })
      throw err
    }
    // Ask Launch Services to pick up the new icon and bundle; harmless when it is not there.
    await run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app],
    )
    files.push(
      app,
      join(app, 'Contents', 'Info.plist'),
      join(app, 'Contents', 'MacOS', APP_NAME),
      join(app, 'Contents', 'Resources', 'AppIcon.icns'),
    )
    hints.push('Open it from ~/Applications or Spotlight ("sideby"), or drag it to the Dock.')
  } else {
    const p = l.linux!
    // Temp file in the same directory, then rename: never writes through a link, never leaves half a file.
    const write = async (path: string, data: string | Buffer, mode = 0o644) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFileAtomic(path, data, mode)
      files.push(path)
    }
    await write(p.launcher!, script, 0o755)
    await write(p.svg!, iconSvg())
    await write(p.png!, iconPng(256))
    await write(p.desktop!, desktopEntry(p.launcher!))
    await run('update-desktop-database', [dirname(p.desktop!)])
    hints.push('Find "sideby" in your application menu.')
  }
  if (url) hints.push(`The app opens ${url}.`)
  else
    hints.push(
      'The app starts the panel in the background and opens it; stop the panel with `sideby ui --stop`.',
      'Run `sideby app install` again after upgrading sideby or Node, so the app starts the new version.',
    )
  if (/[/\\]_npx[/\\]/.test(opts.entry))
    hints.push(
      'sideby runs from the npx cache, which npm may clear; install it with `npm i -g sideby` and run this again.',
    )
  return {
    platform,
    path: l.primary,
    files,
    mode: url ? 'url' : 'panel',
    ...(url ? { url } : {}),
    node: opts.node,
    entry: opts.entry,
    updated,
    hints,
  }
}

export async function uninstallApp(ctx: AppContext): Promise<UninstallResult> {
  const platform = platformOf(ctx)
  const l = layout(ctx, platform)
  const removed: string[] = []
  const skipped: UninstallResult['skipped'] = []
  for (const e of l.entries) {
    const o = await ownership(e)
    if (o.state === 'absent') continue
    if (o.state === 'foreign') {
      const reason = o.reason === NOT_OURS ? 'not created by `sideby app install`' : `${o.path} ${o.reason}`
      skipped.push({ path: e, reason: `${reason}; left in place` })
      continue
    }
    await rm(e, { recursive: e.endsWith('.app'), force: true })
    removed.push(e)
  }
  if (platform === 'linux' && removed.length) {
    // The launcher's own directory, only when nothing else is left in it.
    await rmdir(dirname(l.linux!.launcher!)).catch(() => {})
    await (ctx.run ?? defaultRunner)('update-desktop-database', [dirname(l.primary)])
  }
  return { platform, removed, skipped }
}
