// The sideby mark drawn without dependencies: the Panel header's logo (two faces side by side on a light rounded
// tile, core/brand-mark.ts) rasterised with analytic antialiasing and encoded as PNG, SVG or ICNS.
import { deflateSync } from 'node:zlib'
import { MARK, MARK_COLORS, MARK_TILE_VIEWBOX, markSvgBody, type RoundedRect } from '../core/brand-mark.ts'

/** Text stored in every generated file, so `sideby app uninstall` deletes only what it wrote. */
export const APP_MARKER = 'sideby-app-install'

// The Panel's logo tile (page-styles.ts: .logo 40×40, radius 10), with the mark in MARK_TILE_VIEWBOX units on it.
const TILE = { size: 40, radius: 10, color: [0xe5, 0xf2, 0xfb] as const }
// The tile sits on the macOS icon grid: 824 of 1024 units, centred.
const GRID = { canvas: 1024, tile: 824 }

type Rgb = readonly [number, number, number]
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb

interface Rect {
  x: number
  y: number
  w: number
  h: number
  r: number
}

function shapes(size: number) {
  const tilePx = (size * GRID.tile) / GRID.canvas
  const off = (size - tilePx) / 2
  const u = tilePx / MARK_TILE_VIEWBOX.size
  const place = ([x, y, w, h, r]: RoundedRect): Rect => ({
    x: off + (x - MARK_TILE_VIEWBOX.x) * u,
    y: off + (y - MARK_TILE_VIEWBOX.y) * u,
    w: w * u,
    h: h * u,
    r: r * u,
  })
  return {
    tile: { x: off, y: off, w: tilePx, h: tilePx, r: (TILE.radius * tilePx) / TILE.size },
    back: place(MARK.back),
    front: place(MARK.front),
    gap: place(MARK.gap),
    backEyes: MARK.backEyes.map(place),
    frontEyes: MARK.frontEyes.map(place),
  }
}

/** Signed distance from (px, py) to a rounded rectangle; negative inside. */
function roundedRectDistance(px: number, py: number, s: Rect): number {
  const hx = s.w / 2
  const hy = s.h / 2
  const qx = Math.abs(px - (s.x + hx)) - (hx - s.r)
  const qy = Math.abs(py - (s.y + hy)) - (hy - s.r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - s.r
}

/** RGBA pixels (straight alpha) of the icon at `size`×`size`. */
export function renderIcon(size: number): Uint8Array {
  const sh = shapes(size)
  const d = (r: Rect) => (x: number, y: number) => roundedRectDistance(x, y, r)
  // Inside `r` and outside the gap around the front face.
  const cut = (r: Rect) => (x: number, y: number) =>
    Math.max(roundedRectDistance(x, y, r), -roundedRectDistance(x, y, sh.gap))
  const layers = [
    { dist: d(sh.tile), color: TILE.color },
    { dist: cut(sh.back), color: rgb(MARK_COLORS.back) },
    ...sh.backEyes.map((e) => ({ dist: cut(e), color: rgb(MARK_COLORS.eye) })),
    { dist: d(sh.front), color: rgb(MARK_COLORS.front) },
    ...sh.frontEyes.map((e) => ({ dist: d(e), color: rgb(MARK_COLORS.eye) })),
  ]
  const px = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // Premultiplied "over" compositing; coverage from the distance at the pixel centre.
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const l of layers) {
        const la = Math.min(1, Math.max(0, 0.5 - l.dist(x + 0.5, y + 0.5)))
        if (la === 0) continue
        r = (l.color[0] / 255) * la + r * (1 - la)
        g = (l.color[1] / 255) * la + g * (1 - la)
        b = (l.color[2] / 255) * la + b * (1 - la)
        a = la + a * (1 - la)
      }
      const i = (y * size + x) * 4
      if (a > 0) {
        px[i] = Math.round((r / a) * 255)
        px[i + 1] = Math.round((g / a) * 255)
        px[i + 2] = Math.round((b / a) * 255)
        px[i + 3] = Math.round(a * 255)
      }
    }
  return px
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes straight-alpha RGBA pixels as a PNG with a `Software` text chunk holding APP_MARKER. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Software\0${APP_MARKER}`, 'latin1')),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const iconPng = (size: number): Buffer => encodePng(size, size, renderIcon(size))

/** The macOS `.iconset` file names and their pixel sizes, 16 to 1024. */
export const ICONSET: readonly { name: string; size: number }[] = [16, 32, 128, 256, 512].flatMap((s) => [
  { name: `icon_${s}x${s}.png`, size: s },
  { name: `icon_${s}x${s}@2x.png`, size: s * 2 },
])

// ICNS element types for PNG data, by pixel size (`@2x` variants have their own types).
const ICNS_TYPES: Record<string, string> = {
  'icon_16x16.png': 'icp4',
  'icon_16x16@2x.png': 'ic11',
  'icon_32x32.png': 'icp5',
  'icon_32x32@2x.png': 'ic12',
  'icon_128x128.png': 'ic07',
  'icon_128x128@2x.png': 'ic13',
  'icon_256x256.png': 'ic08',
  'icon_256x256@2x.png': 'ic14',
  'icon_512x512.png': 'ic09',
  'icon_512x512@2x.png': 'ic10',
}

/** Builds an `.icns` file directly from PNGs; used when `iconutil` is not available. */
export function encodeIcns(pngs: ReadonlyMap<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const { name } of ICONSET) {
    const data = pngs.get(name)
    if (!data) continue
    const head = Buffer.alloc(8)
    head.write(ICNS_TYPES[name]!, 0, 'latin1')
    head.writeUInt32BE(data.length + 8, 4)
    parts.push(head, data)
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

/** The same mark as an SVG (1024-unit canvas), for Linux icon themes. */
export function iconSvg(): string {
  const { tile } = shapes(GRID.canvas)
  const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const V = MARK_TILE_VIEWBOX
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.canvas} ${GRID.canvas}" width="${GRID.canvas}" height="${GRID.canvas}">`,
    `  <!-- ${APP_MARKER} -->`,
    `  <rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="${tile.r}" fill="${hex(TILE.color)}"/>`,
    `  <svg x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" viewBox="${V.x} ${V.y} ${V.size} ${V.size}">${markSvgBody('gap', MARK_COLORS.front)}</svg>`,
    '</svg>',
    '',
  ].join('\n')
}
