// The sideby mark: two buddies side by side, the amber one behind on the left and the blue one in front on the right,
// looking at each other (ADR-0022, the characters of the intro film). One source for the Panel header, the empty
// state, the Portal icon, the favicon and the app icon.
// One buddy is drawn on a 64-unit grid; the mark places two of them with a translate and a scale.

/** An outlined shape of one buddy, as SVG path data on its 64-unit grid. */
export interface BuddyPath {
  d: string
  /** `body`, `shade`: the buddy's own colours; `none`: an open line. */
  fill: 'body' | 'shade' | 'none'
  /** Line colour; `chevron` is the buddy's accent colour. Default ink. */
  stroke?: 'ink' | 'chevron'
  /** Line width on the 64-unit grid, before the buddy's scale. Default: the outline width. */
  width?: number
}

/** A filled ellipse without outline: the eyes and their highlights. */
export interface BuddyDot {
  cx: number
  cy: number
  rx: number
  ry: number
  fill: 'ink' | 'light'
}

/** Back to front: feet, arms, body, then the face. */
export const BUDDY: { paths: readonly BuddyPath[]; eyes: readonly BuddyDot[] } = {
  paths: [
    { d: 'M17 48 Q15 58 22 57 Q27 57 27 50 M37 50 Q37 57 42 57 Q49 58 47 48', fill: 'shade' },
    { d: 'M14 37 C4 32 4 41 14 43 M50 37 C60 32 60 41 50 43', fill: 'body' },
    {
      d: 'M12 37 C12 27 17 23 25 23 H39 C47 23 52 27 52 37 C52 48 45 53 32 53 C19 53 12 48 12 37 Z',
      fill: 'body',
    },
    { d: 'M30 27 L34 29.31 L30 31.62', fill: 'none', stroke: 'chevron', width: 2.5 },
    { d: 'M29 46 Q32 49 35 46', fill: 'none', width: 2.5 },
  ],
  eyes: [
    { cx: 22, cy: 38.5, rx: 4.5, ry: 6, fill: 'ink' },
    { cx: 42, cy: 38.5, rx: 4.5, ry: 6, fill: 'ink' },
  ],
}

/** The eye highlights sit towards where the buddy looks: `1` right, `-1` left. */
export function highlights(look: 1 | -1): BuddyDot[] {
  return BUDDY.eyes.map((e) => ({
    cx: e.cx + 1.5 * look,
    cy: e.cy + (look > 0 ? 0.5 : -2),
    rx: 1.65,
    ry: 2.1,
    fill: 'light',
  }))
}

export interface BuddyColors {
  body: string
  shade: string
  chevron: string
}

export const MARK_COLORS = {
  blue: { body: '#3f8fc4', shade: '#29658e', chevron: '#f2b35e' },
  amber: { body: '#f2b35e', shade: '#c98a35', chevron: '#3f8fc4' },
  ink: '#1e2a44',
  light: '#f6f0e5',
} as const

export interface PlacedBuddy {
  colors: BuddyColors
  /** Where the buddy looks (and which way its eye highlights sit). */
  look: 1 | -1
  /** 64-unit grid → mark units: translate by (x, y), then scale. */
  x: number
  y: number
  scale: number
}

/** The two buddies in mark units, back first. The blue one in front is the one a Portal's `logoColor` recolours. */
export const MARK: { line: number; placedLine: number; back: PlacedBuddy; front: PlacedBuddy } = {
  /** Outline width of a buddy drawn alone, on its 64-unit grid. */
  line: 2.75,
  /** Outline width of a placed buddy before its scale, so the outline stays about 2.5 mark units. */
  placedLine: 3.6,
  back: { colors: MARK_COLORS.amber, look: 1, x: -2, y: 2, scale: 0.7 },
  front: { colors: MARK_COLORS.blue, look: -1, x: 22, y: 16, scale: 0.7 },
}

/** The square the pair is drawn in, in mark units (the Panel's 40 px tile and the app icon tile). */
export const MARK_VIEWBOX = { x: -2.5, y: 3, size: 69 } as const

function buddySvg(b: PlacedBuddy, line: number, bodyFill?: string | null): string {
  const color = (fill: BuddyPath['fill']) => {
    if (fill === 'none') return ' fill="none"'
    if (fill === 'shade') return ` fill="${b.colors.shade}"`
    return bodyFill === null ? '' : ` fill="${bodyFill ?? b.colors.body}"`
  }
  const paths = BUDDY.paths
    .map((p) => {
      const stroke = p.stroke === 'chevron' ? ` stroke="${b.colors.chevron}"` : ''
      const width = p.width ? ` stroke-width="${p.width}"` : ''
      return `<path d="${p.d}"${color(p.fill)}${stroke}${width}/>`
    })
    .join('')
  const dots = [...BUDDY.eyes, ...highlights(b.look)]
    .map(
      (e) =>
        `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${e.fill === 'ink' ? MARK_COLORS.ink : MARK_COLORS.light}"/>`,
    )
    .join('')
  const transform =
    b.scale === 1 && b.x === 0 && b.y === 0 ? '' : ` transform="translate(${b.x} ${b.y}) scale(${b.scale})"`
  return `<g${transform} stroke-width="${line}">${paths}<g stroke="none">${dots}</g></g>`
}

const OUTLINE = `stroke="${MARK_COLORS.ink}" stroke-linecap="round" stroke-linejoin="round"`

/**
 * The mark as SVG children (no outer <svg>). With `front` omitted the blue buddy's body has no fill of its own, so it
 * takes the surrounding `fill` (the Panel's `--logo-fg`, which Portals set with `logoColor`); everything else is fixed.
 */
export function markSvgBody(front?: string): string {
  return `<g ${OUTLINE}>${buddySvg(MARK.back, MARK.placedLine)}${buddySvg(MARK.front, MARK.placedLine, front ?? null)}</g>`
}

const viewBox = (v: { x: number; y: number; size: number }) => `${v.x} ${v.y} ${v.size} ${v.size}`

/** The Panel's header logo: the mark sized for its 40 px tile. */
export const MARK_SVG = `<svg viewBox="${viewBox(MARK_VIEWBOX)}">${markSvgBody()}</svg>`

/** `<basePath>/icon.svg`: the whole mark on a transparent square, for a Portal's tab or menu (ADR-0006 amendment). */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(MARK_VIEWBOX)}" role="img" aria-label="sideby">` +
  `${markSvgBody(MARK_COLORS.blue.body)}</svg>`

/**
 * `<basePath>/favicon.svg`: the small cut for sizes below about 24 px, redrawn for a 16 pt browser tab (ADR-0022):
 * the blue buddy alone on a 32 grid, its body filling the width, short feet and no arms, `>` or mouth, bigger eyes,
 * and a 2-unit outline (about 6% of the canvas). The same rules as the Local tools Portal's tab icons.
 */
export const FAVICON_SVG = (() => {
  const blue = MARK_COLORS.blue
  const ink = MARK_COLORS.ink
  const light = MARK_COLORS.light
  const body = BUDDY.paths[2]!.d
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="sideby">` +
    `<g stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -1.3)">` +
    `<path d="M8.5 25 Q7.6 31 11.5 30.6 Q14 30.4 14 26.6 M18 26.6 Q18 30.4 20.5 30.6 Q24.4 31 23.5 25" fill="${blue.shade}" stroke="${ink}" stroke-width="2"/>` +
    `<g transform="translate(-7.2 -12.675) scale(0.725)"><path d="${body}" fill="${blue.body}" stroke="${ink}" stroke-width="2.759"/>` +
    `<ellipse cx="22.5" cy="38" rx="5.5" ry="7" fill="${ink}"/><ellipse cx="41.5" cy="38" rx="5.5" ry="7" fill="${ink}"/>` +
    `<ellipse cx="20.6" cy="35.4" rx="2.1" ry="2.6" fill="${light}"/><ellipse cx="39.6" cy="35.4" rx="2.1" ry="2.6" fill="${light}"/>` +
    `</g></g></svg>`
  )
})()
