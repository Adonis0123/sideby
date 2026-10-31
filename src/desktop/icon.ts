// The sideby app icon without dependencies: the painted mark of core/brand-mark.ts (ADR-0064) on a light rounded
// tile, composited in pure Node and encoded as PNG, SVG or ICNS. The painting is decoded from its PNG, scaled with an
// exact area average (each output pixel is the mean of the source area it covers, in premultiplied alpha) and laid
// over the antialiased tile, as the Panel header lays it over its 40 px tile.
import { deflateSync, inflateSync } from 'node:zlib'
import { MARK_INSET, MARK_SIZES, MARK_TILE, type MarkSize, markDataUri, markPng } from '../core/brand-mark.ts'

/** Text stored in every generated file, so `sideby app uninstall` deletes only what it wrote. */
export const APP_MARKER = 'sideby-app-install'

// The Panel's logo tile (page-styles.ts: .logo 40×40, radius 10).
const TILE = { size: 40, radius: 10 }
// The tile sits on the macOS icon grid: 824 of 1024 units, centred.
const GRID = { canvas: 1024, tile: 824 }

const TILE_RGB = [1, 3, 5].map((i) => Number.parseInt(MARK_TILE.slice(i, i + 2), 16)) as [
  number,
  number,
  number,
]

function tileRect(size: number) {
  const w = (size * GRID.tile) / GRID.canvas
  const off = (size - w) / 2
  return { x: off, y: off, w, h: w, r: (TILE.radius * w) / TILE.size }
}

/** Where the painting goes on a `size` canvas: inset from the tile's edge as in the Panel header. */
export function markRect(size: number) {
  const t = tileRect(size)
  const inset = t.w * MARK_INSET
  return { x: t.x + inset, y: t.y + inset, w: t.w - 2 * inset }
}

/** Coverage (0..1) of the tile's rounded rectangle at each pixel, from its signed distance. */
function tileCoverage(size: number): Float32Array {
  const s = tileRect(size)
  const a = new Float32Array(size * size)
  const hx = s.w / 2
  const hy = s.h / 2
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const qx = Math.abs(px + 0.5 - (s.x + hx)) - (hx - s.r)
      const qy = Math.abs(py + 0.5 - (s.y + hy)) - (hy - s.r)
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r
      a[py * size + px] = Math.min(1, Math.max(0, 0.5 - d))
    }
  return a
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG to straight-alpha RGBA pixels. */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('icon: not a PNG')
  let off = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, color, , , interlace] = data.subarray(8, 13)
      channels = color === 6 ? 4 : color === 2 ? 3 : 0
      if (depth !== 8 || !channels || interlace !== 0) throw new Error('icon: unsupported PNG format')
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const cur = new Uint8Array(stride)
  let prev = new Uint8Array(stride)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1)
    const filter = raw[base]!
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!
      const a = i >= channels ? cur[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      let v = x
      if (filter === 1) v = x + a
      else if (filter === 2) v = x + b
      else if (filter === 3) v = x + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      rgba[o] = cur[x * channels]!
      rgba[o + 1] = cur[x * channels + 1]!
      rgba[o + 2] = cur[x * channels + 2]!
      rgba[o + 3] = channels === 4 ? cur[x * channels + 3]! : 255
    }
    prev = Uint8Array.from(cur)
  }
  return { width, height, rgba }
}

/**
 * For each of `n` output pixels, the source pixels it covers and how much of each, when a `src`-pixel line is laid
 * from `from` to `from + span` on the output line.
 */
function areaWeights(n: number, src: number, from: number, span: number): { j: number; w: number }[][] {
  const k = src / span
  return Array.from({ length: n }, (_, i) => {
    const s0 = Math.max(0, (i - from) * k)
    const s1 = Math.min(src, (i + 1 - from) * k)
    const out: { j: number; w: number }[] = []
    for (let j = Math.floor(s0); j < s1; j++) {
      const w = Math.min(j + 1, s1) - Math.max(j, s0)
      if (w > 0) out.push({ j, w: w / k })
    }
    return out
  })
}

const decoded = new Map<MarkSize, ReturnType<typeof decodePng>>()

/** The smallest painting at least as large as `px`, decoded once. */
function painting(px: number) {
  const size = MARK_SIZES.find((s) => s >= px) ?? MARK_SIZES[MARK_SIZES.length - 1]!
  let d = decoded.get(size)
  if (!d) {
    d = decodePng(markPng(size))
    decoded.set(size, d)
  }
  return d
}

/** RGBA pixels (straight alpha) of the icon at `size`×`size`. */
export function renderIcon(size: number): Uint8Array {
  const r = markRect(size)
  const src = painting(r.w)
  // Premultiplied source, then an area average across, then down.
  const sw = src.width
  const sh = src.height
  const pre = new Float32Array(sw * sh * 4)
  for (let i = 0; i < sw * sh; i++) {
    const a = src.rgba[i * 4 + 3]! / 255
    pre[i * 4] = (src.rgba[i * 4]! / 255) * a
    pre[i * 4 + 1] = (src.rgba[i * 4 + 1]! / 255) * a
    pre[i * 4 + 2] = (src.rgba[i * 4 + 2]! / 255) * a
    pre[i * 4 + 3] = a
  }
  const wx = areaWeights(size, sw, r.x, r.w)
  const wy = areaWeights(size, sh, r.y, r.w)
  const across = new Float32Array(size * sh * 4)
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < size; x++)
      for (const { j, w } of wx[x]!)
        for (let c = 0; c < 4; c++) across[(y * size + x) * 4 + c]! += pre[(y * sw + j) * 4 + c]! * w
  const tile = tileCoverage(size)
  const px = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const m = [0, 0, 0, 0]
      for (const { j, w } of wy[y]!) for (let c = 0; c < 4; c++) m[c]! += across[(j * size + x) * 4 + c]! * w
      // The painting over the tile, both premultiplied.
      const ta = tile[y * size + x]!
      const ma = Math.min(1, m[3]!)
      const a = ma + ta * (1 - ma)
      if (a <= 0) continue
      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++)
        px[o + c] = Math.min(255, Math.round(((m[c]! + (TILE_RGB[c]! / 255) * ta * (1 - ma)) / a) * 255))
      px[o + 3] = Math.min(255, Math.round(a * 255))
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

/** The same icon as an SVG (1024-unit canvas), for Linux icon themes: the tile, and the painting as a `data:` image. */
export function iconSvg(): string {
  const tile = tileRect(GRID.canvas)
  const r = markRect(GRID.canvas)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.canvas} ${GRID.canvas}" width="${GRID.canvas}" height="${GRID.canvas}">`,
    `  <!-- ${APP_MARKER} -->`,
    `  <rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="${tile.r}" fill="${MARK_TILE}"/>`,
    `  <image x="${r.x}" y="${r.y}" width="${r.w}" height="${r.w}" href="${markDataUri(1024)}"/>`,
    '</svg>',
    '',
  ].join('\n')
}
