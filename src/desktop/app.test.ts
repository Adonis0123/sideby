// `sideby app install|uninstall`: generated files, the icon, ownership checks and the launcher script's behaviour.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, constants, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { UserError } from '../core/errors.ts'
import {
  type AppContext,
  desktopEntry,
  installApp,
  launcherScript,
  type Runner,
  uninstallApp,
} from './app.ts'
import { APP_MARKER, encodeIcns, ICONSET, iconPng, iconSvg } from './icon.ts'

const MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const NODE = '/opt/node/bin/node'
const ENTRY = '/opt/sideby/dist/src/cli/main.js'

/** Decodes the PNGs this module writes (8-bit RGBA, filter 0) back to pixels. */
function decodePng(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let off = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  const text: string[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('latin1', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)]
    if (type === 'IDAT') idat.push(data)
    if (type === 'tEXt') text.push(data.toString('latin1'))
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = (x: number, y: number) => [...raw.subarray(y * (width * 4 + 1) + 1 + x * 4).subarray(0, 4)]
  return { width, height, text, px }
}

function ctx(h: FakeHome, platform: NodeJS.Platform, calls: string[][] = []): AppContext {
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args])
    // The real iconutil on macOS; every other helper is stubbed out.
    if (cmd === 'iconutil' && process.platform === 'darwin')
      return new Promise((r) => execFile(cmd, args, (err) => r(!err)))
    return false
  }
  return { home: h.home, env: h.env, platform, run }
}

describe('app icon', () => {
  it('draws the Panel logo with antialiased edges at every iconset size', () => {
    assert.deepEqual(
      ICONSET.map((i) => i.size),
      [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024],
    )
    const { width, height, text, px } = decodePng(iconPng(256))
    assert.deepEqual([width, height], [256, 256])
    assert.deepEqual(text, [`Software\0${APP_MARKER}`])
    assert.deepEqual(px(0, 0), [0, 0, 0, 0], 'outside the tile is transparent')
    assert.deepEqual(px(128, 60), [0x15, 0x17, 0x1c, 255], 'the tile is the Panel dark')
    // Bars sit at 11-18 and 22-29 of the 40-unit logo; the tile is 824/1024 of the canvas, centred.
    const at = (u: number) => Math.floor(25 + (u * 206) / 40)
    assert.deepEqual(px(at(14.5), 128), [0xf5, 0xf6, 0xf8, 255], 'first bar opaque')
    const second = px(at(25.5), 128)
    assert.equal(second[0], Math.round(0xf5 * 0.55 + 0x15 * 0.45), 'second bar at 55%')
    assert.deepEqual(px(at(20), 128), [0x15, 0x17, 0x1c, 255], 'gap between the bars')
    const edge = Array.from({ length: 256 }, (_, y) => px(25, y)[3]!)
    assert.ok(
      edge.some((a) => a > 0 && a < 255),
      'the rounded corner is antialiased',
    )
    for (const { size } of ICONSET) assert.equal(decodePng(iconPng(size)).width, size)
  })

  it('writes an ICNS container and an SVG with the marker', () => {
    const icns = encodeIcns(new Map([['icon_16x16.png', iconPng(16)]]))
    assert.equal(icns.toString('latin1', 0, 4), 'icns')
    assert.equal(icns.readUInt32BE(4), icns.length)
    assert.equal(icns.toString('latin1', 8, 12), 'icp4')
    assert.match(iconSvg(), new RegExp(`<svg[^]*${APP_MARKER}[^]*fill-opacity="0.55"`))
  })
})

describe('app install on Linux', () => {
  it('writes a desktop entry, launcher and icons, updates in place, and uninstalls only its own files', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const c = ctx(h, 'linux', calls)
      const before = await snapshot(h.home)
      const r = await installApp(c, { node: NODE, entry: ENTRY, version: '1.2.3' })
      const data = h.path('.local/share')
      assert.equal(r.path, `${data}/applications/sideby.desktop`)
      assert.equal(r.updated, false)
      assert.ok(Value.Check(OUTPUT_SCHEMAS['app-install']!, { schemaVersion: 1, ...r }))
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [
        '.local',
        '.local/share',
        '.local/share/applications',
        '.local/share/applications/sideby.desktop',
        '.local/share/icons',
        '.local/share/icons/hicolor',
        '.local/share/icons/hicolor/256x256',
        '.local/share/icons/hicolor/256x256/apps',
        '.local/share/icons/hicolor/256x256/apps/sideby.png',
        '.local/share/icons/hicolor/scalable',
        '.local/share/icons/hicolor/scalable/apps',
        '.local/share/icons/hicolor/scalable/apps/sideby.svg',
        '.local/share/sideby',
        '.local/share/sideby/sideby-launcher',
      ])
      const launcher = `${data}/sideby/sideby-launcher`
      assert.equal(await readFile(r.path, 'utf8'), desktopEntry(launcher))
      assert.match(await readFile(r.path, 'utf8'), /^Exec=".*\/sideby-launcher"$/m)
      assert.match(await readFile(r.path, 'utf8'), /^Icon=sideby$/m)
      await access(launcher, constants.X_OK)
      const script = await readFile(launcher, 'utf8')
      assert.match(script, new RegExp(`^NODE='${NODE}'$`, 'm'))
      assert.match(script, new RegExp(`^ENTRY='${ENTRY}'$`, 'm'))
      assert.match(script, /"\$NODE" "\$ENTRY" ui --background/)
      assert.match(script, new RegExp(`^export XDG_CONFIG_HOME='${h.home}/.config'$`, 'm'))
      assert.deepEqual(calls, [['update-desktop-database', `${data}/applications`]])

      const again = await installApp(c, {
        node: NODE,
        entry: ENTRY,
        url: 'http://accounts.localhost:17333',
        version: '1.2.3',
      })
      assert.equal(again.updated, true)
      assert.equal(again.mode, 'url')
      assert.equal(again.url, 'http://accounts.localhost:17333/')
      assert.match(await readFile(launcher, 'utf8'), /^URL='http:\/\/accounts\.localhost:17333\/'$/m)

      // A file someone else put there survives both install and uninstall.
      const svg = `${data}/icons/hicolor/scalable/apps/sideby.svg`
      await writeFile(svg, '<svg>mine</svg>')
      await assert.rejects(installApp(c, { node: NODE, entry: ENTRY, version: '1' }), UserError)
      const un = await uninstallApp(c)
      assert.ok(Value.Check(OUTPUT_SCHEMAS['app-uninstall']!, { schemaVersion: 1, ...un }))
      assert.deepEqual(
        un.skipped.map((s) => s.path),
        [svg],
      )
      assert.equal(un.removed.length, 3)
      assert.equal(await readFile(svg, 'utf8'), '<svg>mine</svg>')
    })
  })

  it('rejects a non-http --url and unsupported platforms', async () => {
    await withFakeHome(async (h) => {
      await assert.rejects(
        installApp(ctx(h, 'linux'), { node: NODE, entry: ENTRY, url: 'file:///etc/passwd', version: '1' }),
        /must start with http/,
      )
      await assert.rejects(
        installApp(ctx(h, 'win32'), { node: NODE, entry: ENTRY, version: '1' }),
        /macOS and Linux/,
      )
    })
  })
})

describe('app install refuses links and odd files', () => {
  it('on Linux: never writes through or removes a symlinked target, even one pointing at a marked file', async () => {
    await withFakeHome(async (h) => {
      const c = ctx(h, 'linux')
      const data = h.path('.local/share')
      const launcher = `${data}/sideby/sideby-launcher`
      // An outside file that looks exactly like ours, reached through a symlink at the install target.
      const ours = launcherScript({ node: NODE, entry: ENTRY, platform: 'linux', xdg: {} })
      const outside = await h.write('outside/launcher', ours)
      await mkdir(dirname(launcher), { recursive: true })
      await symlink(outside, launcher)
      await assert.rejects(
        installApp(c, { node: NODE, entry: ENTRY, version: '1' }),
        (err: Error) => err instanceof UserError && /is a symbolic link/.test(err.message),
      )
      assert.equal(await readFile(outside, 'utf8'), ours)
      assert.ok((await lstat(launcher)).isSymbolicLink())
      const un = await uninstallApp(c)
      assert.deepEqual(
        un.skipped.map((s) => [s.path, /symbolic link/.test(s.reason)]),
        [[launcher, true]],
      )
      assert.equal(await readFile(outside, 'utf8'), ours)
      assert.ok((await lstat(launcher)).isSymbolicLink())

      // A directory where a file belongs, and a file that only mentions the marker, are not ours either.
      await rm(launcher)
      const png = `${data}/icons/hicolor/256x256/apps/sideby.png`
      await mkdir(png, { recursive: true })
      await assert.rejects(installApp(c, { node: NODE, entry: ENTRY, version: '1' }), /not a regular file/)
      await rm(png, { recursive: true })
      const desktop = `${data}/applications/sideby.desktop`
      await h.write('.local/share/applications/sideby.desktop', `[Desktop Entry]\nComment=${APP_MARKER}\n`)
      await assert.rejects(installApp(c, { node: NODE, entry: ENTRY, version: '1' }), /not created by/)
      assert.deepEqual(
        (await uninstallApp(c)).skipped.map((s) => s.path),
        [desktop],
      )
    })
  })

  it('on macOS: refuses a symlinked bundle and links inside a marked bundle', async () => {
    await withFakeHome(async (h) => {
      const c = ctx(h, 'darwin')
      // A genuine marked bundle elsewhere, reached through a symlink at ~/Applications/sideby.app.
      const other = await installApp(
        { ...c, home: h.path('other') },
        { node: NODE, entry: ENTRY, version: '1' },
      )
      const before = await snapshot(other.path)
      const app = h.path('Applications/sideby.app')
      await mkdir(h.path('Applications'), { recursive: true })
      await symlink(other.path, app)
      await assert.rejects(installApp(c, { node: NODE, entry: ENTRY, version: '2' }), /is a symbolic link/)
      assert.deepEqual(
        (await uninstallApp(c)).skipped.map((s) => s.path),
        [app],
      )
      assert.deepEqual(diffSnapshots(before, await snapshot(other.path)), [])
      assert.ok((await lstat(app)).isSymbolicLink())
      await rm(app)

      // A real bundle whose Info.plist, launcher or icon is a link to a marked file outside.
      for (const inner of [
        'Contents/Info.plist',
        'Contents/MacOS/sideby',
        'Contents/Resources/AppIcon.icns',
      ]) {
        await installApp(c, { node: NODE, entry: ENTRY, version: '1' })
        await rm(join(app, inner))
        await symlink(join(other.path, inner), join(app, inner))
        await assert.rejects(
          installApp(c, { node: NODE, entry: ENTRY, version: '2' }),
          (err: Error) => /is a symbolic link/.test(err.message) && err.message.includes(inner),
          inner,
        )
        assert.equal((await uninstallApp(c)).removed.length, 0, inner)
        assert.deepEqual(diffSnapshots(before, await snapshot(other.path)), [], inner)
        await rm(app, { recursive: true })
      }
    })
  })
})

describe('app install on macOS', () => {
  it('builds ~/Applications/sideby.app with Info.plist, launcher and icon, and refuses a foreign bundle', async () => {
    await withFakeHome(async (h) => {
      const calls: string[][] = []
      const c = ctx(h, 'darwin', calls)
      const r = await installApp(c, { node: NODE, entry: ENTRY, version: '1.2.3' })
      const app = h.path('Applications/sideby.app')
      assert.equal(r.path, app)
      const plist = await readFile(join(app, 'Contents/Info.plist'), 'utf8')
      assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.sideby\.panel<\/string>/)
      assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>sideby<\/string>/)
      assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/)
      assert.ok(plist.includes(APP_MARKER))
      const exe = join(app, 'Contents/MacOS/sideby')
      assert.equal((await stat(exe)).mode & 0o777, 0o755)
      assert.match(await readFile(exe, 'utf8'), /^#!\/bin\/sh\n/)
      const icns = await readFile(join(app, 'Contents/Resources/AppIcon.icns'))
      assert.equal(icns.toString('latin1', 0, 4), 'icns')
      assert.ok(icns.length > 10_000)
      assert.equal(calls[0]![0], 'iconutil')
      assert.ok(calls.some((x) => x[0]!.endsWith('/lsregister')))
      const { readdir } = await import('node:fs/promises')
      assert.deepEqual(await readdir(h.path('Applications')), ['sideby.app'], 'no build leftovers')

      assert.equal((await installApp(c, { node: NODE, entry: ENTRY, version: '1.2.4' })).updated, true)
      assert.match(await readFile(join(app, 'Contents/Info.plist'), 'utf8'), /1\.2\.4/)
      assert.deepEqual((await uninstallApp(c)).removed, [app])

      await h.write('Applications/sideby.app/Contents/Info.plist', '<plist>someone else</plist>')
      await assert.rejects(installApp(c, { node: NODE, entry: ENTRY, version: '1' }), /not created by/)
      const un = await uninstallApp(c)
      assert.deepEqual([un.removed, un.skipped.length], [[], 1])
      assert.match(await readFile(join(app, 'Contents/Info.plist'), 'utf8'), /someone else/)
    })
  })
})

describe('launcher script', () => {
  function runScript(path: string, env: Record<string, string>) {
    return new Promise<number | null>((resolve) => {
      spawn('/bin/sh', [path], { env, stdio: 'ignore' }).on('exit', resolve)
    })
  }

  it('with a URL only opens that URL', async () => {
    await withFakeHome(async (h) => {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      await h.write(`stub/${opener}`, `#!/bin/sh\necho "$@" > "${h.path('opened')}"\n`, 0o755)
      const script = await h.write(
        'launcher',
        launcherScript({
          node: NODE,
          entry: ENTRY,
          url: 'http://accounts.localhost:17333/',
          platform: process.platform === 'darwin' ? 'darwin' : 'linux',
          xdg: {},
        }),
        0o755,
      )
      const code = await runScript(script, { HOME: h.home, PATH: `${h.path('stub')}:/usr/bin:/bin` })
      assert.equal(code, 0)
      assert.equal(await readFile(h.path('opened'), 'utf8'), 'http://accounts.localhost:17333/\n')
    })
  })

  it('without a URL runs the recorded Node and entry with `ui --background`', async () => {
    await withFakeHome(async (h) => {
      // A stand-in "node" that records its arguments instead of starting a Panel.
      const node = await h.write('fake-node', `#!/bin/sh\necho "$@" > "${h.path('ran')}"\n`, 0o755)
      const entry = await h.write('main.js', '')
      const script = await h.write(
        'launcher',
        launcherScript({ node, entry, platform: 'linux', xdg: { XDG_STATE_HOME: h.env.XDG_STATE_HOME! } }),
        0o755,
      )
      assert.equal(await runScript(script, { HOME: h.home, PATH: '/usr/bin:/bin' }), 0)
      assert.equal(await readFile(h.path('ran'), 'utf8'), `${entry} ui --background\n`)
    })
  })
})

describe('sideby app (CLI)', () => {
  function sideby(h: FakeHome, args: string[]) {
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [MAIN, ...args], { env: h.env as NodeJS.ProcessEnv })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d))
      child.on('exit', (code) => resolve({ code, out }))
    })
  }

  it('reports usage errors and an empty uninstall as JSON', async () => {
    await withFakeHome(async (h) => {
      assert.equal((await sideby(h, ['app'])).code, 2)
      assert.equal((await sideby(h, ['app', 'uninstall', '--url', 'http://x/'])).code, 2)
      const bad = await sideby(h, ['app', 'install', '--url', 'ftp://x', '--json'])
      assert.equal(bad.code, 1)
      assert.ok(Value.Check(OUTPUT_SCHEMAS.error!, JSON.parse(bad.out)))
      const un = await sideby(h, ['app', 'uninstall', '--json'])
      assert.equal(un.code, 0)
      const data = JSON.parse(un.out) as { removed: string[] }
      assert.ok(Value.Check(OUTPUT_SCHEMAS['app-uninstall']!, data))
      assert.deepEqual(data.removed, [])
    })
  })
})
