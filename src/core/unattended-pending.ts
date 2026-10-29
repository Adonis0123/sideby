// Pending Decisions (spec §3.37, ADR-0057): questions the model was not allowed to ask, permission requests nobody was
// there to answer, and actions it left undone, while Unattended Mode was on. One file each under `<state>/unattended/pending/` (folder 700, files 600), so writes
// from several sessions never meet. Kept until the user marks one done, deleted 30 days after that. A leaf module
// (Node built-ins and core/fs-safe.ts only): `unattended-hook` writes here.
//
// Both folders must be real folders of the user that nobody else can write to (`ownedFolder`); when one is not, nothing
// is read from or written there. Files are read without following a link.
import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, readSmallFile, writeFileAtomic } from './fs-safe.ts'

export interface PendingDecision {
  id: string
  /** When it was kept (ISO). */
  at: string
  /**
   * question: a question the Host's ask tool was not allowed to show; permission: a permission request Claude Code
   * would have shown, refused; deferred: `sideby unattended defer`.
   */
  kind: PendingKind
  family: string
  /** The Account the session ran as (`SIDEBY_ACCOUNT`). */
  account?: string
  sessionId?: string
  cwd?: string
  /** The subagent that made the request, when a subagent did (Claude's `agent_id` and `agent_type`). */
  agentId?: string
  agentType?: string
  /** The question and its options, the tool and what it was to do, or the deferred text; at most 4000 characters. */
  text: string
  /** When the user marked it done (ISO). */
  doneAt?: string
}

export type PendingKind = 'question' | 'permission' | 'deferred'
export const PENDING_KINDS: readonly PendingKind[] = ['question', 'permission', 'deferred']

export type PendingInput = Omit<PendingDecision, 'id' | 'at' | 'doneAt'>

export const PENDING_TEXT_MAX = 4000
const KEEP_DONE_MS = 30 * 24 * 60 * 60 * 1000
const ID = /^[a-z0-9]{6,16}-[0-9a-f]{6}$/
const FIELD = /^[\x20-\x7e]{1,256}$/

export const pendingDir = (stateDir: string): string => join(stateDir, 'unattended', 'pending')

const PARTS = ['unattended', 'pending'] as const

/** The pending folder, made (mode 700) when missing; throws `UnsafeFolderError` when a level is not safe to use. */
async function ensureDir(stateDir: string): Promise<string> {
  return (await ownedFolder(stateDir, PARTS, { create: true, private: true }))!
}

/** The pending folder when it exists and is safe to read; null otherwise. */
async function existingDir(stateDir: string): Promise<string | null> {
  return ownedFolder(stateDir, PARTS, { create: false }).catch(() => null)
}

/** At most `PENDING_TEXT_MAX` characters (whole characters, never half of one), ending in `…` when cut. */
export function clipPendingText(text: string): string {
  const chars = [...text.trim()]
  return chars.length <= PENDING_TEXT_MAX
    ? chars.join('')
    : `${chars.slice(0, PENDING_TEXT_MAX - 1).join('')}…`
}

function parse(value: unknown): PendingDecision | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !ID.test(v.id)) return undefined
  if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return undefined
  if (!PENDING_KINDS.includes(v.kind as PendingKind)) return undefined
  if (typeof v.family !== 'string' || !FIELD.test(v.family) || typeof v.text !== 'string') return undefined
  const opt = (k: 'account' | 'sessionId' | 'cwd' | 'agentId' | 'agentType') =>
    typeof v[k] === 'string' && v[k] ? { [k]: (v[k] as string).slice(0, 4096) } : {}
  const done =
    typeof v.doneAt === 'string' && Number.isFinite(Date.parse(v.doneAt)) ? { doneAt: v.doneAt } : {}
  return {
    id: v.id,
    at: v.at,
    kind: v.kind as PendingKind,
    family: v.family,
    ...opt('account'),
    ...opt('sessionId'),
    ...opt('cwd'),
    ...opt('agentId'),
    ...opt('agentType'),
    text: clipPendingText(v.text),
    ...done,
  }
}

async function readOne(file: string): Promise<PendingDecision | undefined> {
  const text = await readSmallFile(file, 64 * 1024)
  if (text === undefined) return undefined
  try {
    return parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

async function readAll(stateDir: string): Promise<PendingDecision[]> {
  const dir = await existingDir(stateDir)
  if (!dir) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))
  const read = await Promise.all(
    ids.filter((id) => ID.test(id)).map((id) => readOne(join(dir, `${id}.json`))),
  )
  return read
    .filter((d): d is PendingDecision => d !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}

const fileOf = (stateDir: string, id: string) => join(pendingDir(stateDir), `${id}.json`)

/**
 * Keeps one Pending Decision and returns it. With `dedupe`, an open one of the same kind, session and text is
 * returned instead of a second copy (a model that asks the same question twice leaves one).
 */
export async function addPendingDecision(
  stateDir: string,
  input: PendingInput,
  at: Date = new Date(),
  opts: { dedupe?: boolean } = {},
): Promise<PendingDecision> {
  const text = clipPendingText(input.text)
  if (opts.dedupe) {
    const same = (await readAll(stateDir)).find(
      (d) => !d.doneAt && d.kind === input.kind && d.sessionId === input.sessionId && d.text === text,
    )
    if (same) return same
  }
  const dir = await ensureDir(stateDir)
  const decision: PendingDecision = {
    id: `${at.getTime().toString(36)}-${randomBytes(3).toString('hex')}`,
    at: at.toISOString(),
    kind: input.kind,
    family: input.family,
    ...(input.account ? { account: input.account } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentType ? { agentType: input.agentType } : {}),
    text,
  }
  await writeFileAtomic(join(dir, `${decision.id}.json`), `${JSON.stringify(decision)}\n`, 0o600)
  return decision
}

/**
 * The Pending Decisions, oldest first: open ones, or with `all` the done ones too. Deletes the files of those done
 * more than 30 days ago.
 */
export async function listPendingDecisions(
  stateDir: string,
  /** `prune: false` only reads (a read-only Panel): old done ones are left out but not deleted. */
  opts: { all?: boolean; now?: Date; prune?: boolean } = {},
): Promise<PendingDecision[]> {
  const now = (opts.now ?? new Date()).getTime()
  const out: PendingDecision[] = []
  for (const d of await readAll(stateDir)) {
    if (d.doneAt && now - Date.parse(d.doneAt) > KEEP_DONE_MS) {
      if (opts.prune !== false) await rm(fileOf(stateDir, d.id), { force: true }).catch(() => {})
      continue
    }
    if (opts.all || !d.doneAt) out.push(d)
  }
  return out
}

/** Opens a Pending Decision marked done again (the Panel's Undo after "Done"); throws when there is no such id. */
export async function reopenPendingDecision(stateDir: string, id: string): Promise<PendingDecision> {
  const d = (await readAll(stateDir)).find((x) => x.id === id)
  if (!d)
    throw new Error(`no Pending Decision has the id "${id}"; \`sideby unattended pending --all\` lists them`)
  if (!d.doneAt) return d
  const { doneAt: _, ...open } = d
  await ensureDir(stateDir)
  await writeFileAtomic(fileOf(stateDir, d.id), `${JSON.stringify(open)}\n`, 0o600)
  return open
}

/** The open Pending Decision an id names: the whole id, or a start of it that only one has. */
export async function findPendingDecision(
  stateDir: string,
  id: string,
): Promise<PendingDecision | undefined> {
  const all = await readAll(stateDir)
  const exact = all.find((d) => d.id === id)
  if (exact) return exact
  const starts = all.filter((d) => id.length >= 4 && d.id.startsWith(id))
  return starts.length === 1 ? starts[0] : undefined
}

/**
 * Marks Pending Decisions done: one by id (or a unique start of it), or every open one with `'all'`. Returns the ones
 * it marked; an id no Pending Decision has throws an Error whose message says how to list them.
 */
export async function markPendingDone(
  stateDir: string,
  id: string | 'all',
  at: Date = new Date(),
): Promise<PendingDecision[]> {
  const targets =
    id === 'all'
      ? (await readAll(stateDir)).filter((d) => !d.doneAt)
      : [await findPendingDecision(stateDir, id)].filter((d): d is PendingDecision => d !== undefined)
  if (id !== 'all' && !targets.length)
    throw new Error(`no Pending Decision has the id "${id}"; \`sideby unattended pending --all\` lists them`)
  if (targets.length) await ensureDir(stateDir)
  const out: PendingDecision[] = []
  for (const d of targets) {
    if (d.doneAt) {
      out.push(d)
      continue
    }
    const done = { ...d, doneAt: at.toISOString() }
    await writeFileAtomic(fileOf(stateDir, d.id), `${JSON.stringify(done)}\n`, 0o600)
    out.push(done)
  }
  return out
}
