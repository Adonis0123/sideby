// Builds the files of the sideby Design System (tokens.json, components/bundle.css, the logos, the README and the
// component guides) from the code, so the system on claude.ai never drifts from the Panel. Values come from
// src/panel/themes.ts, theme.ts and page-styles.ts, the logos from src/core/brand-mark.ts; the prose (README, guides,
// previews and each token's usage note) lives in design-system/. `node scripts/design-system.ts` writes
// design-system/dist/; publish that folder with /design-sync in Claude Code.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAVICON_SVG, ICON_SVG, markPng } from '../src/core/brand-mark.ts'
import { pageStyles, tokenStyles } from '../src/panel/page-styles.ts'
import { type PanelThemeTokens, resolveTheme, THEME_TOKENS } from '../src/panel/theme.ts'
import { BUILTIN_THEMES } from '../src/panel/themes.ts'

const ROOT = resolve(import.meta.dirname, '..')
export const SOURCE_DIR = join(ROOT, 'design-system')
export const OUT_DIR = join(SOURCE_DIR, 'dist')

type Value = string | Record<string, string>

export interface Notes {
  color: Record<string, string>
  type: Record<string, { usage: string; sample: string }>
  spacing: Record<string, string>
  radius: Record<string, string>
  size: Record<string, string>
  sizeNote: string
  shadow: Record<string, string>
}

/** `--name: value` declarations of a CSS block body. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of body.split(';')) {
    const i = part.indexOf(':')
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return out
}

/** The declarations of the first rule whose selector is exactly `selector`. */
export function ruleOf(css: string, selector: string): Map<string, string> {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)
  const m = re.exec(css)
  if (!m)
    throw new Error(
      `design-system: no rule "${selector} { … }" in page-styles.ts; update its selector in TYPE_STYLES of scripts/design-system.ts`,
    )
  return declarations(m[2]!)
}

/** The Panel's built-in tokens: the light block (`:root`) and the dark block (`:root[data-theme=dark]`). */
export function rootTokens(): { light: Map<string, string>; dark: Map<string, string> } {
  const css = tokenStyles(resolveTheme(undefined))
  const light = /^:root \{([^}]*)\}/.exec(css)
  const dark = /:root\[data-theme=dark\] \{([^}]*)\}/.exec(css)
  if (!light || !dark)
    throw new Error('design-system: tokenStyles() no longer has :root and :root[data-theme=dark]')
  return { light: declarations(light[1]!), dark: declarations(dark[1]!) }
}

const SPACING = ['gutter']
const RADII = ['radius', 'ctl-radius', 'chip-radius']
const SIZES = ['ctl-h', 'ctl-h-sm', 'field-h', 'content-width']
const SHADOWS = ['shadow', 'float-shadow']

/** The color tokens' THEME_TOKENS keys: every token from `bg` to `logoBorder`. */
function colorKeys(): (keyof PanelThemeTokens)[] {
  const keys = Object.keys(THEME_TOKENS) as (keyof PanelThemeTokens)[]
  return keys.slice(keys.indexOf('bg'), keys.indexOf('shadow'))
}

/** The CSS variables the system defines from tokens.json. */
export function tokenVars(): Set<string> {
  const names = [
    ...colorKeys().map((k) => THEME_TOKENS[k].slice(2)),
    ...SPACING,
    ...RADII,
    ...SIZES,
    ...SHADOWS,
  ]
  return new Set(names.map((n) => `--${n}`))
}

/**
 * What components/bundle.css holds: the Panel's rules, after a `:root` block with the variables they read that are
 * no token of the system (font stacks, sizes, weights, the focus outline, spark colors), at their light values.
 */
export function bundleCss(): string {
  const tokens = tokenStyles(resolveTheme(undefined))
  const all = pageStyles()
  if (!all.startsWith(tokens))
    throw new Error('design-system: pageStyles() no longer starts with tokenStyles()')
  const rules = all.slice(tokens.length).replace(/^\n/, '')
  const { light } = rootTokens()
  const exported = tokenVars()
  const used = new Set([...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!))
  const support = [...light].filter(([name]) => used.has(name) && !exported.has(name))
  return `:root { ${support.map(([n, v]) => `${n}: ${v};`).join(' ')} }\n${rules}`
}

/** One value when all themes agree, else a value per theme. */
function perTheme(values: Record<string, string>): Value {
  const all = Object.values(values)
  return all.every((v) => v === all[0]) ? all[0]! : values
}

/** A color as the system stores it: lowercase hex, `{alias}` for `var(--alias)`, `#00000000` for transparent. */
function colorValue(v: string): string {
  if (v === 'transparent') return '#00000000'
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(v)
  if (alias) return `{${alias[1]}}`
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v.toLowerCase() : v
}

/** The color tokens: every token from `bg` to `logoBorder` in theme.ts, each Theme's value or the Panel's default. */
function colorTokens(notes: Notes, root: Map<string, string>) {
  return colorKeys().map((key) => {
    const name = THEME_TOKENS[key].slice(2)
    const values: Record<string, string> = {}
    for (const t of BUILTIN_THEMES)
      for (const scheme of ['light', 'dark'] as const) {
        const v = t[scheme][key] ?? root.get(THEME_TOKENS[key])
        if (v === undefined) throw new Error(`design-system: ${t.id}.${scheme} has no value for ${key}`)
        values[`${t.id}-${scheme}`] = colorValue(v)
      }
    return { name, value: perTheme(values), usage: note(notes.color, name, 'color') }
  })
}

function note(map: Record<string, string>, name: string, family: string): string {
  const usage = map[name]
  if (!usage)
    throw new Error(
      `design-system: add a usage note for ${family} token "${name}" to design-system/notes.json`,
    )
  return usage
}

interface TypeStyle {
  name: string
  /** Rules that set the style, in cascade order, read from page-styles.ts. */
  rules: string[]
  /** Values not set by a rule, such as a token used where no single rule holds it. */
  set?: Partial<Record<'font-size' | 'font-weight' | 'line-height' | 'letter-spacing', string>>
}

// Each text style, the rules of page-styles.ts it comes from, and its group. Body text (`body`) is the base of all.
const TYPE_STYLES: { name: string; family: 'sans' | 'mono'; styles: TypeStyle[] }[] = [
  {
    name: 'Panel',
    family: 'sans',
    styles: [
      { name: 'title', rules: ['.brand h1'] },
      { name: 'stat-value', rules: ['.stat-value'] },
      {
        name: 'large',
        rules: [],
        set: { 'font-size': 'var(--large)', 'font-weight': 'var(--heading-weight)' },
      },
      { name: 'heading', rules: ['h1, h2, h3', 'h2'] },
      { name: 'body', rules: [] },
      { name: 'control', rules: ['.btn'] },
      { name: 'tagline', rules: ['.tagline'] },
      { name: 'small', rules: [], set: { 'font-size': 'var(--small)' } },
      { name: 'chip', rules: ['.chip'] },
      { name: 'tag', rules: ['.tag'] },
    ],
  },
  {
    name: 'Mono',
    family: 'mono',
    styles: [
      { name: 'version-pill', rules: ['.ver-pill'] },
      { name: 'kbd', rules: ['.kbd'] },
    ],
  },
]

/** `[weight] size[/line-height] family` of a `font` shorthand; the forms page-styles.ts uses. */
function fontShorthand(v: string): Record<string, string> {
  const m = /^(?:(\d{3}|bold|normal) )?([^\s/]+)(?:\/([^\s]+))? /.exec(v)
  if (!m || v === 'inherit') return {}
  const out: Record<string, string> = { 'font-size': m[2]!, 'font-weight': m[1] ?? '400' }
  if (m[3]) out['line-height'] = m[3]
  return out
}

function typeStyle(css: string, root: Map<string, string>, s: TypeStyle, notes: Notes) {
  const resolveVar = (v: string) => v.replace(/var\((--[a-z0-9-]+)\)/g, (_, n: string) => root.get(n) ?? _)
  const props: Record<string, string> = {
    'font-weight': '400',
    ...fontShorthand(resolveVar(ruleOf(css, 'body').get('font') ?? '')),
  }
  for (const selector of s.rules)
    for (const [k, v] of ruleOf(css, selector)) {
      if (k === 'font') Object.assign(props, fontShorthand(resolveVar(v)))
      else if (k in { 'font-size': 1, 'font-weight': 1, 'line-height': 1, 'letter-spacing': 1 }) props[k] = v
    }
  Object.assign(props, s.set)
  for (const k of Object.keys(props)) props[k] = resolveVar(props[k]!)
  const num = (v: string) => (/^\d+(\.\d+)?$/.test(v) ? Number(v) : v)
  const info = notes.type[s.name]
  if (!info)
    throw new Error(
      `design-system: add usage and sample for type style "${s.name}" to design-system/notes.json`,
    )
  return {
    name: s.name,
    fontSize: props['font-size']!,
    lineHeight: num(props['line-height']!),
    fontWeight: num(props['font-weight']!),
    ...(props['letter-spacing'] ? { letterSpacing: props['letter-spacing'] } : {}),
    usage: info.usage,
    sample: info.sample,
  }
}

function literalTokens(
  root: Map<string, string>,
  names: string[],
  notes: Record<string, string>,
  family: string,
) {
  return names.map((name) => {
    const value = root.get(`--${name}`)
    if (value === undefined) throw new Error(`design-system: page-styles.ts no longer defines --${name}`)
    return { name, value, usage: note(notes, name, family) }
  })
}

/** Where the commit stands: `main@95815a3` and its date, so the same commit always gives the same files. */
function gitRef(): { ref: string; date: string } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    return { ref: `${branch}@${git('rev-parse', '--short', 'HEAD')}`, date: git('log', '-1', '--format=%cs') }
  } catch {
    return { ref: 'unknown', date: 'unknown' }
  }
}

/** tokens.json, in the Design System's format. */
export function buildTokens(notes: Notes, ref = gitRef()) {
  const css = bundleCss()
  const { light, dark } = rootTokens()
  const byScheme = (f: (scheme: 'light' | 'dark', theme: (typeof BUILTIN_THEMES)[number]) => string) =>
    Object.fromEntries(
      BUILTIN_THEMES.flatMap((t) => (['light', 'dark'] as const).map((s) => [`${t.id}-${s}`, f(s, t)])),
    )
  return {
    name: 'sideby',
    version: 1,
    color: {
      themes: BUILTIN_THEMES.flatMap((t) => [
        { id: `${t.id}-light`, name: `${t.name.en} · Light` },
        { id: `${t.id}-dark`, name: `${t.name.en} · Dark` },
      ]),
      tokens: colorTokens(notes, light),
    },
    type: {
      fonts: [],
      families: { sans: light.get('--font'), mono: light.get('--mono') },
      groups: TYPE_STYLES.map((g) => ({
        name: g.name,
        family: g.family,
        styles: g.styles.map((s) => typeStyle(css, light, s, notes)),
      })),
    },
    spacing: { tokens: literalTokens(light, SPACING, notes.spacing, 'spacing') },
    radius: { tokens: literalTokens(light, RADII, notes.radius, 'radius') },
    size: {
      note: notes.sizeNote,
      tokens: literalTokens(light, SIZES, notes.size, 'size'),
    },
    shadow: {
      tokens: [
        {
          name: 'shadow',
          value: byScheme((s, t) => t[s].shadow ?? 'none'),
          usage: note(notes.shadow, 'shadow', 'shadow'),
        },
        {
          name: 'float-shadow',
          value: byScheme((s) => (s === 'light' ? light : dark).get('--float-shadow') ?? 'none'),
          usage: note(notes.shadow, 'float-shadow', 'shadow'),
        },
      ],
    },
    meta: {
      source: 'github',
      repo: 'Adonis0123/sideby',
      ref: ref.ref,
      paths: {
        tokens: ['src/panel/themes.ts', 'src/panel/theme.ts', 'src/panel/page-styles.ts'],
        fonts: [],
        assets: ['src/core/brand-mark.ts', 'assets/brand', 'docs/assets/banner.jpg'],
        docs: ['design-system/README.md', 'design-system/notes.json', 'design-system/components'],
      },
      components: {
        Button: 'src/panel/page-styles.ts (.btn)',
        Chip: 'src/panel/page-styles.ts (.chip)',
        Tag: 'src/panel/page-styles.ts (.tag)',
        QuotaBar: 'src/panel/page-styles.ts (.bar)',
      },
      synced: ref.date,
    },
  }
}

/** Writes every file of the system into `out`, replacing what was there. */
export function build(out = OUT_DIR): void {
  const notes = JSON.parse(readFileSync(join(SOURCE_DIR, 'notes.json'), 'utf8')) as Notes
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'assets/Logos'), { recursive: true })
  cpSync(join(SOURCE_DIR, 'components'), join(out, 'components'), { recursive: true })
  copyFileSync(join(SOURCE_DIR, 'README.md'), join(out, 'README.md'))
  copyFileSync(join(SOURCE_DIR, 'assets/Logos/README.md'), join(out, 'assets/Logos/README.md'))
  writeFileSync(join(out, 'tokens.json'), `${JSON.stringify(buildTokens(notes), null, 2)}\n`)
  writeFileSync(join(out, 'components/bundle.css'), bundleCss())
  writeFileSync(join(out, 'assets/Logos/sideby-mark.svg'), ICON_SVG)
  writeFileSync(join(out, 'assets/Logos/sideby-favicon.svg'), FAVICON_SVG)
  writeFileSync(join(out, 'assets/Logos/sideby-mark.png'), markPng(1024))
  copyFileSync(join(ROOT, 'docs/assets/banner.jpg'), join(out, 'assets/Logos/sideby-banner.jpg'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build()
  console.log(
    `design-system: wrote ${OUT_DIR.slice(ROOT.length + 1)}/; publish it with /design-sync in Claude Code`,
  )
}
