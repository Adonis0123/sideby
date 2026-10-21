// Grok Build's Session History (spec §3.33): one folder `sessions/<encodeURIComponent(cwd)>/<id>/` per Session (tried
// with Grok Build 1.0.62 on 2026-10-20). `summary.json` gives the title, repository root, branch, model and times;
// `chat_history.jsonl` the conversation. `session_kind` is empty for a Session a person started, and `headless` or
// `subagent…` for a Script Session.
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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

const CHAT = 'chat_history.jsonl'

function decodeCwd(name: string): string | undefined {
  try {
    const d = decodeURIComponent(name)
    return d.startsWith('/') ? d : undefined
  } catch {
    return undefined
  }
}

type Rec = { type?: unknown; content?: unknown; synthetic_reason?: unknown; tool_calls?: unknown }

function promptOf(r: Rec): string {
  if (r.synthetic_reason !== undefined && r.synthetic_reason !== null) return ''
  return typedText(blockText(r.content))
}

const replyOf = (r: Rec): string => blockText(r.content).trim()

function toolNames(r: Rec): string[] {
  if (!Array.isArray(r.tool_calls)) return []
  return r.tool_calls.map((c) => {
    const fn = (c as { function?: { name?: unknown }; name?: unknown }) ?? {}
    return str(fn.function?.name) ?? str(fn.name) ?? 'tool'
  })
}

export const grokHistory: HistoryReader = {
  family: 'grok',

  async list(account) {
    const out: HistoryFile[] = []
    const root = join(account.dir, 'sessions')
    for (const c of await dirEntries(root)) {
      if (!c.isDirectory()) continue
      for (const s of await dirEntries(join(root, c.name))) {
        if (!s.isDirectory()) continue
        const dir = join(root, c.name, s.name)
        const f = await historyFile(join(dir, CHAT), { also: join(dir, 'summary.json') })
        if (f) out.push(f)
      }
    }
    return out
  },

  async parse(file) {
    const dir = dirname(file.path)
    let summary: Record<string, unknown> = {}
    try {
      summary = parseRecord(await readFile(join(dir, 'summary.json'), 'utf8')) ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const text = new SessionText()
    let first: string | undefined
    let last: string | undefined
    for await (const line of fileLines(file.path)) {
      if (!/"type":"(user|assistant)"/.test(line)) continue
      const rec = parseRecord(line) as Rec | undefined
      if (!rec) continue
      const at = isoTime((rec as Record<string, unknown>).timestamp)
      if (at) {
        first ??= at
        last = at
      }
      if (rec.type === 'user') {
        const t = promptOf(rec)
        if (t) text.prompt(t)
      } else {
        const t = replyOf(rec)
        if (t) text.reply(t)
      }
    }
    if (!text.count) return undefined
    const kind = str(summary.session_kind)
    const hostTitle = str(summary.generated_title)?.trim()
    const s: ParsedSession = {
      sessionId: basename(dir),
      titleFrom: hostTitle ? 'host' : text.first ? 'prompt' : 'none',
      messages: text.count,
      script: Boolean(kind),
      prompts: text.prompts,
      replies: text.replies,
      ...(text.cut ? { cut: true } : {}),
    }
    const title = hostTitle ? titleFromText(hostTitle) : text.first && titleFromText(text.first)
    if (title) s.title = title
    const cwd = decodeCwd(basename(dirname(dir)))
    if (cwd) s.cwd = cwd
    const root = str(summary.git_root_dir)
    if (root) s.gitRoot = root
    const branch = str(summary.head_branch)
    if (branch) s.branch = branch
    const model = str(summary.current_model_id)
    if (model) s.model = model
    const startedAt = isoTime(summary.created_at) ?? first
    const updatedAt = isoTime(summary.last_active_at) ?? isoTime(summary.updated_at) ?? last
    if (startedAt) s.startedAt = startedAt
    if (updatedAt) s.updatedAt = updatedAt
    return s
  },

  async *messages(path) {
    for await (const line of fileLines(path)) {
      if (!/"type":"(user|assistant)"/.test(line)) continue
      const rec = parseRecord(line) as Rec | undefined
      if (!rec) continue
      const at = isoTime((rec as Record<string, unknown>).timestamp)
      const when = at ? { at } : {}
      if (rec.type === 'user') {
        const text = promptOf(rec)
        if (text) yield { role: 'user', text, ...when } satisfies HistoryMessage
      } else {
        const text = replyOf(rec)
        if (text) yield { role: 'assistant', text, ...when }
        for (const tool of toolNames(rec)) yield { role: 'tool', text: tool, tool, ...when }
      }
    }
  },

  async *toolText(path) {
    for await (const line of fileLines(path)) {
      const rec = parseRecord(line) as Rec | undefined
      if (!rec) continue
      if (rec.type === 'tool' || (rec.type === 'user' && rec.synthetic_reason === 'tool_result'))
        yield jsonText(rec.content)
      else if (rec.type === 'assistant' && Array.isArray(rec.tool_calls))
        for (const c of rec.tool_calls as { function?: { arguments?: unknown }; arguments?: unknown }[])
          yield jsonText(c?.function?.arguments ?? c?.arguments)
    }
  },
}
