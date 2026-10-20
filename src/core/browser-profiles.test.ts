// Browser Sign-ins (spec §3.24, ADR-0023). Chrome's data is built here as fake LevelDB files; every program goes
// through a fake `exec`, so no test reads a real browser or starts one.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { createRuntime } from '../runtime.ts'
import type { Env } from '../types.ts'
import {
  browserReport,
  keyHasId,
  openInBrowser,
  setBrowserChoice,
  setBrowserSignIns,
} from './browser-profiles.ts'
import type { DesktopDeps, ExecResult } from './desktop-app.ts'
import { UserError } from './errors.ts'
import { localStorageKeys, snappyDecompress } from './leveldb-keys.ts'

// --- LevelDB writers (just enough of the format for the reader) -------------------------------------------------

const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}

const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u64 = (n: number) => [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))]

/** A Local Storage key: `_<origin>\0` then `\x01` + Latin-1, or `\x00` + UTF-16LE. */
function lsKey(origin: string, name: string, utf16 = false): Buffer {
  return Buffer.concat([
    Buffer.from(`_${origin}\u0000`, 'latin1'),
    utf16
      ? Buffer.concat([Buffer.from([0]), Buffer.from(name, 'utf16le')])
      : Buffer.from(`\u0001${name}`, 'latin1'),
  ])
}

type Entry = { key: Buffer; value?: string }

/** A `.log` with one WriteBatch, split into 32 KiB-block records (checksums are not checked by the reader). */
function logFile(entries: Entry[], seq = 1): Buffer {
  const body: number[] = [...u64(seq), ...u32(entries.length)]
  for (const e of entries) {
    body.push(e.value === undefined ? 0 : 1, ...varint(e.key.length), ...e.key)
    if (e.value !== undefined) {
      const v = Buffer.from(`\u0001${e.value}`, 'latin1')
      body.push(...varint(v.length), ...v)
    }
  }
  const out: number[] = []
  let pos = 0
  let first = true
  while (pos < body.length || first) {
    const room = 32768 - (out.length % 32768) - 7
    const n = Math.min(room, body.length - pos)
    const last = pos + n >= body.length
    const type = first && last ? 1 : first ? 2 : last ? 4 : 3
    out.push(0, 0, 0, 0, n & 0xff, n >> 8, type, ...body.slice(pos, pos + n))
    pos += n
    first = false
  }
  return Buffer.from(out)
}

/** Snappy with literals only, which every decoder must accept. */
function snappyLiterals(data: Buffer): Buffer {
  const out: number[] = [...varint(data.length)]
  for (let i = 0; i < data.length; i += 256) {
    const chunk = data.subarray(i, i + 256)
    out.push(60 << 2, chunk.length - 1, ...chunk)
  }
  return Buffer.from(out)
}

function block(entries: { key: Buffer; value: Buffer }[]): Buffer {
  const out: number[] = []
  for (const e of entries)
    out.push(0, ...varint(e.key.length), ...varint(e.value.length), ...e.key, ...e.value)
  out.push(...u32(0), ...u32(1))
  return Buffer.from(out)
}

/** A `.ldb` table: one data block (Snappy unless `raw`), an empty metaindex, an index block and the footer. */
function tableFile(entries: Entry[], seq = 100, raw = false): Buffer {
  const internal = entries
    .map((e, i) => ({
      key: Buffer.concat([e.key, Buffer.from(u64((seq + i) * 256 + (e.value === undefined ? 0 : 1)))]),
      value: Buffer.from(`\u0001${e.value ?? ''}`, 'latin1'),
    }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
  const parts: Buffer[] = []
  let size = 0
  const put = (b: Buffer, type: number) => {
    const handle = { off: size, len: b.length }
    parts.push(b, Buffer.from([type, 0, 0, 0, 0]))
    size += b.length + 5
    return handle
  }
  const dataRaw = block(internal)
  const data = put(raw ? dataRaw : snappyLiterals(dataRaw), raw ? 0 : 1)
  const meta = put(block([]), 0)
  const last = internal[internal.length - 1]?.key ?? Buffer.alloc(0)
  const index = put(block([{ key: last, value: Buffer.from([...varint(data.off), ...varint(data.len)]) }]), 0)
  const handles = [...varint(meta.off), ...varint(meta.len), ...varint(index.off), ...varint(index.len)]
  const footer = Buffer.alloc(48)
  Buffer.from(handles).copy(footer)
  Buffer.from([...u32(0x8b80fb57), ...u32(0xdb477524)]).copy(footer, 40)
  return Buffer.concat([...parts, footer])
}

/** Writes bytes as they are (FakeHome.write takes text). */
async function bin(h: FakeHome, rel: string, data: Buffer) {
  await mkdir(dirname(h.path(rel)), { recursive: true })
  await writeFile(h.path(rel), data)
}

// --- fixtures ----------------------------------------------------------------------------------------------------

const CHROME = 'Library/Application Support/Google/Chrome'
const CLAUDE_MAIN = '11111111-2222-4333-8444-555555555555'
const CLAUDE_WORK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CLAUDE_ORG = '99999999-8888-4777-8666-555555555555'
const CODEX_USER = 'user-FakeUser0123456789'
const SECRET = 'value-that-must-never-be-read'

const plist = (id: string) =>
  `<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>x</string><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`

const fakeJwt = (claims: object) =>
  ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((s) => Buffer.from(s).toString('base64url')).join('.')

interface Fake {
  calls: { cmd: string; args: string[] }[]
  deps: Partial<DesktopDeps>
  openCode: number
}

function fakeDeps(h: FakeHome, platform: NodeJS.Platform = 'darwin'): Fake {
  const f: Fake = { calls: [], deps: {}, openCode: 0 }
  const exec = async (cmd: string, args: readonly string[], _env?: Env): Promise<ExecResult> => {
    f.calls.push({ cmd, args: [...args] })
    if (cmd === '/usr/bin/open')
      return { code: f.openCode, stdout: '', stderr: f.openCode ? 'open failed' : '' }
    if (cmd === '/usr/bin/mdfind') return { code: 0, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` }
  }
  f.deps = { platform, appDirs: [h.path('Apps')], exec }
  return f
}

/** claude main and work, codex main, a claude API account, grok main; Chrome with three browser users. */
async function seed(h: FakeHome, opts: { enabled?: boolean } = {}) {
  await h.write('.claude/settings.json', '{}\n')
  await h.write(
    '.claude.json',
    JSON.stringify({ oauthAccount: { accountUuid: CLAUDE_MAIN, emailAddress: 'a@example.com' } }),
    0o600,
  )
  await h.write('.claude-work/settings.json', '{}\n')
  await h.write(
    '.claude-work/.claude.json',
    JSON.stringify({ oauthAccount: { accountUuid: CLAUDE_WORK } }),
    0o600,
  )
  await h.write('.claude-deepseek/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.write(
    '.codex/auth.json',
    JSON.stringify({
      tokens: {
        id_token: fakeJwt({ email: 'c@example.com', 'https://api.openai.com/auth': { user_id: CODEX_USER } }),
        account_id: 'ws-1',
      },
    }),
    0o600,
  )
  await h.write('.grok/skills/x.md', 'x\n')
  await h.write('Apps/Google Chrome.app/Contents/Info.plist', plist('com.google.Chrome'))
  await h.write(
    `${CHROME}/Local State`,
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: 'Personal', user_name: 'someone@gmail.example', gaia_id: '123' },
          'Profile 1': { name: 'Work', user_name: 'not an email' },
          'Profile 2': { name: 'Work' },
        },
      },
    }),
  )
  // Default: claude main (log, Latin-1), codex (table, Snappy), a token value next to it, another site's key.
  const d = `${CHROME}/Default/Local Storage/leveldb`
  await bin(
    h,
    `${d}/000003.log`,
    logFile([
      {
        key: lsKey('https://claude.ai', `persisted.ccd-session-presets.${CLAUDE_MAIN}.${CLAUDE_ORG}`),
        value: SECRET,
      },
      { key: lsKey('https://claude.ai', 'theme'), value: 'dark' },
      { key: lsKey('https://example.com', `x.${CLAUDE_WORK}`), value: '1' },
    ]),
  )
  await bin(
    h,
    `${d}/000005.ldb`,
    tableFile([{ key: lsKey('https://chatgpt.com', `cache/${CODEX_USER}/ws-uuid/models`), value: SECRET }]),
  )
  // Profile 1: claude work in UTF-16, and a key with the id glued to more letters (not a match).
  const p1 = `${CHROME}/Profile 1/Local Storage/leveldb`
  await bin(
    h,
    `${p1}/000003.log`,
    logFile([
      { key: lsKey('https://claude.ai', `frame:${CLAUDE_ORG}:${CLAUDE_WORK}`, true), value: '1' },
      { key: lsKey('https://chatgpt.com', `cache/${CODEX_USER}x/ws/models`), value: '1' },
    ]),
  )
  // Profile 2: claude main once, deleted later.
  const p2 = `${CHROME}/Profile 2/Local Storage/leveldb`
  await bin(
    h,
    `${p2}/000005.ldb`,
    tableFile([{ key: lsKey('https://claude.ai', `persisted.${CLAUDE_MAIN}`), value: '1' }], 10, true),
  )
  await bin(
    h,
    `${p2}/000006.log`,
    logFile([{ key: lsKey('https://claude.ai', `persisted.${CLAUDE_MAIN}`) }], 50),
  )
  const old = new Date('2026-01-01T00:00:00Z')
  for (const f of [`${p1}/000003.log`]) await utimes(h.path(f), old, old)
  const older = new Date('2026-02-01T00:00:00Z')
  for (const f of [`${p2}/000005.ldb`, `${p2}/000006.log`]) await utimes(h.path(f), older, older)
  if (opts.enabled !== false)
    await h.write('.config/sideby/config.json', JSON.stringify({ browser: { signIns: true } }))
}

async function setup(h: FakeHome, opts: { enabled?: boolean; platform?: NodeJS.Platform } = {}) {
  await seed(h, opts)
  const fake = fakeDeps(h, opts.platform)
  const rt = await createRuntime({ env: h.env, desktop: fake.deps })
  return { rt, fake }
}

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UserError, String(err))
    assert.equal(err.code, code)
    return true
  })
}

// --- tests -------------------------------------------------------------------------------------------------------

describe('leveldb key names', () => {
  it('decompresses Snappy literals and copies', () => {
    // "abc" as a literal, then a 1-byte-offset copy of 6 bytes from 3 back.
    const out = snappyDecompress(Uint8Array.from([9, 2 << 2, 0x61, 0x62, 0x63, (2 << 2) | 1, 3]))
    assert.equal(Buffer.from(out).toString(), 'abcabcabc')
  })

  it('takes key names of the asked origins only, never a value, and drops keys deleted later', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await localStorageKeys(h.path(`${CHROME}/Default/Local Storage/leveldb`), [
        'https://claude.ai',
        'https://chatgpt.com',
      ])
      assert.deepEqual([...(r.keys.get('https://claude.ai') ?? [])].sort(), [
        `persisted.ccd-session-presets.${CLAUDE_MAIN}.${CLAUDE_ORG}`,
        'theme',
      ])
      assert.deepEqual([...(r.keys.get('https://chatgpt.com') ?? [])], [`cache/${CODEX_USER}/ws-uuid/models`])
      assert.ok(!JSON.stringify([...r.keys.values()].map((s) => [...s])).includes(SECRET))
      assert.deepEqual(r.problems, [])
      const p2 = await localStorageKeys(h.path(`${CHROME}/Profile 2/Local Storage/leveldb`), [
        'https://claude.ai',
      ])
      assert.equal(p2.keys.get('https://claude.ai')?.size, 0)
    })
  })

  it('reads UTF-16 key names and tolerates a record cut short', async () => {
    await withFakeHome(async (h) => {
      const full = logFile([{ key: lsKey('https://claude.ai', 'ünïcode', true), value: 'v' }])
      await bin(h, 'ls/000001.log', full)
      await bin(h, 'ls/000002.log', full.subarray(0, full.length - 3))
      const r = await localStorageKeys(h.path('ls'), ['https://claude.ai'])
      assert.deepEqual([...(r.keys.get('https://claude.ai') ?? [])], ['ünïcode'])
    })
  })
})

describe('keyHasId', () => {
  it('matches a whole segment only', () => {
    assert.ok(keyHasId(`a.${CLAUDE_MAIN}.b`, CLAUDE_MAIN))
    assert.ok(keyHasId(`cache/${CODEX_USER}/x`, CODEX_USER))
    assert.ok(keyHasId(CLAUDE_MAIN.toUpperCase(), CLAUDE_MAIN))
    assert.ok(!keyHasId(`cache/${CODEX_USER}x/y`, CODEX_USER))
    assert.ok(!keyHasId(`x${CLAUDE_MAIN}`, CLAUDE_MAIN))
  })
})

describe('sideby browser: report', () => {
  it('reads nothing of the browser while it is off', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, { enabled: false })
      const r = await browserReport(rt, await rt.accounts())
      assert.equal(r.enabled, false)
      assert.deepEqual(r.profiles, [])
      assert.deepEqual(r.families, { matched: ['claude', 'codex'], openOnly: ['grok'] })
    })
  })

  it('matches claude by account id and codex by ChatGPT user id, newest browser user first, never showing an id', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const r = await browserReport(rt, await rt.accounts())
      assert.equal(r.found, true)
      assert.deepEqual(
        r.profiles.map((p) => [p.dir, p.name, p.signIns]),
        [
          ['Default', 'Personal', ['claude:main', 'codex:main']],
          ['Profile 2', 'Work', []],
          ['Profile 1', 'Work', ['claude:work']],
        ],
      )
      const text = JSON.stringify(r)
      for (const secret of [CLAUDE_MAIN, CLAUDE_WORK, CODEX_USER, SECRET])
        assert.ok(!text.includes(secret), secret)
      // The Google account each browser user uses in Chrome is shown; nothing else of Local State is.
      assert.deepEqual(
        r.profiles.map((p) => p.email),
        ['someone@gmail.example', undefined, undefined],
      )
      assert.ok(!text.includes('gaia'), 'gaia_id')
      assert.ok(Value.Check(OUTPUT_SCHEMAS.browser!, { schemaVersion: 1, ...r }))
    })
  })

  it('keeps only the strongest trace: a key left from an earlier sign-in does not count', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const state = JSON.parse(await readFile(h.path(`${CHROME}/Local State`), 'utf8'))
      state.profile.info_cache['Profile 3'] = { name: 'Lab' }
      await h.write(`${CHROME}/Local State`, JSON.stringify(state))
      const main = (n: string) => ({ key: lsKey('https://claude.ai', `${n}.${CLAUDE_MAIN}`), value: '1' })
      const work = (n: string) => ({ key: lsKey('https://claude.ai', `${n}:${CLAUDE_WORK}`), value: '1' })
      await bin(h, `${CHROME}/Default/Local Storage/leveldb/000007.log`, logFile([main('a'), main('b')], 200))
      // Profile 3 is signed in to work now, and keeps one key of main from before.
      await bin(
        h,
        `${CHROME}/Profile 3/Local Storage/leveldb/000003.log`,
        logFile([work('a'), work('b'), work('c'), main('read-state')]),
      )
      const rt = await createRuntime({ env: h.env, desktop: fakeDeps(h).deps })
      const r = await browserReport(rt, await rt.accounts())
      const by = Object.fromEntries(r.profiles.map((p) => [p.dir, p.signIns]))
      assert.deepEqual(by, {
        Default: ['claude:main', 'codex:main'],
        'Profile 1': [],
        'Profile 2': [],
        'Profile 3': ['claude:work'],
      })
    })
  })

  it('reports nothing on another platform', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, { platform: 'linux' })
      assert.deepEqual((await browserReport(rt, await rt.accounts())).profiles, [])
    })
  })
})

describe('sideby browser: open', () => {
  it('opens the only browser user that signed in, with Chrome unchanged and nothing written', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const before = await snapshot(h.home)
      const r = await openInBrowser(rt, await rt.resolve('claude:work'))
      assert.deepEqual(r.profile, { dir: 'Profile 1', name: 'Work' })
      assert.deepEqual(
        fake.calls.filter((c) => c.cmd === '/usr/bin/open').map((c) => c.args),
        [
          [
            '-na',
            h.path('Apps/Google Chrome.app'),
            '--args',
            '--profile-directory=Profile 1',
            'https://claude.ai',
          ],
        ],
      )
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('opens a browser user named by the Google account it uses in Chrome', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const r = await openInBrowser(rt, await rt.resolve('grok:main'), 'Someone@gmail.example')
      assert.deepEqual(r.profile, { dir: 'Default', name: 'Personal' })
    })
  })

  it('opens grok in a browser user named by folder, and asks when a name is shared or unknown', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const grok = await rt.resolve('grok:main')
      await refused(openInBrowser(rt, grok), 'profile-needed')
      await refused(openInBrowser(rt, grok, 'Work'), 'profile-ambiguous')
      await refused(openInBrowser(rt, grok, 'Nope'), 'profile-unknown')
      const r = await openInBrowser(rt, grok, 'Profile 2')
      assert.equal(r.url, 'https://grok.com')
      assert.equal(fake.calls.filter((c) => c.cmd === '/usr/bin/open').length, 1)
      assert.equal((await openInBrowser(rt, grok, 'personal')).profile.dir, 'Default')
    })
  })

  it('refuses an API account, a missing Chrome, another platform and a failed open', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      await refused(openInBrowser(rt, await rt.resolve('claude:deepseek')), 'no-website')
      fake.openCode = 1
      await refused(openInBrowser(rt, await rt.resolve('claude:work')), 'open-failed')
      const linux = await createRuntime({ env: h.env, desktop: fakeDeps(h, 'linux').deps })
      await refused(openInBrowser(linux, await linux.resolve('claude:work')), 'unsupported')
      const none = fakeDeps(h)
      none.deps.appDirs = [h.path('Nowhere')]
      const noChrome = await createRuntime({ env: h.env, desktop: none.deps })
      await refused(openInBrowser(noChrome, await noChrome.resolve('claude:work')), 'not-installed')
    })
  })
})

describe('sideby browser: WSL', () => {
  const USERS = ['mnt', 'c', 'Users'].join('/')
  const WIN_CHROME = `${USERS}/Me/AppData/Local/Google/Chrome/User Data`
  const CMD = 'mnt/c/Windows/System32/cmd.exe'
  const EXE = 'mnt/c/Program Files/Google/Chrome/Application/chrome.exe'

  /** The fixture's Chrome moved to where Windows keeps it, and a `cmd.exe` that answers `cmdOut` (or fails). */
  async function wsl(h: FakeHome, cmdOut: string | null) {
    await seed(h)
    await cp(h.path(CHROME), h.path(WIN_CHROME), { recursive: true, preserveTimestamps: true })
    await rm(h.path(CHROME), { recursive: true })
    const f: Fake = { calls: [], deps: {}, openCode: 0 }
    const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
      f.calls.push({ cmd, args: [...args] })
      if (cmd !== h.path(CMD)) return { code: 1, stdout: '', stderr: `unexpected ${cmd}` }
      if (args.includes('start')) return { code: f.openCode, stdout: '', stderr: '' }
      return cmdOut === null
        ? { code: 1, stdout: '', stderr: 'no interop' }
        : { code: 0, stdout: cmdOut, stderr: '' }
    }
    f.deps = { platform: 'linux', wslMount: h.path('mnt'), appDirs: [], exec }
    return { rt: await createRuntime({ env: h.env, desktop: f.deps }), fake: f }
  }
  const ANSWER = 'C:\\Users\\Me\\AppData\\Local|C:\\Program Files|C:\\Program Files (x86)\r\n'

  it("reads Windows' Chrome from the folders cmd.exe names, asking once", async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await wsl(h, ANSWER)
      for (let i = 0; i < 2; i++) {
        const r = await browserReport(rt, await rt.accounts())
        assert.equal(r.found, true)
        assert.deepEqual(
          r.profiles.map((p) => [p.dir, p.signIns]),
          [
            ['Default', ['claude:main', 'codex:main']],
            ['Profile 2', []],
            ['Profile 1', ['claude:work']],
          ],
        )
      }
      assert.equal(fake.calls.length, 1)
      assert.deepEqual(fake.calls[0]?.args, [
        '/d',
        '/c',
        'echo %LOCALAPPDATA%^|%ProgramFiles%^|%ProgramFiles(x86)%',
      ])
    })
  })

  it('without cmd.exe, uses the only Windows user with Chrome and does not guess between several', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await wsl(h, null)
      const r = await browserReport(rt, await rt.accounts())
      assert.equal(r.found, true)
      assert.equal(r.profiles.length, 3)
      await h.write(`${USERS}/Other/AppData/Local/Google/Chrome/User Data/Local State`, '{}')
      const two = await browserReport(rt, await rt.accounts())
      assert.equal(two.found, false)
      assert.match(
        two.problems.join('\n'),
        /several Windows users .*Me, Other|several Windows users .*Other, Me/,
      )
    })
  })

  it("opens Windows' chrome.exe with cmd.exe start, nothing written, and refuses when it is missing or fails", async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await wsl(h, ANSWER)
      await refused(openInBrowser(rt, await rt.resolve('claude:work')), 'not-installed')
      await h.write(EXE, 'MZ')
      const before = await snapshot(h.home)
      const r = await openInBrowser(rt, await rt.resolve('claude:work'))
      assert.deepEqual(r.profile, { dir: 'Profile 1', name: 'Work' })
      assert.deepEqual(r.command, [
        h.path(CMD),
        '/d',
        '/c',
        'start',
        '',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        '--profile-directory=Profile 1',
        'https://claude.ai',
      ])
      assert.deepEqual(fake.calls.at(-1)?.args, r.command.slice(1))
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      fake.openCode = 1
      await refused(openInBrowser(rt, await rt.resolve('claude:work')), 'open-failed')
    })
  })
})

describe('sideby browser: switch', () => {
  it('shows the change, writes config only with apply, and turns off by removing the key', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h, { enabled: false })
      const before = await snapshot(h.home)
      const plan = await setBrowserSignIns(rt, true, { apply: false })
      assert.deepEqual([plan.changed, plan.applied], [true, false])
      assert.ok(plan.reads.length > 0)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
      assert.equal((await setBrowserSignIns(rt, true, { apply: true })).applied, true)
      assert.equal((await createRuntime({ env: h.env })).config.browser?.signIns, true)
      await setBrowserSignIns(rt, false, { apply: true })
      assert.deepEqual((await createRuntime({ env: h.env })).config.browser, {})
    })
  })

  it('exits 10 before --yes and prints schema-valid JSON', async () => {
    await withFakeHome(async (h) => {
      await seed(h, { enabled: false })
      const plan = await cli(h, ['browser', '--enable', '--json'])
      assert.equal(plan.code, 10)
      assert.ok(Value.Check(OUTPUT_SCHEMAS['browser-switch']!, JSON.parse(plan.out)))
      const report = await cli(h, ['browser', '--json'])
      assert.equal(report.code, 0)
      assert.ok(Value.Check(OUTPUT_SCHEMAS.browser!, JSON.parse(report.out)))
    })
  })
})

/** Adds browser users to the seeded Local State: folder → Chrome name and Google account. */
async function addProfiles(h: FakeHome, more: Record<string, { name: string; user_name?: string }>) {
  const file = `${CHROME}/Local State`
  const state = JSON.parse(await readFile(h.path(file), 'utf8'))
  Object.assign(state.profile.info_cache, more)
  await h.write(file, JSON.stringify(state))
}

const signedInTo = async (rt: Awaited<ReturnType<typeof createRuntime>>, ref: string) =>
  (await browserReport(rt, await rt.accounts())).profiles
    .filter((p) => p.signIns.includes(ref))
    .map((p) => p.dir)

describe('sideby browser: Google account (spec §3.24 "按 Google 账号收窄")', () => {
  it('keeps only the browser users whose Google account is the login email when several show the same login', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      // Profile 3 uses c@example.com in Chrome and also holds codex main's key; Default holds it as well.
      await addProfiles(h, { 'Profile 3': { name: 'Codex', user_name: 'c@example.com' } })
      await bin(
        h,
        `${CHROME}/Profile 3/Local Storage/leveldb/000003.log`,
        logFile([{ key: lsKey('https://chatgpt.com', `cache/${CODEX_USER}/ws/models`), value: '1' }]),
      )
      const rt = await createRuntime({ env: h.env, desktop: fakeDeps(h).deps })
      assert.deepEqual(await signedInTo(rt, 'codex:main'), ['Profile 3'])
    })
  })

  it('gives an account found nowhere the one browser user whose Google account is its login email', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write(
        '.codex-team/auth.json',
        JSON.stringify({
          tokens: {
            id_token: fakeJwt({
              email: 'team@example.com',
              'https://api.openai.com/auth': { user_id: 'user-Other1' },
            }),
          },
        }),
        0o600,
      )
      await addProfiles(h, { 'Profile 3': { name: 'Team', user_name: 'Team@Example.com' } })
      const rt = await createRuntime({ env: h.env, desktop: fakeDeps(h).deps })
      assert.deepEqual(await signedInTo(rt, 'codex:team'), ['Profile 3'])
      // Two browser users with that Google account: sideby does not guess.
      await addProfiles(h, { 'Profile 4': { name: 'Team 2', user_name: 'team@example.com' } })
      const again = await createRuntime({ env: h.env, desktop: fakeDeps(h).deps })
      assert.deepEqual(await signedInTo(again, 'codex:team'), [])
    })
  })
})

describe('sideby browser: chosen by the user (spec §3.24 "手动指定")', () => {
  it('replaces what was found, opens there, and forgets it again', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const before = await snapshot(h.home)
      const codex = await rt.resolve('codex:main')
      const set = await setBrowserChoice(rt, codex, 'Profile 1')
      assert.deepEqual(set, { ref: 'codex:main', profile: { dir: 'Profile 1', name: 'Work' }, changed: true })
      // Only sideby's config changed.
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), ['.config/sideby/config.json'])
      const fresh = await createRuntime({ env: h.env, desktop: fake.deps })
      assert.deepEqual(await signedInTo(fresh, 'codex:main'), ['Profile 1'])
      const r = await browserReport(fresh, await fresh.accounts())
      assert.deepEqual(r.choices, { 'codex:main': 'Profile 1' })
      assert.ok(Value.Check(OUTPUT_SCHEMAS.browser!, { schemaVersion: 1, ...r }))
      const opened = await openInBrowser(fresh, await fresh.resolve('codex:main'))
      assert.equal(opened.profile.dir, 'Profile 1')
      // A Grok account, which nothing can match, can be chosen too.
      await setBrowserChoice(fresh, await fresh.resolve('grok:main'), 'Personal')
      assert.equal((await openInBrowser(fresh, await fresh.resolve('grok:main'))).profile.dir, 'Default')
      const auto = await setBrowserChoice(fresh, await fresh.resolve('codex:main'), null)
      assert.deepEqual(auto, { ref: 'codex:main', profile: null, changed: true })
      const last = await createRuntime({ env: h.env, desktop: fake.deps })
      assert.deepEqual(await signedInTo(last, 'codex:main'), ['Default'])
      assert.deepEqual(last.config.browser?.choices, { 'grok:main': 'Default' })
    })
  })

  it('refuses an unknown or ambiguous browser user and an API account, writing nothing', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const before = await snapshot(h.home)
      await refused(setBrowserChoice(rt, await rt.resolve('codex:main'), 'Nobody'), 'profile-unknown')
      await refused(setBrowserChoice(rt, await rt.resolve('codex:main'), 'Work'), 'profile-ambiguous')
      await refused(setBrowserChoice(rt, await rt.resolve('claude:deepseek'), 'Default'), 'no-website')
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })

  it('finds the account again when the chosen browser user is gone, and says so', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ browser: { signIns: true, choices: { 'codex:main': 'Profile 9' } } }),
      )
      const rt = await createRuntime({ env: h.env, desktop: fakeDeps(h).deps })
      const r = await browserReport(rt, await rt.accounts())
      assert.deepEqual(r.choices, {})
      assert.deepEqual(await signedInTo(rt, 'codex:main'), ['Default'])
      assert.ok(r.problems.some((p) => p.includes('codex:main') && p.includes('--auto')))
    })
  })

  it('`browser set --auto` prints schema-valid JSON', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await cli(h, ['browser', 'set', 'codex:main', '--auto', '--json'])
      assert.equal(r.code, 0, r.out)
      const out = JSON.parse(r.out) as { profile: unknown; changed: boolean }
      assert.ok(Value.Check(OUTPUT_SCHEMAS['browser-set']!, out))
      assert.deepEqual([out.profile, out.changed], [null, false])
    })
  })
})

const MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url))

function cli(h: FakeHome, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: h.env, cwd: h.home })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}
