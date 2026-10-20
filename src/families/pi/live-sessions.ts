// pi's Live Sessions (spec §3.32): a running `pi` belongs to the Account its `PI_CODING_AGENT_DIR` names (the Main
// Account when it has none). pi does not say which session a process runs, so the Account's newest session file
// (`sessions/<cwd>/<time>_<id>.jsonl`, its first line a `session` header) is taken and marked `guessed`.
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { accountProcesses, headerField, isoOf, readHead } from '../../core/live-sessions-procs.ts'
import type { Account } from '../../types.ts'
import type { LiveSessionReader } from '../live-sessions.ts'

const piDirIs = (account: Account, dir: string | undefined): boolean =>
  dir ? resolve(dir) === resolve(account.dir) : account.isMain

async function newestSession(
  dir: string,
  problems: string[],
  ref: string,
): Promise<{ path: string; mtimeMs: number } | undefined> {
  let entries: Dirent[]
  try {
    entries = await readdir(join(dir, 'sessions'), { recursive: true, withFileTypes: true })
  } catch (err) {
    // Only a missing directory means "no sessions yet"; another error is the Account's to report.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let best: { path: string; mtimeMs: number } | undefined
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
    const path = join(e.parentPath, e.name)
    try {
      const { mtimeMs } = await stat(path)
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
    } catch (err) {
      // Removed while scanning is fine; anything else is said.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        problems.push(
          `${ref}: could not read ${path} (${(err as NodeJS.ErrnoException).code}); check that the file is readable`,
        )
    }
  }
  return best
}

export const piLiveSessions: LiveSessionReader = {
  family: 'pi',
  async read(account, procs, problems) {
    const mine = await accountProcesses(
      procs,
      { bin: 'pi', envName: 'PI_CODING_AGENT_DIR', belongs: (dir) => piDirIs(account, dir) },
      problems,
    )
    if (!mine.length) return []
    const newest = await newestSession(account.dir, problems, account.ref)
    if (!newest) return []
    let head: string
    try {
      head = await readHead(newest.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      problems.push(
        `${account.ref}: could not read ${newest.path} (${(err as NodeJS.ErrnoException).code}); check that the file is readable`,
      )
      return []
    }
    const sessionId = headerField(head, 'id')
    if (!sessionId) return []
    const cwd = headerField(head, 'cwd')
    const started = headerField(head, 'timestamp')
    return [
      {
        sessionId,
        ...(cwd ? { title: basename(cwd), cwd } : {}),
        status: 'unknown',
        ...(started ? { startedAt: started } : {}),
        ...(isoOf(newest.mtimeMs) ? { updatedAt: isoOf(newest.mtimeMs) } : {}),
        guessed: true,
        transcript: newest.path,
      },
    ]
  },
}
