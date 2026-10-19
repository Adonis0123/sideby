// The sideby mark: two buddies side by side, the amber one behind on the left and the blue one in front on the right,
// looking at each other (ADR-0022, the characters of the intro film). One source for the Panel header, the empty
// state, the Portal icon, the favicon and the app icon.
// One buddy is drawn on a 64-unit grid; the mark places two of them with a translate and a scale. Both share one
// gumdrop body; what tells them apart is a pair of props each, from the brand design sheet (ADR-0022 amendment):
// Sai, the blue one, wears a gold crown and a red cape; Bai, the amber one, a bent antenna and a spare battery.

/** A colour by name, or a fixed hex colour for a prop. */
export type Paint = 'ink' | 'light' | `#${string}`

/** An outlined shape of one buddy, as SVG path data (absolute M, L, H, Q, C, Z) on its 64-unit grid. */
export interface BuddyPath {
  d: string
  /** `body`, `shade`: the buddy's own colours; `none`: an open line. */
  fill: 'body' | 'shade' | 'none' | Paint
  /** Line colour; `none` draws no line. Default ink. */
  stroke?: Paint | 'none'
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

/** The body both buddies share, back to front: feet, arms, body; then the eyes. No forehead `>`: that belongs to Nika. */
export const BUDDY: { paths: readonly BuddyPath[]; eyes: readonly BuddyDot[] } = {
  paths: [
    { d: 'M17 48 Q15 58 22 57 Q27 57 27 50 M37 50 Q37 57 42 57 Q49 58 47 48', fill: 'shade' },
    { d: 'M14 37 C4 32 4 41 14 43 M50 37 C60 32 60 41 50 43', fill: 'body' },
    {
      d: 'M12 37 C12 27 17 23 25 23 H39 C47 23 52 27 52 37 C52 48 45 53 32 53 C19 53 12 48 12 37 Z',
      fill: 'body',
    },
  ],
  eyes: [
    { cx: 22, cy: 38.5, rx: 4.5, ry: 6, fill: 'ink' },
    { cx: 42, cy: 38.5, rx: 4.5, ry: 6, fill: 'ink' },
  ],
}

/** What one buddy wears and how it smiles: `behind` the body, its `mouth`, and `above` the face. */
export interface BuddyProps {
  behind: readonly BuddyPath[]
  mouth: BuddyPath
  above: readonly BuddyPath[]
}

const RED = '#e0685a'
const GOLD = '#ffd977'
const GREEN = '#5bb06a'

/** Sai (blue): a red cape behind the shoulders, a gold crown with a red jewel, a small smile. */
export const SAI: BuddyProps = {
  behind: [
    { d: 'M19 29 Q10 27 9 34 L4 53 Q13 57 22 50 L42 50 Q51 57 60 53 L55 34 Q54 27 45 29 Z', fill: RED },
  ],
  mouth: { d: 'M29 46 Q32 49 35 46', fill: 'none', width: 2.5 },
  above: [
    { d: 'M20 23 L17 10 L27 15 L32 6 L37 15 L47 10 L44 23 Z', fill: GOLD },
    {
      d: 'M35 19 C35 20.66 33.66 22 32 22 C30.34 22 29 20.66 29 19 C29 17.34 30.34 16 32 16 C33.66 16 35 17.34 35 19 Z',
      fill: RED,
      stroke: 'none',
    },
  ],
}

/** Bai (amber): a green spare battery on its back, a bent antenna with a ball, an open laugh. */
export const BAI: BuddyProps = {
  behind: [
    {
      d: 'M52 23 H56 C58.21 23 60 24.79 60 27 L60 48 C60 50.21 58.21 52 56 52 H52 C49.79 52 48 50.21 48 48 L48 27 C48 24.79 49.79 23 52 23 Z',
      fill: GREEN,
    },
    { d: 'M52 23 L52 19 H57 L57 23', fill: GREEN },
    { d: 'M51 32 H57 M54 29 L54 35', fill: 'none', stroke: 'light', width: 2 },
  ],
  mouth: { d: 'M29 46 Q32 52 35 46 Z', fill: 'ink', width: 2.5 },
  above: [
    { d: 'M31 24 C24 17 26 9 36 10', fill: 'none', stroke: GREEN, width: 4 },
    {
      d: 'M44 10 C44 12.76 41.76 15 39 15 C36.24 15 34 12.76 34 10 C34 7.24 36.24 5 39 5 C41.76 5 44 7.24 44 10 Z',
      fill: GREEN,
    },
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
}

export const MARK_COLORS = {
  blue: { body: '#3f8fc4', shade: '#29658e' },
  amber: { body: '#f2b35e', shade: '#c98a35' },
  ink: '#1e2a44',
  light: '#f6f0e5',
} as const

export interface PlacedBuddy {
  colors: BuddyColors
  props: BuddyProps
  /** Where the buddy looks (and which way its eye highlights sit). */
  look: 1 | -1
  /** Mirror the props left to right, so what is worn on the back stays behind a buddy that turns the other way. */
  mirror?: boolean
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
  back: { colors: MARK_COLORS.amber, props: BAI, look: 1, mirror: true, x: -2, y: 2, scale: 0.7 },
  front: { colors: MARK_COLORS.blue, props: SAI, look: -1, x: 22, y: 16, scale: 0.7 },
}

/** The square the pair is drawn in, in mark units (the Panel's 40 px tile and the app icon tile). */
export const MARK_VIEWBOX = { x: -2.5, y: 3, size: 69 } as const

/** Path data mirrored on the 64-unit grid (x → 64 − x); absolute M, L, H, Q, C, Z only. */
export function mirrorPath(d: string): string {
  let cmd = ''
  let n = 0
  return d.replace(/[MLHQCZ]|-?\d*\.?\d+/g, (t) => {
    if (/[A-Z]/.test(t)) {
      cmd = t
      n = 0
      return t
    }
    const isX = cmd === 'H' || n++ % 2 === 0
    return isX ? String(Math.round((64 - Number(t)) * 1000) / 1000) : t
  })
}

const paint = (p: Paint): string => (p === 'ink' ? MARK_COLORS.ink : p === 'light' ? MARK_COLORS.light : p)

/** One shape of a placed buddy with its colours resolved; `fill` undefined inherits the surrounding fill. */
export interface BuddyShape {
  d: string
  fill: string | undefined
  stroke: string
  width?: number
}

/**
 * One buddy's shapes, back to front: the props behind, the body, the mouth, the eyes, the props above.
 * `bodyFill`: `undefined` keeps the buddy's body colour, `null` leaves the body unfilled so it inherits.
 */
export function buddyShapes(
  b: PlacedBuddy,
  bodyFill?: string | null,
): { paths: BuddyShape[]; above: BuddyShape[]; dots: BuddyDot[] } {
  const resolve = (p: BuddyPath): BuddyShape => {
    const fill =
      p.fill === 'none'
        ? 'none'
        : p.fill === 'shade'
          ? b.colors.shade
          : p.fill === 'body'
            ? bodyFill === null
              ? undefined
              : (bodyFill ?? b.colors.body)
            : paint(p.fill)
    const stroke = p.stroke === undefined ? MARK_COLORS.ink : p.stroke === 'none' ? 'none' : paint(p.stroke)
    return { d: p.d, fill, stroke, ...(p.width ? { width: p.width } : {}) }
  }
  const prop = (p: BuddyPath): BuddyShape => {
    const s = resolve(p)
    return b.mirror ? { ...s, d: mirrorPath(s.d) } : s
  }
  return {
    paths: [...b.props.behind.map(prop), ...BUDDY.paths.map(resolve), resolve(b.props.mouth)],
    dots: [...BUDDY.eyes, ...highlights(b.look)],
    above: b.props.above.map(prop),
  }
}

function shapeSvg(s: BuddyShape): string {
  const fill = s.fill === undefined ? '' : ` fill="${s.fill}"`
  const stroke = s.stroke === MARK_COLORS.ink ? '' : ` stroke="${s.stroke}"`
  const width = s.width ? ` stroke-width="${s.width}"` : ''
  return `<path d="${s.d}"${fill}${stroke}${width}/>`
}

/** One placed buddy as SVG, drawn inside a group that sets the ink outline (`MARK_OUTLINE`). */
export function buddySvg(b: PlacedBuddy, line: number, bodyFill?: string | null): string {
  const { paths, dots, above } = buddyShapes(b, bodyFill)
  const eyes = dots
    .map(
      (e) =>
        `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${e.fill === 'ink' ? MARK_COLORS.ink : MARK_COLORS.light}"/>`,
    )
    .join('')
  const transform =
    b.scale === 1 && b.x === 0 && b.y === 0 ? '' : ` transform="translate(${b.x} ${b.y}) scale(${b.scale})"`
  return `<g${transform} stroke-width="${line}">${paths.map(shapeSvg).join('')}<g stroke="none">${eyes}</g>${above.map(shapeSvg).join('')}</g>`
}

export const MARK_OUTLINE = `stroke="${MARK_COLORS.ink}" stroke-linecap="round" stroke-linejoin="round"`

/**
 * The mark as SVG children (no outer <svg>). With `front` omitted the blue buddy's body has no fill of its own, so it
 * takes the surrounding `fill` (the Panel's `--logo-fg`, which Portals set with `logoColor`); everything else is fixed.
 */
export function markSvgBody(front?: string): string {
  return `<g ${MARK_OUTLINE}>${buddySvg(MARK.back, MARK.placedLine)}${buddySvg(MARK.front, MARK.placedLine, front ?? null)}</g>`
}

const viewBox = (v: { x: number; y: number; size: number }) => `${v.x} ${v.y} ${v.size} ${v.size}`

/** The Panel's header logo: the mark sized for its 40 px tile. */
export const MARK_SVG = `<svg viewBox="${viewBox(MARK_VIEWBOX)}">${markSvgBody()}</svg>`

/** `<basePath>/icon.svg`: the whole mark on a transparent square, for a Portal's tab or menu (ADR-0006 amendment). */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(MARK_VIEWBOX)}" role="img" aria-label="sideby">` +
  `${markSvgBody(MARK_COLORS.blue.body)}</svg>`

/**
 * `<basePath>/favicon.svg`: the small cut for sizes below about 24 px, for a 16 pt browser tab (ADR-0022): Sai alone
 * on a 32 grid at half scale, his body, eyes, cape and crown; no feet, arms or mouth. The same cut as the tab icons
 * of the brand design sheet.
 */
export const FAVICON_SVG = (() => {
  const sai: PlacedBuddy = { ...MARK.front, x: 0, y: 0, scale: 1 }
  const { paths, dots, above } = buddyShapes(sai)
  const body = BUDDY.paths[2]!.d
  const keep = paths.filter((p) => p.d === body || SAI.behind.some((q) => q.d === p.d))
  const eyes = dots
    .map(
      (e) =>
        `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${e.fill === 'ink' ? MARK_COLORS.ink : MARK_COLORS.light}"/>`,
    )
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="sideby">` +
    `<g transform="translate(0 -1) scale(.5)"><g ${MARK_OUTLINE} stroke-width="${MARK.line}">` +
    `${keep.map(shapeSvg).join('')}<g stroke="none">${eyes}</g>${above.map(shapeSvg).join('')}</g></g></svg>`
  )
})()

/**
 * The Menu Bar Item's icon (spec §3.31): the favicon's small cut of Sai in colour, 18 pt square. It keeps its colours
 * in light and dark mode, as the brand's tab icons do; the body's dark outline keeps it visible on both.
 */
export const MENUBAR_ICON_SVG = FAVICON_SVG.replace('<svg ', '<svg width="18" height="18" ')
