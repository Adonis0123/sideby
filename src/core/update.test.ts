// Update Check, Update Notice, Install Method and Auto Update (spec §3.23, ADR-0021). The registry, the install
// command and the machine are replaced through bindUpdateDeps; nothing here reaches the network.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { MENUBAR_AGENT } from '../menubar/agent.ts'
import { autostartInstalled, PANEL_AGENT } from './autostart.ts'
import { resolvePaths } from './paths.ts'
import {
  afterCommandPlan,
  applySkillUpdate,
  applyUpdate,
  autoPending,
  autostartRefreshed,
  autoUpdateBlocker,
  autoUpdateLine,
  backgroundCheck,
  bindUpdateDeps,
  checkDue,
  checksOff,
  checksOffWhy,
  compareVersions,
  installMethod,
  isZombieStat,
  jsonNotice,
  markRunning,
  noticeLine,
  planFrom,
  planUpdate,
  readUpdateCache,
  refreshUpdateCheck,
  runningSessions,
  sameLine,
  skillAutoPending,
  skillBehind,
  skillNoticeLine,
  skillUpdatePlan,
  type UpdateDeps,
  updateCommand,
  updateUpdateCache,
} from './update.ts'
import { packageVersion } from './version.ts'

const CURRENT = packageVersion()
const [maj, min] = CURRENT.split('.').map(Number) as [number, number]
const NEXT_MINOR = `${maj}.${min + 1}.0`
const NEXT_MAJOR = maj === 0 ? '1.0.0' : `${maj + 1}.0.0`

let unbind: (() => void) | null = null
afterEach(() => {
  unbind?.()
  unbind = null
})

/** A fake registry that answers `latest`, counting the requests and keeping the URLs asked for. */
function registry(latest: string | Error) {
  const urls: string[] = []
  const fetch = (async (url: string | URL) => {
    urls.push(String(url))
    if (latest instanceof Error) throw latest
    return new Response(JSON.stringify({ latest }), { status: 200 })
  }) as typeof globalThis.fetch
  return { urls, fetch }
}

interface Machine {
  execs: { file: string; args: readonly string[] }[]
  restarts: number[]
  appRefreshes: number
  autostartRefreshes: number
  /** The commands whose login item was refreshed, in order. */
  loginItems: string[]
}

function machine(h: FakeHome, over: Partial<UpdateDeps> & { latest?: string | Error } = {}): Machine {
  const m: Machine = { execs: [], restarts: [], appRefreshes: 0, autostartRefreshes: 0, loginItems: [] }
  const reg = registry(over.latest ?? NEXT_MINOR)
  unbind = bindUpdateDeps({
    fetch: reg.fetch,
    packageDir: async () => join(h.home, '.nvm/versions/node/v22/lib/node_modules/sideby'),
    writable: async () => true,
    alive: () => false,
    exec: async (file, args) => {
      m.execs.push({ file, args })
      return { code: 0, output: 'added 1 package\n' }
    },
    restartPanel: async (_env, port) => {
      m.restarts.push(port)
      return true
    },
    appInstalled: async () => false,
    refreshApp: async () => {
      m.appRefreshes++
      return true
    },
    // The login items these tests write are LaunchAgents, whatever system runs the tests.
    autostartInstalled: (home, command = 'autostart') =>
      autostartInstalled(home, command === 'menubar' ? MENUBAR_AGENT : PANEL_AGENT, { platform: 'darwin' }),
    refreshAutostart: async (_env, command = 'autostart') => {
      m.autostartRefreshes++
      m.loginItems.push(command)
      return true
    },
    ...over,
  })
  return m
}

const envWithChecks = (h: FakeHome) => {
  const { SIDEBY_NO_UPDATE_NOTIFIER: _off, ...env } = h.env
  return env
}

describe('autostartRefreshed', () => {
  it('counts only a refresh that says it changed the login item', () => {
    assert.equal(autostartRefreshed(0, '{"schemaVersion":1,"state":"on","changed":true}'), true)
    // Exit 0 also when nothing needed rewriting or the rewrite was refused.
    assert.equal(autostartRefreshed(0, '{"schemaVersion":1,"state":"on","changed":false}'), false)
    assert.equal(
      autostartRefreshed(0, '{"schemaVersion":1,"state":"stale","changed":false,"note":"blocked"}'),
      false,
    )
    assert.equal(autostartRefreshed(0, ''), false)
    assert.equal(autostartRefreshed(0, 'not json'), false)
    assert.equal(autostartRefreshed(1, '{"changed":true}'), false)
    assert.equal(autostartRefreshed(null, '{"changed":true}'), false)
  })
})

describe('versions', () => {
  it('compares versions with prereleases before their release', () => {
    assert.equal(compareVersions('0.12.0', '0.11.9'), 1)
    assert.equal(compareVersions('0.11.0', '0.11.0'), 0)
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
    assert.equal(compareVersions('v2.0.0', '1.9.9'), 1)
    assert.equal(compareVersions('latest', '1.0.0'), null)
    assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
    // Build metadata outside semver's characters (a terminal escape, say) is not a version.
    assert.equal(compareVersions('1.0.0+\u001b]8;;x\u0007', '0.1.0'), null)
  })
  it('keeps Auto Update on one major version', () => {
    assert.equal(sameLine('0.11.0', '0.12.3'), true)
    assert.equal(sameLine('0.11.0', '1.0.0'), false)
    assert.equal(sameLine('1.2.0', '1.9.0'), true)
    assert.equal(sameLine('1.2.0', '2.0.0'), false)
    assert.equal(sameLine('0.0.3', '0.0.4'), true)
  })
})

describe('switches', () => {
  it('turns checks off with either variable, the config or CI', () => {
    assert.equal(checksOff({}, {}), null)
    assert.match(checksOff({ NO_UPDATE_NOTIFIER: '1' }, {}) ?? '', /NO_UPDATE_NOTIFIER/)
    assert.match(checksOff({ SIDEBY_NO_UPDATE_NOTIFIER: 'true' }, {}) ?? '', /SIDEBY_NO_UPDATE_NOTIFIER/)
    assert.match(checksOff({}, { update: { check: false } }) ?? '', /update\.check/)
    assert.match(checksOff({ CI: 'true' }, {}) ?? '', /CI/)
    assert.equal(checksOff({ CI: 'false', NO_UPDATE_NOTIFIER: '0' }, {}), null)
  })
  it('keeps checks off for a Local Build, whatever else is set', () => {
    assert.match(checksOff({}, { update: { check: true, auto: true } }, true) ?? '', /local build/)
    assert.equal(checksOff({}, {}, false), null)
  })
})

describe('the _notice of --json outputs', () => {
  const SKILL = 'npx skills add Adonis0123/sideby -g'
  it('names a newer version from the cache and an installed skill for another version', () => {
    const n = jsonNotice({ latest: '0.14.0' }, '0.13.0', {}, {}, ['0.12.1', '0.13.0'], SKILL)
    assert.deepEqual(n?.update && [n.update.current, n.update.latest, n.update.command], [
      '0.13.0',
      '0.14.0',
      'sideby update',
    ])
    assert.deepEqual(n?.skill && [n.skill.installed, n.skill.command], ['0.12.1', SKILL])
    assert.equal(jsonNotice({ latest: '0.14.0' }, '0.13.0', {}, {}, [null], SKILL)?.skill?.installed, null)
  })
  it('says nothing when all is current, when checks are off, or for a Local Build', () => {
    assert.equal(jsonNotice({ latest: '0.13.0' }, '0.13.0', {}, {}, ['0.13.0'], SKILL), null)
    assert.equal(jsonNotice({}, '0.13.0', {}, {}, [], SKILL), null)
    assert.equal(
      jsonNotice({ latest: '0.14.0' }, '0.13.0', {}, { SIDEBY_NO_UPDATE_NOTIFIER: '1' }, ['0.1.0'], SKILL),
      null,
    )
    assert.equal(
      jsonNotice({ latest: '0.14.0' }, '0.13.0', { update: { check: false } }, {}, [], SKILL),
      null,
    )
    assert.equal(jsonNotice({ latest: '0.14.0' }, '0.13.0', {}, { CI: 'true' }, [], SKILL), null)
  })
})

describe('the notice', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  it('says a newer version exists once per version per day', () => {
    assert.equal(noticeLine({ latest: CURRENT }, CURRENT, now), null)
    const line = noticeLine({ latest: NEXT_MINOR }, CURRENT, now)
    assert.ok(line?.includes(NEXT_MINOR) && line.includes('sideby update'))
    const at = new Date(now.getTime() - 3600_000).toISOString()
    assert.equal(
      noticeLine({ latest: NEXT_MINOR, notified: { version: NEXT_MINOR, at } }, CURRENT, now),
      null,
    )
    const old = new Date(now.getTime() - 25 * 3600_000).toISOString()
    assert.ok(noticeLine({ latest: NEXT_MINOR, notified: { version: NEXT_MINOR, at: old } }, CURRENT, now))
    // A newer version than the one already announced is said at once.
    assert.ok(noticeLine({ latest: '9.0.0', notified: { version: NEXT_MINOR, at } }, CURRENT, now))
  })
  it('says the result of an Auto Update until it was shown', () => {
    const auto = { from: '0.11.0', to: '0.12.0', at: now.toISOString(), ok: true, message: '' }
    assert.match(autoUpdateLine({ auto }) ?? '', /updated itself from 0\.11\.0 to 0\.12\.0/)
    assert.equal(autoUpdateLine({ auto: { ...auto, shown: true } }), null)
    assert.match(
      autoUpdateLine({ auto: { ...auto, ok: false, message: 'npm failed' } }) ?? '',
      /could not.*npm failed/,
    )
  })
  it('is due when the last check is missing or a day old', () => {
    assert.equal(checkDue({}, now), true)
    assert.equal(checkDue({ checkedAt: new Date(now.getTime() - 3600_000).toISOString() }, now), false)
    assert.equal(checkDue({ checkedAt: new Date(now.getTime() - 25 * 3600_000).toISOString() }, now), true)
    assert.equal(checkDue({ checkedAt: 'garbage' }, now), true)
  })
})

describe('Install Method', () => {
  const at = (dir: string, writable = true) => {
    unbind?.()
    unbind = bindUpdateDeps({ packageDir: async () => dir, writable: async () => writable })
  }
  it('tells each install apart and runs only the ones it may', async () => {
    at('/u/.nvm/versions/node/v22/lib/node_modules/sideby')
    const npm = await installMethod({})
    assert.deepEqual([npm.kind, npm.canUpdate, npm.prefix], ['npm', true, '/u/.nvm/versions/node/v22'])
    assert.deepEqual(updateCommand(npm, '0.12.0').run, {
      file: 'npm',
      args: ['install', '-g', '--prefix', '/u/.nvm/versions/node/v22', 'sideby@0.12.0'],
    })
    at('/usr/local/lib/node_modules/sideby', false)
    const root = await installMethod({})
    assert.equal(root.canUpdate, false)
    assert.match(root.reason ?? '', /not writable/)
    assert.equal(updateCommand(root, '0.12.0').run, undefined)
    assert.equal(updateCommand(root, '0.12.0').text, 'npm install -g sideby@0.12.0')
    at('/u/Library/pnpm/global/5/.pnpm/sideby@0.11.0/node_modules/sideby')
    assert.equal((await installMethod({})).kind, 'pnpm')
    at('/u/.bun/install/global/node_modules/sideby')
    assert.equal((await installMethod({})).kind, 'bun')
    at('/u/.npm/_npx/0aed/node_modules/sideby')
    const npx = await installMethod({})
    assert.deepEqual([npx.kind, npx.canUpdate], ['npx', false])
    at('/u/work/app/node_modules/sideby')
    assert.equal((await installMethod({})).kind, 'project')
    at('/u/coding/sideby')
    assert.equal((await installMethod({})).kind, 'source')
  })
  it('tells a Local Build by its build file and only names pnpm local --off', async () => {
    await withFakeHome(async (h) => {
      const pkg = h.path('.local/share/sideby-dev/pkg')
      await mkdir(join(pkg, 'dist'), { recursive: true })
      await writeFile(
        join(pkg, 'dist', 'build.json'),
        JSON.stringify({ id: 'x', local: true, commit: 'abc1234', dirty: true }),
      )
      at(pkg)
      const local = await installMethod({})
      assert.deepEqual([local.kind, local.canUpdate], ['local', false])
      assert.match(local.reason ?? '', /pnpm local --off/)
      assert.deepEqual(updateCommand(local, '0.13.0'), { text: 'pnpm local --off' })
      // A published build file has no `local`: the path decides as before.
      await writeFile(join(pkg, 'dist', 'build.json'), JSON.stringify({ id: 'x' }))
      assert.equal((await installMethod({})).kind, 'source')
    })
  })
})

describe('the check', () => {
  it('asks the registry once and keeps the answer; a failure keeps the old one', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const reg = registry('0.99.0')
      unbind = bindUpdateDeps({ fetch: reg.fetch })
      const c = await refreshUpdateCheck(paths, {
        ...h.env,
        SIDEBY_UPDATE_REGISTRY: 'https://mirror.test/npm/',
      })
      assert.equal(c.latest, '0.99.0')
      assert.deepEqual(reg.urls, ['https://mirror.test/npm/-/package/sideby/dist-tags'])
      unbind()
      unbind = bindUpdateDeps({ fetch: registry(new Error('offline')).fetch })
      assert.equal((await refreshUpdateCheck(paths, h.env)).latest, '0.99.0')
      const raw = JSON.parse(await readFile(join(paths.stateDir, 'update.json'), 'utf8')) as object
      assert.deepEqual(Object.keys(raw).sort(), ['checkedAt', 'latest', 'triedAt'])
    })
  })
  it('reads a broken cache as empty', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await h.write('.local/state/sideby/update.json', '{nope')
      assert.deepEqual(await readUpdateCache(paths), {})
    })
  })
})

describe('running sessions', () => {
  it('records a running Host and forgets ended ones', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const live = new Set([4242])
      unbind = bindUpdateDeps({ alive: (pid) => live.has(pid) })
      const done = await markRunning(paths, 4242)
      await markRunning(paths, 999)
      assert.deepEqual(await runningSessions(paths), [4242])
      await done()
      assert.deepEqual(await runningSessions(paths), [])
    })
  })
})

describe('Update and Auto Update', () => {
  const skill = (v: string) => `---\nname: sideby\nmetadata:\n  version: ${v}\n---\n`
  it('brings an installed sideby skill along: the CLI first, then skills update, keeping its agents', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      const m = machine(h)
      const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
      assert.deepEqual(plan.skill && [plan.skill.installed, plan.skill.outdated, plan.skill.canRun], [
        [CURRENT],
        true,
        true,
      ])
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.deepEqual(
        m.execs.map((e) => e.file),
        ['npm', 'npx'],
      )
      assert.equal(
        m.execs[1] && [m.execs[1].file, ...m.execs[1].args].join(' '),
        'npx -y skills update sideby -g -y',
      )
      assert.equal(r.skillUpdated, true)
    })
  })
  it('leaves a skill alone when it lives in a git repository, and says where to update it', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.1.0'))
      await mkdir(h.path('.agents/.git'), { recursive: true })
      const m = machine(h)
      const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
      assert.deepEqual(plan.skill && [plan.skill.outdated, plan.skill.canRun], [true, false])
      assert.match(plan.skill?.reason ?? '', /git repository ~\/\.agents/)
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.equal(m.execs.length, 1, 'only the CLI install ran')
      assert.equal(r.skillUpdated, undefined)
    })
  })
  it('does not call a skill for a newer sideby outdated: the CLI is what is behind', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill('99.0.0'))
      const plan = await skillUpdatePlan(h.home, CURRENT)
      assert.equal(plan?.outdated, false)
      assert.equal(plan && skillBehind(plan, CURRENT), null)
      await h.write('.claude/skills/sideby/SKILL.md', skill('0.0.1'))
      const both = await skillUpdatePlan(h.home, CURRENT)
      assert.equal(both?.outdated, true)
      assert.equal(both && skillBehind(both, CURRENT)?.installed, '0.0.1', 'names the older one')
    })
  })
  it('has no skill part without an installed skill, and runs nothing for a current one', async () => {
    await withFakeHome(async (h) => {
      machine(h)
      assert.equal((await planUpdate(resolvePaths(h.env), envWithChecks(h))).skill, undefined)
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      const m = machine(h, { latest: CURRENT })
      const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
      assert.equal(plan.skill?.outdated, false)
      assert.equal(await applySkillUpdate(plan.skill, h.env), null)
      assert.equal(m.execs.length, 0)
    })
  })
  it('leaves the skill to the new code in the background for the Panel, so its answer comes before a reload', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      const started: string[] = []
      const m = machine(h, {
        startDetached: async (file, args) => {
          started.push([file, ...args].join(' '))
          return true
        },
      })
      const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env, { skillSync: 'background' })
      assert.deepEqual(
        m.execs.map((e) => e.file),
        ['npm'],
      )
      assert.deepEqual([r.ok, r.skillUpdated, r.skillSyncStarted], [true, undefined, true])
      assert.deepEqual(started, ['sideby update --skill --yes'])
      // The lock is free by then, so the started `sideby update --skill --yes` can take it.
      assert.equal(existsSync(join(resolvePaths(h.env).stateDir, 'update-install.lock')), false)
      // A failed install starts nothing.
      unbind?.()
      machine(h, {
        exec: async () => ({ code: 1, output: '' }),
        startDetached: async (file, args) => {
          started.push([file, ...args].join(' '))
          return true
        },
      })
      const failed = await applyUpdate(resolvePaths(h.env), plan, h.env, { skillSync: 'background' })
      assert.deepEqual([failed.ok, failed.skillSyncStarted], [false, undefined])
      assert.equal(started.length, 1)
    })
  })
  it('restarts the background Panel last, after the app, the login item and the skill (after-install.ts)', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      await h.write(
        'Library/LaunchAgents/dev.sideby.panel.plist',
        '<!-- Written by `sideby autostart`: … -->\n',
        0o644,
      )
      const lock = join(resolvePaths(h.env).stateDir, 'update-install.lock')
      for (const skillSync of ['wait', 'background'] as const) {
        const calls: string[] = []
        unbind?.()
        machine(h, {
          exec: async (file) => {
            calls.push(`${file}${existsSync(lock) ? ' (locked)' : ''}`)
            return { code: 0, output: '' }
          },
          appInstalled: async () => true,
          refreshApp: async () => {
            calls.push('app')
            return true
          },
          refreshAutostart: async () => {
            calls.push('autostart')
            return true
          },
          startDetached: async (file, args) => {
            calls.push(`${[file, ...args].join(' ')}${existsSync(lock) ? ' (locked)' : ''}`)
            return true
          },
          restartPanel: async () => {
            calls.push('panel')
            return true
          },
        })
        const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
        const r = await applyUpdate(resolvePaths(h.env), plan, h.env, {
          skillSync,
          panelPort: async () => 17420,
        })
        assert.equal(r.ok, true)
        assert.deepEqual(
          calls,
          skillSync === 'wait'
            ? // In place, the skill keeps the lock: one install at a time.
              ['npm (locked)', 'app', 'autostart', 'npx (locked)', 'panel']
            : // On its own, it starts once the lock is free, since the new process takes it itself.
              ['npm (locked)', 'app', 'autostart', 'sideby update --skill --yes', 'panel'],
        )
        assert.deepEqual([r.restartedPanel, r.refreshedApp, r.refreshedAutostart], [true, true, true])
      }
    })
  })
  it('reports a failed skill update without failing the Update', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      machine(h, { exec: async (file) => ({ code: file === 'npx' ? 1 : 0, output: '' }) })
      const plan = await planUpdate(resolvePaths(h.env), envWithChecks(h))
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.deepEqual([r.ok, r.skillUpdated], [true, false])
      assert.match(r.skillMessage ?? '', /run it yourself/)
    })
  })

  it('runs the command and restarts a running background Panel', async () => {
    await withFakeHome(async (h) => {
      const m = machine(h)
      const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env, { panelPort: async () => 17420 })
      assert.equal(r.ok, true)
      assert.equal(m.execs[0]?.file, 'npm')
      assert.deepEqual(m.restarts, [17420])
      assert.equal(r.restartedPanel, true)
      assert.deepEqual(
        [r.refreshedApp, m.appRefreshes],
        [false, 0],
        'no desktop app installed: nothing to refresh',
      )
    })
  })
  it('writes an installed desktop app again from the new code', async () => {
    await withFakeHome(async (h) => {
      const homes: string[] = []
      const m = machine(h, {
        appInstalled: async (home) => {
          homes.push(home)
          return true
        },
      })
      const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.equal(r.ok, true)
      assert.deepEqual([r.refreshedApp, m.appRefreshes, homes], [true, 1, [h.home]])
    })
  })
  it('points an existing login item at the new code, and creates none (spec §3.29)', async () => {
    await withFakeHome(async (h) => {
      const m = machine(h)
      const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
      const none = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.deepEqual([none.refreshedAutostart, m.autostartRefreshes], [undefined, 0])
      await h.write(
        'Library/LaunchAgents/dev.sideby.panel.plist',
        '<!-- Written by `sideby autostart`: … -->\n',
        0o644,
      )
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.deepEqual([r.refreshedAutostart, m.autostartRefreshes], [true, 1])
      // The menu bar item's login item (spec §3.31) is refreshed too, only where it exists, and not reported.
      await h.write(
        'Library/LaunchAgents/dev.sideby.menubar.plist',
        '<!-- Written by `sideby menubar`: … -->\n',
        0o644,
      )
      const both = await applyUpdate(resolvePaths(h.env), plan, h.env)
      assert.equal(both.refreshedAutostart, true)
      assert.deepEqual(m.loginItems, ['autostart', 'autostart', 'menubar'])
    })
  })
  it('keeps a successful Update when refreshing the desktop app fails', async () => {
    await withFakeHome(async (h) => {
      for (const refreshApp of [
        async () => false,
        async () => Promise.reject(new Error('spawn sideby ENOENT')),
      ]) {
        unbind?.()
        machine(h, { appInstalled: async () => true, refreshApp })
        const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
        const r = await applyUpdate(resolvePaths(h.env), plan, h.env)
        assert.deepEqual([r.ok, r.code, r.refreshedApp], [true, 0, false])
        assert.match(r.message, /^updated sideby from/)
      }
    })
  })
  it('reports a failed install and restarts nothing', async () => {
    await withFakeHome(async (h) => {
      const m = machine(h, {
        exec: async () => ({ code: 243, output: 'EACCES' }),
        appInstalled: async () => true,
      })
      const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
      const r = await applyUpdate(resolvePaths(h.env), plan, h.env, { panelPort: async () => 17420 })
      assert.equal(r.ok, false)
      assert.match(r.message, /exit 243/)
      assert.deepEqual(m.restarts, [])
      assert.deepEqual([r.refreshedApp, m.appRefreshes], [false, 0])
    })
  })
  it('names what blocks an Auto Update', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      machine(h, { alive: () => true })
      const method = await installMethod(h.env)
      assert.match((await autoUpdateBlocker(paths, planFrom(method, CURRENT, CURRENT))) ?? '', /up to date/)
      assert.match(
        (await autoUpdateBlocker(paths, planFrom(method, CURRENT, NEXT_MAJOR))) ?? '',
        /new major version/,
      )
      assert.equal(await autoUpdateBlocker(paths, planFrom(method, CURRENT, NEXT_MINOR)), null)
      await markRunning(paths, 4242)
      assert.match((await autoUpdateBlocker(paths, planFrom(method, CURRENT, NEXT_MINOR))) ?? '', /pid 4242/)
    })
  })
  it('the background check installs only with update.auto, and says so once', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const env = envWithChecks(h)
      const m = machine(h)
      await backgroundCheck(paths, env, {}, async () => null)
      assert.equal(m.execs.length, 0)
      assert.equal((await readUpdateCache(paths)).latest, NEXT_MINOR)
      await writeFile(join(paths.stateDir, 'update.json'), '{}')
      await backgroundCheck(paths, env, { update: { auto: true } }, async () => 17420)
      assert.equal(m.execs.length, 1)
      assert.deepEqual(m.restarts, [17420])
      const cache = await readUpdateCache(paths)
      assert.equal(cache.auto?.ok, true)
      assert.equal(cache.auto?.to, NEXT_MINOR)
      await updateUpdateCache(paths, { auto: { ...cache.auto!, shown: true } })
      assert.equal(autoUpdateLine(await readUpdateCache(paths)), null)
    })
  })
  it('never checks or installs while checks are off, nor a major version', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const off = machine(h)
      await backgroundCheck(paths, h.env, { update: { auto: true } }, async () => null)
      assert.equal(off.execs.length, 0)
      assert.deepEqual(await readUpdateCache(paths), {})
      unbind?.()
      const major = machine(h, { latest: NEXT_MAJOR })
      await backgroundCheck(paths, envWithChecks(h), { update: { auto: true } }, async () => null)
      assert.equal(major.execs.length, 0)
      const after = await readUpdateCache(paths)
      assert.equal(after.latest, NEXT_MAJOR)
      // Said once, and not looked at again for a day.
      assert.match(autoUpdateLine(after) ?? '', /new major version/)
      assert.equal(
        autoPending(after, CURRENT, { update: { auto: true } }, new Date(Date.now() + 2 * 3600_000)),
        false,
      )
    })
  })
})

describe('hardening round 1', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3600_000).toISOString()

  it('backs off for an hour after a failed check, and keeps that across other writes', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      unbind = bindUpdateDeps({ fetch: registry(new Error('offline')).fetch, now: () => now })
      const c = await refreshUpdateCheck(paths, h.env)
      assert.equal(c.triedAt, now.toISOString())
      await updateUpdateCache(paths, { notified: { version: '9.9.9', at: now.toISOString() } })
      const again = await readUpdateCache(paths)
      assert.equal(checkDue(again, new Date(now.getTime() + 30 * 60_000)), false)
      assert.equal(checkDue(again, new Date(now.getTime() + 61 * 60_000)), true)
    })
  })

  it('keeps an Auto Update pending until it is tried, looks again within the hour while it waits, retries a failure a day later', () => {
    const on = { update: { auto: true } }
    const base = { latest: NEXT_MINOR, checkedAt: hoursAgo(1) }
    assert.equal(autoPending(base, CURRENT, {}, now), false)
    assert.equal(autoPending(base, CURRENT, on, now), true)
    assert.equal(autoPending({ ...base, autoTriedAt: hoursAgo(0.5) }, CURRENT, on, now), false)
    const failed = { from: CURRENT, to: NEXT_MINOR, ok: false, message: 'x' }
    assert.equal(autoPending({ ...base, auto: { ...failed, at: hoursAgo(2) } }, CURRENT, on, now), false)
    assert.equal(autoPending({ ...base, auto: { ...failed, at: hoursAgo(25) } }, CURRENT, on, now), true)
    assert.equal(
      autoPending({ ...base, auto: { ...failed, ok: true, at: hoursAgo(25) } }, CURRENT, on, now),
      false,
    )
  })

  it('plans what to print after a command and marks only what it printed', () => {
    const auto = { from: CURRENT, to: NEXT_MINOR, at: hoursAgo(1), ok: true, message: '' }
    const cache = { latest: NEXT_MINOR, checkedAt: hoursAgo(1), auto }
    const p = afterCommandPlan(cache, CURRENT, {}, {}, now)
    assert.equal(p.lines.length, 2)
    assert.equal(p.startCheck, false)
    // Another process wrote a newer Auto Update meanwhile: it stays to be said.
    const newer = { ...auto, at: now.toISOString() }
    const rec = p.record!({ ...cache, auto: newer })
    assert.equal(rec.auto, undefined)
    assert.equal(rec.notified?.version, NEXT_MINOR)
    assert.equal(p.record!(cache).auto?.shown, true)
    // Off: nothing printed and nothing started.
    assert.deepEqual(afterCommandPlan(cache, CURRENT, {}, { NO_UPDATE_NOTIFIER: '1' }, now), {
      lines: [],
      record: null,
      startCheck: false,
    })
    // A Panel ran today's check: the CLI still starts the background check while an Auto Update is pending.
    assert.equal(
      afterCommandPlan(
        { latest: NEXT_MINOR, checkedAt: hoursAgo(1) },
        CURRENT,
        { update: { auto: true } },
        {},
        now,
      ).startCheck,
      true,
    )
  })

  it('runs one Update at a time and never breaks a lock its live owner still holds', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      let release: (() => void) | undefined
      const m = machine(h, {
        alive: (pid) => pid === process.pid,
        exec: (file, args) => {
          m.execs.push({ file, args })
          return new Promise((r) => {
            release = () => r({ code: 0, output: '' })
          })
        },
      })
      const plan = planFrom(await installMethod(h.env), CURRENT, NEXT_MINOR)
      const first = applyUpdate(paths, plan, h.env)
      while (!release) await new Promise((r) => setTimeout(r, 5))
      const second = await applyUpdate(paths, plan, h.env)
      assert.deepEqual([second.ok, second.busy], [false, true])
      release()
      assert.equal((await first).ok, true)
      assert.equal(m.execs.length, 1)
      // A lock its live pid stopped touching (a Portal worker thread ended mid-install) is taken over.
      unbind?.()
      machine(h, { alive: (pid) => pid === process.pid })
      const lock = join(paths.stateDir, 'update-install.lock')
      await writeFile(lock, `${process.pid} ${Date.now()}`)
      assert.equal((await applyUpdate(paths, plan, h.env)).busy, true)
      const old = new Date(Date.now() - 3 * 60 * 1000)
      await utimes(lock, old, old)
      assert.equal((await applyUpdate(paths, plan, h.env)).ok, true)
      // A lock left by a process that ended is taken over.
      await writeFile(join(paths.stateDir, 'update-install.lock'), `999999 ${Date.now()}`)
      unbind?.()
      machine(h, { alive: () => false })
      assert.equal((await applyUpdate(paths, plan, h.env)).ok, true)
    })
  })

  it('installs from the registry it checked, without showing its password, and refuses other protocols', async () => {
    unbind = bindUpdateDeps({
      packageDir: async () => '/u/lib/node_modules/sideby',
      writable: async () => true,
    })
    const method = await installMethod({})
    const env = { SIDEBY_UPDATE_REGISTRY: 'https://me:secret@mirror.test/npm/' }
    const cmd = updateCommand(method, '0.12.0', env)
    assert.deepEqual(cmd.run?.args, [
      'install',
      '-g',
      '--prefix',
      '/u',
      '--registry',
      'https://me:secret@mirror.test/npm',
      'sideby@0.12.0',
    ])
    assert.equal(cmd.text, 'npm install -g sideby@0.12.0 --registry https://mirror.test/npm')
    assert.doesNotMatch(cmd.text, /secret/)
    assert.throws(
      () => updateCommand(method, '0.12.0', { SIDEBY_UPDATE_REGISTRY: 'file:///tmp' }),
      /http or https/,
    )
  })

  it('leaves a Volta install to Volta and needs the npm bin folder writable', async () => {
    unbind = bindUpdateDeps({
      packageDir: async () => '/u/.volta/tools/image/packages/sideby/lib/node_modules/sideby',
    })
    const volta = await installMethod({})
    assert.deepEqual(
      [volta.kind, volta.canUpdate, updateCommand(volta, '0.12.0').text],
      ['volta', false, 'volta install sideby@0.12.0'],
    )
    unbind()
    unbind = bindUpdateDeps({
      packageDir: async () => '/u/lib/node_modules/sideby',
      writable: async (d) => !d.endsWith('/bin'),
    })
    const npm = await installMethod({})
    assert.equal(npm.canUpdate, false)
    assert.match(npm.reason ?? '', /\/u\/bin is not writable/)
  })
})

describe('the skill is part of the version (spec §3.23)', () => {
  const skill = (v: string) => `---\nname: sideby\nmetadata:\n  version: ${v}\n---\n`
  const lock = (source: string) =>
    JSON.stringify({ version: 3, skills: { sideby: { source, sourceType: 'github' } } })
  const now = new Date('2026-10-17T12:00:00Z')
  const auto = { update: { auto: true } }

  it('updates a skill the skills tool installed, even inside a git repository; leaves any other one there alone', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.1.0'))
      await mkdir(h.path('.agents/.git'), { recursive: true })
      await h.write('.agents/.skill-lock.json', lock('Adonis0123/sideby'))
      const ours = await skillUpdatePlan(h.home, CURRENT)
      assert.deepEqual(ours && [ours.canRun, ours.reasonCode], [true, undefined])
      await h.write('.agents/.skill-lock.json', lock('someone/else'))
      const theirs = await skillUpdatePlan(h.home, CURRENT)
      assert.deepEqual(theirs && [theirs.canRun, theirs.reasonCode, theirs.reasonAt, theirs.command], [
        false,
        'skill-in-git',
        '~/.agents',
        'npx skills update sideby -g',
      ])
    })
  })

  it('an Auto Update of the CLI brings the skill along', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill(CURRENT))
      const m = machine(h)
      await backgroundCheck(resolvePaths(h.env), envWithChecks(h), auto, async () => null)
      assert.deepEqual(
        m.execs.map((e) => e.file),
        ['npm', 'npx'],
      )
    })
  })

  it('with Auto Update on and the CLI current, brings a skill behind it up to date alone, once', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.1.0'))
      const m = machine(h, { latest: CURRENT })
      await backgroundCheck(paths, envWithChecks(h), {}, async () => null)
      assert.equal(m.execs.length, 0, 'not without update.auto')
      await backgroundCheck(paths, envWithChecks(h), auto, async () => null)
      assert.deepEqual(
        m.execs.map((e) => [e.file, ...e.args].join(' ')),
        ['npx -y skills update sideby -g -y'],
      )
      const cache = await readUpdateCache(paths)
      assert.deepEqual(cache.skillAuto && [cache.skillAuto.to, cache.skillAuto.ok], [CURRENT, true])
      // The fake skills tool changed nothing, but this version was tried: it is not tried again.
      await backgroundCheck(paths, envWithChecks(h), auto, async () => null)
      assert.equal(m.execs.length, 1)
      const p = afterCommandPlan(cache, CURRENT, auto, envWithChecks(h), now)
      assert.match(p.lines.join('\n'), /updated the sideby skill agents read/)
      assert.equal(p.record!(cache).skillAuto?.shown, true)
    })
  })

  it('never updates the skill alone while a newer CLI waits, since the skills tool fetches the newest skill', async () => {
    await withFakeHome(async (h) => {
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.1.0'))
      const m = machine(h, { latest: NEXT_MAJOR })
      await backgroundCheck(resolvePaths(h.env), envWithChecks(h), auto, async () => null)
      assert.equal(m.execs.length, 0)
      const behind = { installed: '0.1.0', canRun: true }
      assert.equal(skillAutoPending({ latest: NEXT_MAJOR }, CURRENT, auto, behind, now), false)
      assert.equal(skillAutoPending({ latest: CURRENT }, CURRENT, auto, behind, now), true)
      // A failed try waits a day.
      const failed = { to: CURRENT, at: now.toISOString(), ok: false, message: 'x' }
      assert.equal(skillAutoPending({ skillAuto: failed }, CURRENT, auto, behind, now), false)
      assert.equal(
        skillAutoPending(
          { skillAuto: failed },
          CURRENT,
          auto,
          behind,
          new Date(now.getTime() + 25 * 3600_000),
        ),
        true,
      )
    })
  })

  it('tells a terminal about a skill behind this version once a day, unless Auto Update will bring it along', () => {
    const behind = skillBehind({ installed: ['0.1.0'], outdated: true, command: '', canRun: true }, CURRENT)
    assert.deepEqual(behind, { installed: '0.1.0', canRun: true })
    assert.equal(
      skillBehind({ installed: [CURRENT], outdated: false, command: '', canRun: true }, CURRENT),
      null,
    )
    const p = afterCommandPlan(
      { latest: CURRENT, checkedAt: now.toISOString() },
      CURRENT,
      {},
      {},
      now,
      behind,
    )
    assert.deepEqual(p.lines, [
      `the sideby skill agents read is for 0.1.0 (this sideby is ${CURRENT}) · run \`sideby update\``,
    ])
    const seen = { latest: CURRENT, checkedAt: now.toISOString(), ...p.record!({}) }
    assert.equal(skillNoticeLine(seen, CURRENT, {}, behind, now), null)
    // Auto Update on: no line, and the background check is started to bring it along.
    const a = afterCommandPlan(
      { latest: CURRENT, checkedAt: now.toISOString() },
      CURRENT,
      auto,
      {},
      now,
      behind,
    )
    assert.deepEqual([a.lines, a.startCheck], [[], true])
    // A skill sideby may not update is still said with Auto Update on.
    assert.notEqual(skillNoticeLine({}, CURRENT, auto, { installed: '0.1.0', canRun: false }, now), null)
    // A newer CLI's notice leads to `sideby update`, which brings the skill along: one line, not two.
    const n = afterCommandPlan(
      { latest: NEXT_MINOR, checkedAt: now.toISOString() },
      CURRENT,
      {},
      {},
      now,
      behind,
    )
    assert.equal(n.lines.length, 1)
    assert.match(n.lines[0]!, /is available/)
  })

  it('gives every reason a code a page can say in its own language', async () => {
    assert.deepEqual(checksOffWhy({}, {}, true), {
      code: 'local-build',
      text: 'this is a local build (pnpm local)',
    })
    assert.equal(checksOffWhy({ NO_UPDATE_NOTIFIER: '1' }, {}, false)?.code, 'env')
    assert.equal(checksOffWhy({}, { update: { check: false } }, false)?.code, 'config')
    assert.equal(checksOffWhy({ CI: 'true' }, {}, false)?.code, 'ci')
    await withFakeHome(async (h) => {
      machine(h, {
        packageDir: async () => join(h.home, '.volta/tools/image/packages/sideby/lib/node_modules/sideby'),
      })
      assert.equal((await installMethod(h.env)).reasonCode, 'volta')
      unbind?.()
      machine(h, { writable: async () => false })
      const m = await installMethod(h.env)
      assert.equal(m.reasonCode, 'not-writable')
      assert.match(m.reasonAt ?? '', /lib\/node_modules/)
    })
  })
})

describe('isZombieStat', () => {
  it('reads the state after the command name, whatever the name holds', () => {
    assert.equal(isZombieStat('1075152 (node) Z 895969 1075152'), true)
    assert.equal(isZombieStat('42 (node) S 1 42'), false)
    assert.equal(isZombieStat('43 (a) Z b) R 1 43'), false)
  })
})
