// The outro mark of the README demo (docs/assets/demo.html), drawn from src/core/brand-mark.ts. Each buddy sits in
// its own group (.h0 behind, .h1 in front) so the scene slides them in, over a light halo that keeps the ink outline
// visible on the dark stage. `node scripts/demo-mark.ts` writes it between the mark:start and mark:end comments;
// scripts/demo-mark.test.ts fails while demo.html holds another one. Retake the GIF afterwards.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buddyShapes,
  buddySvg,
  MARK,
  MARK_COLORS,
  MARK_OUTLINE,
  type PlacedBuddy,
} from '../src/core/brand-mark.ts'

export const DEMO_HTML = join(resolve(import.meta.dirname, '..'), 'docs/assets/demo.html')
const START = '<!-- mark:start -->'
const END = '<!-- mark:end -->'
/** How much wider than its outline the halo is, in a buddy's 64-unit grid. */
const HALO = 4

/** The buddy's silhouette in the light colour, outlines widened, drawn under the buddy. */
function halo(b: PlacedBuddy): string {
  const { paths, above } = buddyShapes(b)
  const light = MARK_COLORS.light
  const shapes = [...paths, ...above]
    .map((s) => {
      const fill = s.fill === 'none' ? ' fill="none"' : ''
      const width = s.width ? ` stroke-width="${s.width + HALO}"` : ''
      return `<path d="${s.d}"${fill}${width}/>`
    })
    .join('')
  return `<g transform="translate(${b.x} ${b.y}) scale(${b.scale})" stroke="${light}" stroke-width="${MARK.placedLine + HALO}" fill="${light}" stroke-linecap="round" stroke-linejoin="round">${shapes}</g>`
}

const buddy = (cls: string, b: PlacedBuddy) =>
  `<g class="${cls}">${halo(b)}<g ${MARK_OUTLINE}>${buddySvg(b, MARK.placedLine)}</g></g>`

/** The markup that goes between the markers. */
export function outroMark(): string {
  return buddy('h0', MARK.back) + buddy('h1', MARK.front)
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
