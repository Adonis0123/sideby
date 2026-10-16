// Update Check, Update Notice, Install Method and Auto Update (spec §3.23, ADR-0021). The registry, the install
// command and the machine are replaced through bindUpdateDeps; nothing here reaches the network.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from './paths.ts'
import {
  afterCommandPlan,
  applyUpdate,
  autoPending,
  autoUpdateBlocker,
  autoUpdateLine,
  backgroundCheck,
  bindUpdateDeps,
  checkDue,
  checksOff,
  compareVersions,
  installMethod,
  jsonNotice,
  markRunning,
  noticeLine,
  planFrom,
  readUpdateCache,
  refreshUpdateCheck,
  runningSessions,
  sameLine,
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
}

function machine(h: FakeHome, over: Partial<UpdateDeps> & { latest?: string | Error } = {}): Machine {
  const m: Machine = { execs: [], restarts: [], appRefreshes: 0 }
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
    ...over,
  })
  return m
}

const envWithChecks = (h: FakeHome) => {
  const { SIDEBY_NO_UPDATE_NOTIFIER: _off, ...env } = h.env
  return env
}

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
