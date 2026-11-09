// When Claude Code last said an Account's login expired, and when it last showed it working (ADR-0071), from the
// tail of its newest main session transcripts (`<dir>/projects/<project>/<session>.jsonl`). Claude Code writes an
// expired login as an assistant record with `isApiErrorMessage: true`, `error: "authentication_failed"` and a text
// such as "Login reached its time limit · Please run /login" (Claude Code 2.1.319, 2026-11-08). Only the two times
// are kept: never the transcript text, a token, the Keychain or `.credentials.json`.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FileMemo } from '../../core/file-memo.ts'
import type { Account, LoginEvents } from '../../types.ts'
import { tailLinesWith } from './session-files.ts'

/** How many of the newest main transcripts are read. */
export const LOGIN_SCAN_SESSIONS = 20

/**
 * Phrases Claude Code is known to use for an expired login, compared in lower case with every run of spaces and
 * punctuation as one space. A `/login` hint or "Invalid API key" alone is not one: that is a different problem.
 */
export const EXPIRY_PHRASES = ['login reached its time limit'] as const

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Whether a Host message says the login expired, by the phrases above. */
export function saysLoginExpired(text: string): boolean {
  const t = ` ${plain(text)} `
  return EXPIRY_PHRASES.some((p) => t.includes(` ${p} `))
}

interface Times {
  expiredAt?: number
  workingAt?: number
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => ((b as { type?: unknown })?.type === 'text' ? (b as { text?: unknown }).text : ''))
    .filter((t): t is string => typeof t === 'string')
    .join('\n')
}

/** The newest expiry record and the newest normal assistant turn in the tail of one transcript. */
export async function transcriptLoginTimes(file: string): Promise<Times> {
  const out: Times = {}
  for (const line of await tailLinesWith(file, '"assistant"')) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row?.type !== 'assistant') continue
    // A sub-agent's turn (`isSidechain`) says nothing about the main sign-in, as in history.ts.
    if (row.isSidechain === true) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isFinite(at)) continue
    const message = row.message as { model?: unknown } | null | undefined
    if (row.isApiErrorMessage === true) {
      if (row.error === 'authentication_failed' && saysLoginExpired(textOf(message)))
        out.expiredAt = Math.max(out.expiredAt ?? at, at)
      continue
    }
    // Claude Code's own notices (interrupted, no response) carry the model `<synthetic>`: no model answered them.
    if (message?.model === '<synthetic>' || row.error !== undefined) continue
    out.workingAt = Math.max(out.workingAt ?? at, at)
  }
  return out
}

type Listed = { file: string; st: import('node:fs').Stats }

/**
 * Each Account's last full listing: every main transcript with its modification time, and each project folder's own
 * modification time when it was listed. A new or removed transcript changes its folder's time, so the listing is
 * redone then; otherwise it is redone at most every `LISTING_MS`, and only the newest `LOGIN_SCAN_SESSIONS` are stat-ed
 * again. A transcript outside them that grows (an old session resumed) is seen at the next full listing.
 */
const listings = new Map<
  string,
  { folders: Map<string, number>; files: { file: string; mtimeMs: number }[]; at: number }
>()
export const LISTING_MS = 60_000

async function projectFolders(projects: string): Promise<Map<string, number> | null> {
  let names: import('node:fs').Dirent[]
  try {
    names = await readdir(projects, { withFileTypes: true })
  } catch {
    return null
  }
  const out = new Map<string, number>()
  for (const p of names) {
    if (!p.isDirectory()) continue
    const st = await stat(join(projects, p.name)).catch(() => null)
    if (st) out.set(join(projects, p.name), st.mtimeMs)
  }
  return out
}

const sameFolders = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

async function statAll(files: readonly string[]): Promise<Listed[]> {
  const out: Listed[] = []
  for (const file of files) {
    const st = await stat(file).catch(() => null)
    if (st?.isFile()) out.push({ file, st })
  }
  return out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
}

/** The main transcripts of an Account, newest first, at most `LOGIN_SCAN_SESSIONS`. Subagent transcripts are left out. */
async function newestTranscripts(dir: string, now = Date.now()): Promise<Listed[]> {
  const projects = join(dir, 'projects')
  const folders = await projectFolders(projects)
  if (!folders) {
    listings.delete(dir)
    return []
  }
  const kept = listings.get(dir)
  if (kept && now - kept.at < LISTING_MS && now >= kept.at && sameFolders(kept.folders, folders)) {
    const top = await statAll(kept.files.slice(0, LOGIN_SCAN_SESSIONS).map((f) => f.file))
    return top.slice(0, LOGIN_SCAN_SESSIONS)
  }
  const files: string[] = []
  for (const folder of folders.keys()) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(folder, e.name))
  }
  const all = await statAll(files)
  listings.set(dir, { folders, files: all.map((f) => ({ file: f.file, mtimeMs: f.st.mtimeMs })), at: now })
  return all.slice(0, LOGIN_SCAN_SESSIONS)
}

/** Forgets every kept listing (for tests). */
export function clearLoginListings(): void {
  listings.clear()
}

export const claudeLoginMemo = new FileMemo<Times>({ name: 'claude-login', version: 1 })

const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString())

/** `FamilyDef.readLoginEvents` for Claude Code. An API Account is never checked. */
export async function readClaudeLoginEvents(account: Account): Promise<LoginEvents> {
  if (account.kind === 'api') return {}
  const pass = claudeLoginMemo.pass(account.dir)
  let expiredAt: number | undefined
  let workingAt: number | undefined
  try {
    for (const { file, st } of await newestTranscripts(account.dir)) {
      const t = await pass.get(file, st, () => transcriptLoginTimes(file))
      if (t.expiredAt !== undefined) expiredAt = Math.max(expiredAt ?? t.expiredAt, t.expiredAt)
      if (t.workingAt !== undefined) workingAt = Math.max(workingAt ?? t.workingAt, t.workingAt)
    }
  } finally {
    pass.done()
  }
  const e = iso(expiredAt)
  const w = iso(workingAt)
  return { ...(e ? { expiredAt: e } : {}), ...(w ? { workingAt: w } : {}) }
}
