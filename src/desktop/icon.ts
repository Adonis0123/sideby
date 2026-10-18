// The sideby mark drawn without dependencies: the two buddies of core/brand-mark.ts on a light rounded tile,
// rasterised in pure Node and encoded as PNG, SVG or ICNS. Curves are flattened to polylines; fills use the nonzero
// rule with exact horizontal coverage on 16 sub-rows per pixel, outlines are round-capped, round-joined thick
// polylines (distance to a segment), ellipses use an analytic distance. Each shape is computed only inside its own
// bounding box and composited back to front, fill before outline, as an SVG renderer would.
import { deflateSync } from 'node:zlib'
import {
  type BuddyShape,
  buddyShapes,
  MARK,
  MARK_COLORS,
  MARK_VIEWBOX,
  markSvgBody,
  type PlacedBuddy,
} from '../core/brand-mark.ts'

/** Text stored in every generated file, so `sideby app uninstall` deletes only what it wrote. */
export const APP_MARKER = 'sideby-app-install'

// The Panel's logo tile (page-styles.ts: .logo 40×40, radius 10); MARK_VIEWBOX maps onto the whole tile square.
const TILE = { size: 40, radius: 10, color: [0xe5, 0xf2, 0xfb] as const }
// The tile sits on the macOS icon grid: 824 of 1024 units, centred.
const GRID = { canvas: 1024, tile: 824 }
// Sub-rows per pixel row for fills.
const SUB_ROWS = 16

type Rgb = readonly [number, number, number]
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb

type Pt = readonly [number, number]
/** One subpath as a polyline in pixels; `closed` when it ended with Z. */
interface Poly {
  pts: Pt[]
  closed: boolean
}

function tileRect(size: number) {
  const w = (size * GRID.tile) / GRID.canvas
  const off = (size - w) / 2
  return { x: off, y: off, w, h: w, r: (TILE.radius * w) / TILE.size }
}

/** Pixels per mark unit and the map from a buddy's 64-unit grid to pixels. */
function placement(size: number, b: PlacedBuddy) {
  const tile = tileRect(size)
  const u = tile.w / MARK_VIEWBOX.size
  const k = b.scale * u
  return {
    k,
    map: (gx: number, gy: number): Pt => [
      tile.x + (b.x + b.scale * gx - MARK_VIEWBOX.x) * u,
      tile.y + (b.y + b.scale * gy - MARK_VIEWBOX.y) * u,
    ],
  }
}

/** Parses absolute M, L, H, Q, C, Z path data and flattens it to pixel polylines. */
function flatten(d: string, map: (x: number, y: number) => Pt): Poly[] {
  const tokens = d.match(/[MLHQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  const polys: Poly[] = []
  let cur: Poly | null = null
  let gx = 0
  let gy = 0
  let start: Pt = [0, 0]
  let i = 0
  const num = () => Number(tokens[i++])
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]!)
  const lineTo = (x: number, y: number) => {
    gx = x
    gy = y
    cur!.pts.push(map(x, y))
  }
  const curve = (ctrl: Pt[], end: Pt) => {
    const all = [map(gx, gy), ...ctrl.map(([x, y]) => map(x, y)), map(end[0], end[1])]
    let len = 0
    for (let j = 1; j < all.length; j++)
      len += Math.hypot(all[j]![0] - all[j - 1]![0], all[j]![1] - all[j - 1]![1])
    const n = Math.max(4, Math.ceil(len / 2))
    for (let s = 1; s <= n; s++) {
      const t = s / n
      // De Casteljau on the pixel control points.
      let p = all.map((q) => [q[0], q[1]] as [number, number])
      while (p.length > 1)
        p = p.slice(1).map((q, j) => [p[j]![0] + (q[0] - p[j]![0]) * t, p[j]![1] + (q[1] - p[j]![1]) * t])
      cur!.pts.push([p[0]![0], p[0]![1]])
    }
    gx = end[0]
    gy = end[1]
  }
  let cmd = ''
  while (i < tokens.length) {
    if (!isNum()) cmd = tokens[i++]!.toUpperCase()
    switch (cmd) {
      case 'M':
        gx = num()
        gy = num()
        start = [gx, gy]
        cur = { pts: [map(gx, gy)], closed: false }
        polys.push(cur)
        cmd = 'L' // further pairs after M are lines
        break
      case 'L':
        lineTo(num(), num())
        break
      case 'H':
        lineTo(num(), gy)
        break
      case 'Q': {
        const c: Pt = [num(), num()]
        curve([c], [num(), num()])
        break
      }
      case 'C': {
        const c1: Pt = [num(), num()]
        const c2: Pt = [num(), num()]
        curve([c1, c2], [num(), num()])
        break
      }
      case 'Z':
        cur!.closed = true
        gx = start[0]
        gy = start[1]
        break
      default:
        throw new Error(`icon: unsupported path command ${cmd}`)
    }
  }
  return polys
}

/** A coverage mask (0..1) over an integer pixel box. */
interface Mask {
  x0: number
  y0: number
  w: number
  h: number
  a: Float32Array
}

function box(size: number, x0: number, y0: number, x1: number, y1: number): Mask | null {
  const bx0 = Math.max(0, Math.floor(x0))
  const by0 = Math.max(0, Math.floor(y0))
  const bx1 = Math.min(size, Math.ceil(x1))
  const by1 = Math.min(size, Math.ceil(y1))
  if (bx1 <= bx0 || by1 <= by0) return null
  const w = bx1 - bx0
  const h = by1 - by0
  return { x0: bx0, y0: by0, w, h, a: new Float32Array(w * h) }
}

/** Nonzero fill of the polylines (each closed implicitly), exact in x and sampled on SUB_ROWS rows per pixel. */
function fillMask(size: number, polys: Poly[]): Mask | null {
  const edges: [number, number, number, number][] = []
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const { pts } of polys)
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j]!
      const q = pts[(j + 1) % pts.length]!
      if (p[1] !== q[1]) edges.push([p[0], p[1], q[0], q[1]])
      x0 = Math.min(x0, p[0])
      y0 = Math.min(y0, p[1])
      x1 = Math.max(x1, p[0])
      y1 = Math.max(y1, p[1])
    }
  const m = box(size, x0, y0, x1, y1)
  if (!m) return null
  const hits: [number, number][] = []
  for (let row = 0; row < m.h; row++)
    for (let s = 0; s < SUB_ROWS; s++) {
      const sy = m.y0 + row + (s + 0.5) / SUB_ROWS
      hits.length = 0
      for (const [ax, ay, bx, by] of edges) {
        if (sy < Math.min(ay, by) || sy >= Math.max(ay, by)) continue
        hits.push([ax + ((sy - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1])
      }
      if (hits.length < 2) continue
      hits.sort((p, q) => p[0] - q[0])
      let wind = 0
      for (let h = 0; h < hits.length - 1; h++) {
        wind += hits[h]![1]
        if (wind === 0) continue
        const xa = Math.max(hits[h]![0], m.x0)
        const xb = Math.min(hits[h + 1]![0], m.x0 + m.w)
        for (let px = Math.floor(xa); px < xb; px++) {
          const cover = Math.min(xb, px + 1) - Math.max(xa, px)
          if (cover > 0) m.a[row * m.w + px - m.x0]! += cover / SUB_ROWS
        }
      }
    }
  return m
}

/** Round-capped, round-joined line of width `w` along the polylines: distance to the nearest segment ≤ w/2. */
function strokeMask(size: number, polys: Poly[], w: number): Mask | null {
  const r = w / 2
  const segs: [number, number, number, number][] = []
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const { pts, closed } of polys) {
    const n = closed ? pts.length : pts.length - 1
    for (let j = 0; j < Math.max(n, 1); j++) {
      const p = pts[j]!
      const q = pts[(j + 1) % pts.length] ?? p
      segs.push([p[0], p[1], q[0], q[1]])
      x0 = Math.min(x0, p[0], q[0])
      y0 = Math.min(y0, p[1], q[1])
      x1 = Math.max(x1, p[0], q[0])
      y1 = Math.max(y1, p[1], q[1])
    }
  }
  const m = box(size, x0 - r - 1, y0 - r - 1, x1 + r + 1, y1 + r + 1)
  if (!m) return null
  const dist = new Float32Array(m.w * m.h).fill(Infinity)
  for (const [ax, ay, bx, by] of segs) {
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const sx0 = Math.max(m.x0, Math.floor(Math.min(ax, bx) - r - 1))
    const sx1 = Math.min(m.x0 + m.w, Math.ceil(Math.max(ax, bx) + r + 1))
    const sy0 = Math.max(m.y0, Math.floor(Math.min(ay, by) - r - 1))
    const sy1 = Math.min(m.y0 + m.h, Math.ceil(Math.max(ay, by) + r + 1))
    for (let py = sy0; py < sy1; py++)
      for (let px = sx0; px < sx1; px++) {
        const cx = px + 0.5 - ax
        const cy = py + 0.5 - ay
        const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (cx * dx + cy * dy) / len2))
        const d = Math.hypot(cx - t * dx, cy - t * dy)
        const i = (py - m.y0) * m.w + px - m.x0
        if (d < dist[i]!) dist[i] = d
      }
  }
  for (let i = 0; i < dist.length; i++) m.a[i] = Math.min(1, Math.max(0, r + 0.5 - dist[i]!))
  return m
}

/** Filled ellipse with an approximate signed distance (exact on the axes, good near the edge). */
function ellipseMask(size: number, cx: number, cy: number, rx: number, ry: number): Mask | null {
  const m = box(size, cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1)
  if (!m) return null
  for (let py = 0; py < m.h; py++)
    for (let px = 0; px < m.w; px++) {
      const x = m.x0 + px + 0.5 - cx
      const y = m.y0 + py + 0.5 - cy
      const k0 = Math.hypot(x / rx, y / ry)
      const k1 = Math.hypot(x / (rx * rx), y / (ry * ry))
      const d = k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1
      m.a[py * m.w + px] = Math.min(1, Math.max(0, 0.5 - d))
    }
  return m
}

/** Signed distance from (px, py) to a rounded rectangle; negative inside. */
function roundedRectMask(
  size: number,
  s: { x: number; y: number; w: number; h: number; r: number },
): Mask | null {
  const m = box(size, s.x - 1, s.y - 1, s.x + s.w + 1, s.y + s.h + 1)
  if (!m) return null
  const hx = s.w / 2
  const hy = s.h / 2
  for (let py = 0; py < m.h; py++)
    for (let px = 0; px < m.w; px++) {
      const qx = Math.abs(m.x0 + px + 0.5 - (s.x + hx)) - (hx - s.r)
      const qy = Math.abs(m.y0 + py + 0.5 - (s.y + hy)) - (hy - s.r)
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r
      m.a[py * m.w + px] = Math.min(1, Math.max(0, 0.5 - d))
    }
  return m
}

/** The shapes of one placed buddy, back to front, each with its colour (core/brand-mark.ts buddyShapes). */
function buddyLayers(size: number, b: PlacedBuddy): { mask: Mask | null; color: Rgb }[] {
  const { k, map } = placement(size, b)
  const { paths, dots, above } = buddyShapes(b)
  const layers: { mask: Mask | null; color: Rgb }[] = []
  const shape = (s: BuddyShape) => {
    const polys = flatten(s.d, map)
    if (s.fill && s.fill !== 'none') layers.push({ mask: fillMask(size, polys), color: rgb(s.fill) })
    if (s.stroke !== 'none')
      layers.push({ mask: strokeMask(size, polys, (s.width ?? MARK.placedLine) * k), color: rgb(s.stroke) })
  }
  paths.forEach(shape)
  for (const e of dots) {
    const [cx, cy] = map(e.cx, e.cy)
    layers.push({
      mask: ellipseMask(size, cx, cy, e.rx * k, e.ry * k),
      color: rgb(e.fill === 'ink' ? MARK_COLORS.ink : MARK_COLORS.light),
    })
  }
  above.forEach(shape)
  return layers
}

/** RGBA pixels (straight alpha) of the icon at `size`×`size`. */
export function renderIcon(size: number): Uint8Array {
  const layers = [
    { mask: roundedRectMask(size, tileRect(size)), color: TILE.color as Rgb },
    ...buddyLayers(size, MARK.back),
    ...buddyLayers(size, { ...MARK.front, colors: { ...MARK.front.colors, body: MARK_COLORS.blue.body } }),
  ]
  // Premultiplied "over" compositing, layer by layer inside each mask's box.
  const acc = new Float32Array(size * size * 4)
  for (const { mask: m, color } of layers) {
    if (!m) continue
    const [cr, cg, cb] = color.map((c) => c / 255) as unknown as Rgb
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const la = Math.min(1, m.a[y * m.w + x]!)
        if (la <= 0) continue
        const i = ((m.y0 + y) * size + m.x0 + x) * 4
        acc[i] = cr * la + acc[i]! * (1 - la)
        acc[i + 1] = cg * la + acc[i + 1]! * (1 - la)
        acc[i + 2] = cb * la + acc[i + 2]! * (1 - la)
        acc[i + 3] = la + acc[i + 3]! * (1 - la)
      }
  }
  const px = new Uint8Array(size * size * 4)
  for (let i = 0; i < px.length; i += 4) {
    const a = acc[i + 3]!
    if (a <= 0) continue
    px[i] = Math.round((acc[i]! / a) * 255)
    px[i + 1] = Math.round((acc[i + 1]! / a) * 255)
    px[i + 2] = Math.round((acc[i + 2]! / a) * 255)
    px[i + 3] = Math.round(a * 255)
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
  const tile = tileRect(GRID.canvas)
  const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const V = MARK_VIEWBOX
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.canvas} ${GRID.canvas}" width="${GRID.canvas}" height="${GRID.canvas}">`,
    `  <!-- ${APP_MARKER} -->`,
    `  <rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="${tile.r}" fill="${hex(TILE.color)}"/>`,
    `  <svg x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" viewBox="${V.x} ${V.y} ${V.size} ${V.size}">${markSvgBody(MARK_COLORS.blue.body)}</svg>`,
    '</svg>',
    '',
  ].join('\n')
}
