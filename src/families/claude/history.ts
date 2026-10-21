// Claude Code's Session History (spec §3.33): one `projects/<encoded cwd>/<id>.jsonl` per Session, written by Claude
// Code itself (tried with Claude Code 2.1.304 on 2026-10-20), and `<id>/subagents/agent-*.jsonl` for the subagents
// that Session started. The folder name is only an encoding of the working directory and may be cut, so the
// directory is taken from the records' `cwd`, never decoded from the name.
import { basename, dirname, join } from 'node:path'
import type { HistoryFile, HistoryMessage, HistoryReader, ParsedSession, TitleSource } from '../history.ts'
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

const SESSION_FILE = /^(.+)\.jsonl$/
const SUBAGENT_FILE = /^agent-.+\.jsonl$/

// Record types that carry something Session History reads; every other line is skipped before it is parsed.
const WANTED = /"type":"(user|assistant|ai-title|custom-title|summary)"/
// A tool's result comes back as a `user` record with this key; it is never read, so its (often huge) line is not
// parsed. Inside a message's text the key would be escaped and does not match.
const TOOL_RESULT = '"toolUseResult"'

/** The text a person typed in a `user` record, or '' for tool results, meta and injected turns. */
function userText(rec: Record<string, unknown>): string {
  if (rec.isMeta === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true)
    return ''
  const msg = rec.message as { content?: unknown } | undefined
  return typedText(blockText(msg?.content))
}

function assistantText(rec: Record<string, unknown>): string {
  const msg = rec.message as { content?: unknown } | undefined
  return blockText(msg?.content).trim()
}

function toolNames(rec: Record<string, unknown>): string[] {
  const content = (rec.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use')
    .map((b) => str((b as { name?: unknown }).name) ?? 'tool')
}

export const claudeHistory: HistoryReader = {
  family: 'claude',

  async list(account) {
    const out: HistoryFile[] = []
    const projects = join(account.dir, 'projects')
    for (const p of await dirEntries(projects)) {
      if (!p.isDirectory()) continue
      const dir = join(projects, p.name)
      for (const e of await dirEntries(dir)) {
        if (e.isFile() && SESSION_FILE.test(e.name)) {
          const f = await historyFile(join(dir, e.name))
          if (f) out.push(f)
        } else if (e.isDirectory()) {
          const sub = join(dir, e.name, 'subagents')
          for (const s of await dirEntries(sub)) {
            if (!s.isFile() || !SUBAGENT_FILE.test(s.name)) continue
            const f = await historyFile(join(sub, s.name), { parent: e.name })
            if (f) out.push(f)
          }
        }
      }
    }
    return out
  },

  async parse(file) {
    const sub = Boolean(file.parent)
    let sessionId = sub ? basename(file.path, '.jsonl') : SESSION_FILE.exec(basename(file.path))?.[1]
    let cwd: string | undefined
    let branch: string | undefined
    let model: string | undefined
    let entrypoint: string | undefined
    let startedAt: string | undefined
    let updatedAt: string | undefined
    let custom: string | undefined
    let aiTitle: string | undefined
    let summary: string | undefined
    const text = new SessionText()
    for await (const line of fileLines(file.path)) {
      if (!WANTED.test(line) || line.includes(TOOL_RESULT)) continue
      const rec = parseRecord(line)
      if (!rec) continue
      const type = rec.type
      if (type === 'custom-title') custom = str(rec.customTitle) ?? custom
      else if (type === 'ai-title') aiTitle = str(rec.aiTitle) ?? aiTitle
      else if (type === 'summary') summary = str(rec.summary) ?? summary
      if (type !== 'user' && type !== 'assistant') continue
      // A subagent's own file is all sidechain; in the main file a sidechain line belongs to a subagent.
      if (!sub && rec.isSidechain === true) continue
      if (!sub && !sessionId) sessionId = str(rec.sessionId)
      cwd ??= str(rec.cwd)
      entrypoint ??= str(rec.entrypoint)
      branch = str(rec.gitBranch) ?? branch
      const at = isoTime(rec.timestamp)
      if (at) {
        startedAt ??= at
        updatedAt = at
      }
      if (type === 'user') {
        const t = userText(rec)
        if (t) text.prompt(t)
      } else {
        const m = str((rec.message as { model?: unknown } | undefined)?.model)
        if (m && m !== '<synthetic>') model = m
        const t = assistantText(rec)
        if (t) text.reply(t)
      }
    }
    if (!sessionId || !text.count) return undefined
    const [title, titleFrom]: [string | undefined, TitleSource] = custom
      ? [titleFromText(custom), 'user']
      : aiTitle
        ? [titleFromText(aiTitle), 'host']
        : summary
          ? [titleFromText(summary), 'host']
          : text.first
            ? [titleFromText(text.first), 'prompt']
            : [undefined, 'none']
    const s: ParsedSession = {
      sessionId,
      titleFrom,
      messages: text.count,
      script: sub || /^sdk/i.test(entrypoint ?? ''),
      prompts: text.prompts,
      replies: text.replies,
      ...(text.cut ? { cut: true } : {}),
    }
    if (title) s.title = title
    if (cwd) s.cwd = cwd
    if (branch && branch !== 'HEAD') s.branch = branch
    if (model) s.model = model
    if (startedAt) s.startedAt = startedAt
    if (updatedAt) s.updatedAt = updatedAt
    if (file.parent) s.parent = file.parent
    return s
  },

  async *messages(path) {
    // As in parse(): a subagent's own file is all sidechain, and in the main file a sidechain line is a subagent's.
    const sub = basename(dirname(path)) === 'subagents'
    for await (const line of fileLines(path)) {
      if (!/"type":"(user|assistant)"/.test(line) || line.includes(TOOL_RESULT)) continue
      const rec = parseRecord(line)
      if (!rec || (!sub && rec.isSidechain === true)) continue
      const at = isoTime(rec.timestamp)
      if (rec.type === 'user') {
        const text = userText(rec)
        if (text) yield { role: 'user', text, ...(at ? { at } : {}) } satisfies HistoryMessage
      } else if (rec.type === 'assistant') {
        const text = assistantText(rec)
        if (text) yield { role: 'assistant', text, ...(at ? { at } : {}) }
        for (const tool of toolNames(rec)) yield { role: 'tool', text: tool, tool, ...(at ? { at } : {}) }
      }
    }
  },

  async *toolText(path) {
    for await (const line of fileLines(path)) {
      if (!/"type":"(user|assistant)"/.test(line)) continue
      const content = (parseRecord(line)?.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) continue
      for (const b of content as { type?: unknown; input?: unknown; content?: unknown }[]) {
        if (b?.type === 'tool_use') yield jsonText(b.input)
        else if (b?.type === 'tool_result') yield jsonText(b.content)
      }
    }
  },
}
