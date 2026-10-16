// Desktop Apps per Account (spec §3.20, ADR-0015). Every program goes through a fake `exec`, so no test starts a
// real app, lists real processes or asks Spotlight.
import assert from 'node:assert/strict'
import { lstat, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { HookBus } from '../plugins/bus.ts'
import { createRuntime } from '../runtime.ts'
import type { Env } from '../types.ts'
import {
  appDataDir,
  checkAppData,
  type DesktopDeps,
  desktopStatuses,
  type ExecResult,
  openDesktopApp,
} from './desktop-app.ts'
import { runDoctor } from './doctor.ts'
import { UserError } from './errors.ts'

const plist = (id: string, exe: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key>
  <string>${exe}</string>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
</dict></plist>
`

interface Call {
  cmd: string
  args: string[]
  env?: Env
}

interface Fake {
  calls: Call[]
  deps: Partial<DesktopDeps>
  /** `ps -axo pid=,command=` lines. */
  procs: string[]
  /** What the activation script prints. */
  activate: string
  mdfind: string
  openCode: number
  psCode: number
}

function fakeDeps(appDirs: string[], platform: NodeJS.Platform = 'darwin'): Fake {
  const f: Fake = {
    calls: [],
    procs: [],
    activate: 'ok',
    mdfind: '',
    openCode: 0,
    psCode: 0,
    deps: {},
  }
  const exec = async (cmd: string, args: readonly string[], env?: Env): Promise<ExecResult> => {
    f.calls.push({ cmd, args: [...args], ...(env ? { env } : {}) })
    if (cmd === '/bin/ps')
      return f.psCode
        ? { code: f.psCode, stdout: '', stderr: 'ps failed' }
        : { code: 0, stdout: `${f.procs.join('\n')}\n`, stderr: '' }
    if (cmd === '/usr/bin/osascript') return { code: 0, stdout: `${f.activate}\n`, stderr: '' }
    if (cmd === '/usr/bin/mdfind') return { code: 0, stdout: f.mdfind, stderr: '' }
    if (cmd === '/usr/bin/open')
      return { code: f.openCode, stdout: '', stderr: f.openCode ? 'LSOpenURLsWithRole() failed' : '' }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` }
  }
  f.deps = { platform, appDirs, exec }
  return f
}

const SUPPORT = 'Library/Application Support'

/** Main and `work` / `work2` accounts of claude and codex, a claude API account, grok main and `lab`, and pi. */
async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}\n')
  await h.write('.claude/.claude.json', '{"oauthAccount":{}}\n', 0o600)
  for (const n of ['work', 'work2']) {
    await h.write(`.claude-${n}/settings.json`, '{}\n')
    await h.write(`.codex-${n}/AGENTS.md`, '# rules\n')
  }
  await h.write('.codex-work/auth.json', '{}\n', 0o600)
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.write('.codex/auth.json', '{}\n', 0o600)
  await h.write('.claude-deepseek/proxy.env', 'ANTHROPIC_BASE_URL=https://example.invalid\n', 0o600)
  await h.write('.grok/skills/x.md', 'x\n')
  await h.write('.grok-lab/skills/x.md', 'x\n')
  await h.write('.pi/agent/AGENTS.md', '# rules\n')
  await h.write('Apps/Claude.app/Contents/Info.plist', plist('com.anthropic.claudefordesktop', 'Claude'))
  await h.write('Apps/ChatGPT.app/Contents/Info.plist', plist('com.openai.codex', 'ChatGPT'))
  await h.write('Apps/Grok Bot.app/Contents/Info.plist', plist('com.anysphere.sand', 'Grok Bot'))
  await h.write(`${SUPPORT}/Claude/claude_desktop_config.json`, '{"mcpServers":{}}\n')
}

async function setup(h: FakeHome, opts: { platform?: NodeJS.Platform; env?: Env } = {}) {
  await seed(h)
  const fake = fakeDeps([h.path('Apps'), h.path('Applications')], opts.platform)
  const rt = await createRuntime({ env: { ...h.env, ...opts.env }, desktop: fake.deps })
  return { rt, fake }
}

const opens = (f: Fake) => f.calls.filter((c) => c.cmd === '/usr/bin/open')

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UserError, String(err))
    assert.equal(err.code, code)
    return true
  })
}

describe('sideby desktop: launching', () => {
  it('opens Claude Desktop for a non-main account with its config dir and own app data, clearing hijack variables', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h, {
        env: {
          ANTHROPIC_API_KEY: 'sk-fake',
          CLAUDE_CONFIG_DIR: '/elsewhere',
          CLAUDE_USER_DATA_DIR: '/elsewhere',
          SIDEBY_ACCOUNT: 'claude:other',
          CLAUDE_CODE_SESSION_ID: 'sess',
          CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
          CLAUDE_CODE_CHILD_SESSION: '1',
          CLAUDECODE: '1',
          CLAUDE_PID: '42',
          CLAUDE_PLUGIN_DATA: '/x',
          CODEX_COMPANION_SESSION_ID: 'c',
          CODEX_COMPANION_TRANSCRIPT_PATH: '/t',
          CODEX_THREAD_ID: 'th',
          CODEX_SANDBOX: 'seatbelt',
          CODEX_SANDBOX_NETWORK_DISABLED: '1',
          LANG: 'en_US.UTF-8',
          CLAUDE_CODE_USE_BEDROCK: '1',
        },
      })
      const r = await openDesktopApp(rt, 'claude:work')
      const app = h.path('Apps/Claude.app')
      const data = join(h.home, SUPPORT, 'sideby/claude/work')
      assert.equal(r.action, 'started')
      assert.equal(r.appData, data)
      assert.equal(r.createdAppData, true)
      const [call, ...more] = opens(fake)
      assert.equal(more.length, 0)
      assert.deepEqual(call!.args, [
        '-n',
        '-a',
        app,
        '--env',
        `CLAUDE_CONFIG_DIR=${h.path('.claude-work')}`,
        '--args',
        `--user-data-dir=${data}`,
      ])
      const cleared = Object.keys(call!.env ?? {}).filter(
        (k) => /^(ANTHROPIC_|CLAUDE|CODEX_|SIDEBY_)/.test(k) && k !== 'CLAUDE_CODE_USE_BEDROCK',
      )
      assert.deepEqual(cleared, [], 'hijack, selecting and agent-session variables are cleared')
      assert.equal(call!.env?.LANG, 'en_US.UTF-8', 'other variables pass through')
      assert.equal(
        call!.env?.CLAUDE_CODE_USE_BEDROCK,
        '1',
        'user settings with a session-like prefix pass through',
      )
      assert.equal(call!.env?.HOME, h.home)
      assert.equal((await stat(data)).mode & 0o777, 0o700)
      // The MCP config links to the Main Account's default App Data.
      assert.deepEqual(r.linked, ['claude_desktop_config.json'])
      assert.equal(
        await readlink(join(data, 'claude_desktop_config.json')),
        join(h.home, SUPPORT, 'Claude/claude_desktop_config.json'),
      )
      assert.match(r.notices.join('\n'), /sign in inside Claude Desktop/)
      assert.doesNotMatch(r.notices.join('\n'), /Close the other/)
      assert.ok(Value.Check(OUTPUT_SCHEMAS.desktop!, { schemaVersion: 1, ...r }))
    })
  })

  it('opens the Main Account as a new instance, with the default data folder', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      // Another Account's window runs: a plain `open -a` would only bring that one forward.
      fake.procs = [
        `  400 ${h.path('Apps/Claude.app')}/Contents/MacOS/Claude --user-data-dir=${join(h.home, SUPPORT, 'sideby/claude/work')}`,
      ]
      const r = await openDesktopApp(rt, 'claude:main')
      assert.equal(r.action, 'started')
      assert.deepEqual(opens(fake)[0]!.args, ['-n', '-a', h.path('Apps/Claude.app')])
      assert.equal(r.appData, undefined)
      assert.deepEqual(r.notices, [])
      const c = await openDesktopApp(rt, 'codex:main')
      assert.deepEqual(opens(fake)[1]!.args, ['-n', '-a', h.path('Apps/ChatGPT.app')])
      assert.equal(c.app, 'Codex app')
    })
  })

  it('opens the Codex app with CODEX_HOME and both data path settings', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h, {
        env: { OPENAI_API_KEY: 'sk-fake', CODEX_HOME: '/elsewhere', CODEX_ELECTRON_USER_DATA_PATH: '/x' },
      })
      const r = await openDesktopApp(rt, 'codex:work')
      const data = join(h.home, SUPPORT, 'sideby/codex/work')
      const call = opens(fake)[0]!
      assert.deepEqual(call.args, [
        '-n',
        '--env',
        `CODEX_HOME=${h.path('.codex-work')}`,
        '--env',
        `CODEX_ELECTRON_USER_DATA_PATH=${data}`,
        h.path('Apps/ChatGPT.app'),
        '--args',
        `--user-data-dir=${data}`,
      ])
      for (const v of ['OPENAI_API_KEY', 'CODEX_HOME', 'CODEX_ELECTRON_USER_DATA_PATH'])
        assert.equal(call.env?.[v], undefined, v)
      assert.deepEqual(r.linked, [])
      assert.deepEqual(r.notices, [])
    })
  })

  it('tells a signed-out Codex account to sign in first', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const r = await openDesktopApp(rt, 'codex:work2')
      assert.match(r.notices.join('\n'), /sideby login codex:work2/)
    })
  })

  it('writes nothing into any Host account directory', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const dirs = ['.claude', '.claude-work', '.codex', '.codex-work']
      const before = await Promise.all(dirs.map((d) => snapshot(h.path(d))))
      const home = await snapshot(h.home)
      await openDesktopApp(rt, 'claude:work')
      await openDesktopApp(rt, 'codex:work')
      await openDesktopApp(rt, 'claude:main')
      const after = await Promise.all(dirs.map((d) => snapshot(h.path(d))))
      for (const [i, d] of dirs.entries()) assert.deepEqual(diffSnapshots(before[i]!, after[i]!), [], d)
      // The only new entries in HOME are the app data folders.
      assert.deepEqual(diffSnapshots(home, await snapshot(h.home)), [
        `${SUPPORT}/sideby`,
        `${SUPPORT}/sideby/claude`,
        `${SUPPORT}/sideby/claude/work`,
        `${SUPPORT}/sideby/claude/work/claude_desktop_config.json`,
        `${SUPPORT}/sideby/codex`,
        `${SUPPORT}/sideby/codex/work`,
      ])
    })
  })
})

describe('sideby desktop: one instance per account', () => {
  it('brings the running instance to the front instead of starting another', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const data = appDataDir(h.home, { family: 'claude', name: 'work' })
      const exe = `${h.path('Apps/Claude.app')}/Contents/MacOS/Claude`
      fake.procs = [
        `  101 ${exe}`,
        `  202 ${exe} --user-data-dir=${data}`,
        `  203 ${h.path('Apps/Claude.app')}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer --user-data-dir=${data}`,
      ]
      const r = await openDesktopApp(rt, 'claude:work')
      assert.equal(r.action, 'focused')
      assert.equal(opens(fake).length, 0)
      const osa = fake.calls.find((c) => c.cmd === '/usr/bin/osascript')!
      assert.deepEqual(osa.args.slice(0, 3), ['-l', 'JavaScript', '-e'])
      assert.match(osa.args[3]!, /runningApplicationWithProcessIdentifier\(202\)/)

      // The Main Account's instance is the one without --user-data-dir.
      fake.calls.length = 0
      const m = await openDesktopApp(rt, 'claude:main')
      assert.equal(m.action, 'focused')
      assert.match(fake.calls.find((c) => c.cmd === '/usr/bin/osascript')!.args[3]!, /Identifier\(101\)/)
    })
  })

  it('says it is already running when it cannot be brought to the front, and never kills anything', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const data = appDataDir(h.home, { family: 'codex', name: 'work' })
      fake.procs = [`  300 ${h.path('Apps/ChatGPT.app')}/Contents/MacOS/ChatGPT --user-data-dir=${data}`]
      fake.activate = 'refused'
      const r = await openDesktopApp(rt, 'codex:work')
      assert.equal(r.action, 'already-running')
      assert.match(r.notices[0]!, /already open for codex:work/)
      assert.deepEqual(
        fake.calls.map((c) => c.cmd),
        ['/bin/ps', '/usr/bin/osascript'],
      )
    })
  })

  it('does not take another account whose app data path starts the same way', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const other = appDataDir(h.home, { family: 'claude', name: 'work2' })
      fake.procs = [`  400 ${h.path('Apps/Claude.app')}/Contents/MacOS/Claude --user-data-dir=${other}`]
      const r = await openDesktopApp(rt, 'claude:work')
      assert.equal(r.action, 'started')
      // Another Claude instance runs while this account signs in for the first time.
      assert.match(r.notices.join('\n'), /Close the other Claude Desktop windows while you sign in/)
    })
  })

  it('reports which accounts have their desktop app open', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      const data = appDataDir(h.home, { family: 'claude', name: 'work' })
      fake.procs = [`  500 ${h.path('Apps/Claude.app')}/Contents/MacOS/Claude --user-data-dir=${data}`]
      const map = await desktopStatuses(rt, await rt.accounts())
      assert.deepEqual(map.get('claude:work'), { app: 'Claude Desktop', installed: true, running: true })
      assert.deepEqual(map.get('claude:main'), { app: 'Claude Desktop', installed: true, running: false })
      assert.deepEqual(map.get('codex:work'), { app: 'Codex app', installed: true, running: false })
      assert.equal(map.has('claude:deepseek'), false, 'API accounts get no desktop app')
      assert.equal(map.has('grok:lab'), false, 'Grok Bot windows are App Profiles, not a grok desktop app')
      assert.equal(map.has('pi:main'), false, 'a family without a desktop app gets none')
      // Listing never asks Spotlight.
      assert.equal(fake.calls.filter((c) => c.cmd === '/usr/bin/mdfind').length, 0)
    })
  })
})

describe('sideby desktop: refusals', () => {
  it('refuses an API account, another platform, a family without an app and a missing app', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      await refused(openDesktopApp(rt, 'claude:deepseek'), 'api-account')
      await refused(openDesktopApp(rt, 'pi:main'), 'no-desktop-app')
      await assert.rejects(openDesktopApp(rt, 'grok:lab'), (err: UserError) => {
        assert.equal(err.code, 'no-desktop-app')
        assert.match(
          err.message,
          /for Grok Bot, which signs in on its own, use `sideby desktop grok-bot:<name>`/,
        )
        return true
      })
      assert.equal(fake.calls.length, 0)

      const linux = fakeDeps([h.path('Apps')], 'linux')
      const onLinux = await createRuntime({ env: h.env, desktop: linux.deps })
      await refused(openDesktopApp(onLinux, 'claude:work'), 'not-macos')
      assert.equal(linux.calls.length, 0)
      assert.equal((await desktopStatuses(onLinux, await onLinux.accounts())).size, 0)

      const none = fakeDeps([h.path('Nothing')])
      const noApp = await createRuntime({ env: h.env, desktop: none.deps })
      await assert.rejects(openDesktopApp(noApp, 'claude:work'), (err: UserError) => {
        assert.equal(err.code, 'app-not-installed')
        assert.match(err.message, /install it from https:\/\/claude\.ai\/download/)
        return true
      })
      assert.deepEqual(
        none.calls.map((c) => c.cmd),
        ['/usr/bin/mdfind'],
      )
      assert.equal(
        await lstat(appDataDir(h.home, { family: 'claude', name: 'work' })).catch(() => null),
        null,
      )
    })
  })

  it('finds the app through Spotlight when it is somewhere else', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write(
        'Elsewhere/Claude Beta.app/Contents/Info.plist',
        plist('com.anthropic.claudefordesktop', 'Claude'),
      )
      const f = fakeDeps([h.path('Nothing')])
      f.mdfind = `${h.path('.Trash/Claude.app')}\n${h.path('Elsewhere/Claude Beta.app')}\n`
      const rt = await createRuntime({ env: h.env, desktop: f.deps })
      const r = await openDesktopApp(rt, 'claude:main')
      assert.equal(r.appPath, h.path('Elsewhere/Claude Beta.app'))
    })
  })

  it('reports a failed open with what to try', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      fake.openCode = 1
      await refused(openDesktopApp(rt, 'claude:work'), 'open-failed')
    })
  })
})

describe('sideby desktop: claude_desktop_config.json', () => {
  it('never replaces a real file in the app data', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const data = appDataDir(h.home, { family: 'claude', name: 'work' })
      const own = await h.write(`${SUPPORT}/sideby/claude/work/claude_desktop_config.json`, '{"own":true}\n')
      const r = await openDesktopApp(rt, 'claude:work')
      assert.deepEqual(r.linked, [])
      assert.equal(r.createdAppData, false)
      assert.equal((await lstat(own)).isFile(), true)
      assert.equal(await readFile(own, 'utf8'), '{"own":true}\n')
      assert.equal(join(data, 'claude_desktop_config.json'), own)
    })
  })

  it('links nothing when the main account has no such file, and nothing into used app data', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      await writeFile(join(h.home, SUPPORT, 'Claude/claude_desktop_config.json'), '{}\n')
      // App Data already used by the app: not new, so no link and no first-sign-in notice.
      await h.write(`${SUPPORT}/sideby/claude/work/Preferences`, '{}\n')
      const r = await openDesktopApp(rt, 'claude:work')
      assert.deepEqual(r.linked, [])
      assert.deepEqual(r.notices, [])
    })
  })

  it("checkAppData: a real file is the app's own copy, a warning that is never replaced", async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const file = `${SUPPORT}/sideby/claude/work/claude_desktop_config.json`
      await h.write(file, '{"own":true}\n')
      const rs = await checkAppData(rt.plugins, h.home, await rt.resolve('claude:work'))
      assert.equal(rs.length, 1)
      const r = rs[0]!
      assert.equal(r.item, 'app-data/claude_desktop_config.json')
      assert.equal(r.code, 'link.real-file')
      // The app makes its own copy when the main account had none: a warning, not a failure.
      assert.equal(r.level, 'warn')
      assert.ok(!(r.fixable && r.fix))
      assert.equal(
        r.message,
        "Claude Desktop data: claude_desktop_config.json is Claude Desktop's own copy for this account, not a link to the main account's",
      )
      const p = h.path(file)
      assert.equal(
        r.hint,
        `Claude Desktop made it itself; that is fine. To share the main account's instead, quit that window, then: mv "${p}" "${p}.local" && ln -s "${join(h.home, SUPPORT, 'Claude/claude_desktop_config.json')}" "${p}"`,
      )
      assert.equal(await readFile(p, 'utf8'), '{"own":true}\n')
    })
  })

  it('checkAppData: a missing link is fixable, and the fix writes only inside the app data', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      await h.mkdir(`${SUPPORT}/sideby/claude/work2`)
      const rs = await checkAppData(rt.plugins, h.home, await rt.resolve('claude:work2'))
      assert.equal(rs.length, 1)
      const r = rs[0]!
      assert.equal(r.item, 'app-data/claude_desktop_config.json')
      assert.match(r.message, /^Claude Desktop data: /)
      assert.ok(r.fixable && r.fix)
      const before = await snapshot(h.home)
      assert.equal((await r.fix()).ok, true)
      const diff = diffSnapshots(before, await snapshot(h.home))
      assert.deepEqual(diff, [`${SUPPORT}/sideby/claude/work2/claude_desktop_config.json`])
      assert.equal(
        await readlink(h.path(`${SUPPORT}/sideby/claude/work2/claude_desktop_config.json`)),
        join(h.home, SUPPORT, 'Claude/claude_desktop_config.json'),
      )
    })
  })

  it('checkAppData: nothing for the main account, an API account, a family without one, or no app data yet', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      await h.mkdir(`${SUPPORT}/sideby/codex/work`)
      for (const ref of ['claude:main', 'claude:deepseek', 'claude:work', 'codex:work', 'grok:main'])
        assert.deepEqual(await checkAppData(rt.plugins, h.home, await rt.resolve(ref)), [], ref)
    })
  })

  it('opens the Main Account with plain open -a when the process list is unavailable', async () => {
    await withFakeHome(async (h) => {
      const { rt, fake } = await setup(h)
      fake.psCode = 1
      const r = await openDesktopApp(rt, 'claude:main')
      assert.equal(r.action, 'started')
      // A running Main instance cannot be ruled out, so no `-n`: `open` brings an existing one forward instead.
      assert.deepEqual(opens(fake)[0]!.args, ['-a', h.path('Apps/Claude.app')])
    })
  })

  it('doctor keeps going when an extra check throws', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      const report = await runDoctor({
        home: h.home,
        families: rt.families,
        accounts: await rt.accounts(),
        bus: new HookBus(),
        extraChecks: async (a) => {
          if (a.ref === 'claude:work') throw new Error('boom')
          return []
        },
      })
      const work = report.accounts.find((a) => a.ref === 'claude:work')!
      const f = work.findings.find((x) => x.code === 'extra-check.error')!
      assert.equal(f.level, 'warn')
      assert.match(f.message, /boom/)
      assert.ok(
        report.accounts.some((a) => a.ref === 'claude:work2'),
        'other accounts are still checked',
      )
    })
  })

  it('doctor merges the app data checks, applies their fixes and keeps them out of shared.total', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      // claude:work: a real file where the link belongs; claude:work2: nothing there yet.
      await h.write(`${SUPPORT}/sideby/claude/work/claude_desktop_config.json`, '{"own":true}\n')
      const plain = await rt.doctor({ target: 'claude:work2' })
      await h.mkdir(`${SUPPORT}/sideby/claude/work2`)
      const report = await rt.doctor({ target: 'claude', fix: true })
      const work = report.accounts.find((a) => a.ref === 'claude:work')!
      const f = work.findings.find((x) => x.item === 'app-data/claude_desktop_config.json')!
      assert.equal(f.level, 'warn')
      assert.equal(f.source, 'core')
      assert.equal(f.fixable, false)
      const work2 = report.accounts.find((a) => a.ref === 'claude:work2')!
      assert.deepEqual(work2.shared, plain.accounts[0]!.shared)
      assert.ok(
        report.fixes.some(
          (x) => x.account === 'claude:work2' && x.item === 'app-data/claude_desktop_config.json' && x.ok,
        ),
      )
      assert.equal(
        await readlink(h.path(`${SUPPORT}/sideby/claude/work2/claude_desktop_config.json`)),
        join(h.home, SUPPORT, 'Claude/claude_desktop_config.json'),
      )
      const main = report.accounts.find((a) => a.ref === 'claude:main')!
      assert.equal(
        main.findings.some((x) => x.item.startsWith('app-data/')),
        false,
      )
    })
  })
})

describe('sideby desktop: the app replaces the shared link', () => {
  it('a real file the app wrote over the link is a warning, never a failure', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await setup(h)
      await openDesktopApp(rt, 'claude:work')
      const link = h.path(`${SUPPORT}/sideby/claude/work/claude_desktop_config.json`)
      await rm(link)
      await writeFile(link, '{"written":"by the app"}\n')
      const report = await rt.doctor({ target: 'claude:work', fix: true })
      const f = report.accounts[0]!.findings.find((x) => x.item === 'app-data/claude_desktop_config.json')!
      assert.equal(f.level, 'warn')
      assert.deepEqual(
        report.accounts[0]!.findings.filter((x) => x.item.startsWith('app-data/') && x.level === 'fail'),
        [],
      )
      assert.equal(await readFile(link, 'utf8'), '{"written":"by the app"}\n')
    })
  })
})
