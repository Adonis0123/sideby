// A Brief from a Grok Build session (`sessions/<encoded cwd>/<id>/chat_history.jsonl`), for when the session hit its
// limit before writing one. Grok's hook input carries the session id but no transcript path.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../../types.ts'
import { DigestBuilder, formatDigest } from '../shared/brief.ts'

const EDIT_TOOL = /edit|write|replace|patch/i

async function findSession(dir: string, id: string): Promise<string | undefined> {
  try {
    for (const d of await readdir(join(dir, 'sessions'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = join(dir, 'sessions', d.name, id, 'chat_history.jsonl')
      try {
        await stat(p)
        return p
      } catch {
        // not under this directory
      }
    }
  } catch {
    // no sessions yet
  }
  return undefined
}

export async function grokBrief(
  account: Account,
  session: { id?: string; transcriptPath?: string },
): Promise<string | undefined> {
  const file = session.transcriptPath ?? (session.id ? await findSession(account.dir, session.id) : undefined)
  if (!file) return undefined
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const b = new DigestBuilder()
  for (const line of text.split('\n')) {
    let o: { type?: unknown; content?: unknown; tool_calls?: unknown }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'user' && Array.isArray(o.content)) {
      for (const c of o.content as { type?: unknown; text?: unknown }[])
        if (c?.type === 'text' && typeof c.text === 'string') b.user(c.text)
    } else if (o.type === 'assistant') {
      if (typeof o.content === 'string') b.assistant(o.content)
      for (const call of Array.isArray(o.tool_calls)
        ? (o.tool_calls as { name?: unknown; arguments?: unknown }[])
        : []) {
        if (
          typeof call?.name !== 'string' ||
          !EDIT_TOOL.test(call.name) ||
          typeof call.arguments !== 'string'
        )
          continue
        try {
          const args = JSON.parse(call.arguments) as Record<string, unknown>
          b.file(args.path ?? args.file_path ?? args.target_file)
        } catch {
          // arguments not JSON
        }
      }
    }
  }
  const d = b.result()
  return d ? formatDigest(d) : undefined
}
