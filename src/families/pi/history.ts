// pi's Session History (spec §3.33): one `sessions/<cwd>/<time>_<id>.jsonl` per Session under the Account's agent
// folder (tried with pi 1.3.0 on 2026-10-20). The first line is a `session` header with `id`, `cwd` and
// `timestamp`; `message` records hold the conversation. pi keeps no title, so the first prompt is the Session Title.
import { join } from 'node:path'
import type { HistoryFile, HistoryMessage, HistoryReader, ParsedSession } from '../history.ts'
import {
  blockText,
  dirEntries,
  fileLines,
  historyFile,
  isoTime,
  jsonText,
  parseRecord,
  SessionText,
  str,
  titleFromText,
  typedText,
} from '../shared/history-text.ts'

type Msg = { role?: unknown; content?: unknown; model?: unknown }

function toolNames(m: Msg): string[] {
  if (!Array.isArray(m.content)) return []
  return m.content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'toolCall')
    .map((b) => str((b as { name?: unknown }).name) ?? 'tool')
}

export const piHistory: HistoryReader = {
  family: 'pi',

  async list(account) {
    const out: HistoryFile[] = []
    const root = join(account.dir, 'sessions')
    for (const c of await dirEntries(root)) {
      if (!c.isDirectory()) continue
      for (const e of await dirEntries(join(root, c.name))) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
        const f = await historyFile(join(root, c.name, e.name))
        if (f) out.push(f)
      }
    }
    return out
  },

  async parse(file) {
    let sessionId: string | undefined
    let cwd: string | undefined
    let model: string | undefined
    let startedAt: string | undefined
    let updatedAt: string | undefined
    const text = new SessionText()
    for await (const line of fileLines(file.path)) {
      const rec = parseRecord(line)
      if (!rec) continue
      const at = isoTime(rec.timestamp)
      if (at) {
        startedAt ??= at
        updatedAt = at
      }
      if (rec.type === 'session') {
        sessionId ??= str(rec.id)
        cwd ??= str(rec.cwd)
      } else if (rec.type === 'message') {
        const m = (rec.message ?? {}) as Msg
        if (m.role === 'user') {
          const t = typedText(blockText(m.content))
          if (t) text.prompt(t)
        } else if (m.role === 'assistant') {
          model = str(m.model) ?? model
          const t = blockText(m.content).trim()
          if (t) text.reply(t)
        }
      }
    }
    if (!sessionId || !text.count) return undefined
    const s: ParsedSession = {
      sessionId,
      titleFrom: text.first ? 'prompt' : 'none',
      messages: text.count,
      script: false,
      prompts: text.prompts,
      replies: text.replies,
      ...(text.cut ? { cut: true } : {}),
    }
    if (text.first) s.title = titleFromText(text.first)
    if (cwd) s.cwd = cwd
    if (model) s.model = model
    if (startedAt) s.startedAt = startedAt
    if (updatedAt) s.updatedAt = updatedAt
    return s
  },

  async *messages(path) {
    for await (const line of fileLines(path)) {
      if (!line.includes('"type":"message"')) continue
      const rec = parseRecord(line)
      const m = (rec?.message ?? {}) as Msg
      const at = isoTime(rec?.timestamp)
      const when = at ? { at } : {}
      if (m.role === 'user') {
        const text = typedText(blockText(m.content))
        if (text) yield { role: 'user', text, ...when } satisfies HistoryMessage
      } else if (m.role === 'assistant') {
        const text = blockText(m.content).trim()
        if (text) yield { role: 'assistant', text, ...when }
        for (const tool of toolNames(m)) yield { role: 'tool', text: tool, tool, ...when }
      }
    }
  },

  async *toolText(path) {
    for await (const line of fileLines(path)) {
      if (!line.includes('"type":"message"')) continue
      const m = (parseRecord(line)?.message ?? {}) as Msg
      if (m.role === 'toolResult') yield jsonText(m.content)
      else if (m.role === 'assistant' && Array.isArray(m.content))
        for (const b of m.content as { type?: unknown; arguments?: unknown }[])
          if (b?.type === 'toolCall') yield jsonText(b.arguments)
    }
  },
}
