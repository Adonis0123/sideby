// Attachments of an AI Task (spec §3.28 "附件"): images and videos the user adds to a task. The type comes from the
// first bytes of the file only, never from its name or a browser's guess; sideby names the saved files itself.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { UserError } from './errors.ts'
import type { Paths } from './paths.ts'

export type AttachmentKind = 'image' | 'video'
export interface Attachment {
  /** Absolute path of the saved file (`--print`: of the user's own file). */
  path: string
  kind: AttachmentKind
  bytes: number
}
interface FileType {
  ext: 'png' | 'jpg' | 'gif' | 'webp' | 'mp4' | 'mov' | 'webm'
  kind: AttachmentKind
  mime: string
}

const MB = 1024 * 1024
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = { image: 20 * MB, video: 200 * MB }
/** The largest upload the Panel accepts; the per-kind limit is checked once the type is known. */
export const MAX_UPLOAD_BYTES = ATTACHMENT_LIMITS.video
export const MAX_ATTACHMENTS = 5
const ATTACHMENT_TTL_MS = 7 * 24 * 3600000
// Uploads nobody sent with a task; a picture may show something private, so they go sooner than task folders.
const STAGED_TTL_MS = 24 * 3600000
/** What the staging folder holds at most, whatever the browser does: uploads beyond it are refused. */
export const MAX_STAGED_FILES = 20
export const MAX_STAGED_BYTES = 400 * MB
// Enough for every signature below, including WebM's DocType inside the EBML header.
const SNIFF_BYTES = 4096
const EXTS = ['png', 'jpg', 'gif', 'webp', 'mp4', 'mov', 'webm'] as const
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'dash',
  'mmp4',
  'MSNV',
  'f4v ',
])
export const SUPPORTED_TYPES = 'a PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video'

const ascii = (b: Uint8Array, from: number, to: number) =>
  Buffer.from(b.subarray(from, to)).toString('latin1')

/** The type of a file from its first bytes, or null when it is none sideby accepts. */
export function sniffType(head: Uint8Array): FileType | null {
  const starts = (sig: readonly number[]) => sig.every((v, i) => head[i] === v)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { ext: 'png', kind: 'image', mime: 'image/png' }
  if (starts([0xff, 0xd8, 0xff])) return { ext: 'jpg', kind: 'image', mime: 'image/jpeg' }
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a')
    return { ext: 'gif', kind: 'image', mime: 'image/gif' }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP')
    return { ext: 'webp', kind: 'image', mime: 'image/webp' }
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'qt  ') return { ext: 'mov', kind: 'video', mime: 'video/quicktime' }
    // HEIC, AVIF and other ISO files share the box but are not videos sideby accepts.
    if (MP4_BRANDS.has(brand)) return { ext: 'mp4', kind: 'video', mime: 'video/mp4' }
    return null
  }
  // Matroska and WebM share the EBML header; only the DocType tells them apart.
  if (ebmlDocType(head) === 'webm') return { ext: 'webm', kind: 'video', mime: 'video/webm' }
  return null
}

/** An EBML variable-length integer at `at`: its length and value (`keepMarker` for element ids), or null. */
function vint(b: Uint8Array, at: number, keepMarker: boolean, maxLength: number) {
  const first = b[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (length > maxLength || at + length > b.length) return null
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i]!
    allOnes &&= b[at + i] === 0xff
  }
  return { length, value, unknown: !keepMarker && allOnes }
}

/** The DocType of a whole EBML header at the start of `head` (element 0x1A45DFA3, child 0x4282), or null. */
function ebmlDocType(head: Uint8Array): string | null {
  const id = vint(head, 0, true, 4)
  if (id?.value !== 0x1a45dfa3) return null
  const size = vint(head, id.length, false, 8)
  if (!size || size.unknown) return null
  const start = id.length + size.length
  const end = start + size.value
  if (end > head.length) return null
  for (let at = start; at < end; ) {
    const childId = vint(head, at, true, 4)
    const childSize = childId && vint(head, at + childId.length, false, 8)
    if (!childId || !childSize || childSize.unknown) return null
    const data = at + childId.length + childSize.length
    if (data + childSize.value > end) return null
    if (childId.value === 0x4282) return ascii(head, data, data + childSize.value).replace(/\0+$/, '')
    at = data + childSize.value
  }
  return null
}

function tooLarge(kind: AttachmentKind): UserError {
  return new UserError(
    kind === 'image'
      ? 'This image is over 20 MB; attach a smaller one.'
      : 'This video is over 200 MB; trim it or attach a shorter one.',
    { code: 'attachment-too-large' },
  )
}
function unsupported(): UserError {
  return new UserError(`This file type is not supported; attach ${SUPPORTED_TYPES}.`, {
    code: 'attachment-type',
  })
}
function stagingFull(): UserError {
  return new UserError(
    `Too many attached files are waiting to be sent (at most ${MAX_STAGED_FILES} files, ${MAX_STAGED_BYTES / MB} MB in all). Send your task with the files you have or remove pending ones, then attach again; unsent files are cleared after a day.`,
    { code: 'attachment-quota' },
  )
}
function tooMany(): UserError {
  return new UserError(`Attach at most ${MAX_ATTACHMENTS} files to one task.`, {
    code: 'too-many-attachments',
  })
}

/** A directory the user owns, mode 700; a link or someone else's directory is refused. */
export async function privateDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const s = await lstat(path)
  if (!s.isDirectory() || s.uid !== process.getuid?.())
    throw new UserError('Unsafe task directory; fix its ownership and rerun `sideby ask`.')
  await chmod(path, 0o700)
  return path
}

const ID = /^[a-f0-9]{16}$/
function unsafeDir(path: string): UserError {
  return new UserError(
    `Unsafe attachment folder ${path}: it must be your own real folder that nobody else can write. Remove it and attach again.`,
    { code: 'attachment-unsafe' },
  )
}
/**
 * Checks `stateDir/ai/attachments/<sub…>` one folder at a time: each must be a real directory (not a link), owned by
 * the user and not writable by group or others. A missing one is made (mode 700) when `create` is set; otherwise the
 * answer is null. Every path sideby reads, writes or removes under the attachments folder goes through here first.
 */
async function attachmentDir(
  paths: Pick<Paths, 'stateDir'>,
  sub: readonly string[],
  create: boolean,
): Promise<string | null> {
  if (create) await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  let dir = paths.stateDir
  for (const part of ['ai', 'attachments', ...sub]) {
    dir = join(dir, part)
    let s = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!s) {
      if (!create) return null
      await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err
      })
      s = await lstat(dir)
      if (s.isDirectory() && s.uid === process.getuid?.()) await chmod(dir, 0o700)
      s = await lstat(dir)
    }
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o022) !== 0) throw unsafeDir(dir)
  }
  return dir
}
const attachmentsRoot = (paths: Pick<Paths, 'stateDir'>, create: boolean) => attachmentDir(paths, [], create)
const stagingDir = async (paths: Pick<Paths, 'stateDir'>) =>
  (await attachmentDir(paths, ['staging'], true)) as string
const taskDir = async (paths: Pick<Paths, 'stateDir'>, taskId: string) => {
  if (!ID.test(taskId)) throw new Error('invalid task id')
  return (await attachmentDir(paths, [taskId], true)) as string
}

/**
 * Streams `source` into `<dir>/<name>.<ext>` (mode 600, through a temp file and a rename). It stops as soon as the
 * first bytes show an unsupported type or the file passes its kind's limit, so a wrong upload is not read whole.
 */
async function saveStream(
  source: AsyncIterable<Uint8Array>,
  dir: string,
  name: string,
  budget = Number.POSITIVE_INFINITY,
): Promise<{ path: string; type: FileType; bytes: number }> {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  let bytes = 0
  let head = Buffer.alloc(0)
  let type: FileType | null = null
  try {
    for await (const chunk of source) {
      const buf = Buffer.from(chunk)
      bytes += buf.length
      if (!type && head.length < SNIFF_BYTES) {
        head = Buffer.concat([head, buf.subarray(0, SNIFF_BYTES - head.length)])
        if (head.length >= SNIFF_BYTES) {
          type = sniffType(head)
          if (!type) throw unsupported()
        }
      }
      if (bytes > (type ? ATTACHMENT_LIMITS[type.kind] : MAX_UPLOAD_BYTES))
        throw tooLarge(type?.kind ?? 'video')
      if (bytes > budget) throw stagingFull()
      await fh.write(buf)
    }
    type ??= sniffType(head)
    if (!type) throw unsupported()
    if (bytes > ATTACHMENT_LIMITS[type.kind]) throw tooLarge(type.kind)
    await fh.chmod(0o600)
    await fh.close()
  } catch (err) {
    await fh.close().catch(() => undefined)
    await rm(tmp, { force: true })
    throw err
  }
  const path = join(dir, `${name}.${type.ext}`)
  try {
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  return { path, type, bytes }
}

/** Opens one of the user's files for `--attach`: a regular file, not a link. */
async function openUserFile(file: string) {
  const path = resolve(file)
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new UserError(
      code === 'ELOOP'
        ? `${path} is a link; attach the file itself.`
        : `Cannot read ${path}; check the path and rerun \`sideby ask\`.`,
      { code: code === 'ELOOP' ? 'attachment-link' : 'attachment-missing' },
    )
  }
  const s = await fh.stat()
  if (!s.isFile()) {
    await fh.close()
    throw new UserError(`${path} is not a file; attach an image or a video.`, { code: 'attachment-missing' })
  }
  return { path, fh, size: s.size }
}

/**
 * `sideby ask --print --attach`: checks the user's files as an upload would be checked and returns them where they
 * are, since `--print` writes nothing.
 */
export async function checkAttachmentFiles(files: readonly string[]): Promise<Attachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw tooMany()
  const out: Attachment[] = []
  for (const file of files) {
    const { path, fh, size } = await openUserFile(file)
    try {
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, size))
      await fh.read(head, 0, head.length, 0)
      const type = sniffType(head)
      if (!type) throw unsupported()
      if (size > ATTACHMENT_LIMITS[type.kind]) throw tooLarge(type.kind)
      out.push({ path, kind: type.kind, bytes: size })
    } finally {
      await fh.close()
    }
  }
  return out
}

/** `sideby ask --attach`: copies the user's files into the task's attachment folder as `1.png`, `2.mp4`, … */
export async function copyAttachments(
  paths: Pick<Paths, 'stateDir'>,
  files: readonly string[],
  taskId: string,
): Promise<Attachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw tooMany()
  await checkAttachmentFiles(files)
  const dir = await taskDir(paths, taskId)
  const out: Attachment[] = []
  for (const [i, file] of files.entries()) {
    const { fh } = await openUserFile(file)
    try {
      const saved = await saveStream(fh.createReadStream({ autoClose: false }), dir, String(i + 1))
      out.push({ path: saved.path, kind: saved.type.kind, bytes: saved.bytes })
    } finally {
      await fh.close()
    }
  }
  return out
}

/** A Panel upload: saved under a random id in the staging folder until `/api/ask` takes it into a task. */
// One upload at a time per staging folder: the count and the write must not interleave, or two uploads that arrive
// together both see room for one more and the folder ends up over its limit.
const stagingLocks = new Map<string, Promise<unknown>>()

export async function stageUpload(
  paths: Pick<Paths, 'stateDir'>,
  source: AsyncIterable<Uint8Array>,
  now = Date.now(),
): Promise<{ id: string; kind: AttachmentKind; bytes: number; mime: string }> {
  const dir = await stagingDir(paths)
  const before = stagingLocks.get(dir) ?? Promise.resolve()
  const run = before.catch(() => {}).then(() => stageLocked(dir, source, now))
  stagingLocks.set(dir, run)
  try {
    return await run
  } finally {
    if (stagingLocks.get(dir) === run) stagingLocks.delete(dir)
  }
}

async function stageLocked(
  dir: string,
  source: AsyncIterable<Uint8Array>,
  now: number,
): Promise<{ id: string; kind: AttachmentKind; bytes: number; mime: string }> {
  const kept = await cleanStaging(dir, now)
  if (kept.files >= MAX_STAGED_FILES || kept.bytes >= MAX_STAGED_BYTES) throw stagingFull()
  const id = randomBytes(8).toString('hex')
  const saved = await saveStream(source, dir, id, MAX_STAGED_BYTES - kept.bytes)
  return { id, kind: saved.type.kind, bytes: saved.bytes, mime: saved.type.mime }
}

// A staged upload (`<id>.<ext>`) or the temp file of one still being written (`.<id>.<hex>.tmp`).
const STAGED_NAME = new RegExp(
  `^(?:[a-f0-9]{16}\\.(?:${EXTS.join('|')})|\\.[a-f0-9]{16}\\.[a-f0-9]{12}\\.tmp)$`,
)

/** True when `path` is still inside `root` once links are resolved (`root` itself already checked). */
async function inside(root: string, path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => null)
  if (!real) return false
  const rel = relative(await realpath(root), real)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)
}

/**
 * Removes staged uploads older than a day from a checked staging folder and returns what is left. Only regular files
 * of the user with names sideby gives are counted or removed.
 */
async function cleanStaging(dir: string, now: number): Promise<{ files: number; bytes: number }> {
  const uid = process.getuid?.()
  const left = { files: 0, bytes: 0 }
  for (const name of await readdir(dir)) {
    if (!STAGED_NAME.test(name)) continue
    const path = join(dir, name)
    try {
      const s = await lstat(path)
      if (!s.isFile() || s.uid !== uid) continue
      if (now - s.mtimeMs > STAGED_TTL_MS && (await inside(dir, path))) await unlink(path)
      else if (!name.startsWith('.')) {
        left.files++
        left.bytes += s.size
      }
    } catch {
      // Taken into a task or removed by another sideby meanwhile.
    }
  }
  return left
}

async function findStaged(paths: Pick<Paths, 'stateDir'>, ids: readonly string[]) {
  if (ids.length > MAX_ATTACHMENTS) throw tooMany()
  if (new Set(ids).size !== ids.length) throw new UserError('The same file is attached twice; remove one.')
  const dir = await stagingDir(paths)
  const names = await readdir(dir)
  return Promise.all(
    ids.map(async (id) => {
      const gone = new UserError('An attached file is no longer there; add it again.', {
        code: 'attachment-missing',
      })
      if (!ID.test(id)) throw gone
      const name = names.find((n) => EXTS.some((e) => n === `${id}.${e}`))
      if (!name) throw gone
      const path = join(dir, name)
      const s = await lstat(path)
      if (!s.isFile() || s.uid !== process.getuid?.()) throw gone
      const ext = name.slice(id.length + 1) as FileType['ext']
      const kind: AttachmentKind = ext === 'mp4' || ext === 'mov' || ext === 'webm' ? 'video' : 'image'
      return { path, ext, kind, bytes: s.size }
    }),
  )
}

/** The staged uploads where they are, for a prompt shown before the task exists. */
export async function stagedAttachments(
  paths: Pick<Paths, 'stateDir'>,
  ids: readonly string[],
): Promise<Attachment[]> {
  return (await findStaged(paths, ids)).map(({ path, kind, bytes }) => ({ path, kind, bytes }))
}

/** Deletes staged uploads the person removed before sending; an id that is already gone is skipped. */
export async function removeStaged(paths: Pick<Paths, 'stateDir'>, ids: readonly string[]): Promise<number> {
  let removed = 0
  for (const id of ids) {
    const found = await findStaged(paths, [id]).catch(() => [])
    for (const f of found) {
      await unlink(f.path)
      removed++
    }
  }
  return removed
}

/** Moves staged uploads into the task's attachment folder, in the order given. */
export async function takeStaged(
  paths: Pick<Paths, 'stateDir'>,
  ids: readonly string[],
  taskId: string,
): Promise<Attachment[]> {
  const found = await findStaged(paths, ids)
  if (!found.length) return []
  const dir = await taskDir(paths, taskId)
  const out: Attachment[] = []
  for (const [i, f] of found.entries()) {
    const path = join(dir, `${i + 1}.${f.ext}`)
    await rename(f.path, path)
    out.push({ path, kind: f.kind, bytes: f.bytes })
  }
  return out
}

/**
 * Drops task attachment folders older than 7 days and staged uploads older than a day; leaves anything else, and
 * does nothing when a folder on the way is not the user's own real folder.
 */
export async function removeOldAttachments(paths: Pick<Paths, 'stateDir'>, now = Date.now()): Promise<void> {
  const base = await attachmentsRoot(paths, false).catch(() => null)
  if (!base) return
  const uid = process.getuid?.()
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const path = join(base, name)
    try {
      if (ID.test(name)) {
        const s = await lstat(path)
        if (
          s.isDirectory() &&
          s.uid === uid &&
          now - s.mtimeMs > ATTACHMENT_TTL_MS &&
          (await inside(base, path))
        )
          await rm(path, { recursive: true, force: true })
      } else if (name === 'staging') {
        const staging = await attachmentDir(paths, ['staging'], false)
        if (staging) await cleanStaging(staging, now)
      }
    } catch {
      // Another sideby may be cleaning too; a leftover is retried next time.
    }
  }
}
