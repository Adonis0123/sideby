// Reads the key names of a Chrome Local Storage LevelDB directory, read-only (spec §3.24, ADR-0023). Only keys are
// kept: a value's bytes are stepped over and never turned into text, compared or returned. A table block is Snappy
// compressed as a whole, keys and values together, so it is decompressed into a buffer that is dropped after its keys
// are taken. Nothing is written, locked or copied; a record cut short (Chrome writing while we read) is skipped.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Files larger than this are skipped and reported. */
export const MAX_LEVELDB_FILE = 64 * 1024 * 1024

class Cut extends Error {}

function varint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0
  let shift = 0
  for (let i = pos; i < buf.length && shift <= 35; i++) {
    const b = buf[i] as number
    result += (b & 0x7f) * 2 ** shift
    if (b < 0x80) return [result, i + 1]
    shift += 7
  }
  throw new Cut()
}

/** Snappy raw-format decompression (https://github.com/google/snappy/blob/main/format_description.txt). */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  const [len, start] = varint(src, 0)
  if (len > MAX_LEVELDB_FILE) throw new Cut()
  const out = new Uint8Array(len)
  let o = 0
  let i = start
  while (i < src.length) {
    const tag = src[i++] as number
    const kind = tag & 3
    if (kind === 0) {
      let n = tag >> 2
      if (n >= 60) {
        const extra = n - 59
        n = 0
        for (let k = 0; k < extra; k++) n += (src[i + k] ?? 0) * 256 ** k
        i += extra
      }
      n += 1
      if (i + n > src.length || o + n > len) throw new Cut()
      out.set(src.subarray(i, i + n), o)
      i += n
      o += n
      continue
    }
    let n: number
    let off: number
    if (kind === 1) {
      n = ((tag >> 2) & 7) + 4
      off = ((tag >> 5) << 8) | (src[i++] ?? 0)
    } else if (kind === 2) {
      n = (tag >> 2) + 1
      off = (src[i] ?? 0) | ((src[i + 1] ?? 0) << 8)
      i += 2
    } else {
      n = (tag >> 2) + 1
      off =
        ((src[i] ?? 0) | ((src[i + 1] ?? 0) << 8) | ((src[i + 2] ?? 0) << 16)) + (src[i + 3] ?? 0) * 2 ** 24
      i += 4
    }
    if (off === 0 || off > o || o + n > len) throw new Cut()
    for (let k = 0; k < n; k++, o++) out[o] = out[o - off] as number
  }
  if (o !== len) throw new Cut()
  return out
}

/** The newest state of one user key: its sequence number and whether it still holds a value. */
interface KeyState {
  seq: number
  live: boolean
}

type Sink = (key: Uint8Array, seq: number, live: boolean) => void

/** A `.log` file: 32 KiB blocks of records that together form WriteBatches. */
function readLog(buf: Uint8Array, sink: Sink): void {
  const BLOCK = 32768
  const parts: Uint8Array[] = []
  let pos = 0
  while (pos + 7 <= buf.length) {
    const left = BLOCK - (pos % BLOCK)
    if (left < 7) {
      pos += left
      continue
    }
    const len = (buf[pos + 4] as number) | ((buf[pos + 5] as number) << 8)
    const type = buf[pos + 6] as number
    const data = buf.subarray(pos + 7, pos + 7 + len)
    pos += 7 + len
    if (type === 0 || data.length < len) break
    if (type === 1) batch(data, sink)
    else if (type === 2) parts.splice(0, parts.length, data)
    else if (type === 3) parts.push(data)
    else if (type === 4 && parts.length) {
      parts.push(data)
      batch(concat(parts), sink)
      parts.length = 0
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function batch(b: Uint8Array, sink: Sink): void {
  if (b.length < 12) return
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let seq = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32
  const count = view.getUint32(8, true)
  let pos = 12
  try {
    for (let n = 0; n < count && pos < b.length; n++, seq++) {
      const tag = b[pos++]
      const [kl, p1] = varint(b, pos)
      const key = b.subarray(p1, p1 + kl)
      pos = p1 + kl
      if (pos > b.length) throw new Cut()
      if (tag === 1) {
        const [vl, p2] = varint(b, pos)
        pos = p2 + vl // the value is stepped over
        sink(key, seq, true)
      } else if (tag === 0) sink(key, seq, false)
      else break
    }
  } catch (e) {
    if (!(e instanceof Cut)) throw e
  }
}

/** One block of a table: prefix-compressed entries, then the restart array. Calls `each` with key and value range. */
function blockEntries(
  block: Uint8Array,
  each: (key: Uint8Array, valueStart: number, valueEnd: number) => void,
): void {
  if (block.length < 4) return
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  const restarts = view.getUint32(block.length - 4, true)
  const end = block.length - 4 - restarts * 4
  if (end < 0) return
  let pos = 0
  let last = new Uint8Array(0)
  while (pos < end) {
    const [shared, p1] = varint(block, pos)
    const [unshared, p2] = varint(block, p1)
    const [vlen, p3] = varint(block, p2)
    if (shared > last.length || p3 + unshared + vlen > end) throw new Cut()
    const key = new Uint8Array(shared + unshared)
    key.set(last.subarray(0, shared), 0)
    key.set(block.subarray(p3, p3 + unshared), shared)
    each(key, p3 + unshared, p3 + unshared + vlen)
    last = key
    pos = p3 + unshared + vlen
  }
}

function readBlock(file: Uint8Array, offset: number, size: number): Uint8Array {
  if (offset + size + 5 > file.length) throw new Cut()
  const raw = file.subarray(offset, offset + size)
  const type = file[offset + size]
  if (type === 0) return raw
  if (type === 1) return snappyDecompress(raw)
  throw new Cut()
}

/** A `.ldb` (or `.sst`) table: footer → index block → data blocks. Only internal keys are taken from data blocks. */
function readTable(buf: Uint8Array, sink: Sink): void {
  if (buf.length < 48) return
  const footer = buf.subarray(buf.length - 48)
  const magic = new DataView(footer.buffer, footer.byteOffset + 40, 8)
  if (magic.getUint32(0, true) !== 0x8b80fb57 || magic.getUint32(4, true) !== 0xdb477524) return
  let [, p] = varint(footer, 0) // metaindex offset
  ;[, p] = varint(footer, p) // metaindex size
  const [indexOff, p2] = varint(footer, p)
  const [indexSize] = varint(footer, p2)
  const index = readBlock(buf, indexOff, indexSize)
  blockEntries(index, (_key, vs, ve) => {
    const handle = index.subarray(vs, ve)
    const [off, q] = varint(handle, 0)
    const [size] = varint(handle, q)
    let block: Uint8Array
    try {
      block = readBlock(buf, off, size)
    } catch (e) {
      if (e instanceof Cut) return
      throw e
    }
    blockEntries(block, (ikey) => {
      if (ikey.length < 8) return
      const t = new DataView(ikey.buffer, ikey.byteOffset + ikey.length - 8, 8)
      const tag = t.getUint32(0, true) + t.getUint32(4, true) * 2 ** 32
      sink(ikey.subarray(0, ikey.length - 8), Math.floor(tag / 256), tag % 256 === 1)
    })
  })
}

const latin1 = new TextDecoder('latin1')
const utf16 = new TextDecoder('utf-16le')

/**
 * The Local Storage key names of `origins` (`https://claude.ai`), from a `Local Storage/leveldb` directory. A key
 * deleted later is left out. `changedAt` is the newest modification time of the files read. Files that are too large
 * or unreadable go to `problems` (their name only).
 */
export async function localStorageKeys(
  dir: string,
  origins: readonly string[],
): Promise<{ keys: Map<string, Set<string>>; changedAt?: number; problems: string[] }> {
  const problems: string[] = []
  const keys = new Map<string, Set<string>>(origins.map((o) => [o, new Set<string>()]))
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { keys, problems }
  }
  const prefixes = origins.map((o) => Buffer.from(`_${o}\u0000`, 'latin1'))
  const states = new Map<string, { origin: string; name: string } & KeyState>()
  const sink: Sink = (key, seq, live) => {
    const i = prefixes.findIndex(
      (p) => key.length > p.length && Buffer.from(key.subarray(0, p.length)).equals(p),
    )
    if (i < 0) return
    const prefix = prefixes[i] as Buffer
    const enc = key[prefix.length]
    const body = key.subarray(prefix.length + 1)
    const name = enc === 1 ? latin1.decode(body) : enc === 0 ? utf16.decode(body) : undefined
    if (name === undefined) return
    const id = `${i}\u0000${name}`
    const prev = states.get(id)
    if (!prev || seq >= prev.seq) states.set(id, { origin: origins[i] as string, name, seq, live })
  }
  let changedAt: number | undefined
  for (const name of names.sort()) {
    const table = name.endsWith('.ldb') || name.endsWith('.sst')
    if (!table && !name.endsWith('.log')) continue
    const file = join(dir, name)
    try {
      const st = await stat(file)
      if (!st.isFile()) continue
      if (st.size > MAX_LEVELDB_FILE) {
        problems.push(`${name} is larger than 64 MB and was skipped`)
        continue
      }
      changedAt = Math.max(changedAt ?? 0, st.mtimeMs)
      const buf = new Uint8Array(await readFile(file))
      try {
        if (table) readTable(buf, sink)
        else readLog(buf, sink)
      } catch (e) {
        if (!(e instanceof Cut)) throw e
        problems.push(`${name} could not be read completely`)
      }
    } catch (e) {
      if (e instanceof Cut) continue
      problems.push(`${name} could not be read`)
    }
  }
  for (const s of states.values()) if (s.live) keys.get(s.origin)?.add(s.name)
  return { keys, ...(changedAt === undefined ? {} : { changedAt }), problems }
}
