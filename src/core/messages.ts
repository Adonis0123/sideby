// Messages between Sessions (spec §3.32 step 2, ADR-0040): text and screenshots one Session sends another. A Message
// is kept as a file in sideby's state directory before any delivery, so it is never lost; it is then delivered
// through the Host's own channel where it has one, or handed to the user to paste.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tailLinesWith } from '../families/claude/session-files.ts'
import { DELIVERERS, type Delivery } from '../families/messaging.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { UserError } from './errors.ts'
import { ownedFolder, UnsafeFolderError, writeFileAtomic } from './fs-safe.ts'
import type { LiveSession } from './live-sessions.ts'
import { type LiveSessionDeps, type ProcessInfo, processView, systemDeps } from './live-sessions-procs.ts'
import { selectSession } from './session-select.ts'

/**
 * stored: kept as a file only; delivered: the Host's channel accepted it; read: the target Session shows it;
 * paste-needed: the user must paste `pasteText` into the target; unknown: the channel was given it but never said
 * whether it took it, so it may still show up (ADR-0065): check the target before sending again.
 */
export type MessageStatus = 'stored' | 'delivered' | 'read' | 'paste-needed' | 'unknown'

export interface MessageReceipt {
  /** Short id, also written into the delivered text so it can be found in the target's record. */
  id: string
  /** The target Session's Session Label. */
  to: string
  toSessionId: string
  /** The Account ref that holds the target Session. */
  toAccount: string
  /** Sender's Session Label when sideby could tell which Session sent it. */
  from?: string
  status: MessageStatus
  /** Where the Message file is. */
  file: string
  /** Copied screenshots next to the Message file. */
  attachments: string[]
  /** One line the user pastes into the target when status is paste-needed (else the same line, for reference). */
  pasteText: string
  /** Plain-language note: why paste is needed, or that the target must approve it (bypass mode). */
  note?: string
  /** Delivered, but the target shows it only once the user approves it in its terminal (ADR-0045). */
  needsApproval?: boolean
  sentAt: string
  /** The session id the sender named, when an Auto Handoff chain led from it to this target (ADR-0057). */
  handedOverFrom?: string
}

export interface SendOptions {
  text: string
  /** Paths of images to attach (copied into the Message's folder). */
  images?: readonly string[]
  /** Sender Session id when known (the CLI detects it from its parent Host process). */
  fromSessionId?: string
  /** The user sends it (the Panel): no sender Session is looked for, so it carries no Reply line. */
  fromUser?: boolean
  lang?: 'en' | 'zh'
}

/** What sending touches on the machine; tests replace each part. */
export interface MessageDeps {
  /** The programs Live Sessions are read with (`ps`, `lsof`). */
  procs?: LiveSessionDeps
  /** Folders a Claude message socket's `cc-socks` may sit in; `socketRoots(rt.env)` when left out. */
  tempRoots?: readonly string[]
  /** The user a socket must belong to; the current user when left out. */
  uid?: number
  /** The process whose parents are searched for the sending Session; this process when left out. */
  selfPid?: number
  /** How a line reaches a socket; `verify` runs after connecting and before writing. */
  write?: (
    path: string,
    line: string,
    timeoutMs: number,
    verify: () => Promise<string | null>,
  ) => Promise<void>
  timeoutMs?: number
  /** How `codex <args>` runs for Codex delivery; resolves to its exit code. */
  runCodex?: (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<number>
}

/** The largest screenshot sideby copies. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** What the receipt file next to a Message holds: the receipt and where to look for the read receipt. */
interface Stored extends MessageReceipt {
  transcript?: string
}

const IMAGE_TYPES: [string, (b: Buffer) => boolean][] = [
  ['png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'webp',
    (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
]

/** The image type of a file's first bytes (`png`, `jpg`, `gif`, `webp`), or null. */
export function imageType(head: Buffer): string | null {
  return IMAGE_TYPES.find(([, is]) => is(head))?.[0] ?? null
}

const badImage = (message: string) => new UserError(message, { code: 'bad-image' })
const notImage = (p: string) =>
  badImage(
    `${p} is not a PNG, JPEG, GIF or WebP image. Attach a screenshot in one of those formats, or mention the file path in your message`,
  )
const tooLarge = (p: string) => badImage(`${p} is over 20 MB. Crop it or pick a smaller screenshot`)

type FileHandle = Awaited<ReturnType<typeof open>>
interface OpenImage {
  path: string
  fh: FileHandle
}

/**
 * Opens each image (a regular file, not a link) and checks its type and size before anything is written. The handles
 * stay open, so what is copied later is the file that was checked; the caller closes them.
 */
async function openImages(paths: readonly string[]): Promise<OpenImage[]> {
  const out: OpenImage[] = []
  try {
    for (const p of paths) {
      let fh: FileHandle
      try {
        fh = await open(resolve(p), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch (err) {
        throw badImage(
          (err as NodeJS.ErrnoException).code === 'ELOOP'
            ? `${p} is a symlink. Pass the path to the screenshot file itself`
            : `sideby cannot read ${p}; check the path and that the file is readable, then send again`,
        )
      }
      out.push({ path: p, fh })
      const st = await fh.stat()
      if (!st.isFile()) throw badImage(`${p} is not a regular file. Pass the path to a screenshot`)
      if (st.size > MAX_IMAGE_BYTES) throw tooLarge(p)
      const head = Buffer.alloc(16)
      await fh.read(head, 0, 16, 0)
      if (!imageType(head)) throw notImage(p)
    }
  } catch (err) {
    await Promise.all(out.map((i) => i.fh.close().catch(() => {})))
    throw err
  }
  return out
}

/**
 * Reads an opened image from its start, never more than the limit allows, and tells its type again from the bytes
 * read: a file that grew or changed since it was checked is refused.
 */
async function readImage(img: OpenImage): Promise<{ bytes: Buffer; type: string }> {
  const chunks: Buffer[] = []
  let size = 0
  let pos = 0
  for (;;) {
    const buf = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await img.fh.read(buf, 0, buf.length, pos)
    if (!bytesRead) break
    pos += bytesRead
    size += bytesRead
    if (size > MAX_IMAGE_BYTES) throw tooLarge(img.path)
    chunks.push(buf.subarray(0, bytesRead))
  }
  const bytes = Buffer.concat(chunks)
  const type = imageType(bytes.subarray(0, 16))
  if (!type) throw notImage(img.path)
  return { bytes, type }
}

const messagesDir = (stateDir: string) => join(stateDir, 'messages')

/** A folder name for a session id: the id itself when it is plain, else its hex; never `.`, `..` or a separator. */
export const safeName = (id: string): string =>
  /^[A-Za-z0-9_-][\w.-]*$/.test(id) && id.length <= 128 ? id : Buffer.from(id).toString('hex').slice(0, 128)

const isSafeName = (name: string) => /^[A-Za-z0-9_-][\w.-]*$/.test(name) && name.length <= 128

function unsafeFolder(path: string): UserError {
  return new UserError(
    `sideby cannot save messages in ${path}: it must be a real folder you own that nobody else can write to. Move or delete ${path}, then send again`,
    { code: 'messages-unsafe' },
  )
}

/**
 * Checks `<state>/messages/<sub…>` one folder at a time: each must be a real folder (not a link) of the current
 * user that group and others cannot write. A missing one is made (mode 700) when `create` is set, else the answer is
 * null. Only a folder sideby made here gets its mode set. Every Message path goes through this first.
 */
export async function messageFolder(
  stateDir: string,
  sub: readonly string[],
  create: boolean,
): Promise<string | null> {
  for (const part of sub) if (!isSafeName(part)) throw unsafeFolder(join(messagesDir(stateDir), part))
  try {
    return await ownedFolder(stateDir, ['messages', ...sub], { create })
  } catch (err) {
    if (err instanceof UnsafeFolderError) throw unsafeFolder(err.path)
    throw err
  }
}

/** The Live Session whose Host process is a parent of `pid` (the Session `sideby send` runs inside), if any. */
export function senderSession(
  pid: number,
  procs: readonly ProcessInfo[],
  sessions: readonly LiveSession[],
): LiveSession | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const seen = new Set<number>()
  let cur = byPid.get(pid)?.ppid
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    seen.add(cur)
    const s = sessions.find((x) => x.pid === cur)
    if (s) return s
    cur = byPid.get(cur)?.ppid
  }
  return undefined
}

/** The line the user pastes into the target (and keeps for reference when it was delivered). */
export function pasteLine(id: string, file: string, screenshots: number, lang: 'en' | 'zh'): string {
  if (lang === 'zh')
    return `请读取 sideby 存好的消息 ${file}（sideby message ${id}）${screenshots ? '，以及里面列出的截图' : ''}。`
  return `Read the message sideby kept for you at ${file} (sideby message ${id})${screenshots ? ' and the screenshots it lists' : ''}.`
}

/** The line that tells the receiving AI how to answer a sender sideby identified: `sideby send <its full id>`. */
export const replyLine = (senderSessionId: string): string => `Reply: sideby send ${senderSessionId} "<text>"`

/**
 * The text a Claude session receives: who sent it, the text, one line per screenshot so it can read them, then the
 * Reply line when the sender is a Session sideby identified.
 */
export function deliveredText(
  id: string,
  from: string | undefined,
  text: string,
  attachments: readonly string[],
  reply?: string,
) {
  const head = `sideby message ${id} ${from ? `from ${from}` : 'from the user via sideby'}`
  return [
    head,
    ...(text ? [text] : []),
    ...attachments.map((a) => `Screenshot: ${a}`),
    ...(reply ? [reply] : []),
  ].join('\n')
}

function messageFile(r: MessageReceipt, text: string, reply: string | undefined): string {
  const lines = [
    `# sideby message ${r.id}`,
    '',
    `From: ${r.from ?? 'the user'}`,
    `To: ${r.to}`,
    `Sent: ${r.sentAt}`,
    '',
    text,
  ]
  if (r.attachments.length) lines.push('', 'Screenshots:', ...r.attachments.map((a) => `- ${a}`))
  if (reply) lines.push('', reply)
  return `${lines.join('\n')}\n`
}

const NO_CHANNEL: Record<string, string> = {
  grok: 'Grok Build cannot receive messages directly yet',
  pi: 'pi cannot receive messages directly yet',
}

/** Sends `opts` to the Live Session `target` names (an Account ref/alias with one Live Session, or a session id or its first 8 chars). */
export async function sendMessage(
  rt: Runtime,
  target: string,
  opts: SendOptions,
  deps: MessageDeps = {},
): Promise<MessageReceipt> {
  const text = opts.text.trim()
  const paths = opts.images ?? []
  if (!text && !paths.length)
    throw new UserError('the message is empty; write a message or attach a screenshot', {
      code: 'empty',
    })
  const lang = opts.lang ?? 'en'
  const images = await openImages(paths)
  try {
    return await sendOpened(
      rt,
      target,
      { text, lang, images, fromSessionId: opts.fromSessionId, fromUser: opts.fromUser === true },
      deps,
    )
  } finally {
    await Promise.all(images.map((i) => i.fh.close().catch(() => {})))
  }
}

async function sendOpened(
  rt: Runtime,
  target: string,
  opts: {
    text: string
    lang: 'en' | 'zh'
    images: OpenImage[]
    fromSessionId: string | undefined
    fromUser: boolean
  },
  deps: MessageDeps,
): Promise<MessageReceipt> {
  const { text, lang } = opts
  const procDeps = deps.procs ?? systemDeps(rt.env)
  const {
    session: to,
    listed,
    handedOverFrom,
  } = await selectSession(rt, target, {
    next: { verb: 'send to', command: (id) => `sideby send ${id} "<text>"` },
    deps: procDeps,
  })
  let from: LiveSession | undefined
  if (opts.fromUser) from = undefined
  else if (opts.fromSessionId) from = listed.sessions.find((s) => s.sessionId === opts.fromSessionId)
  else {
    const all = await processView(procDeps)
      .list()
      .catch(() => [] as ProcessInfo[])
    from = senderSession(deps.selfPid ?? process.pid, all, listed.sessions)
  }
  if (from?.sessionId === to.sessionId)
    throw new UserError(`you are already in ${to.label}; pick another session to send to`, {
      code: 'same-session',
    })
  // Read every screenshot before anything is written, so a refused one leaves nothing behind.
  const copies = []
  for (const img of opts.images) copies.push(await readImage(img))

  // Keep the Message first, so nothing is lost whatever happens next.
  const id = randomBytes(4).toString('hex')
  const sentAt = rt.readContext().now.toISOString()
  const dir = (await messageFolder(rt.readContext().stateDir, [safeName(to.sessionId)], true)) as string
  const stem = `${sentAt.slice(0, 19).replace(/:/g, '-')}Z-${id}`
  const file = join(dir, `${stem}.md`)
  const attachments: string[] = []
  for (const [i, c] of copies.entries()) {
    const dest = join(dir, `${stem}-${i + 1}.${c.type}`)
    await writeFileAtomic(dest, c.bytes, 0o600)
    attachments.push(dest)
  }
  const receipt: Stored = {
    id,
    to: to.label,
    toSessionId: to.sessionId,
    toAccount: to.account,
    ...(from ? { from: from.label } : {}),
    status: 'stored',
    file,
    attachments,
    pasteText: pasteLine(id, file, attachments.length, lang),
    sentAt,
    ...(to.transcript ? { transcript: to.transcript } : {}),
  }
  // Only a sender sideby knows exactly gets a way to answer: a guessed one may be the wrong session.
  const reply = from && !from.guessed ? replyLine(from.sessionId) : undefined
  await writeFileAtomic(file, messageFile(receipt, text, reply), 0o600)

  // From here on the Message is safe: whatever goes wrong, the user gets the line to paste.
  try {
    await saveReceipt(receipt)
  } catch (err) {
    // Without a receipt sideby could not follow it later, so it does not deliver it; the Message file is kept.
    receipt.status = 'paste-needed'
    receipt.note = `sideby saved the message file, but could not save its status (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Paste the line into the session's tab`
    return { ...publicReceipt(receipt), ...(handedOverFrom ? { handedOverFrom } : {}) }
  }
  let result: { status: MessageStatus; note?: string; needsApproval?: boolean }
  try {
    const acct = (await rt.accounts()).find((a) => a.ref === to.account)
    result = await deliver(rt, to, acct, receipt, text, reply, procDeps, deps)
  } catch (err) {
    result = {
      status: 'paste-needed',
      note: `sideby could not deliver it (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); paste the line into its tab`,
    }
  }
  Object.assign(receipt, result)
  try {
    await saveReceipt(receipt)
  } catch (err) {
    // The Message file is kept; only its status could not be recorded. Still hand the user what to do.
    const why = (err as NodeJS.ErrnoException).code ?? (err as Error).message
    if (receipt.status === 'delivered') receipt.note = `sideby could not save the message status (${why})`
    else
      receipt.note = `${receipt.note ?? 'paste the line into its tab'} (sideby also could not save the message status: ${why})`
  }
  return { ...publicReceipt(receipt), ...(handedOverFrom ? { handedOverFrom } : {}) }
}

async function deliver(
  rt: Runtime,
  to: LiveSession,
  acct: Account | undefined,
  r: Stored,
  text: string,
  reply: string | undefined,
  procDeps: LiveSessionDeps,
  deps: MessageDeps,
): Promise<Delivery> {
  if (to.guessed)
    return {
      status: 'paste-needed',
      note: `sideby could not tell which ${to.accountLabel} session is running (picked the newest one). Paste the line into the right tab`,
    }
  if (!acct)
    return {
      status: 'paste-needed',
      note: `account ${to.account} was not found. Paste the line into its terminal tab`,
    }
  const family = DELIVERERS[to.family]
  if (!family || to.pid === undefined)
    return {
      status: 'paste-needed',
      note: `${NO_CHANNEL[to.family] ?? `${rt.families.get(to.family)?.title ?? to.family} cannot receive messages directly`}; paste the line into its terminal tab`,
    }
  const pid = to.pid
  return family({
    rt,
    to,
    pid,
    acct,
    text: deliveredText(r.id, r.from, text, r.attachments, reply),
    pasteText: r.pasteText,
    // A fresh look at the processes: the screenshots were copied since the listing, and the session may have ended.
    procs: processView(procDeps),
    ended: () =>
      processView(procDeps)
        .get(pid)
        .then(
          (p) => !p,
          () => false,
        ),
    deps,
  })
}

function publicReceipt(s: Stored): MessageReceipt {
  const { transcript: _t, ...r } = s
  return r
}

const receiptPath = (file: string) => file.replace(/\.md$/, '.json')

async function saveReceipt(r: Stored, path = receiptPath(r.file)): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(r, null, 2)}\n`, 0o600)
}

/** The statuses whose Message may still show in the target's record, so it is looked for there. */
const READ_CHECKED: ReadonlySet<MessageStatus> = new Set(['delivered', 'paste-needed', 'unknown'])

/** How long after sending a held Message counts as dropped: Claude Code's five minutes plus one of margin. */
export const APPROVAL_EXPIRED_MS = 6 * 60_000

const STATUSES: readonly string[] = ['stored', 'delivered', 'read', 'paste-needed', 'unknown']
const optStr = (v: unknown) => v === undefined || typeof v === 'string'

/**
 * The receipt at `path` in the Message folder `dir`, when every field has its type and its Message and screenshots
 * are files of that folder named after the receipt; anything else is skipped as not sideby's.
 */
function validReceipt(raw: unknown, dir: string, path: string): Stored | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const strs = ['id', 'to', 'toSessionId', 'toAccount', 'file', 'pasteText', 'sentAt']
  if (!strs.every((k) => typeof r[k] === 'string')) return null
  if (!optStr(r.from) || !optStr(r.note) || !optStr(r.transcript)) return null
  if (r.needsApproval !== undefined && typeof r.needsApproval !== 'boolean') return null
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return null
  if (!Array.isArray(r.attachments) || !r.attachments.every((a) => typeof a === 'string')) return null
  if (!/^[0-9a-f]{8}$/.test(r.id as string) || Number.isNaN(Date.parse(r.sentAt as string))) return null
  const stem = basename(path, '.json')
  if (r.file !== join(dir, `${stem}.md`)) return null
  if (!(r.attachments as string[]).every((a) => dirname(a) === dir && basename(a).startsWith(`${stem}-`)))
    return null
  if (typeof r.transcript === 'string' && !r.transcript.endsWith('.jsonl')) return null
  return r as unknown as Stored
}

/**
 * Messages sideby kept, newest first, with their current status (re-checks `delivered`, `paste-needed` and `unknown`
 * for `read`; an `unknown` one never turns into anything else by itself, ADR-0065). A `read` found
 * is saved into the receipt unless `persist` is false (a read-only Panel only computes it).
 */
export async function listMessages(
  rt: Runtime,
  opts: { to?: string; limit?: number; persist?: boolean } = {},
): Promise<MessageReceipt[]> {
  const stateDir = rt.readContext().stateDir
  const root = await messageFolder(stateDir, [], false)
  if (!root) return []
  const names = await readdir(root)
  const all: { r: Stored; path: string }[] = []
  for (const d of names) {
    if (!isSafeName(d)) continue
    let dir: string | null
    try {
      dir = await messageFolder(stateDir, [d], false)
    } catch {
      continue
    }
    if (!dir) continue
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue
      const path = join(dir, f)
      try {
        const st = await lstat(path)
        if (!st.isFile()) continue
        const r = validReceipt(JSON.parse(await readFile(path, 'utf8')), dir, path)
        if (r) all.push({ r, path })
      } catch {
        // a receipt being written
      }
    }
  }
  let list = all
  if (opts.to) {
    const t = opts.to
    let ref: string | undefined
    try {
      ref = (await rt.resolve(t)).ref
    } catch {
      // a session id
    }
    list = all.filter(
      ({ r }) => r.toSessionId === t || (t.length >= 8 && r.toSessionId.startsWith(t)) || r.toAccount === ref,
    )
  }
  list.sort((a, b) => b.r.sentAt.localeCompare(a.r.sentAt))
  list = list.slice(0, opts.limit ?? 20)
  const now = rt.readContext().now.getTime()
  for (const { r, path } of list) {
    if (!READ_CHECKED.has(r.status) || !r.transcript) continue
    const seen = await tailLinesWith(r.transcript, `sideby message ${r.id}`).catch(() => [])
    let changed = false
    if (seen.length) {
      r.status = 'read'
      delete r.needsApproval
      changed = true
    } else if (
      r.status === 'delivered' &&
      r.needsApproval &&
      now - Date.parse(r.sentAt) > APPROVAL_EXPIRED_MS
    ) {
      // Claude Code drops a held Message after about five minutes (ADR-0045): the user pastes it instead.
      r.status = 'paste-needed'
      delete r.needsApproval
      r.note = `${r.to} did not show it: nobody approved it within 5 minutes, so the session dropped it. Paste the line into its tab`
      changed = true
    }
    if (changed && opts.persist !== false) await saveReceipt(r, path).catch(() => {})
  }
  return list.map(({ r }) => publicReceipt(r))
}
