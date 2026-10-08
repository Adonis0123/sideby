// The sideby mark drawn without dependencies: the Panel header's logo (a dark rounded tile with a light disc
// split into two halves, offset along the diagonal, the second at 55% opacity) rasterised with analytic
// antialiasing and encoded as PNG, SVG or ICNS.
import { deflateSync } from 'node:zlib'

/** Text stored in every generated file, so `sideby app uninstall` deletes only what it wrote. */
export const APP_MARKER = 'sideby-app-install'

// Geometry in the Panel's 40-unit logo box (page.ts: .logo 40×40, radius 10; halves of radius 10.5 centred at
// 18.5,18.5 facing left and 21.5,21.5 facing right, so they sit 3 apart and mirror through the centre).
const TILE = { size: 40, radius: 10, color: [0xe5, 0xf2, 0xfb] as const }
const MARK = { color: [0x3f, 0x8f, 0xc4] as const, opacities: [1, 0.55] }
const HALVES = [
  { cx: 18.5, cy: 18.5, r: 10.5, side: -1 },
  { cx: 21.5, cy: 21.5, r: 10.5, side: 1 },
] as const
// The tile sits on the macOS icon grid: 824 of 1024 units, centred.
const GRID = { canvas: 1024, tile: 824 }

interface Rect {
  x: number
  y: number
  w: number
  h: number
  r: number
}

/** Half of a disc: `side` -1 keeps the part left of the centre, 1 the part right of it. */
interface Half {
  cx: number
  cy: number
  r: number
  side: number
}

function shapes(size: number): { tile: Rect; halves: Half[] } {
  const tilePx = (size * GRID.tile) / GRID.canvas
  const off = (size - tilePx) / 2
  const u = tilePx / TILE.size
  return {
    tile: { x: off, y: off, w: tilePx, h: tilePx, r: TILE.radius * u },
    halves: HALVES.map((h) => ({ cx: off + h.cx * u, cy: off + h.cy * u, r: h.r * u, side: h.side })),
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

/** Signed distance from (px, py) to a half disc: the disc intersected with the half-plane on its side. */
function halfDistance(px: number, py: number, h: Half): number {
  return Math.max(Math.hypot(px - h.cx, py - h.cy) - h.r, (px - h.cx) * -h.side)
}

/** RGBA pixels (straight alpha) of the icon at `size`×`size`. */
export function renderIcon(size: number): Uint8Array {
  const { tile, halves } = shapes(size)
  const layers = [
    { dist: (x: number, y: number) => roundedRectDistance(x, y, tile), color: TILE.color, opacity: 1 },
    ...halves.map((h, i) => ({
      dist: (x: number, y: number) => halfDistance(x, y, h),
      color: MARK.color,
      opacity: MARK.opacities[i]!,
    })),
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
        const cover = Math.min(1, Math.max(0, 0.5 - l.dist(x + 0.5, y + 0.5)))
        const la = cover * l.opacity
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
  const { tile, halves } = shapes(GRID.canvas)
  const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const opacityAttr = (opacity: number) => (opacity === 1 ? '' : ` fill-opacity="${opacity}"`)
  const rect = (s: Rect, fill: string) =>
    `  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${fill}"/>`
  // From the top of the cut to its bottom, bulging to the half's side.
  const half = (h: Half, fill: string, opacity: number) =>
    `  <path d="M${h.cx} ${h.cy - h.r}A${h.r} ${h.r} 0 0 ${h.side > 0 ? 1 : 0} ${h.cx} ${h.cy + h.r}Z" fill="${fill}"${opacityAttr(opacity)}/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.canvas} ${GRID.canvas}" width="${GRID.canvas}" height="${GRID.canvas}">`,
    `  <!-- ${APP_MARKER} -->`,
    rect(tile, hex(TILE.color)),
    ...halves.map((h, i) => half(h, hex(MARK.color), MARK.opacities[i]!)),
    '</svg>',
    '',
  ].join('\n')
}
