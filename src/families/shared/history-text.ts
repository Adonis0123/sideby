// Text helpers for Session History readers (spec §3.33): reading a record file line by line, and keeping only what a
// person typed or a model replied. Injected context (system reminders, environment blocks, instruction files) is cut
// out, so it never reaches the History Index (ADR-0042).
import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'

/** The longest record line read; a longer one (a huge tool output, never a typed prompt) is skipped unread. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * Every non-empty line of a file, streamed: a huge file never sits in memory at once, a line over `MAX_LINE_BYTES`
 * is dropped as it streams by, and stopping early closes the file.
 */
export async function* fileLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path)
  let parts: Buffer[] = []
  let size = 0
  let skipping = false
  const take = (): string => {
    const line = Buffer.concat(parts).toString('utf8')
    parts = []
    size = 0
    return line.endsWith('\r') ? line.slice(0, -1) : line
  }
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      let from = 0
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
        if (skipping) skipping = false
        else if (size + nl - from > MAX_LINE_BYTES) {
          parts = []
          size = 0
        } else {
          parts.push(chunk.subarray(from, nl))
          const line = take()
          if (line) yield line
        }
        from = nl + 1
      }
      if (from < chunk.length && !skipping) {
        parts.push(chunk.subarray(from))
        size += chunk.length - from
        if (size > MAX_LINE_BYTES) {
          skipping = true
          parts = []
          size = 0
        }
      }
    }
    if (!skipping && parts.length) {
      const line = take()
      if (line) yield line
    }
  } finally {
    input.destroy()
  }
}

/** A JSON object from one record line, or undefined for a line that is cut, still being written or not an object. */
export function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The `text` of every `{ type: <kind>, text }` block of a message's content; a string content is its own text. */
export function blockText(content: unknown, kinds: readonly string[] = ['text']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && kinds.includes((b as { type?: unknown }).type as string)) {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') out.push(t)
    }
  }
  return out.join('\n')
}

// Blocks a Host or a tool puts into a "user" turn that the person did not type.
const INJECTED_TAG =
  /<\/?(system-reminder|environment_context|user_instructions|permissions[\w-]*|local-command-stdout|local-command-stderr|local-command-caveat|command-message|task-notification|ide_selection|ide_opened_file|turn_aborted|skill)\b[^>]*>/g

/**
 * `text` without its injected blocks. Blocks may nest (a reminder quoting a reminder), so each one ends at the close
 * tag that balances its own open tag; a block left open runs to the end of the text, which is cut too.
 */
export function stripInjected(text: string): string {
  let out = ''
  let at = 0
  let open: { name: string; depth: number } | undefined
  for (const m of text.matchAll(INJECTED_TAG)) {
    const closing = m[0].startsWith('</')
    const name = m[1]!
    if (!open) {
      if (closing) continue
      out += text.slice(at, m.index)
      open = { name, depth: 1 }
    } else if (name === open.name) {
      open.depth += closing ? -1 : 1
      if (!open.depth) {
        open = undefined
        at = m.index + m[0].length
      }
    }
  }
  return open ? out : out + text.slice(at)
}
// A whole turn that is injected when it starts with one of these.
const INJECTED_START =
  /^\s*(#\s*AGENTS\.md instructions|<INSTRUCTIONS>|Caveat: The messages below|\[Request interrupted)/

/**
 * What a person typed in a "user" turn: injected blocks cut out, a slash command shown as `/name args`, a shell
 * escape as `!cmd`. Empty when nothing typed is left.
 */
export function typedText(text: string): string {
  if (INJECTED_START.test(text)) return ''
  // Injected blocks go first: a reminder may quote a command or a shell escape the person never typed.
  const typed = stripInjected(text)
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(typed)?.[1]?.trim()
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(typed)?.[1]?.trim()
    return [name.startsWith('/') ? name : `/${name}`, args].filter(Boolean).join(' ')
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(typed)?.[1]?.trim()
  if (bash) return `!${bash}`
  // Codex wraps a pasted image as <image name=[Image #1] path="..."> ... </image>; the tags are not typed.
  return typed
    .replace(/<bash-std(out|err)>[\s\S]*?<\/bash-std\1>/g, '')
    .replace(/<\/?image\b[^>]*>/g, '')
    .trim()
}

/** The most text of one Session that is kept for search, in characters; the rest is counted but not kept. */
export const SESSION_TEXT_MAX = 4 * 1024 * 1024

/** The first `max` UTF-16 units of `t`, one fewer when the cut would leave half of a surrogate pair. */
export function cutText(t: string, max: number): string {
  if (t.length <= max) return t
  const end = max > 0 && /[\uD800-\uDBFF]/.test(t[max - 1]!) ? max - 1 : max
  return t.slice(0, end)
}

/** Collects a Session's prompts and replies while a reader parses it, keeping at most `SESSION_TEXT_MAX` of text. */
export class SessionText {
  readonly prompts: string[] = []
  readonly replies: string[] = []
  /** Prompts plus replies, kept or not. */
  count = 0
  /** The first prompt, kept whole for the title. */
  first: string | undefined
  /** True once some text was left out for the limit. */
  cut = false
  #left: number

  constructor(max = SESSION_TEXT_MAX) {
    this.#left = max
  }

  prompt(t: string): void {
    this.first ??= t
    this.#keep(this.prompts, t)
  }

  reply(t: string): void {
    this.#keep(this.replies, t)
  }

  #keep(list: string[], t: string): void {
    this.count++
    if (t.length > this.#left) this.cut = true
    if (this.#left <= 0) return
    const kept = cutText(t, this.#left)
    this.#left -= kept.length
    list.push(kept)
  }
}

/**
 * Every string, number and boolean inside a JSON value, one per line: the text of a tool's input or output, without
 * the `type` names of content blocks.
 */
export function jsonText(v: unknown): string {
  const out: string[] = []
  const walk = (x: unknown, depth: number): void => {
    if (typeof x === 'string') out.push(x)
    else if (typeof x === 'number' || typeof x === 'boolean') out.push(String(x))
    else if (Array.isArray(x)) {
      if (depth < 32) for (const y of x) walk(y, depth + 1)
    } else if (x && typeof x === 'object' && depth < 32)
      // A content block's `type` (`{ type: 'text', text }`) names the block, it is not text of the tool.
      for (const [k, y] of Object.entries(x)) if (!(k === 'type' && 'text' in x)) walk(y, depth + 1)
  }
  walk(v, 0)
  return out.join('\n')
}

/** The longest Session Title sideby shows; the Host's own titles are cut the same way. */
export const TITLE_MAX = 120

/** A one-line title from a prompt: its first non-empty line, spaces collapsed, cut at `TITLE_MAX` characters. */
export function titleFromText(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  const one = line.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : one
}

/** ISO time of a value a Host wrote as an ISO string or epoch milliseconds/seconds; undefined when it is neither. */
export function isoTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : new Date(t).toISOString()
  }
  return undefined
}

/** A record file as a `HistoryFile`, signed by size, mtime and inode; undefined when it vanished meanwhile. */
export async function historyFile(
  path: string,
  extra: { parent?: string; also?: string } = {},
): Promise<{ path: string; sig: string; mtimeMs: number; parent?: string } | undefined> {
  const sigOf = async (p: string) => {
    try {
      const st = await stat(p)
      return st.isFile() ? { sig: `${st.size}:${st.mtimeMs}:${st.ino}`, mtimeMs: st.mtimeMs } : undefined
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }
  const main = await sigOf(path)
  if (!main) return undefined
  const also = extra.also ? await sigOf(extra.also) : undefined
  return {
    path,
    sig: also ? `${main.sig}|${also.sig}` : main.sig,
    mtimeMs: Math.max(main.mtimeMs, also?.mtimeMs ?? 0),
    ...(extra.parent ? { parent: extra.parent } : {}),
  }
}

/** The entries of a folder; empty when it does not exist, other errors thrown. */
export async function dirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR')
      return []
    throw err
  }
}
