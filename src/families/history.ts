// Session History readers (spec §3.33): the built-in Families' readers are internal (ADR-0042); a plugin Family gives
// its own through FamilyDef.history (ADR-0044), and what it returns is checked and cut to the built-in limits here.
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyDef, FamilyHistory, HistoryMessage, ParsedSession } from '../types.ts'
import { claudeHistory } from './claude/history.ts'
import { codexHistory } from './codex/history.ts'
import { grokHistory } from './grok/history.ts'
import { piHistory } from './pi/history.ts'
import { cutText, SESSION_TEXT_MAX, TITLE_MAX, titleFromText } from './shared/history-text.ts'

export type { HistoryFile, HistoryMessage, ParsedSession, TitleSource } from '../types.ts'

/**
 * A message as a reader gives it inside sideby: a user message may say who made it, when the Host records that
 * (Claude Code's `origin.kind`: `human`, `task-notification`, `peer`, …). Never shown, and not part of the plugin
 * contract (`HistoryMessage`).
 */
export interface ReadMessage extends HistoryMessage {
  origin?: string
}

/** A Session History reader: a built-in Family's, or a plugin Family's `history` with its Family id. */
export interface HistoryReader extends Omit<FamilyHistory, 'resumeArgs' | 'toolText' | 'messages'> {
  family: string
  messages(path: string): AsyncIterable<ReadMessage>
  /**
   * The text of the Session's tool calls (their input) and tool results, for searching tool output. Never the
   * record's other fields (ids, instructions, settings), so a search cannot match or show them.
   */
  toolText(path: string): AsyncIterable<string>
  /** Host arguments that resume a Session; built-in Families use `hostResumeArgs`. */
  resumeArgs?(sessionId: string): string[]
}

const READERS: ReadonlyMap<string, HistoryReader> = new Map(
  [claudeHistory, codexHistory, grokHistory, piHistory].map((r) => [r.family, r]),
)

const PLUGIN_READERS = new WeakMap<FamilyHistory, HistoryReader>()

async function* nothing(): AsyncGenerator<string> {}

const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * A plugin reader's Session as the built-in readers give one: the wrong shape is an error naming the Family, and its
 * text and title are cut to the same limits (a plugin cannot fill the History Index or the Panel without bound).
 */
export function checkParsed(family: string, p: ParsedSession | undefined): ParsedSession | undefined {
  if (p === undefined || p === null) return undefined
  const bad = (what: string) =>
    new Error(
      `family ${family}: history.parse returned ${what}; fix the plugin's reader or remove its history`,
    )
  if (typeof p !== 'object') throw bad('something that is not an object')
  if (typeof p.sessionId !== 'string' || !p.sessionId) throw bad('no sessionId')
  if (!strings(p.prompts) || !strings(p.replies)) throw bad('prompts or replies that are not lists of text')
  if (typeof p.messages !== 'number' || !Number.isFinite(p.messages))
    throw bad('a messages count that is not a number')
  let room = SESSION_TEXT_MAX
  let cut = Boolean(p.cut)
  const keep = (list: string[]) =>
    list.flatMap((t) => {
      if (room <= 0) {
        cut = true
        return []
      }
      const kept = cutText(t, room)
      if (kept.length < t.length) cut = true
      room -= kept.length
      return [kept]
    })
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const prompts = keep(p.prompts)
  const replies = keep(p.replies)
  return {
    ...p,
    cwd: text(p.cwd),
    gitRoot: text(p.gitRoot),
    title: text(p.title) && titleFromText(p.title!).slice(0, TITLE_MAX),
    branch: text(p.branch),
    model: text(p.model),
    startedAt: text(p.startedAt),
    updatedAt: text(p.updatedAt),
    parent: text(p.parent),
    script: Boolean(p.script),
    messages: Math.max(0, Math.floor(p.messages)),
    prompts,
    replies,
    ...(cut ? { cut: true } : {}),
  }
}

/** The Session History reader of a Family: a built-in one's, else the `history` a plugin Family declares. */
export function historyReader(
  familyId: string,
  families?: ReadonlyMap<string, FamilyDef>,
): HistoryReader | undefined {
  const builtin = READERS.get(familyId)
  if (builtin) return builtin
  const h = families?.get(familyId)?.history
  if (!h) return undefined
  let r = PLUGIN_READERS.get(h)
  if (!r) {
    r = {
      family: familyId,
      list: (account, problems) => h.list(account, problems),
      parse: async (file, account) => checkParsed(familyId, await h.parse(file, account)),
      messages: (path) => h.messages(path),
      toolText: (path) => (h.toolText ? h.toolText(path) : nothing()),
      resumeArgs: (id) => h.resumeArgs(id),
      ...(h.titles ? { titles: (account: Account) => h.titles!(account) } : {}),
    }
    PLUGIN_READERS.set(h, r)
  }
  return r
}

/**
 * One Account's Session records, listed once: `find` gives where Session `id`'s record is, or undefined. The id is
 * matched against the names listed and never put into a path.
 */
export interface SessionRecords {
  find(id: string): string | undefined
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Claude's `projects/<folder>/<id>.jsonl` (the first folder that has one). */
async function claudeRecords(account: Account): Promise<SessionRecords> {
  const root = join(account.dir, 'projects')
  const byId = new Map<string, string>()
  const folders = (await entries(root)).filter((e) => e.isDirectory())
  const listed = await Promise.all(folders.map((f) => entries(join(root, f.name))))
  folders.forEach((f, i) => {
    for (const e of listed[i]!) {
      const id = e.name.slice(0, -'.jsonl'.length)
      if (e.name.endsWith('.jsonl') && !e.isDirectory() && !byId.has(id))
        byId.set(id, join(root, f.name, e.name))
    }
  })
  return { find: (id) => byId.get(id) }
}

/** Codex's `sessions/<date folders>/rollout-…-<id>.jsonl`. */
async function codexRecords(account: Account): Promise<SessionRecords> {
  const root = join(account.dir, 'sessions')
  let names: string[] = []
  try {
    names = (await readdir(root, { recursive: true })).filter((n) => n.endsWith('.jsonl'))
  } catch {
    // no sessions yet
  }
  return {
    find: (id) => {
      const name = names.find((n) => n.endsWith(`-${id}.jsonl`))
      return name === undefined ? undefined : join(root, name)
    },
  }
}

/** Where each built-in Family keeps its Session records in an Account (the files `list` finds). */
const RECORD_LISTS: Readonly<Record<string, (account: Account) => Promise<SessionRecords>>> = {
  claude: claudeRecords,
  codex: codexRecords,
}

/** Whether sideby can find one Session's record by its id in a Family's Accounts (`sessionRecords`). */
export const findsSessionRecords = (familyId: string): boolean =>
  Object.hasOwn(RECORD_LISTS, familyId) && READERS.has(familyId)

/** The Session records of `account`, read-only; undefined when its Family is another one or keeps none sideby finds. */
export async function sessionRecords(
  familyId: string,
  account: Account,
): Promise<SessionRecords | undefined> {
  if (account.family !== familyId || !Object.hasOwn(RECORD_LISTS, familyId)) return undefined
  return RECORD_LISTS[familyId]!(account)
}
