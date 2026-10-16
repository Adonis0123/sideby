// The sideby mark: two friendly faces side by side, the amber one behind and the blue one in front, cut apart by a
// gap that follows the front face (ADR-0020). One source for the Panel header, the empty state and the app icon.
// Geometry is on a 256-unit grid centred on (128, 128); rounded rectangles are [x, y, width, height, radius].

export type RoundedRect = readonly [x: number, y: number, w: number, h: number, r: number]

export const MARK = {
  back: [12, 82, 128, 104, 44],
  front: [116, 70, 128, 116, 46],
  /** Cut out of the back face (and its eyes) so the two faces never touch. */
  gap: [104, 58, 152, 140, 58],
  backEyes: [
    [45, 119, 14, 26, 7],
    [83, 119, 14, 26, 7],
  ],
  frontEyes: [
    [155, 111, 14, 26, 7],
    [193, 111, 14, 26, 7],
  ],
} as const satisfies Record<string, RoundedRect | readonly RoundedRect[]>

export const MARK_COLORS = { front: '#3f8fc4', back: '#f2b35e', eye: '#1e2a44' } as const

/** The square the mark is drawn in when it sits on a tile (about 78% of the tile is mark). */
export const MARK_TILE_VIEWBOX = { x: -20.5, y: -20.5, size: 297 } as const

export function roundedRectPath([x, y, w, h, r]: RoundedRect): string {
  return (
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  )
}

/**
 * The mark as SVG children (no outer <svg>). The front face has no fill of its own, so it takes the surrounding
 * `fill` (the Panel's `--logo-fg`, which Portals can set with `logoColor`); the back face and the eyes are fixed.
 * `id` names the gap mask; keep it unique per document.
 */
export function markSvgBody(id: string, front?: string): string {
  const eyes = (list: readonly RoundedRect[]) => list.map(roundedRectPath).join('')
  const frontFill = front ? ` fill="${front}"` : ''
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">` +
    `<rect width="256" height="256" fill="#fff"/><path fill="#000" d="${roundedRectPath(MARK.gap)}"/></mask>` +
    `<g mask="url(#${id})"><path fill="${MARK_COLORS.back}" d="${roundedRectPath(MARK.back)}"/>` +
    `<path fill="${MARK_COLORS.eye}" d="${eyes(MARK.backEyes)}"/></g>` +
    `<path${frontFill} d="${roundedRectPath(MARK.front)}"/>` +
    `<path fill="${MARK_COLORS.eye}" d="${eyes(MARK.frontEyes)}"/>`
  )
}

const V = MARK_TILE_VIEWBOX
/** The Panel's header logo: the mark sized for its 40 px tile. */
export const MARK_SVG = `<svg viewBox="${V.x} ${V.y} ${V.size} ${V.size}">${markSvgBody('sideby-mark-gap')}</svg>`

/** `<basePath>/icon.svg`: the whole mark on a transparent square, for a Portal's tab or menu (ADR-0006 amendment). */
export const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${V.x} ${V.y} ${V.size} ${V.size}" role="img" aria-label="sideby">` +
  `${markSvgBody('sideby-icon-gap', MARK_COLORS.front)}</svg>`

/** `<basePath>/favicon.svg`: the small cut, the front face alone, for sizes below about 24 px (ADR-0020). */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="104 58 152 140">' +
  `<path fill="${MARK_COLORS.front}" d="${roundedRectPath(MARK.front)}"/>` +
  `<path fill="${MARK_COLORS.eye}" d="${MARK.frontEyes.map(roundedRectPath).join('')}"/></svg>`
