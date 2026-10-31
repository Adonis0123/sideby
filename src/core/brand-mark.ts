// The sideby mark (ADR-0064): Sai, the blue buddy with a gold crown and a red cape, painted in ink and watercolour.
// One source for the Panel header, the empty state, the Portal icon, the favicon, the Menu Bar Item and the app icon.
// The paintings are PNGs with a transparent background in assets/brand/ (shipped in the package), one per size; each
// place picks the smallest one that stays sharp at twice its size. Like the old vector mark, it sits on a light tile.
import { readFileSync } from 'node:fs'

/** The sizes painted, in pixels; `assets/brand/sai-painted-<size>.png`. */
export const MARK_SIZES = [64, 128, 256, 1024] as const
export type MarkSize = (typeof MARK_SIZES)[number]

const cache = new Map<MarkSize, Buffer>()

/** The painting at `size` as PNG bytes, from `assets/brand/` (two levels above src/, three above dist/src/). */
export function markPng(size: MarkSize): Buffer {
  const hit = cache.get(size)
  if (hit) return hit
  const name = `assets/brand/sai-painted-${size}.png`
  for (const rel of ['../../', '../../../']) {
    try {
      const png = readFileSync(new URL(rel + name, import.meta.url))
      cache.set(size, png)
      return png
    } catch {
      // try the next layout
    }
  }
  throw new Error(`sideby: ${name} is missing from the package; reinstall sideby`)
}

/** The painting at `size` as a `data:` URI. */
export const markDataUri = (size: MarkSize): string =>
  `data:image/png;base64,${markPng(size).toString('base64')}`

/** The light tile behind the mark: the Panel's `--logo-bg` default and the app icon's tile. */
export const MARK_TILE = '#e5f2fb'

/** How much of its tile the painting fills on each side: 3 of 40 px in the Panel header. */
export const MARK_INSET = 3 / 40

/** The Panel's header logo: the painting for its 40 px tile (sharp at 3x). The page's CSP allows `data:` images. */
export const MARK_IMG = `<img src="${markDataUri(128)}" alt="" width="40" height="40" decoding="async">`

/** The painting as a square SVG with a transparent background, the PNG inside as a `data:` image. */
function markSvg(size: MarkSize): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="sideby">` +
    `<image href="${markDataUri(size)}" width="${size}" height="${size}"/></svg>`
  )
}

/** `<basePath>/icon.svg`: the mark on a transparent square, for a Portal's tab or menu (ADR-0006 amendment). */
export const ICON_SVG = markSvg(128)

/** `<basePath>/favicon.svg`: the same painting at the size a 16 to 32 px browser tab needs. */
export const FAVICON_SVG = markSvg(64)

/**
 * The Menu Bar Item's icon (spec §3.31) and its card's, as base64 PNG: Sai in colour, drawn at 18 pt and 30 pt. It
 * keeps its colours in light and dark mode; the painting's dark outline keeps it visible on both.
 */
export const MENUBAR_ICON_PNG = markPng(64).toString('base64')
