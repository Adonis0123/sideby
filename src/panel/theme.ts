// Host theming for the Panel page: a typed set of tokens that become CSS custom properties inside the page's
// nonce'd <style>, so an embedding host can match its own look without loosening the CSP.

/** Values for the Panel's design tokens. Every value is one CSS value, such as `#3f8fc4`, `14px` or a font stack. */
export interface PanelThemeTokens {
  // Type
  /** Font stack for all text but code. */
  font?: string
  monoFont?: string
  /** Body text, 14px by default. */
  fontSize?: string
  /** Meta text, hints and small labels, 12.5px. */
  smallSize?: string
  /** Button text, 13.5px. */
  controlSize?: string
  /** Section headings, 15px. */
  headingSize?: string
  /** Account names on cards, 16px. */
  largeSize?: string
  /** Page title, 22px. */
  titleSize?: string
  titleWeight?: string
  /** Section headings and account names. */
  headingWeight?: string
  /** Labels, emphasis and numbers. */
  strongWeight?: string
  buttonWeight?: string
  /** Main action button; defaults to `buttonWeight`. */
  primaryWeight?: string
  // Colors
  /** Page background. */
  bg?: string
  /** Cards, panels, fields and buttons. */
  surface?: string
  /** Quiet areas inside a card: notes, logo tiles, chips. */
  surfaceMuted?: string
  border?: string
  /** Borders of fields and buttons. */
  borderStrong?: string
  text?: string
  muted?: string
  faint?: string
  /** Background of a hovered or pressed secondary button. */
  hover?: string
  active?: string
  /** Links and the Subscription chip. */
  accent?: string
  accentSoft?: string
  /** Focus outline and focused field border. */
  focus?: string
  /** Main action button. */
  primary?: string
  primaryHover?: string
  primaryActive?: string
  onPrimary?: string
  primaryBorder?: string
  primaryHoverBorder?: string
  /** Secondary button text, and its border and text on hover. */
  buttonText?: string
  buttonHoverBorder?: string
  buttonHoverText?: string
  /** Checkbox color. */
  checkColor?: string
  ok?: string
  okSoft?: string
  warn?: string
  warnSoft?: string
  fail?: string
  failSoft?: string
  /** The sideby mark in the page header. */
  logoBg?: string
  logoColor?: string
  logoBorder?: string
  shadow?: string
  /** `outline` of focused controls (`none` to rely on `focusRing`). */
  focusOutline?: string
  /** `box-shadow` of focused controls, such as a soft halo. */
  focusRing?: string
  // Shape and layout
  /** Cards and panels; banners and notes derive smaller radii from it. */
  radius?: string
  /** Buttons and fields. */
  controlRadius?: string
  chipRadius?: string
  /** Button height; `controlHeightSmall` for buttons inside cards and banners. */
  controlHeight?: string
  controlHeightSmall?: string
  /** Text field and select height. */
  fieldHeight?: string
  /** Maximum width of the page content (`none` for full width). */
  contentWidth?: string
  /** Left and right page padding. */
  gutter?: string
}

export interface PanelTheme {
  /** `auto` (default) follows the system; `light` or `dark` fixes one scheme. */
  colorScheme?: 'auto' | 'light' | 'dark'
  /** `plain` (default): the title sits on the page background. `bar`: a full-width header strip on the surface color. */
  header?: 'plain' | 'bar'
  /**
   * Light-mode values. Color tokens set here apply in light mode only; the others (type, shape, layout) also apply
   * in dark mode unless `dark` sets them.
   */
  light?: PanelThemeTokens
  /** Dark-mode values, layered over the built-in dark palette. */
  dark?: PanelThemeTokens
}

/** Token name to the CSS custom property the page reads. */
export const THEME_TOKENS: Record<keyof PanelThemeTokens, string> = {
  font: '--font',
  monoFont: '--mono',
  fontSize: '--font-size',
  smallSize: '--small',
  controlSize: '--control-size',
  headingSize: '--heading-size',
  largeSize: '--large',
  titleSize: '--title-size',
  titleWeight: '--title-weight',
  headingWeight: '--heading-weight',
  strongWeight: '--strong-weight',
  buttonWeight: '--button-weight',
  primaryWeight: '--primary-weight',
  bg: '--bg',
  surface: '--surface',
  surfaceMuted: '--surface-2',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  muted: '--muted',
  faint: '--faint',
  hover: '--hover',
  active: '--active',
  accent: '--accent',
  accentSoft: '--accent-soft',
  focus: '--focus',
  primary: '--primary',
  primaryHover: '--primary-hover',
  primaryActive: '--primary-active',
  onPrimary: '--on-primary',
  primaryBorder: '--primary-border',
  primaryHoverBorder: '--primary-hover-border',
  buttonText: '--btn-text',
  buttonHoverBorder: '--btn-hover-border',
  buttonHoverText: '--btn-hover-text',
  checkColor: '--check',
  ok: '--ok',
  okSoft: '--ok-soft',
  warn: '--warn',
  warnSoft: '--warn-soft',
  fail: '--fail',
  failSoft: '--fail-soft',
  logoBg: '--logo-bg',
  logoColor: '--logo-fg',
  logoBorder: '--logo-line',
  shadow: '--shadow',
  focusOutline: '--focus-outline',
  focusRing: '--focus-ring',
  radius: '--radius',
  controlRadius: '--ctl-radius',
  chipRadius: '--chip-radius',
  controlHeight: '--ctl-h',
  controlHeightSmall: '--ctl-h-sm',
  fieldHeight: '--field-h',
  contentWidth: '--content-width',
  gutter: '--gutter',
}

/** A theme checked and turned into CSS declarations, ready for the page. */
export interface ResolvedTheme {
  colorScheme: 'auto' | 'light' | 'dark'
  header: 'plain' | 'bar'
  /** `--name: value` declarations. */
  light: string[]
  dark: string[]
}

export const MAX_THEME_VALUE = 200
// Letters, digits, spaces and the punctuation CSS values need (`#`, `%`, `(`, `)`, `,`, `.`, `+`, `-`, `/`, quotes, `_`).
// Nothing that ends a declaration, a block or the <style> element (`;`, `{`, `}`, `<`), no escapes (`\`), no comments (`*`)
// and no `:`, so no URL scheme either.
const VALUE_RE = /^[A-Za-z0-9 #%(),.+\-/'"_]+$/

/** Why a theme value is unsafe or malformed, or null when it can go into the style block as is. */
export function themeValueProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string'
  if (!value.trim()) return 'must not be empty'
  if (value.length > MAX_THEME_VALUE) return `is over ${MAX_THEME_VALUE} characters`
  if (!VALUE_RE.test(value))
    return 'may hold only letters, digits, spaces and # % ( ) , . + - / \' " _ (no ; { } < \\ * or :)'
  if (/url\s*\(/i.test(value)) return 'must not load a URL'
  let depth = 0
  for (const c of value) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) break
  }
  if (depth !== 0) return 'has unbalanced parentheses'
  if (value.split('"').length % 2 === 0 || value.split("'").length % 2 === 0) return 'has an unclosed quote'
  return null
}

function declarations(tokens: unknown, where: string): string[] {
  if (tokens === undefined) return []
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens))
    throw new TypeError(`panel theme: ${where} must be an object of tokens`)
  const out: string[] = []
  for (const [name, value] of Object.entries(tokens)) {
    if (value === undefined) continue
    const prop = Object.hasOwn(THEME_TOKENS, name) ? THEME_TOKENS[name as keyof PanelThemeTokens] : undefined
    if (!prop)
      throw new TypeError(
        `panel theme: unknown token ${where}.${name}; known tokens: ${Object.keys(THEME_TOKENS).join(', ')}`,
      )
    const problem = themeValueProblem(value)
    if (problem) throw new TypeError(`panel theme: ${where}.${name} ${problem}`)
    out.push(`${prop}: ${(value as string).trim()}`)
  }
  return out
}

/** Checks a host theme and turns it into CSS declarations. Throws a TypeError that names the bad token. */
export function resolveTheme(theme: PanelTheme | undefined): ResolvedTheme {
  if (theme === undefined) return { colorScheme: 'auto', header: 'plain', light: [], dark: [] }
  if (typeof theme !== 'object' || theme === null || Array.isArray(theme))
    throw new TypeError('panel theme must be an object')
  for (const key of Object.keys(theme))
    if (!['colorScheme', 'header', 'light', 'dark'].includes(key))
      throw new TypeError(`panel theme: unknown option ${key}; use colorScheme, header, light or dark`)
  const colorScheme = theme.colorScheme ?? 'auto'
  if (!['auto', 'light', 'dark'].includes(colorScheme))
    throw new TypeError('panel theme: colorScheme must be "auto", "light" or "dark"')
  const header = theme.header ?? 'plain'
  if (!['plain', 'bar'].includes(header)) throw new TypeError('panel theme: header must be "plain" or "bar"')
  return {
    colorScheme,
    header,
    light: declarations(theme.light, 'light'),
    dark: declarations(theme.dark, 'dark'),
  }
}
