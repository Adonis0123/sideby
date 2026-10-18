import assert from 'node:assert/strict'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { writeTask } from './ask.ts'
import {
  ATTACHMENT_LIMITS,
  checkAttachmentFiles,
  copyAttachments,
  MAX_STAGED_BYTES,
  MAX_STAGED_FILES,
  removeOldAttachments,
  sniffType,
  stagedAttachments,
  stageUpload,
  takeStaged,
} from './attachments.ts'
import { resolvePaths } from './paths.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const box = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`, 'latin1')])
const MP4 = box('isom')
const MOV = box('qt  ')
/** An EBML header holding `children`, as raw bytes. */
const ebmlHeader = (children: Buffer) =>
  Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length]), children])
const element = (id: number[], data: Buffer) =>
  Buffer.concat([Buffer.from([...id, 0x80 | data.length]), data])
const ebml = (doc: string) =>
  ebmlHeader(
    Buffer.concat([element([0x42, 0x86], Buffer.from([1])), element([0x42, 0x82], Buffer.from(doc))]),
  )
const WEBM = ebml('webm')
const TASK = '0123456789abcdef'
const DAY = 24 * 3600000

async function* chunks(...parts: Buffer[]) {
  for (const p of parts) yield p
}
/** A file of `size` bytes that starts with `head`; sparse, so a large one costs nothing. */
async function file(h: FakeHome, name: string, head: Buffer, size = head.length): Promise<string> {
  const path = h.path(name)
  const fh = await open(path, 'w', 0o644)
  await fh.write(head)
  await fh.truncate(size)
  await fh.close()
  return path
}
const mode = async (p: string) => (await stat(p)).mode & 0o777

describe('attachment types', () => {
  it('come from the first bytes, for every supported type', () => {
    const cases: [Buffer, string, string][] = [
      [PNG, 'png', 'image'],
      [JPEG, 'jpg', 'image'],
      [GIF, 'gif', 'image'],
      [WEBP, 'webp', 'image'],
      [MP4, 'mp4', 'video'],
      [box('mp42'), 'mp4', 'video'],
      [MOV, 'mov', 'video'],
      [WEBM, 'webm', 'video'],
      // A size written in more bytes than it needs, and a DocType padded with zeros, are still WebM.
      [
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x40, 0x08, 0x42, 0x82, 0x85, ...Buffer.from('webm'), 0, 0xec]),
        'webm',
        'video',
      ],
    ]
    for (const [head, ext, kind] of cases) {
      const t = sniffType(head)
      assert.equal(t?.ext, ext)
      assert.equal(t?.kind, kind)
    }
  })

  it('refuse files sideby does not accept, whatever their name says', async () => {
    for (const head of [
      box('heic'),
      ebml('matroska'),
      ebml('webmx'),
      // "webm" in another element of the header, or after it, is not the DocType.
      ebmlHeader(element([0x42, 0x87], Buffer.from('webm'))),
      Buffer.concat([ebmlHeader(element([0x42, 0x82], Buffer.from('matroska'))), Buffer.from('webm')]),
      // Cut off inside the header, inside the DocType, or with an unknown header size.
      WEBM.subarray(0, WEBM.length - 1),
      WEBM.subarray(0, 6),
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x42, 0x82, 0x84, ...Buffer.from('webm')]),
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('%PDF-1.7'),
      Buffer.from('hello'),
      Buffer.alloc(0),
    ])
      assert.equal(sniffType(head), null)
    await withFakeHome(async (h) => {
      const renamed = await file(h, 'shot.png', Buffer.from('not really a picture\n'))
      await assert.rejects(checkAttachmentFiles([renamed]), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'attachment-type')
        assert.match(err.message, /PNG, JPEG, GIF or WebP/)
        assert.ok(!err.message.includes('not really'))
        return true
      })
    })
  })
})

describe('attachment files', () => {
  it('copy the user files into the task folder with their own names, private', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const a = await file(h, 'my screenshot.PNG', PNG, 2048)
      const b = await file(h, 'clip.bin', MOV, 4096)
      const saved = await copyAttachments(paths, [a, b], TASK)
      const dir = join(paths.stateDir, 'ai', 'attachments', TASK)
      assert.deepEqual(
        saved.map((s) => [s.path, s.kind, s.bytes]),
        [
          [join(dir, '1.png'), 'image', 2048],
          [join(dir, '2.mov'), 'video', 4096],
        ],
      )
      assert.equal(await mode(dir), 0o700)
      assert.equal(await mode(saved[0]!.path), 0o600)
      assert.deepEqual(await readFile(saved[1]!.path), await readFile(b))
      assert.deepEqual((await readdir(dir)).sort(), ['1.png', '2.mov'])
    })
  })

  it('refuse a file over its kind limit, more than five files, and links', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const big = await file(h, 'big.png', PNG, ATTACHMENT_LIMITS.image + 1)
      await assert.rejects(copyAttachments(paths, [big], TASK), { code: 'attachment-too-large' })
      // The same size is fine for a video.
      const video = await file(h, 'v.mp4', MP4, ATTACHMENT_LIMITS.image + 1)
      assert.equal((await checkAttachmentFiles([video]))[0]!.kind, 'video')
      const bigVideo = await file(h, 'big.webm', WEBM, ATTACHMENT_LIMITS.video + 1)
      await assert.rejects(checkAttachmentFiles([bigVideo]), { code: 'attachment-too-large' })

      const small = await file(h, 's.gif', GIF)
      await assert.rejects(copyAttachments(paths, Array(6).fill(small), TASK), {
        code: 'too-many-attachments',
      })
      const link = h.path('link.gif')
      await symlink(small, link)
      await assert.rejects(copyAttachments(paths, [link], TASK), { code: 'attachment-link' })
      await assert.rejects(checkAttachmentFiles([h.path('missing.png')]), { code: 'attachment-missing' })
      // Nothing was saved for a refused task.
      assert.deepEqual(await readdir(join(paths.stateDir, 'ai', 'attachments', TASK)).catch(() => []), [])
    })
  })

  it('stage uploads, refuse wrong ones early, and move them into the task in order', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const staging = join(paths.stateDir, 'ai', 'attachments', 'staging')
      const one = await stageUpload(paths, chunks(WEBP, Buffer.alloc(5000)))
      const two = await stageUpload(paths, chunks(MP4.subarray(0, 6), MP4.subarray(6), Buffer.alloc(10)))
      assert.deepEqual([one.kind, one.bytes, two.kind], ['image', WEBP.length + 5000, 'video'])
      assert.match(one.id, /^[a-f0-9]{16}$/)
      assert.equal(await mode(join(staging, `${one.id}.webp`)), 0o600)

      await assert.rejects(stageUpload(paths, chunks(Buffer.from('plain text'))), { code: 'attachment-type' })
      // An image stops at its limit without reading the rest.
      const mb = Buffer.alloc(1024 * 1024)
      let read = 0
      async function* endless() {
        yield PNG
        for (;;) {
          read++
          yield mb
        }
      }
      await assert.rejects(stageUpload(paths, endless()), { code: 'attachment-too-large' })
      assert.ok(read <= 21, `read ${read} MB`)
      assert.deepEqual((await readdir(staging)).sort(), [`${one.id}.webp`, `${two.id}.mp4`].sort())

      const shown = await stagedAttachments(paths, [two.id])
      assert.equal(shown[0]!.path, join(staging, `${two.id}.mp4`))
      await assert.rejects(stagedAttachments(paths, ['ffffffffffffffff']), { code: 'attachment-missing' })
      await assert.rejects(stagedAttachments(paths, ['../../etc/passwd']), { code: 'attachment-missing' })

      const moved = await takeStaged(paths, [two.id, one.id], TASK)
      const dir = join(paths.stateDir, 'ai', 'attachments', TASK)
      assert.deepEqual(
        moved.map((m) => [m.path, m.kind]),
        [
          [join(dir, '1.mp4'), 'video'],
          [join(dir, '2.webp'), 'image'],
        ],
      )
      assert.deepEqual(await readdir(staging), [])
      await assert.rejects(takeStaged(paths, [one.id], TASK), { code: 'attachment-missing' })
    })
  })

  it('refuse a staging folder that is a link', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await h.mkdir('elsewhere')
      await h.mkdir('.local/state/sideby/ai/attachments')
      await symlink(h.path('elsewhere'), join(paths.stateDir, 'ai', 'attachments', 'staging'))
      await assert.rejects(stageUpload(paths, chunks(PNG)), /Unsafe attachment folder/)
      assert.deepEqual(await readdir(h.path('elsewhere')), [])
    })
  })

  for (const parent of ['ai', 'ai/attachments']) {
    it(`refuse to write or remove anything when ${parent} is a link to another folder`, async () => {
      await withFakeHome(async (h) => {
        const paths = resolvePaths(h.env)
        const target = h.path('elsewhere')
        // The target looks like an attachments folder with old uploads and an old task folder in it.
        const inner = parent === 'ai' ? join(target, 'attachments') : target
        await mkdir(join(inner, 'staging'), { recursive: true })
        await mkdir(join(inner, TASK), { recursive: true })
        const victim = join(inner, 'staging', 'aaaaaaaaaaaaaaaa.png')
        await writeFile(victim, PNG)
        await writeFile(join(inner, TASK, '1.png'), PNG)
        const long = new Date(Date.now() - 30 * DAY)
        await utimes(victim, long, long)
        await utimes(join(inner, TASK), long, long)
        await mkdir(join(paths.stateDir, parent, '..'), { recursive: true })
        await symlink(target, join(paths.stateDir, parent))
        const before = async () => [
          ...(await readdir(join(inner, 'staging'))),
          ...(await readdir(join(inner, TASK))),
        ]
        const was = await before()

        await assert.rejects(stageUpload(paths, chunks(PNG)), { code: 'attachment-unsafe' })
        await assert.rejects(takeStaged(paths, ['aaaaaaaaaaaaaaaa'], TASK), { code: 'attachment-unsafe' })
        await assert.rejects(copyAttachments(paths, [await file(h, 'a.png', PNG)], TASK), {
          code: 'attachment-unsafe',
        })
        await removeOldAttachments(paths, Date.now() + 60 * DAY)
        assert.deepEqual(await before(), was)
      })
    })
  }

  it('refuse an attachments folder others can write, and make missing ones private', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await stageUpload(paths, chunks(PNG))
      for (const d of ['ai', 'ai/attachments', 'ai/attachments/staging'])
        assert.equal(await mode(join(paths.stateDir, d)), 0o700, d)
      await chmod(join(paths.stateDir, 'ai', 'attachments'), 0o777)
      await assert.rejects(stageUpload(paths, chunks(PNG)), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'attachment-unsafe')
        assert.match(err.message, /nobody else can write/)
        return true
      })
    })
  })

  it('let only one of two uploads that arrive together take the last free place', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const staging = join(paths.stateDir, 'ai', 'attachments', 'staging')
      for (let i = 0; i < MAX_STAGED_FILES - 1; i++) await stageUpload(paths, chunks(PNG))
      const both = await Promise.allSettled([
        stageUpload(paths, chunks(PNG)),
        stageUpload(paths, chunks(PNG)),
      ])
      assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
      const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult
      assert.equal((refused.reason as { code?: string }).code, 'attachment-quota')
      assert.equal((await readdir(staging)).length, MAX_STAGED_FILES)
      // A failed upload releases the folder for the next one.
      await assert.rejects(stageUpload(paths, chunks(Buffer.from('not a picture'))))
    })
  })

  it('keep at most 20 staged files and 400 MB, clearing day-old ones on every upload', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const staging = join(paths.stateDir, 'ai', 'attachments', 'staging')
      const ids: string[] = []
      for (let i = 0; i < MAX_STAGED_FILES; i++) ids.push((await stageUpload(paths, chunks(PNG))).id)
      await assert.rejects(stageUpload(paths, chunks(PNG)), (err: Error & { code?: string }) => {
        assert.equal(err.code, 'attachment-quota')
        assert.match(err.message, /Send your task .* or remove pending ones/)
        return true
      })
      assert.equal((await readdir(staging)).length, MAX_STAGED_FILES)
      // A day later the old uploads are cleared by the next upload itself, without a task being written.
      const old = new Date(Date.now() - 2 * DAY)
      for (const id of ids.slice(0, 5)) await utimes(join(staging, `${id}.png`), old, old)
      await stageUpload(paths, chunks(PNG))
      assert.equal((await readdir(staging)).length, MAX_STAGED_FILES - 4)

      // The byte limit counts what is already staged and stops a new upload as it passes it.
      for (const name of await readdir(staging)) await utimes(join(staging, name), old, old)
      const pending = join(staging, 'bbbbbbbbbbbbbbbb.mp4')
      await writeFile(pending, MP4)
      const fh = await open(pending, 'r+')
      await fh.truncate(MAX_STAGED_BYTES - 1024)
      await fh.close()
      const mb = Buffer.alloc(1024 * 1024)
      let read = 0
      async function* video() {
        yield MP4
        for (; read < 10; read++) yield mb
      }
      await assert.rejects(stageUpload(paths, video()), { code: 'attachment-quota' })
      assert.ok(read <= 2, `read ${read} MB`)
      assert.deepEqual(await readdir(staging), ['bbbbbbbbbbbbbbbb.mp4'])
      // A small picture still fits in what is left.
      assert.equal((await stageUpload(paths, chunks(PNG))).kind, 'image')
    })
  })

  it('are cleaned after 7 days (staged uploads after a day) when a task is written', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const base = join(paths.stateDir, 'ai', 'attachments')
      const old = await copyAttachments(paths, [await file(h, 'a.png', PNG)], 'aaaaaaaaaaaaaaaa')
      const fresh = await copyAttachments(paths, [await file(h, 'b.png', PNG)], 'bbbbbbbbbbbbbbbb')
      const staged = await stageUpload(paths, chunks(PNG))
      const keepStaged = await stageUpload(paths, chunks(GIF))
      await h.mkdir('.local/state/sideby/ai/attachments/notes')
      const now = Date.now()
      const ago = (ms: number) => new Date(now - ms)
      await utimes(join(base, 'aaaaaaaaaaaaaaaa'), ago(8 * DAY), ago(8 * DAY))
      await utimes(join(base, 'bbbbbbbbbbbbbbbb'), ago(6 * DAY), ago(6 * DAY))
      await utimes(join(base, 'staging', `${staged.id}.png`), ago(2 * DAY), ago(2 * DAY))
      await utimes(join(base, 'notes'), ago(30 * DAY), ago(30 * DAY))

      await writeTask({ kind: 'prompt', account: 'claude:main', prompt: 'x', cwd: h.path('.') }, paths)
      assert.equal(await lstat(old[0]!.path).catch(() => null), null)
      assert.ok(await lstat(fresh[0]!.path))
      assert.deepEqual(await readdir(join(base, 'staging')), [`${keepStaged.id}.gif`])
      assert.ok(await lstat(join(base, 'notes')))
      // Called directly with a later clock, the fresh folder goes too.
      await removeOldAttachments(paths, now + 2 * DAY)
      assert.equal(await lstat(fresh[0]!.path).catch(() => null), null)
    })
  })
})
