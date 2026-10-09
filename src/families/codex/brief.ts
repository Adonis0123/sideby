// A Brief from a Codex rollout (`sessions/**/rollout-*.jsonl`), for when the session could not write one, for
// example under a read-only sandbox. Codex's hook input carries the rollout path.
import { readFile } from 'node:fs/promises'
import type { Account } from '../../types.ts'
import { DigestBuilder, formatDigest } from '../shared/brief.ts'

/** Context Codex injects as user messages (AGENTS.md, environment), not something the user asked. */
const INJECTED = /^\s*(<|# AGENTS\.md)/
const PATCH_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/gm

export async function codexBrief(
  _account: Account,
  session: { id?: string; transcriptPath?: string },
): Promise<string | undefined> {
  const file = session.transcriptPath
  if (!file) return undefined
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const b = new DigestBuilder()
  for (const line of text.split('\n')) {
    if (!line.includes('"response_item"')) continue
    let o: {
      type?: unknown
      payload?: { type?: unknown; role?: unknown; content?: unknown; name?: unknown; input?: unknown }
    }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const p = o.payload
    if (o.type !== 'response_item' || !p) continue
    if (p.type === 'message' && Array.isArray(p.content)) {
      for (const c of p.content as { type?: unknown; text?: unknown }[]) {
        if (typeof c?.text !== 'string') continue
        if (p.role === 'user' && c.type === 'input_text' && !INJECTED.test(c.text)) b.user(c.text)
        else if (p.role === 'assistant' && c.type === 'output_text') b.assistant(c.text)
      }
    } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string')
      for (const m of p.input.matchAll(PATCH_FILE)) b.file(m[1]!.trim())
  }
  const d = b.result()
  return d ? formatDigest(d) : undefined
}
