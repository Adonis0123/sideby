// Codex's Session History (spec §3.33): one `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` per Session (tried with
// Codex CLI 0.163.0 on 2026-10-20). The first line, `session_meta`, gives the id, working directory, branch and how the
// Session was started; only those fields are read from it, never its account ids or instructions. Titles live apart,
// in `session_index.jsonl` (`thread_name`).
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

const ROLLOUT = /^rollout-.+\.jsonl$/
const WANTED = /"type":"(session_meta|turn_context|response_item)"/
// Tool output and reasoning items, never read: their (often huge) lines are not parsed.
const SKIPPED = /"type":"(function_call_output|custom_tool_call_output|local_shell_call_output|reasoning)"/

/**
 * A person started the Session in Codex itself (the TUI, the desktop app or an editor), not `codex exec`, an
 * automation or another agent driving Codex's app server.
 */
export function codexInteractive(meta: Record<string, unknown>): boolean {
  const source = meta.source
  if (source !== 'cli' && source !== 'vscode') return false
  if (meta.thread_source === 'automation') return false
  const originator = str(meta.originator)
  return !originator || /codex/i.test(originator)
}

async function* rollouts(dir: string): AsyncGenerator<string> {
  for (const e of await dirEntries(dir)) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* rollouts(p)
    else if (e.isFile() && ROLLOUT.test(e.name)) yield p
  }
}

type Item = { type?: unknown; role?: unknown; content?: unknown; name?: unknown; channel?: unknown }

// A reply the model wrote for the person (`phase` commentary or final_answer). A message on another `channel` than
// `final` (a reasoning channel) is not one, so it never reaches the History Index.
const isReply = (m: { channel?: unknown }): boolean => m.channel === undefined || m.channel === 'final'

export const codexHistory: HistoryReader = {
  family: 'codex',

  async list(account) {
    const out: HistoryFile[] = []
    for await (const p of rollouts(join(account.dir, 'sessions'))) {
      const f = await historyFile(p)
      if (f) out.push(f)
    }
    return out
  },

  async parse(file) {
    let sessionId: string | undefined
    let cwd: string | undefined
    let branch: string | undefined
    let model: string | undefined
    let startedAt: string | undefined
    let updatedAt: string | undefined
    let interactive = false
    const text = new SessionText()
    for await (const line of fileLines(file.path)) {
      if (!WANTED.test(line) || SKIPPED.test(line)) continue
      const rec = parseRecord(line)
      if (!rec) continue
      const at = isoTime(rec.timestamp)
      if (at) {
        startedAt ??= at
        updatedAt = at
      }
      const p = (rec.payload ?? {}) as Record<string, unknown>
      if (rec.type === 'session_meta') {
        sessionId ??= str(p.id) ?? str(p.session_id)
        cwd ??= str(p.cwd)
        branch ??= str((p.git as { branch?: unknown } | undefined)?.branch)
        interactive = codexInteractive(p)
      } else if (rec.type === 'turn_context') {
        model = str(p.model) ?? model
      } else if (p.type === 'message') {
        const item = p as Item
        if (item.role === 'user') {
          const t = typedText(blockText(item.content, ['input_text']))
          if (t) text.prompt(t)
        } else if (item.role === 'assistant' && isReply(item)) {
          const t = blockText(item.content, ['output_text']).trim()
          if (t) text.reply(t)
        }
      }
    }
    if (!sessionId || !text.count) return undefined
    const s: ParsedSession = {
      sessionId,
      titleFrom: text.first ? 'prompt' : 'none',
      messages: text.count,
      script: !interactive,
      prompts: text.prompts,
      replies: text.replies,
      ...(text.cut ? { cut: true } : {}),
    }
    if (text.first) s.title = titleFromText(text.first)
    if (cwd) s.cwd = cwd
    if (branch) s.branch = branch
    if (model) s.model = model
    if (startedAt) s.startedAt = startedAt
    if (updatedAt) s.updatedAt = updatedAt
    return s
  },

  async *messages(path) {
    for await (const line of fileLines(path)) {
      if (!line.includes('"type":"response_item"') || SKIPPED.test(line)) continue
      const rec = parseRecord(line)
      const p = (rec?.payload ?? {}) as Item
      const at = isoTime(rec?.timestamp)
      const when = at ? { at } : {}
      if (p.type === 'message' && p.role === 'user') {
        const text = typedText(blockText(p.content, ['input_text']))
        if (text) yield { role: 'user', text, ...when } satisfies HistoryMessage
      } else if (p.type === 'message' && p.role === 'assistant' && isReply(p)) {
        const text = blockText(p.content, ['output_text']).trim()
        if (text) yield { role: 'assistant', text, ...when }
      } else if (
        p.type === 'function_call' ||
        p.type === 'custom_tool_call' ||
        p.type === 'local_shell_call'
      ) {
        const tool = str(p.name) ?? 'shell'
        yield { role: 'tool', text: tool, tool, ...when }
      }
    }
  },

  async *toolText(path) {
    for await (const line of fileLines(path)) {
      if (!line.includes('"type":"response_item"')) continue
      const p = (parseRecord(line)?.payload ?? {}) as Record<string, unknown>
      if (p.type === 'function_call') yield jsonText(p.arguments)
      else if (p.type === 'custom_tool_call') yield jsonText(p.input)
      else if (p.type === 'local_shell_call') yield jsonText(p.action)
      else if (/^(function_call|custom_tool_call|local_shell_call)_output$/.test(String(p.type)))
        yield jsonText(p.output)
    }
  },

  async titles(account) {
    const out = new Map<string, string>()
    try {
      for await (const line of fileLines(join(account.dir, 'session_index.jsonl'))) {
        const rec = parseRecord(line)
        const id = str(rec?.id)
        const name = str(rec?.thread_name)?.trim()
        if (id && name) out.set(id, titleFromText(name))
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return out
  },
}
