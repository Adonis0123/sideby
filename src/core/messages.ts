// Messages between Sessions (spec §3.32 step 2, ADR-0040): text and screenshots one Session sends another. A Message
// is kept as a file in sideby's state directory before any delivery, so it is never lost; it is then delivered
// through the Host's own channel where it has one, or handed to the user to paste.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  checkSocket,
  claudeSocketOf,
  DELIVER_TIMEOUT_MS,
  messageLine,
  sessionBypass,
  socketChanged,
  tailLinesWith,
  writeToSocket,
} from '../families/claude/messaging.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { UserError } from './errors.ts'
import { writeFileAtomic } from './fs-safe.ts'
import { inboundOf } from './inbound.ts'
import { type LiveSession, listLiveSessions } from './live-sessions.ts'
import { pickSession } from './live-sessions-copy.ts'
import {
  hostArgs,
  type LiveSessionDeps,
  type ProcessInfo,
  processView,
  systemDeps,
} from './live-sessions-procs.ts'

/** stored: kept as a file only; delivered: the Host's channel accepted it; read: the target Session shows it; paste-needed: the user must paste `pasteText` into the target. */
export type MessageStatus = 'stored' | 'delivered' | 'read' | 'paste-needed'

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
  sentAt: string
}

export interface SendOptions {
  text: string
  /** Paths of images to attach (copied into the Message's folder). */
  images?: readonly string[]
  /** Sender Session id when known (the CLI detects it from its parent Host process). */
  fromSessionId?: string
  lang?: 'en' | 'zh'
}

/** What sending touches on the machine; tests replace each part. */
export interface MessageDeps {
  /** The programs Live Sessions are read with (`ps`, `lsof`). */
  procs?: LiveSessionDeps
  /** Folders a Claude message socket may sit in (inside `cc-socks`); the system temp folders when left out. */
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
    `${p} is not a PNG, JPEG, GIF or WebP image; only screenshots can be attached (send other files' paths in the text)`,
  )
const tooLarge = (p: string) =>
  badImage(`${p} is larger than 20 MB, too large to send; send a smaller screenshot or crop it first`)

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
            ? `${p} is a link; give the path of the screenshot itself`
            : `${p} is not a file sideby can read; give the path of a screenshot`,
        )
      }
      out.push({ path: p, fh })
      const st = await fh.stat()
      if (!st.isFile()) throw badImage(`${p} is not a file sideby can read; give the path of a screenshot`)
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
    `${path} is not a folder sideby can keep messages in: it must be your own real folder that nobody else can write. Move it away and send again`,
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
  if (create) await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.()
  let dir = stateDir
  for (const part of ['messages', ...sub]) {
    dir = join(dir, part)
    let st = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!st) {
      if (!create) return null
      let made = true
      await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err
        made = false
      })
      st = await lstat(dir)
      if (made && st.isDirectory() && !st.isSymbolicLink() && st.uid === uid) {
        await chmod(dir, 0o700)
        st = await lstat(dir)
      }
    }
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0)
      throw unsafeFolder(dir)
  }
  return dir
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
    return `去读 sideby 留给你的消息 ${file}（sideby message ${id}）${screenshots ? '，以及里面列出的截图' : ''}。`
  return `Read the message sideby kept for you at ${file} (sideby message ${id})${screenshots ? ' and the screenshots it lists' : ''}.`
}

/** The text a Claude session receives: who sent it, the text, then one line per screenshot so it can read them. */
export function deliveredText(
  id: string,
  from: string | undefined,
  text: string,
  attachments: readonly string[],
) {
  const head = `sideby message ${id} ${from ? `from ${from}` : 'from the user via sideby'}`
  return [head, ...(text ? [text] : []), ...attachments.map((a) => `Screenshot: ${a}`)].join('\n')
}

function messageFile(r: MessageReceipt, text: string): string {
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
  return `${lines.join('\n')}\n`
}

const NO_CHANNEL: Record<string, string> = {
  codex: 'Codex has no channel sideby can deliver to yet',
  grok: 'Grok Build has no channel sideby can deliver to yet',
  pi: 'pi has no channel sideby can deliver to yet',
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
    throw new UserError('the message is empty; write what to tell the session, or attach a screenshot', {
      code: 'empty',
    })
  const lang = opts.lang ?? 'en'
  const images = await openImages(paths)
  try {
    return await sendOpened(rt, target, { text, lang, images, fromSessionId: opts.fromSessionId }, deps)
  } finally {
    await Promise.all(images.map((i) => i.fh.close().catch(() => {})))
  }
}

async function sendOpened(
  rt: Runtime,
  target: string,
  opts: { text: string; lang: 'en' | 'zh'; images: OpenImage[]; fromSessionId: string | undefined },
  deps: MessageDeps,
): Promise<MessageReceipt> {
  const { text, lang } = opts
  const procDeps = deps.procs ?? systemDeps(rt.env)
  const listed = await listLiveSessions(rt, {}, procDeps)
  let account: { ref: string; label: string } | undefined
  try {
    account = { ref: (await rt.resolve(target)).ref, label: target }
  } catch {
    // not an Account: a session id
  }
  const to = pickSession(target, listed.sessions, account, {
    verb: 'send to',
    command: (id) => `sideby send ${id} "<text>"`,
  })
  let from: LiveSession | undefined
  if (opts.fromSessionId) from = listed.sessions.find((s) => s.sessionId === opts.fromSessionId)
  else {
    const all = await processView(procDeps)
      .list()
      .catch(() => [] as ProcessInfo[])
    from = senderSession(deps.selfPid ?? process.pid, all, listed.sessions)
  }
  if (from?.sessionId === to.sessionId)
    throw new UserError(`${to.label} is the session you are in; send it to another session`, {
      code: 'same-session',
    })
  // Read every screenshot before anything is written, so a refused one leaves nothing behind.
  const copies = []
  for (const img of opts.images) copies.push(await readImage(img))

  // Keep the Message first, so nothing is lost whatever happens next.
  const id = randomBytes(4).toString('hex')
  const sentAt = new Date().toISOString()
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
  await writeFileAtomic(file, messageFile(receipt, text), 0o600)
  await saveReceipt(receipt)

  // From here on the Message is safe: whatever goes wrong, the user gets the line to paste.
  let result: { status: MessageStatus; note?: string }
  try {
    const acct = (await rt.accounts()).find((a) => a.ref === to.account)
    result = await deliver(rt, to, acct, receipt, text, procDeps, deps)
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
    if (receipt.status !== 'paste-needed')
      receipt.note = `sideby could not record that it was ${receipt.status} (${why})`
    else
      receipt.note = `${receipt.note ?? 'paste the line into its tab'}; sideby could not record this (${why})`
  }
  return publicReceipt(receipt)
}

async function deliver(
  rt: Runtime,
  to: LiveSession,
  acct: Account | undefined,
  r: Stored,
  text: string,
  procDeps: LiveSessionDeps,
  deps: MessageDeps,
): Promise<{ status: MessageStatus; note?: string }> {
  // A fresh look at the processes: the screenshots were copied since the listing, and the session may have ended.
  const procs = processView(procDeps)
  const paste = (note: string) => ({ status: 'paste-needed' as const, note })
  if (to.guessed)
    return paste(
      `sideby could not tell which ${to.accountLabel} session runs now (it took the newest one), so it did not deliver it; paste the line into the right tab`,
    )
  if (to.family !== 'claude' || !acct || to.pid === undefined)
    return paste(
      `${NO_CHANNEL[to.family] ?? `${rt.families.get(to.family)?.title ?? to.family} has no channel sideby can deliver to`}; paste the line into its tab`,
    )
  const inbound = await inboundOf(acct, rt.readContext())
  if (inbound === 'refuse')
    return paste(
      `${to.accountLabel} refuses messages from other sessions (crossSessionInbound is "refuse"); paste the line into its tab`,
    )
  const sock = await claudeSocketOf(acct.dir, to.pid, to.sessionId, procs)
  if ('problem' in sock)
    return paste(`sideby did not deliver it because ${sock.problem}; paste the line into its tab`)
  const checked = await checkSocket(sock.path, {
    tempRoots: deps.tempRoots ?? [tmpdir(), '/tmp'],
    uid: deps.uid ?? process.getuid?.(),
  })
  if ('problem' in checked)
    return paste(`sideby did not deliver it because ${checked.problem}; paste the line into its tab`)
  try {
    await (deps.write ?? writeToSocket)(
      sock.path,
      messageLine(deliveredText(r.id, r.from, text, r.attachments)),
      deps.timeoutMs ?? DELIVER_TIMEOUT_MS,
      () => socketChanged(sock.path, checked.identity),
    )
  } catch (err) {
    return paste(
      `sideby could not reach ${to.label} (${(err as Error).message}); paste the line into its tab`,
    )
  }
  if (inbound === 'accept') return { status: 'delivered' }
  const proc = await procs.get(to.pid)
  const args = (await procs.argv(to.pid)) ?? (proc ? hostArgs(proc.command) : [])
  if (inbound === 'hold' || (await sessionBypass(to.transcript, args)))
    return {
      status: 'delivered',
      note: `${to.accountLabel} holds messages from other sessions: approve it in its terminal within 5 minutes, or run \`sideby messages inbound accept\` so it shows them at once`,
    }
  return { status: 'delivered' }
}

function publicReceipt(s: Stored): MessageReceipt {
  const { transcript: _t, ...r } = s
  return r
}

const receiptPath = (file: string) => file.replace(/\.md$/, '.json')

async function saveReceipt(r: Stored, path = receiptPath(r.file)): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(r, null, 2)}\n`, 0o600)
}

const STATUSES: readonly string[] = ['stored', 'delivered', 'read', 'paste-needed']
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

/** Messages sideby kept, newest first, with their current status (re-checks `delivered` for `read`). */
export async function listMessages(
  rt: Runtime,
  opts: { to?: string; limit?: number } = {},
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
  for (const { r, path } of list) {
    if ((r.status !== 'delivered' && r.status !== 'paste-needed') || !r.transcript) continue
    const seen = await tailLinesWith(r.transcript, `sideby message ${r.id}`).catch(() => [])
    if (seen.length) {
      r.status = 'read'
      await saveReceipt(r, path).catch(() => {})
    }
  }
  return list.map(({ r }) => publicReceipt(r))
}
