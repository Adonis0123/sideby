// A Brief from a Claude Code session file (`projects/<dir>/<id>.jsonl`), for when the session could not write one.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../../types.ts'
import { DigestBuilder, formatDigest } from '../shared/brief.ts'

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Block = {
  type?: unknown
  text?: unknown
  name?: unknown
  input?: { file_path?: unknown; notebook_path?: unknown }
}

async function findSession(dir: string, id: string): Promise<string | undefined> {
  try {
    for (const d of await readdir(join(dir, 'projects'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = join(dir, 'projects', d.name, `${id}.jsonl`)
      try {
        await stat(p)
        return p
      } catch {
        // not in this project
      }
    }
  } catch {
    // no projects yet
  }
  return undefined
}

export async function claudeBrief(
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
    let o: { type?: unknown; isMeta?: unknown; message?: { content?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta === true) continue
    const content = o.message?.content
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    for (const blk of blocks) {
      if (blk.type === 'text' && typeof blk.text === 'string') {
        if (o.type === 'user') b.user(blk.text)
        else b.assistant(blk.text)
      } else if (blk.type === 'tool_use' && typeof blk.name === 'string' && EDITS.has(blk.name))
        b.file(blk.input?.file_path ?? blk.input?.notebook_path)
    }
  }
  const d = b.result()
  return d ? formatDigest(d) : undefined
}
