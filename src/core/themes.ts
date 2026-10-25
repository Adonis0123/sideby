// Themes (spec §3.34, ADR-0050): the Built-in Themes plus the user's Theme Files in <config>/themes/<id>.json.
// A Theme File is data only: a base Built-in Theme, an optional accent that regenerates the accent roles, and token
// overrides checked like a Portal Theme's. This module lists, checks, resolves and switches them; it never runs code.
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type PanelThemeTokens, THEME_TOKENS, themeValueProblem } from '../panel/theme.ts'
import { BUILTIN_THEMES, type BuiltinTheme, DEFAULT_THEME_ID, RENAMED_THEMES } from '../panel/themes.ts'
import { editConfigPanel, loadConfig } from './config.ts'
import { writeFileAtomic } from './fs-safe.ts'
import type { Paths } from './paths.ts'

export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const MAX_FILE = 64 * 1024
const HEX_RE = /^#[0-9a-fA-F]{6}$/

export interface ThemeFile {
  schemaVersion: 1
  name: string
  base?: string
  accent?: string
  light?: PanelThemeTokens
  dark?: PanelThemeTokens
}

export interface ThemeEntry {
  id: string
  name: string
  source: 'builtin' | 'file'
  path?: string
  /** Page, card, accent tint, main button, dark page; for the Theme's card in Settings. */
  swatches: string[]
  /** Why this Theme cannot be used; empty when it can. */
  problems: string[]
  /** Keys that were ignored. */
  warnings: string[]
}

export interface ResolvedColors {
  id: string
  light: PanelThemeTokens
  dark: PanelThemeTokens
  /** How many colors were moved to pass the contrast check. */
  adjusted: number
  /** Set when the chosen Theme could not be used and the Default Theme stands in. */
  fallback?: string
}

export const themesDir = (paths: Paths) => join(paths.configDir, 'themes')
const undoFile = (paths: Paths) => join(paths.stateDir, 'theme-undo.json')
const previewFile = (paths: Paths) => join(paths.stateDir, 'theme-preview.json')
/** A Built-in Theme by id; a renamed one's old id (sky) finds the Theme it became. */
const builtin = (id: string) =>
  BUILTIN_THEMES.find((t) => t.id === (Object.hasOwn(RENAMED_THEMES, id) ? RENAMED_THEMES[id] : id))

/**
 * The name `sideby theme use` takes for "no Theme chosen": the Panel then shows the Default Theme on its own and,
 * inside a Portal, the Portal's colors. It names no Theme File.
 */
export const NO_THEME = 'default'
const reserved = (id: string) => Boolean(builtin(id)) || id === NO_THEME
const DEFAULT = builtin(DEFAULT_THEME_ID) as BuiltinTheme

// ---- Reading and checking a Theme File

/** Checks parsed JSON as a Theme File. Problems make it unusable; warnings are keys that were ignored. */
export function checkThemeData(data: unknown): { theme?: ThemeFile; problems: string[]; warnings: string[] } {
  const problems: string[] = []
  const warnings: string[] = []
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return { problems: ['must be a JSON object, like {"schemaVersion": 1, "name": "My theme"}'], warnings }
  const d = data as Record<string, unknown>
  if (d.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 60)
    problems.push('name must be a short text (1 to 60 characters)')
  if (d.base !== undefined && (typeof d.base !== 'string' || !builtin(d.base)))
    problems.push(`base must be one of ${BUILTIN_THEMES.map((t) => t.id).join(', ')}`)
  if (d.accent !== undefined && (typeof d.accent !== 'string' || !HEX_RE.test(d.accent)))
    problems.push('accent must be a color like #3f8fc4')
  const tokens: Record<'light' | 'dark', PanelThemeTokens> = { light: {}, dark: {} }
  for (const mode of ['light', 'dark'] as const) {
    const v = d[mode]
    if (v === undefined) continue
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      problems.push(`${mode} must be an object of tokens`)
      continue
    }
    for (const [k, value] of Object.entries(v)) {
      if (!Object.hasOwn(THEME_TOKENS, k)) {
        warnings.push(`${mode}.${k} is not a token sideby knows; it was ignored`)
        continue
      }
      const problem = themeValueProblem(value)
      if (problem) problems.push(`${mode}.${k} ${problem}`)
      else tokens[mode][k as keyof PanelThemeTokens] = (value as string).trim()
    }
  }
  for (const k of Object.keys(d))
    if (!['$schema', 'schemaVersion', 'name', 'base', 'accent', 'light', 'dark'].includes(k))
      warnings.push(`${k} is not a Theme File key; it was ignored`)
  if (problems.length) return { problems, warnings }
  return {
    theme: {
      schemaVersion: 1,
      name: (d.name as string).trim(),
      ...(d.base ? { base: d.base as string } : {}),
      ...(d.accent ? { accent: (d.accent as string).toLowerCase() } : {}),
      light: tokens.light,
      dark: tokens.dark,
    },
    problems,
    warnings,
  }
}

/** Reads one Theme File: a regular file of at most 64 KB, never followed through a link. */
export async function readThemeFile(
  path: string,
): Promise<{ theme?: ThemeFile; problems: string[]; warnings: string[] }> {
  try {
    const st = await lstat(path)
    if (!st.isFile()) return { problems: ['is not a regular file (links are not followed)'], warnings: [] }
    if (st.size > MAX_FILE) return { problems: ['is over 64 KB'], warnings: [] }
    const text = await readFile(path, 'utf8')
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (e) {
      return {
        problems: [`is not valid JSON (${(e as Error).message}); fix it or run \`sideby theme check\``],
        warnings: [],
      }
    }
    return checkThemeData(data)
  } catch (e) {
    return { problems: [`cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`], warnings: [] }
  }
}

// ---- Listing

export async function listThemes(paths: Paths): Promise<ThemeEntry[]> {
  const out: ThemeEntry[] = BUILTIN_THEMES.map((t) => ({
    id: t.id,
    name: t.name.en,
    source: 'builtin',
    swatches: [...t.swatches],
    problems: [],
    warnings: [],
  }))
  let names: string[] = []
  try {
    names = (await readdir(themesDir(paths))).filter((n) => n.endsWith('.json')).sort()
  } catch {}
  for (const n of names) {
    const id = n.slice(0, -5)
    const path = join(themesDir(paths), n)
    if (!THEME_ID_RE.test(id) || reserved(id)) {
      out.push({
        id,
        name: id,
        source: 'file',
        path,
        swatches: [],
        warnings: [],
        problems: [
          builtin(id)
            ? `uses the name of a Built-in Theme; rename the file`
            : 'file name must be lowercase letters, digits and hyphens (up to 40), then .json',
        ],
      })
      continue
    }
    const r = await readThemeFile(path)
    const colors = r.theme ? themeColors(r.theme) : undefined
    out.push({
      id,
      name: r.theme?.name ?? id,
      source: 'file',
      path,
      swatches: colors ? swatchesOf(colors.light, colors.dark) : [],
      problems: r.problems,
      warnings: r.warnings,
    })
  }
  return out
}

const swatchesOf = (l: PanelThemeTokens, d: PanelThemeTokens) =>
  [l.bg, l.accentSoft, l.primary, d.bg].filter((c): c is string => typeof c === 'string')

// ---- Resolving a Theme to tokens

/** A Theme File's colors before the contrast check: base, then accent roles, then the file's own tokens. */
export function themeColors(theme: ThemeFile): { light: PanelThemeTokens; dark: PanelThemeTokens } {
  const base = builtin(theme.base ?? DEFAULT_THEME_ID) as BuiltinTheme
  const accent = theme.accent ? accentTokens(theme.accent) : { light: {}, dark: {} }
  return {
    light: { ...base.light, ...accent.light, ...theme.light },
    dark: { ...base.dark, ...accent.dark, ...theme.dark },
  }
}

/** The colors for a Theme id (Built-in or file), with failing pairs moved until they pass. Unknown or broken: the Default Theme. */
export async function resolveColors(paths: Paths, id: string | undefined): Promise<ResolvedColors> {
  const want = id === undefined || id === NO_THEME ? DEFAULT_THEME_ID : id
  const b = builtin(want)
  if (b) return { id: b.id, light: { ...b.light }, dark: { ...b.dark }, adjusted: 0 }
  if (!THEME_ID_RE.test(want))
    return { ...defaults(), fallback: `${want} is not a Theme name; using ${DEFAULT.name.en}` }
  const r = await readThemeFile(join(themesDir(paths), `${want}.json`))
  if (!r.theme)
    return {
      ...defaults(),
      fallback: `Theme ${want} cannot be used (${r.problems[0]}); using ${DEFAULT.name.en}`,
    }
  return adjust(want, themeColors(r.theme))
}

function defaults(): ResolvedColors {
  return { id: DEFAULT_THEME_ID, light: { ...DEFAULT.light }, dark: { ...DEFAULT.dark }, adjusted: 0 }
}

function adjust(id: string, c: { light: PanelThemeTokens; dark: PanelThemeTokens }): ResolvedColors {
  const light = { ...c.light }
  const dark = { ...c.dark }
  let adjusted = 0
  for (const p of contrastPairs({ light, dark }))
    if (!p.ok && p.suggest) {
      ;(p.mode === 'light' ? light : dark)[p.fg] = p.suggest
      adjusted++
    }
  return { id, light, dark, adjusted }
}

// ---- Accent roles from one color

// Lightness and chroma of the maintainer's leaf scales, step 1 to 12; step 9 becomes the accent itself.
const SCALE_LIGHT: [number, number][] = [
  [0.988, 0.014],
  [0.973, 0.029],
  [0.948, 0.055],
  [0.923, 0.08],
  [0.894, 0.101],
  [0.857, 0.118],
  [0.809, 0.14],
  [0.746, 0.161],
  [0.735, 0.18],
  [0.69, 0.178],
  [0.5, 0.126],
  [0.305, 0.072],
]
const SCALE_DARK: [number, number][] = [
  [0.18, 0.015],
  [0.207, 0.026],
  [0.25, 0.045],
  [0.289, 0.06],
  [0.33, 0.074],
  [0.378, 0.09],
  [0.44, 0.11],
  [0.521, 0.136],
  [0.735, 0.18],
  [0.776, 0.172],
  [0.841, 0.14],
  [0.94, 0.061],
]

/** A 12-step scale around one color: step 9 is the color, the others follow the template's lightness. */
export function accentScale(hex: string, dark: boolean): string[] {
  const [sL, sC, sH] = toOklch(hex)
  const k = sC / 0.18
  return (dark ? SCALE_DARK : SCALE_LIGHT).map(([L, C], i) =>
    i === 8
      ? hex.toLowerCase()
      : i === 9
        ? fromOklch(dark ? sL + 0.04 : sL - 0.045, sC, sH)
        : fromOklch(i === 10 && !dark ? Math.min(L, sL - 0.12) : L, Math.min(C * k, C * 1.3), sH),
  )
}

/** The accent roles of a Theme generated from one color; neutrals and warning colors stay the base Theme's. */
export function accentTokens(hex: string): { light: PanelThemeTokens; dark: PanelThemeTokens } {
  const a = accentScale(hex, false)
  const d = accentScale(hex, true)
  // Main button: the accent if white text reaches 3.2:1 on it, else the accent darkened until it does.
  const [L, C, H] = toOklch(hex)
  let l = L
  let p = hex.toLowerCase()
  while (contrast(p, '#ffffff') < 3.2 && l > 0.3) {
    l -= 0.005
    p = fromOklch(l, C, H)
  }
  const pHover = fromOklch(toOklch(p)[0] - 0.045, C, H)
  const button = {
    primary: p,
    primaryHover: pHover,
    primaryActive: pHover,
    primaryBorder: p,
    primaryHoverBorder: pHover,
    onPrimary: '#ffffff',
  }
  return {
    light: {
      ...button,
      accent: a[10],
      accentSoft: a[2],
      focus: a[10],
      buttonHoverBorder: a[5],
      buttonHoverText: a[10],
      checkColor: a[8],
      ok: a[11],
      okSoft: a[2],
      okBar: a[8],
    },
    dark: {
      ...button,
      accent: d[10],
      accentSoft: d[2],
      focus: d[10],
      buttonHoverBorder: d[5],
      buttonHoverText: d[10],
      checkColor: d[8],
      ok: d[10],
      okSoft: d[2],
      okBar: d[8],
    },
  }
}

// ---- Contrast

export interface ContrastPair {
  mode: 'light' | 'dark'
  fg: keyof PanelThemeTokens
  bg: keyof PanelThemeTokens
  ratio?: number
  min: number
  ok: boolean
  /** A value for `fg` that passes; only when it fails. */
  suggest?: string
}

// Text pairs need 4.5:1 (faint too: the Panel uses it for captions, units and reset times people read); the main button (bold text, ADR-0050) and the focus outline need 3:1.
const PAIRS: [keyof PanelThemeTokens, keyof PanelThemeTokens, number][] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['faint', 'bg', 4.5],
  ['faint', 'surface', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface', 4.5],
  ['ok', 'okSoft', 4.5],
  ['warn', 'warnSoft', 4.5],
  ['fail', 'failSoft', 4.5],
  ['fail', 'surface', 4.5],
  ['onPrimary', 'primary', 3],
  ['focus', 'surface', 3],
]

export function contrastPairs(c: { light: PanelThemeTokens; dark: PanelThemeTokens }): ContrastPair[] {
  const out: ContrastPair[] = []
  for (const mode of ['light', 'dark'] as const)
    for (const [fg, bg, min] of PAIRS) {
      const a = c[mode][fg]
      const b = c[mode][bg]
      if (!a || !b || !HEX_RE.test(a) || !HEX_RE.test(b)) {
        out.push({ mode, fg, bg, min, ok: true })
        continue
      }
      const ratio = Math.round(contrast(a, b) * 100) / 100
      const ok = ratio >= min
      out.push({ mode, fg, bg, ratio, min, ok, ...(ok ? {} : { suggest: passing(a, b, min) }) })
    }
  return out
}

/** Moves `fg` along OKLCH lightness, away from `bg`, until it reaches `min`. */
function passing(fg: string, bg: string, min: number): string {
  const [L, C, H] = toOklch(fg)
  const darker = toOklch(bg)[0] > 0.6
  for (let l = L; l >= 0 && l <= 1; l += darker ? -0.01 : 0.01) {
    const c = fromOklch(l, C, H)
    if (contrast(c, bg) >= min) return c
  }
  return darker ? '#000000' : '#ffffff'
}

// ---- Switching

/** Sets `panel.colorTheme`, keeping what it was so `undo` can put it back. */
export async function useTheme(
  paths: Paths,
  id: string,
): Promise<{ before: string; after: string; changed: boolean }> {
  id = builtin(id)?.id ?? id
  if (id !== NO_THEME) {
    const entry = (await listThemes(paths)).find((t) => t.id === id)
    if (!entry) throw new Error(`no Theme named ${id}; run \`sideby theme list\` to see the names`)
    if (entry.problems.length)
      throw new Error(`Theme ${id} cannot be used: ${entry.problems[0]}; fix ${entry.path}`)
  }
  // A Theme picked by name is kept even when it is the Default Theme: inside a Portal it wins over the Portal's colors.
  const before = (await loadConfig(paths.configFile)).panel?.colorTheme ?? NO_THEME
  const r = await editConfigPanel(paths.configFile, { colorTheme: id === NO_THEME ? null : id })
  if (r.changed) {
    await mkdir(paths.stateDir, { recursive: true })
    await writeFileAtomic(undoFile(paths), `${JSON.stringify({ before, after: id })}\n`)
  }
  return { before, after: id, changed: r.changed }
}

/** Puts back the Theme from before the last `use`, only while config still holds what that `use` wrote. */
export async function undoTheme(paths: Paths): Promise<{ before: string; after: string }> {
  let rec: { before?: unknown; after?: unknown }
  try {
    rec = JSON.parse(await readFile(undoFile(paths), 'utf8'))
  } catch {
    throw new Error('nothing to undo: no Theme was switched with sideby yet')
  }
  const now = (await loadConfig(paths.configFile)).panel?.colorTheme ?? NO_THEME
  if (typeof rec.before !== 'string' || rec.after !== now)
    throw new Error(`the Theme was changed since (now ${now}); pick one with \`sideby theme use <name>\``)
  await editConfigPanel(paths.configFile, { colorTheme: rec.before === NO_THEME ? null : rec.before })
  await rm(undoFile(paths), { force: true })
  return { before: now, after: rec.before }
}

// ---- Files

/** Writes a checked Theme File into the themes folder. */
export async function saveThemeFile(paths: Paths, id: string, theme: ThemeFile): Promise<string> {
  if (!THEME_ID_RE.test(id) || reserved(id))
    throw new Error(
      `${id} cannot be a Theme name: use lowercase letters, digits and hyphens, not ${[...BUILTIN_THEMES.map((t) => t.id), NO_THEME].join(', ')}`,
    )
  await mkdir(themesDir(paths), { recursive: true })
  const path = join(themesDir(paths), `${id}.json`)
  await writeFileAtomic(path, `${JSON.stringify(theme, null, 2)}\n`)
  return path
}

export async function removeThemeFile(
  paths: Paths,
  id: string,
): Promise<{ path: string; wasActive: boolean }> {
  if (!THEME_ID_RE.test(id) || reserved(id))
    throw new Error(`${id} is not a Theme File; Built-in Themes cannot be removed`)
  const path = join(themesDir(paths), `${id}.json`)
  const st = await lstat(path).catch(() => undefined)
  if (!st) throw new Error(`no Theme File ${path}`)
  const wasActive = (await loadConfig(paths.configFile)).panel?.colorTheme === id
  if (wasActive) await editConfigPanel(paths.configFile, { colorTheme: null })
  await rm(path)
  return { path, wasActive }
}

/** A full Theme File for an id: a Built-in Theme gets every token, so it can be the start of the user's own. */
export async function exportTheme(paths: Paths, id: string): Promise<ThemeFile> {
  const b = builtin(id)
  if (b)
    return {
      schemaVersion: 1,
      name: `My ${b.name.en}`,
      base: b.id,
      light: { ...b.light },
      dark: { ...b.dark },
    }
  const r = await readThemeFile(join(themesDir(paths), `${id}.json`))
  if (!r.theme) throw new Error(`Theme ${id} cannot be exported: ${r.problems[0] ?? 'not found'}`)
  return r.theme
}

/** Keeps a Theme for one look at the Panel without choosing it (`sideby theme preview`). */
export async function setPreview(paths: Paths, theme: ThemeFile): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true })
  await writeFileAtomic(previewFile(paths), `${JSON.stringify({ at: Date.now(), theme })}\n`)
}

/** The previewed Theme's colors, if one was set in the last ten minutes. */
export async function previewColors(paths: Paths): Promise<ResolvedColors | undefined> {
  try {
    const rec = JSON.parse(await readFile(previewFile(paths), 'utf8')) as { at?: number; theme?: unknown }
    if (typeof rec.at !== 'number' || Date.now() - rec.at > 10 * 60_000) return undefined
    const r = checkThemeData(rec.theme)
    return r.theme ? adjust('preview', themeColors(r.theme)) : undefined
  } catch {
    return undefined
  }
}

// ---- OKLCH and WCAG contrast

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const unlin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)

export function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}

function oklchRgb(L: number, C: number, H: number): number[] {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** OKLCH to #rrggbb, lowering chroma until the color fits sRGB. */
export function fromOklch(L: number, C: number, H: number): string {
  const l = Math.min(1, Math.max(0, L))
  let c = C
  while (c > 0 && !oklchRgb(l, c, H).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) c -= 0.003
  return `#${oklchRgb(l, Math.max(c, 0), H)
    .map((v) =>
      Math.round(unlin(Math.min(1, Math.max(0, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio of two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
