// Reading which session a Host command resumes, and whether an Account holds it (ADR-0007).
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isSessionId = (s: string | undefined): s is string => s !== undefined && SESSION_ID.test(s)

/** Arguments before the first `--`, the ones the Host reads as its own options. */
const options = (args: readonly string[]) => {
  const end = args.indexOf('--')
  return end === -1 ? args : args.slice(0, end)
}

/** The id after `--resume <id>`, `--resume=<id>` or `-r <id>`; Claude Code and Grok Build share this form. */
export function resumeFlagSession(args: readonly string[]): string | undefined {
  const opts = options(args)
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!
    const id = a.startsWith('--resume=')
      ? a.slice('--resume='.length)
      : a === '--resume' || a === '-r'
        ? opts[i + 1]
        : undefined
    if (isSessionId(id)) return id
  }
  return undefined
}

/** The first UUID after the `resume` subcommand (`codex resume [options] <id>`). */
export function resumeSubcommandSession(args: readonly string[]): string | undefined {
  const opts = options(args)
  const at = opts.indexOf('resume')
  return at === -1 ? undefined : opts.slice(at + 1).find(isSessionId)
}

/** Modification time in ms of the first of `paths` that exists with the wanted type. */
async function firstWrittenAt(paths: readonly string[], type: 'file' | 'dir'): Promise<number | undefined> {
  for (const p of paths) {
    try {
      const st = await stat(p)
      if (type === 'file' ? st.isFile() : st.isDirectory()) return st.mtimeMs
    } catch {
      // not here
    }
  }
  return undefined
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** `<dir>/*` + `/<entry>`: one level of grouping directories (Claude projects, Grok working directories). */
export async function groupedEntryWrittenAt(
  dir: string,
  entry: string,
  type: 'file' | 'dir',
): Promise<number | undefined> {
  return firstWrittenAt(
    (await subdirs(dir)).map((d) => join(d, entry)),
    type,
  )
}

/** A file anywhere under `dir` whose name ends with `suffix` (Codex `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`). */
export async function nestedFileWrittenAt(dir: string, suffix: string): Promise<number | undefined> {
  let names: string[]
  try {
    names = await readdir(dir, { recursive: true })
  } catch {
    return undefined
  }
  return firstWrittenAt(
    names.filter((n) => n.endsWith(suffix)).map((n) => join(dir, n)),
    'file',
  )
}
