// The outro mark of the README demo (docs/assets/demo.html), from src/core/brand-mark.ts (ADR-0064): the painted Sai
// on the Panel's light logo tile, in one group (.h1) that the scene slides in. The tile keeps the painting's ink
// outline visible on the dark stage. `node scripts/demo-mark.ts` writes it between the mark:start and mark:end
// comments; scripts/demo-mark.test.ts fails while demo.html holds another one. Retake the GIF afterwards.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARK_INSET, MARK_TILE, markDataUri } from '../src/core/brand-mark.ts'

export const DEMO_HTML = join(resolve(import.meta.dirname, '..'), 'docs/assets/demo.html')
const START = '<!-- mark:start -->'
const END = '<!-- mark:end -->'
/** The tile in the outro's viewBox (-4 9 72 51.4): a 48-unit square, centred, with the Panel tile's radius. */
const TILE = { x: 8, y: 10.7, size: 48 }

/** The markup that goes between the markers. */
export function outroMark(): string {
  const r = (TILE.size * 10) / 40
  const inset = TILE.size * MARK_INSET
  const art = TILE.size - 2 * inset
  return (
    `<g class="h1"><rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="${r}" fill="${MARK_TILE}"/>` +
    `<image x="${TILE.x + inset}" y="${TILE.y + inset}" width="${art}" height="${art}" href="${markDataUri(256)}"/></g>`
  )
}

/** What demo.html holds between the markers; null without them. */
export function markBetweenMarkers(html: string): string | null {
  const a = html.indexOf(START)
  const b = html.indexOf(END, a)
  return a === -1 || b === -1 ? null : html.slice(a + START.length, b)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const html = readFileSync(DEMO_HTML, 'utf8')
  if (markBetweenMarkers(html) === null) {
    console.error(
      `demo-mark: ${START} … ${END} not found in docs/assets/demo.html; put them around the outro mark`,
    )
    process.exit(1)
  }
  const a = html.indexOf(START) + START.length
  writeFileSync(DEMO_HTML, html.slice(0, a) + outroMark() + html.slice(html.indexOf(END, a)))
  console.log(
    'demo-mark: wrote the outro mark into docs/assets/demo.html; retake the GIF: node scripts/record-demo.ts',
  )
}
