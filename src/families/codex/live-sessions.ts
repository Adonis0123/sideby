// Codex's Live Sessions (spec §3.32): a running `codex` belongs to the Account its `CODEX_HOME` names (the Main
// Account when it has none), and its session is the `rollout-*.jsonl` it holds open. When no open rollout is seen,
// the Account's newest rollout is taken and marked `guessed`. The title is Codex's own `thread_name` from
// `session_index.jsonl` (tried with Codex 0.163.0 on 2026-10-20).
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  accountProcesses,
  headerField,
  isInside,
  isoOf,
  mapLimit,
  readHead,
} from '../../core/live-sessions-procs.ts'
import type { Account } from '../../types.ts'
import type { LiveSessionReader, RawLiveSession } from '../live-sessions.ts'

const ROLLOUT_ID = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
/** Codex subcommands that serve other programs rather than run a session. */
const SERVERS = new Set(['app-server', 'exec-server', 'mcp-server', 'mcp', 'login', 'logout', 'proto'])
const INDEX_MAX = 8 * 1024 * 1024
/** Codex options that take a value as the next word (Codex 0.163.0 `--help`). */
const VALUED = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
])

/**
 * The subcommand of a `codex` process (`exec`, `app-server`), or undefined for a plain session or when it cannot
 * be told. `argv` are the arguments after the program; `exact` says they come word by word from the system. From the
 * flattened `ps` line a word could be the start of a quoted prompt (`codex "mcp integration needs fixing"`), so a
 * server word counts there only when nothing but options follows it.
 */
export function codexSubcommand(argv: readonly string[], exact: boolean): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') return undefined
    if (a.startsWith('-')) {
      if (VALUED.has(a)) i++
      continue
    }
    // The first word that is not an option: a subcommand, or the prompt of a plain session.
    if (exact || !SERVERS.has(a)) return a
    const after = argv[i + 1]
    return after === undefined || after.startsWith('-') ? a : undefined
  }
  return undefined
}

const samePath = (a: string, b: string) => resolve(a) === resolve(b)

/** Whether a running `codex` with this `CODEX_HOME` belongs to the Account. */
export const codexHomeIs = (account: Account, codexHome: string | undefined): boolean =>
  codexHome ? samePath(codexHome, account.dir) : account.isMain

async function titles(dir: string, problems: string[], ref: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const file = join(dir, 'session_index.jsonl')
  try {
    if ((await stat(file)).size > INDEX_MAX) return out
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
        if (typeof e.id === 'string' && typeof e.thread_name === 'string' && e.thread_name)
          out.set(e.id, e.thread_name)
      } catch {
        // a line cut off while Codex writes it
      }
    }
  } catch (err) {
    // No index yet is fine; anything else only costs the titles.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      problems.push(
        `${ref}: could not read ${file} (${(err as NodeJS.ErrnoException).code}), so its sessions show their directory names; check that the file is readable`,
      )
  }
  return out
}

async function fromRollout(
  path: string,
  extra: { pid?: number; guessed: boolean },
  names: Map<string, string>,
  problems: string[],
  ref: string,
): Promise<RawLiveSession | null> {
  const idFromName = ROLLOUT_ID.exec(basename(path))?.[1]
  let head = ''
  try {
    head = await readHead(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      problems.push(
        `${ref}: could not read ${path} (${(err as NodeJS.ErrnoException).code}); check that the file is readable`,
      )
    return null
  }
  const sessionId = headerField(head, 'id') ?? idFromName
  if (!sessionId) return null
  const cwd = headerField(head, 'cwd')
  const started = headerField(head, 'timestamp')
  let mtime: number | undefined
  try {
    mtime = (await stat(path)).mtimeMs
  } catch {
    // removed meanwhile
  }
  const title = names.get(sessionId) ?? (cwd ? basename(cwd) : undefined)
  return {
    sessionId,
    ...(title ? { title } : {}),
    status: 'unknown',
    ...(cwd ? { cwd } : {}),
    ...(extra.pid !== undefined ? { pid: extra.pid } : {}),
    ...(started ? { startedAt: started } : {}),
    ...(isoOf(mtime) ? { updatedAt: isoOf(mtime) } : {}),
    guessed: extra.guessed,
    transcript: path,
  }
}

/**
 * The newest rollout under `root`. A folder that cannot be read throws (the Account's sessions cannot be known); a
 * file that cannot be looked at is named in `problems`; one removed meanwhile is skipped.
 */
async function newestRollout(
  root: string,
  problems: string[],
  ref: string,
): Promise<{ path: string; mtimeMs: number } | undefined> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let best: { path: string; mtimeMs: number } | undefined
  for (const e of entries) {
    if (!e.isFile() || !ROLLOUT_ID.test(e.name)) continue
    const path = join(e.parentPath, e.name)
    try {
      const { mtimeMs } = await stat(path)
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        problems.push(
          `${ref}: could not read ${path} (${(err as NodeJS.ErrnoException).code}); check that the file is readable`,
        )
    }
  }
  return best
}

export const codexLiveSessions: LiveSessionReader = {
  family: 'codex',
  async read(account, procs, problems) {
    const mine = await accountProcesses(
      procs,
      {
        bin: 'codex',
        envName: 'CODEX_HOME',
        belongs: (home) => codexHomeIs(account, home),
        skip: (argv, exact) => SERVERS.has(codexSubcommand(argv, exact) ?? ''),
      },
      problems,
    )
    if (!mine.length) return []
    const root = join(account.dir, 'sessions')
    // Only a missing directory means "no sessions yet"; another error is the Account's to report.
    try {
      await readdir(root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const names = await titles(account.dir, problems, account.ref)
    const seen = new Set<string>()
    const out: RawLiveSession[] = []
    // `lsof` takes a moment per process: ask a few at once.
    const open = await mapLimit(mine, 4, async (pid) => ({ pid, files: await procs.openFiles(pid) }))
    for (const { pid, files } of open) {
      for (const f of files) {
        if (!isInside(root, f) || !ROLLOUT_ID.test(basename(f))) continue
        const s = await fromRollout(f, { pid, guessed: false }, names, problems, account.ref)
        if (s && !seen.has(s.sessionId)) {
          seen.add(s.sessionId)
          out.push(s)
        }
      }
    }
    if (out.length) return out
    // Codex may write its rollout without keeping it open: the newest one is a guess.
    const newest = await newestRollout(root, problems, account.ref)
    const guess = newest && (await fromRollout(newest.path, { guessed: true }, names, problems, account.ref))
    return guess ? [guess] : []
  },
}
