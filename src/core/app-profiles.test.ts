// App Profiles: Grok Bot windows (spec §3.20 "Grok Bot 窗口", ADR-0019). Every program goes through a fake `exec`, so
// no test starts a real app, lists real processes or asks Spotlight.
import assert from 'node:assert/strict'
import { lstat, readlink, rm, stat, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { createRuntime } from '../runtime.ts'
import type { Env } from '../types.ts'
import { listAppProfiles, openAppProfile, parseProfileRef, removeAppProfile } from './app-profiles.ts'
import type { DesktopDeps, ExecResult } from './desktop-app.ts'
import { UserError } from './errors.ts'

const SUPPORT = 'Library/Application Support'
const ROOT = `${SUPPORT}/sideby/grok-bot`

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key>
  <string>Grok Bot</string>
  <key>CFBundleIdentifier</key>
  <string>com.anysphere.sand</string>
</dict></plist>
`

interface Fake {
  calls: { cmd: string; args: string[]; env?: Env }[]
  deps: Partial<DesktopDeps>
  procs: string[]
  psCode: number
  activate: string
}

function fakeDeps(appDirs: string[], platform: NodeJS.Platform = 'darwin'): Fake {
  const f: Fake = { calls: [], deps: {}, procs: [], psCode: 0, activate: 'ok' }
  const exec = async (cmd: string, args: readonly string[], env?: Env): Promise<ExecResult> => {
    f.calls.push({ cmd, args: [...args], ...(env ? { env } : {}) })
    if (cmd === '/bin/ps')
      return f.psCode
        ? { code: f.psCode, stdout: '', stderr: 'ps failed' }
        : { code: 0, stdout: `${f.procs.join('\n')}\n`, stderr: '' }
    if (cmd === '/usr/bin/osascript') return { code: 0, stdout: `${f.activate}\n`, stderr: '' }
    if (cmd === '/usr/bin/open') return { code: 0, stdout: '', stderr: '' }
    if (cmd === '/usr/bin/mdfind') return { code: 0, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` }
  }
  f.deps = { platform, appDirs, exec }
  return f
}

async function setup(h: FakeHome, opts: { installed?: boolean; env?: Env; platform?: NodeJS.Platform } = {}) {
  await h.write('.grok/skills/x.md', 'x\n')
  await h.write('.grok-001/skills/x.md', 'x\n')
  if (opts.installed !== false) await h.write('Apps/Grok Bot.app/Contents/Info.plist', plist)
  else await rm(h.path('Apps'), { recursive: true, force: true })
  const fake = fakeDeps([h.path('Apps')], opts.platform)
  const rt = await createRuntime({ env: { ...h.env, ...opts.env }, desktop: fake.deps })
  return { rt, fake, app: h.path('Apps/Grok Bot.app') }
}

const opens = (f: Fake) => f.calls.filter((c) => c.cmd === '/usr/bin/open')
const proc = (app: string, pid: number, dir?: string) =>
  `  ${pid} ${app}/Contents/MacOS/Grok Bot${dir ? ` --user-data-dir=${dir}` : ''}`

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UserError, String(err))
    assert.equal(err.code, code)
    return true
  })
}

describe('app profiles: refs', () => {
  it('reads grok-bot refs and nothing else', () => {
    assert.equal(parseProfileRef('grok-bot')?.name, 'main')
    assert.equal(parseProfileRef('grok-bot:work')?.name, 'work')
    assert.equal(parseProfileRef('grok:work'), undefined)
    assert.equal(parseProfileRef('grok-botx:work'), undefined)
  })
})

describe('app profiles: listing', () => {
  it('lists the main window first, then the folders with a valid name, with what the app wrote about sign-in', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake, app } = await setup(h)
      await h.write(`${SUPPORT}/Grok Bot/desktop-status.json`, '{"version":1,"pid":9,"signedIn":true}', 0o600)
      await h.write(`${ROOT}/work/desktop-status.json`, '{"version":1,"pid":10,"signedIn":false}', 0o600)
      await h.mkdir(`${ROOT}/001`)
      await h.write(`${ROOT}/zz/desktop-status.json`, 'not json')
      await h.mkdir(`${ROOT}/Bad Name`)
      await h.write(`${ROOT}/file`, 'x')
      await symlink(h.path(`${ROOT}/001`), h.path(`${ROOT}/linked`))
      fake.procs = [proc(app, 10, h.path(`${ROOT}/work`))]
      const list = await listAppProfiles(rt)
      assert.deepEqual(
        list.map((p) => [p.ref, p.running, p.signedIn]),
        [
          ['grok-bot:main', false, true],
          ['grok-bot:001', false, undefined],
          ['grok-bot:work', true, false],
          ['grok-bot:zz', false, undefined],
        ],
      )
      assert.equal(list[0]!.appData, undefined)
      assert.equal(list[2]!.appData, h.path(`${ROOT}/work`))
      const data = { schemaVersion: 1, families: [], accounts: [], appProfiles: list, pluginErrors: [] }
      assert.ok(Value.Check(OUTPUT_SCHEMAS.list!, data))
    })
  })

  it('shows nothing off macOS, or when the app is missing and no window was made; keeps made windows', async () => {
    await withFakeHome(async (h) => {
      const linux = await setup(h, { platform: 'linux' })
      assert.deepEqual(await listAppProfiles(linux.rt), [])
      const none = await setup(h, { installed: false })
      assert.deepEqual(await listAppProfiles(none.rt), [])
      await h.mkdir(`${ROOT}/work`)
      const kept = await listAppProfiles(none.rt)
      assert.deepEqual(
        kept.map((p) => [p.ref, p.installed]),
        [
          ['grok-bot:main', false],
          ['grok-bot:work', false],
        ],
      )
      assert.equal(none.fake.calls.filter((c) => c.cmd === '/bin/ps').length, 0)
    })
  })
})

describe('app profiles: opening', () => {
  it('creates a new window folder and opens it with only that folder, clearing variables that would move it', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake, app } = await setup(h, {
        env: {
          SAND_DATA_ROOT: '/x',
          SAND_USER_DATA_DIR: '/y',
          SIDEBY_ACCOUNT: 'grok:001',
          CLAUDE_CODE_SESSION_ID: 's',
          LANG: 'en_US.UTF-8',
        },
      })
      fake.procs = [proc(app, 9)]
      const r = await openAppProfile(rt, 'grok-bot:work')
      const data = h.path(`${ROOT}/work`)
      assert.equal(r.action, 'started')
      assert.equal(r.ref, 'grok-bot:work')
      assert.equal(r.family, 'grok-bot')
      assert.equal(r.createdAppData, true)
      assert.equal((await stat(data)).mode & 0o777, 0o700)
      const call = opens(fake)[0]!
      assert.deepEqual(call.args, ['-n', '-a', app, '--args', `--user-data-dir=${data}`])
      for (const v of ['SAND_DATA_ROOT', 'SAND_USER_DATA_DIR', 'SIDEBY_ACCOUNT', 'CLAUDE_CODE_SESSION_ID'])
        assert.equal(call.env?.[v], undefined, v)
      assert.equal(call.env?.LANG, 'en_US.UTF-8')
      assert.match(r.notices.join('\n'), /sign in inside it with the account you want for this window/)
      assert.match(r.notices.join('\n'), /Close the other Grok Bot windows/, 'another window runs')
      assert.ok(Value.Check(OUTPUT_SCHEMAS.desktop!, { schemaVersion: 1, ...r }))

      // Open again while it runs: brought to the front, no second window.
      fake.procs.push(proc(app, 10, data))
      const again = await openAppProfile(rt, 'grok-bot:work')
      assert.equal(again.action, 'focused')
      assert.equal(opens(fake).length, 1)
    })
  })

  it('opens the main window on the app default, and says nothing about signing in', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake, app } = await setup(h)
      fake.procs = [proc(app, 10, h.path(`${ROOT}/work`))]
      const r = await openAppProfile(rt, 'grok-bot')
      assert.equal(r.ref, 'grok-bot:main')
      assert.equal(r.appData, undefined)
      assert.deepEqual(opens(fake)[0]!.args, ['-n', '-a', app])
      assert.deepEqual(r.notices, [])
      // Without a process list a running main window cannot be ruled out: plain `open -a`.
      fake.psCode = 1
      await openAppProfile(rt, 'grok-bot:main')
      assert.deepEqual(opens(fake)[1]!.args, ['-a', app])
    })
  })

  it('refuses a bad name, another platform, a missing app and a file where the folder goes', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      await refused(openAppProfile(rt, 'grok-bot:Work'), 'invalid-name')
      await refused(openAppProfile(rt, 'grok-bot:'), 'invalid-name')
      await h.write(`${ROOT}/taken`, 'x')
      await refused(openAppProfile(rt, 'grok-bot:taken'), 'app-data-invalid')
      assert.equal(opens(fake).length, 0)
      const linux = await setup(h, { platform: 'linux' })
      await refused(openAppProfile(linux.rt, 'grok-bot:work'), 'not-macos')
      const none = await setup(h, { installed: false })
      await assert.rejects(openAppProfile(none.rt, 'grok-bot:work'), (err: UserError) => {
        assert.equal(err.code, 'app-not-installed')
        assert.match(err.message, /install it from https:\/\/x\.ai\/bot\//)
        return true
      })
      assert.equal(await lstat(h.path(`${ROOT}/work`)).catch(() => null), null)
    })
  })

  it('writes nothing into any Host account directory', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const before = await snapshot(h.path('.grok'))
      const home = await snapshot(h.home)
      await openAppProfile(rt, 'grok-bot:work')
      await openAppProfile(rt, 'grok-bot:main')
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.grok'))), [])
      assert.deepEqual(diffSnapshots(home, await snapshot(h.home)), [
        'Library',
        SUPPORT,
        `${SUPPORT}/sideby`,
        `${SUPPORT}/sideby/grok-bot`,
        `${ROOT}/work`,
      ])
    })
  })
})

describe('app profiles: removing', () => {
  it('shows the plan without --yes, then deletes only that window folder', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      await h.write(`${ROOT}/work/sand-data/settings.json`, '{}')
      await h.mkdir(`${ROOT}/other`)
      const plan = await removeAppProfile(rt, 'grok-bot:work', { yes: false })
      assert.deepEqual(plan, {
        ref: 'grok-bot:work',
        app: 'Grok Bot',
        appData: h.path(`${ROOT}/work`),
        removed: false,
      })
      assert.ok(await lstat(h.path(`${ROOT}/work`)))
      assert.ok(Value.Check(OUTPUT_SCHEMAS['desktop-remove']!, { schemaVersion: 1, ...plan }))
      const done = await removeAppProfile(rt, 'grok-bot:work', { yes: true })
      assert.equal(done.removed, true)
      assert.equal(await lstat(h.path(`${ROOT}/work`)).catch(() => null), null)
      assert.ok(await lstat(h.path(`${ROOT}/other`)))
    })
  })

  it('refuses the main window, a running one, an unknown state, a missing one and a link', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake, app } = await setup(h)
      await refused(removeAppProfile(rt, 'grok-bot:main', { yes: true }), 'main-profile')
      await refused(removeAppProfile(rt, 'grok-bot', { yes: true }), 'main-profile')
      await refused(removeAppProfile(rt, 'grok-bot:none', { yes: true }), 'no-profile')
      await h.mkdir(`${ROOT}/work`)
      fake.procs = [proc(app, 10, h.path(`${ROOT}/work`))]
      await refused(removeAppProfile(rt, 'grok-bot:work', { yes: true }), 'app-running')
      fake.procs = []
      fake.psCode = 1
      await refused(removeAppProfile(rt, 'grok-bot:work', { yes: true }), 'app-running')
      assert.ok(await lstat(h.path(`${ROOT}/work`)))
      await h.mkdir('elsewhere/keep')
      await symlink(h.path('elsewhere/keep'), h.path(`${ROOT}/linked`))
      fake.psCode = 0
      await refused(removeAppProfile(rt, 'grok-bot:linked', { yes: true }), 'app-data-invalid')
      assert.equal(await readlink(h.path(`${ROOT}/linked`)), h.path('elsewhere/keep'))
      assert.ok(await lstat(h.path('elsewhere/keep')))
      const linux = await setup(h, { platform: 'linux' })
      await refused(removeAppProfile(linux.rt, 'grok-bot:work', { yes: true }), 'not-macos')
    })
  })
})

describe('app profiles: list output', () => {
  it('sideby list --json carries appProfiles that match the schema', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const list = await listAppProfiles(rt)
      assert.equal(list.length, 1)
      assert.deepEqual(list[0], {
        ref: 'grok-bot:main',
        app: 'Grok Bot',
        name: 'main',
        isMain: true,
        installed: true,
        running: false,
      })
    })
  })
})
