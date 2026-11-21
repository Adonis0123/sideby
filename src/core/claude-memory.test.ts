// Shared Project Memory (spec §3.44, ADR-0081): the folder name Claude Code gives a Project, and Doctor's fold of an
// Account's own memory into the Main Account.
import assert from 'node:assert/strict'
import {
  chmod,
  type FileHandle,
  lstat,
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
import { claudeProjectDirName } from '../families/claude/layout.ts'
import type { Account } from '../types.ts'
import {
  accountMemories,
  claudeLiveRuns,
  FOLD_STAGE,
  foldAccount,
  foldProject,
  indexProblems,
  indexTargets,
  keepInState,
  type LiveRuns,
  type MemoryDoctorContext,
  memoryFindings,
  memoryStatus,
  memoryTarget,
  mergeIndex,
  nameMismatches,
  rewriteLinks,
} from './claude-memory.ts'
import type { ProcessView } from './live-sessions-procs.ts'

const work = (h: FakeHome): Account => ({
  family: 'claude',
  name: 'work',
  ref: 'claude:work',
  dir: h.path('.claude-work'),
  isMain: false,
  kind: 'subscription',
})

const stateDir = (h: FakeHome) => h.path('.local/state/sideby')
const at = new Date('2026-11-20T08:00:00Z')

function ctx(
  h: FakeHome,
  liveRuns: (a: Account) => Promise<LiveRuns> = async () => ({ runs: [] }),
): MemoryDoctorContext {
  return {
    mainDir: h.path('.claude'),
    stateDir: stateDir(h),
    liveRuns,
    label: (a, r) => [a.ref, r.title, r.sessionId.slice(0, 8)].filter(Boolean).join(' · '),
    trash: (p) => keepInState(p, stateDir(h), at),
    now: () => at,
    show: (p) => p.split(`${h.home}/`).join('~/'),
  }
}

/** Claude Code's 32-bit string hash, written out independently of the code under test. */
function javaHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  )

describe('the folder name Claude Code gives a Project', () => {
  it('turns every character that is not a letter or digit into a dash', () => {
    assert.equal(claudeProjectDirName('/private/tmp/a-b/c'), '-private-tmp-a-b-c')
    assert.equal(claudeProjectDirName('/srv/u/.agents'), '-srv-u--agents')
    assert.equal(claudeProjectDirName('/srv/my app_v2 (copy)/é'), '-srv-my-app-v2--copy---')
  })

  it('cuts a name longer than 200 characters and adds a hash of the whole path', () => {
    const path = `/srv/${'x'.repeat(240)}`
    const name = claudeProjectDirName(path)
    assert.equal(name, `-srv-${'x'.repeat(195)}-${Math.abs(javaHash(path)).toString(36)}`)
    assert.equal(claudeProjectDirName(`/srv/${'y'.repeat(195)}`).length, 200)
  })
})

describe('where a Launch sends Claude memory', () => {
  it('a folder outside git uses itself, by its real path', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude')
      await h.mkdir('code/app/sub')
      await symlink(h.path('code/app'), h.path('app-link'))
      const t = await memoryTarget(h.path('.claude'), h.path('app-link'))
      assert.equal(t.status, 'ok')
      if (t.status !== 'ok') return
      assert.equal(t.root, h.path('code/app'))
      assert.equal(t.name, `${claudeProjectDirName(h.home)}-code-app`)
      assert.equal(t.dir, h.path('.claude/projects', t.name, 'memory'))
      const sub = await memoryTarget(h.path('.claude'), h.path('code/app/sub'))
      assert.equal(sub.status === 'ok' && sub.name, `${claudeProjectDirName(h.home)}-code-app-sub`)
    })
  })

  it("a subfolder of a git repository and a linked worktree both use the main checkout's folder", async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude')
      await h.mkdir('code/repo/.git/worktrees/wt')
      await h.mkdir('code/repo/src')
      await h.mkdir('code/repo-wt/src')
      await h.write('code/repo-wt/.git', `gitdir: ${h.path('code/repo/.git/worktrees/wt')}\n`)
      await h.write('code/repo/.git/worktrees/wt/gitdir', `${h.path('code/repo-wt/.git')}\n`)
      await h.write('code/repo/.git/worktrees/wt/commondir', '../..\n')
      const want = `${claudeProjectDirName(h.home)}-code-repo`
      for (const cwd of ['code/repo', 'code/repo/src', 'code/repo-wt', 'code/repo-wt/src']) {
        const t = await memoryTarget(h.path('.claude'), h.path(cwd))
        assert.equal(t.status === 'ok' && t.name, want, cwd)
      }
    })
  })

  it('skips a folder sideby cannot place (a submodule) and a link under the main account', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude')
      await h.mkdir('code/super/.git/modules/lib')
      await h.write('code/super/lib/.git', 'gitdir: ../.git/modules/lib\n')
      const sub = await memoryTarget(h.path('.claude'), h.path('code/super/lib'))
      assert.equal(sub.status, 'skip')
      await h.mkdir('elsewhere/projects')
      await symlink(h.path('elsewhere/projects'), h.path('.claude/projects'))
      await h.mkdir('code/app')
      const linked = await memoryTarget(h.path('.claude'), h.path('code/app'))
      assert.equal(linked.status, 'skip')
      assert.match(linked.status === 'skip' ? linked.why : '', /is a link/)
    })
  })

  it('skips when the main account has no folder yet', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      assert.equal((await memoryTarget(h.path('.claude'), h.path('code/app'))).status, 'skip')
    })
  })
})

describe('merging MEMORY.md', () => {
  it('adds only the lines it lacks, in order, ignoring trailing spaces and blank lines', () => {
    const r = mergeIndex(
      '# Memory\n- [A](a.md) — a\n',
      '# Memory\n- [A](a.md) — a  \n\n- [B](b.md) — b\n- [B](b.md) — b\n',
    )
    assert.deepEqual(r, { text: '# Memory\n- [A](a.md) — a\n- [B](b.md) — b\n', added: 1 })
    assert.deepEqual(mergeIndex('- x', '- y\n'), { text: '- x\n- y\n', added: 1 })
    assert.deepEqual(mergeIndex('- x\n', '- x\n'), { text: '- x\n', added: 0 })
  })
})

describe("Doctor's fold of an account's own memory", () => {
  it('moves a project the main account lacks whole, keeping file times', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await h.write('.claude-work/projects/-p/memory/MEMORY.md', '- [A](a.md) — a\n')
      const a = await h.write('.claude-work/projects/-p/memory/a.md', 'alpha\n')
      await utimes(a, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
      const r = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r.status, 'moved')
      assert.deepEqual(r.moved, ['MEMORY.md', 'a.md'])
      assert.equal(await readFile(h.path('.claude/projects/-p/memory/a.md'), 'utf8'), 'alpha\n')
      assert.equal(
        (await stat(h.path('.claude/projects/-p/memory/a.md'))).mtime.toISOString(),
        '2026-01-02T00:00:00.000Z',
      )
      assert.equal(await exists(h.path('.claude-work/projects/-p/memory')), false)
    })
  })

  it('keeps a file that differs as <name>.<account>.md, merges the index, and trashes the emptied folder', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/-p/memory/MEMORY.md', '# Memory\n- [A](a.md) — a\n- [C](c.md) — c\n')
      await h.write('.claude/projects/-p/memory/a.md', 'main version\n')
      await h.write('.claude/projects/-p/memory/c.md', 'same\n')
      await h.write('.claude/projects/-p/memory/a.work.md', 'an older copy\n')
      await h.write(
        '.claude-work/projects/-p/memory/MEMORY.md',
        '# Memory\n- [A](a.md) — a\n- [B](b.md) — b\n- [C](c.md) — c\n',
      )
      await h.write('.claude-work/projects/-p/memory/a.md', 'work version\n')
      await h.write('.claude-work/projects/-p/memory/b.md', 'beta\n')
      await h.write('.claude-work/projects/-p/memory/c.md', 'same\n')
      const r = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r.status, 'merged')
      assert.deepEqual(r.moved, ['b.md'])
      assert.deepEqual(r.same, ['c.md'])
      // `a.work.md` already holds other text, so the next free name is used; nothing is overwritten.
      assert.deepEqual(r.renamed, [{ from: 'a.md', to: 'a.work-2.md' }])
      const main = h.path('.claude/projects/-p/memory')
      assert.equal(await readFile(join(main, 'a.md'), 'utf8'), 'main version\n')
      assert.equal(await readFile(join(main, 'a.work.md'), 'utf8'), 'an older copy\n')
      assert.equal(await readFile(join(main, 'a.work-2.md'), 'utf8'), 'work version\n')
      assert.equal(await readFile(join(main, 'b.md'), 'utf8'), 'beta\n')
      assert.equal(
        await readFile(join(main, 'MEMORY.md'), 'utf8'),
        '# Memory\n- [A](a.md) — a\n- [C](c.md) — c\n- [A](a.work-2.md) — a\n- [B](b.md) — b\n',
      )
      assert.equal(r.indexLines, 2)
      // The Account's folder is gone from the Account and kept whole, never deleted.
      assert.equal(await exists(h.path('.claude-work/projects/-p/memory')), false)
      assert.ok(r.trashed)
      assert.deepEqual((await readdir(r.trashed!)).sort(), ['MEMORY.md', 'a.md', 'b.md', 'c.md'])
    })
  })

  it('refuses a linked memory folder, a link inside it, and a linked folder in the main account', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await h.write('outside/memory/x.md', 'x\n')
      await h.mkdir('.claude-work/projects/-linked')
      await symlink(h.path('outside/memory'), h.path('.claude-work/projects/-linked/memory'))
      const listed = await accountMemories(h.path('.claude-work'))
      assert.deepEqual(listed.list, [])
      assert.deepEqual(listed.links, [h.path('.claude-work/projects/-linked/memory')])
      const r1 = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-linked',
        trash: ctx(h).trash,
      })
      assert.equal(r1.status, 'failed')
      assert.equal(await exists(h.path('.claude/projects/-linked')), false)

      await h.write('.claude-work/projects/-inner/memory/a.md', 'a\n')
      await symlink(h.path('outside/memory/x.md'), h.path('.claude-work/projects/-inner/memory/x.md'))
      const r2 = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-inner',
        trash: ctx(h).trash,
      })
      assert.equal(r2.status, 'failed')
      assert.match(r2.why ?? '', /is a link/)
      assert.equal(await exists(h.path('.claude-work/projects/-inner/memory/a.md')), true)
      assert.equal(await exists(h.path('.claude/projects/-inner')), false)

      await h.write('.claude-work/projects/-m/memory/a.md', 'a\n')
      await h.mkdir('.claude/projects/-m')
      await symlink(h.path('outside/memory'), h.path('.claude/projects/-m/memory'))
      const r3 = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-m',
        trash: ctx(h).trash,
      })
      assert.equal(r3.status, 'failed')
      assert.deepEqual(await readdir(h.path('outside/memory')), ['x.md'])
      assert.equal(await exists(h.path('.claude-work/projects/-m/memory/a.md')), true)
    })
  })

  describe('the memory finding while sessions of the account run', () => {
    const run = (cwd: string) => ({
      cwd,
      sessionId: 'ad73ceaf-0001-4000-8000-000000000001',
      title: 'tidy login',
    })
    async function seed(h: FakeHome, ...projects: string[]) {
      await h.mkdir('.claude/projects')
      const out: { path: string; name: string }[] = []
      for (const p of projects) {
        const path = await h.mkdir(`code/${p}`)
        const name = claudeProjectDirName(path)
        await h.write(`.claude-work/projects/${name}/memory/${p}.md`, `${p}\n`)
        out.push({ path, name })
      }
      return out
    }

    it('offers no fix and names the session when every project waits for one', async () => {
      await withFakeHome(async (h) => {
        const [app] = await seed(h, 'app')
        const c = ctx(h, async () => ({ runs: [run(app!.path)] }))
        const [f] = await memoryFindings(c, work(h))
        assert.equal(f?.code, 'memory.unfolded')
        assert.equal(f?.fixable, false)
        assert.equal(f?.fix, undefined)
        const holds = `${app!.name} (claude:work · tidy login · ad73ceaf)`
        assert.deepEqual(f?.params, { form: 'waiting', n: 1, waiting: holds })
        assert.ok(
          f?.message.includes(
            `a session of claude:work works in it: ${holds}; it moves once that session ends`,
          ),
        )
        assert.match(f?.hint ?? '', /wait until that session ends.*do not move memory files by hand/)
        // A Fix run anyway (another surface, or a stale list) moves nothing and says why.
        const r = await foldAccount(c, work(h))
        assert.equal(r.ok, false)
        assert.deepEqual(r.params, { form: 'waiting', waiting: holds })
        assert.equal(await exists(h.path(`.claude-work/projects/${app!.name}/memory/app.md`)), true)
      })
    })

    it('says how many move now and which wait when only some projects have a session', async () => {
      await withFakeHome(async (h) => {
        const [app, site] = await seed(h, 'app', 'site')
        const c = ctx(h, async () => ({ runs: [run(app!.path)] }))
        const [f] = await memoryFindings(c, work(h))
        const holds = `${app!.name} (claude:work · tidy login · ad73ceaf)`
        assert.equal(f?.fixable, true)
        assert.deepEqual(f?.params, { form: 'some', n: 2, ready: 1, waiting: holds })
        assert.ok(
          f?.message.includes(
            `the fix moves 1 project now, and these wait until their session ends: ${holds}`,
          ),
        )
        const r = await f!.fix!()
        assert.equal(r.ok, true, r.message)
        assert.equal(await exists(h.path(`.claude/projects/${site!.name}/memory/site.md`)), true)
        assert.equal(await exists(h.path(`.claude-work/projects/${app!.name}/memory/app.md`)), true)
      })
    })

    it('says it cannot tell which sessions run instead of offering a fix', async () => {
      await withFakeHome(async (h) => {
        await seed(h, 'app')
        const [f] = await memoryFindings(
          ctx(h, async () => ({ unknown: 'a record Claude Code is rewriting' })),
          work(h),
        )
        assert.equal(f?.fixable, false)
        assert.equal(f?.params?.form, 'unknown')
        assert.match(f?.message ?? '', /cannot tell which sessions of claude:work are running right now/)
        assert.match(f?.hint ?? '', /check again in a moment.*Do not move memory files by hand/)
      })
    })
  })

  it('leaves a project alone while a session of that account works in it, and moves nothing when it cannot tell', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      const app = await h.mkdir('code/app')
      const name = claudeProjectDirName(app)
      await h.write(`.claude-work/projects/${name}/memory/a.md`, 'a\n')
      await h.write('.claude-work/projects/-other/memory/b.md', 'b\n')
      const r = await foldAccount(
        ctx(h, async () => ({ runs: [{ cwd: app, sessionId: 'ad73ceaf-0001', title: 'tidy login' }] })),
        work(h),
      )
      assert.equal(r.ok, true)
      assert.match(
        r.message,
        new RegExp(
          `left 1 project while a session of claude:work works there: ${name} \\(claude:work · tidy login · ad73ceaf\\)`,
        ),
      )
      assert.equal(await exists(h.path(`.claude-work/projects/${name}/memory/a.md`)), true)
      assert.equal(await exists(h.path('.claude/projects/-other/memory/b.md')), true)

      const unknown = await foldAccount(
        ctx(h, async () => ({ unknown: 'a record Claude Code is rewriting' })),
        work(h),
      )
      assert.equal(unknown.ok, false)
      assert.match(unknown.message, /moved nothing/)
      assert.equal(await exists(h.path(`.claude-work/projects/${name}/memory/a.md`)), true)
      // The fold that happened is recorded by name and count only.
      const st = await memoryStatus(
        { mainDir: h.path('.claude'), stateDir: stateDir(h), accounts: async () => [work(h)] },
        false,
      )
      assert.deepEqual(st.folded, [
        { account: 'claude:work', project: '-other', files: 1, at: at.toISOString() },
      ])
    })
  })
})

describe("Doctor's warnings about the main account's memory", () => {
  it('names an index that lists a missing file or misses one that is there', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/-ok/memory/MEMORY.md', '- [A](a.md)\n')
      await h.write('.claude/projects/-ok/memory/a.md', 'a\n')
      await h.write(
        '.claude/projects/-bad/memory/MEMORY.md',
        '- [A](./a.md)\n- [Gone](gone.md)\n- [Web](https://example.com/x.md)\n',
      )
      await h.write('.claude/projects/-bad/memory/a.md', 'a\n')
      await h.write('.claude/projects/-bad/memory/new.md', 'n\n')
      assert.deepEqual(await indexProblems(h.path('.claude')), [
        { project: '-bad', missing: ['gone.md'], unlisted: ['new.md'] },
      ])
    })
  })

  it("names a folder whose sessions say Claude Code named it differently from sideby's rule", async () => {
    await withFakeHome(async (h) => {
      const cwd = await h.mkdir('code/app')
      const name = claudeProjectDirName(cwd)
      const line = (c: string) => `${JSON.stringify({ type: 'user', cwd: c, sessionId: 's' })}\n`
      // Agrees: the folder is named the way sideby names the session's folder.
      await h.write(`.claude/projects/${name}/memory/a.md`, 'a\n')
      await h.write(`.claude/projects/${name}/s1.jsonl`, `{"type":"summary"}\n${line(cwd)}`)
      const accounts: Account[] = [
        {
          family: 'claude',
          name: 'main',
          ref: 'claude:main',
          dir: h.path('.claude'),
          isMain: true,
          kind: 'subscription',
        },
        work(h),
      ]
      assert.deepEqual(await nameMismatches(accounts), [])
      // Disagrees: Claude Code kept the dot of `.app` in this folder's name.
      const dotted = await h.mkdir('code/.app')
      await h.write('.claude-work/projects/odd.app/memory/a.md', 'a\n')
      await h.write('.claude-work/projects/odd.app/s2.jsonl', line(dotted))
      assert.deepEqual(await nameMismatches(accounts), [
        { account: 'claude:work', folder: 'odd.app', cwd: dotted, derived: claudeProjectDirName(dotted) },
      ])
    })
  })

  it('does not count a resumed session or a project folder renamed by hand after its project moved', async () => {
    await withFakeHome(async (h) => {
      const now = await h.mkdir('code/app-new')
      const name = claudeProjectDirName(now)
      const line = (c: string) => `${JSON.stringify({ type: 'user', cwd: c, sessionId: 's' })}\n`
      await h.write(`.claude-work/projects/${name}/memory/a.md`, 'a\n')
      // Resumed here: the first records keep the folder it came from, the last ones name this one.
      await h.write(`.claude-work/projects/${name}/s1.jsonl`, `${line(h.path('code/other'))}${line(now)}`)
      // Moved: the folder its sessions name is gone, so they say nothing about Claude Code's naming.
      await h.write('.claude-work/projects/-renamed-by-hand/memory/a.md', 'a\n')
      await h.write('.claude-work/projects/-renamed-by-hand/s2.jsonl', line(h.path('code/gone')))
      await h.mkdir('code/other')
      assert.deepEqual(await nameMismatches([work(h)]), [])
    })
  })

  it('reads no account folder for the status while the setting is off', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-work/projects/-p/memory/a.md', 'a\n')
      // Finding the Accounts walks the Host folders: it must not even be asked while off.
      let asked = 0
      const spy = async () => {
        asked++
        return [work(h)]
      }
      const off = await memoryStatus(
        { mainDir: h.path('.claude'), stateDir: stateDir(h), accounts: spy },
        false,
        h.home,
      )
      assert.equal(asked, 0)
      assert.equal(off.projects, undefined)
      assert.equal(off.dir, undefined)
      const on = await memoryStatus(
        { mainDir: h.path('.claude'), stateDir: stateDir(h), accounts: async () => [work(h)] },
        true,
      )
      assert.deepEqual(on.projects, [
        { name: '-p', main: 0, pending: [{ account: 'claude:work', files: 1 }], folded: [] },
      ])
    })
  })
})

describe('review rounds: the fold never loses or mislinks memory', () => {
  const START = 'Thu Nov 20 08:00:00 2026'
  const startMs = Date.UTC(2026, 10, 20, 8, 0, 0)
  /** A process view where `pid` runs, started at `at`; or one whose process list cannot be read. */
  const procsWith = (pid: number, at = startMs): ProcessView => ({
    list: async () => [{ pid, ppid: 1, startMs: at, command: 'claude' }],
    get: async (p) => (p === pid ? { pid, ppid: 1, startMs: at, command: 'claude' } : undefined),
    envVar: async () => undefined,
    openFiles: async () => [],
    argv: async () => undefined,
  })
  const noPs: ProcessView = {
    list: async () => Promise.reject(new Error('`ps` is not on PATH')),
    get: async () => Promise.reject(new Error('`ps` is not on PATH')),
    envVar: async () => undefined,
    openFiles: async () => [],
    argv: async () => undefined,
  }
  const record = (o: Record<string, unknown>) => JSON.stringify({ pid: 4242, procStart: START, ...o })

  for (const [what, text, procs] of [
    ['a record caught mid-rewrite', '{"sessionId":"s1","cwd":', procsWith(4242)],
    ['a record without its working folder', record({ sessionId: 's1' }), procsWith(4242)],
    ['a record without its session id', record({ cwd: '/srv/app' }), procsWith(4242)],
    [
      'a record without a start time',
      JSON.stringify({ pid: 4242, sessionId: 's1', cwd: '/srv/app' }),
      procsWith(4242),
    ],
    ['a process list that cannot be read', record({ sessionId: 's1', cwd: '/srv/app' }), noPs],
  ] as const)
    it(`counts an account with ${what} as running, and moves nothing of it`, async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('.claude/projects')
        await h.write('.claude-work/projects/-p/memory/a.md', 'a\n')
        await h.write('.claude-work/sessions/4242.json', text)
        const live = await claudeLiveRuns(work(h), procs)
        assert.ok('unknown' in live, JSON.stringify(live))
        const r = await foldAccount(
          ctx(h, () => claudeLiveRuns(work(h), procs)),
          work(h),
        )
        assert.equal(r.ok, false)
        assert.match(r.message, /cannot tell which sessions of claude:work are running .*moved nothing/)
        assert.equal(await exists(h.path('.claude-work/projects/-p/memory/a.md')), true)
        assert.equal(await exists(h.path('.claude/projects/-p')), false)
      })
    })

  it('reads a running session, and counts a record whose pid now belongs to another process as ended', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude-work/sessions/4242.json', record({ sessionId: 's1', cwd: '/srv/app' }))
      assert.deepEqual(await claudeLiveRuns(work(h), procsWith(4242)), {
        runs: [{ cwd: '/srv/app', sessionId: 's1', title: 'app' }],
      })
      await h.write(
        '.claude-work/sessions/4242.json',
        record({ sessionId: 's1', cwd: '/srv/app', name: 'tidy login', nameSource: 'user' }),
      )
      assert.deepEqual(await claudeLiveRuns(work(h), procsWith(4242)), {
        runs: [{ cwd: '/srv/app', sessionId: 's1', title: 'tidy login' }],
      })
      assert.deepEqual(await claudeLiveRuns(work(h), procsWith(4242, startMs + 60_000)), { runs: [] })
      assert.deepEqual(await claudeLiveRuns(work(h), procsWith(1)), { runs: [] })
      assert.deepEqual(await claudeLiveRuns({ ...work(h), dir: h.path('.claude-none') }, noPs), { runs: [] })
    })
  })

  interface FoldHooks {
    /** After every copy is checked, before anything is taken out. */
    change?: (src: string) => Promise<unknown>
    /** After a file is renamed into the stage, before its hash. */
    staged?: (name: string, src: string, stage: string) => Promise<unknown>
    /** After every staged file is checked, right before the stage goes to the trash. */
    beforeTrash?: (src: string) => Promise<unknown>
  }

  /** Main holds `a.md`; the account holds `b.md` and an index; the hooks write at the given moments. */
  async function foldHooked(h: FakeHome, hooks: FoldHooks) {
    await h.write('.claude/projects/-p/memory/MEMORY.md', '- [A](a.md) — a\n')
    await h.write('.claude/projects/-p/memory/a.md', 'a\n')
    await h.write('.claude-work/projects/-p/memory/MEMORY.md', '- [B](b.md) — b\n')
    await h.write('.claude-work/projects/-p/memory/b.md', 'b\n')
    const src = h.path('.claude-work/projects/-p/memory')
    const stage = h.path('.claude-work/projects/-p', FOLD_STAGE)
    const trashed: string[][] = []
    const trashedText = new Map<string, string>()
    const r = await foldProject({
      mainDir: h.path('.claude'),
      account: work(h),
      project: '-p',
      trash: async (p) => {
        await hooks.beforeTrash?.(src)
        const names = (await readdir(p)).sort()
        trashed.push(names)
        for (const n of names) trashedText.set(n, await readFile(join(p, n), 'utf8'))
        return keepInState(p, stateDir(h), at)
      },
      afterCopy: async () => {
        await hooks.change?.(src)
      },
      staged: async (n) => {
        await hooks.staged?.(n, src, stage)
      },
    })
    return { r, src, stage, trashed, trashedText }
  }

  const foldWith = (h: FakeHome, change: (src: string) => Promise<unknown>) => foldHooked(h, { change })

  it('keeps a file written after the check in the account, and trashes only what was copied', async () => {
    await withFakeHome(async (h) => {
      const { r, src, trashed } = await foldWith(h, (src) =>
        writeFile(join(src, 'late.md'), 'written meanwhile\n'),
      )
      assert.equal(r.status, 'partial')
      assert.match(r.why ?? '', /new memory appeared .* the next fix moves it/)
      assert.deepEqual(trashed, [['MEMORY.md', 'b.md']])
      assert.deepEqual(await readdir(src), ['late.md'])
      assert.equal(await readFile(join(src, 'late.md'), 'utf8'), 'written meanwhile\n')
      assert.equal(await exists(h.path('.claude-work/projects/-p', FOLD_STAGE)), false)
    })
  })

  it('puts back a file changed after the check (MEMORY.md too) instead of trashing it', async () => {
    await withFakeHome(async (h) => {
      const { r, src, trashed } = await foldWith(h, (src) =>
        writeFile(join(src, 'MEMORY.md'), '- [B](b.md) — b\n- [Late](late.md)\n'),
      )
      assert.equal(r.status, 'partial')
      assert.match(r.why ?? '', /MEMORY\.md changed while sideby moved it, so it stays in claude:work/)
      assert.deepEqual(trashed, [['b.md']])
      assert.deepEqual(await readdir(src), ['MEMORY.md'])
      assert.equal(await readFile(join(src, 'MEMORY.md'), 'utf8'), '- [B](b.md) — b\n- [Late](late.md)\n')
    })
  })

  it('trashes the checked file and keeps one written by its name after the check and before the trash', async () => {
    await withFakeHome(async (h) => {
      const { r, src, trashed, trashedText } = await foldHooked(h, {
        beforeTrash: (src) => writeFile(join(src, 'b.md'), 'b written again\n'),
      })
      assert.equal(r.status, 'partial')
      assert.match(r.why ?? '', /new memory appeared .* the next fix moves it/)
      assert.deepEqual(trashed, [['MEMORY.md', 'b.md']])
      assert.equal(trashedText.get('b.md'), 'b\n')
      assert.deepEqual(await readdir(src), ['b.md'])
      assert.equal(await readFile(join(src, 'b.md'), 'utf8'), 'b written again\n')
      assert.equal(await readFile(h.path('.claude/projects/-p/memory/b.md'), 'utf8'), 'b\n')
    })
  })

  it('never trashes a file that changed in the stage: back under a free name when a new file took its own', async () => {
    await withFakeHome(async (h) => {
      const { r, src, trashed } = await foldHooked(h, {
        staged: async (n, src, stage) => {
          if (n !== 'b.md') return
          await writeFile(join(stage, 'b.md'), 'b changed while open\n')
          await writeFile(join(src, 'b.md'), 'b new\n')
        },
      })
      assert.equal(r.status, 'partial')
      assert.match(r.why ?? '', /b\.md \(as b\.changed\.md\) changed while sideby moved it/)
      assert.deepEqual(trashed, [['MEMORY.md']])
      assert.deepEqual((await readdir(src)).sort(), ['b.changed.md', 'b.md'])
      assert.equal(await readFile(join(src, 'b.md'), 'utf8'), 'b new\n')
      assert.equal(await readFile(join(src, 'b.changed.md'), 'utf8'), 'b changed while open\n')
    })
  })

  it('trashes nothing when a changed file cannot be put back, and leaves the stage for the user', async () => {
    await withFakeHome(async (h) => {
      let locked = ''
      try {
        const { r, stage, trashed } = await foldHooked(h, {
          staged: async (n, src, stage) => {
            if (n !== 'b.md') return
            await writeFile(join(stage, 'b.md'), 'b changed while open\n')
            await chmod(src, 0o500)
            locked = src
          },
        })
        assert.equal(r.status, 'failed')
        assert.match(r.why ?? '', /b\.md changed while sideby moved it and could not be put back/)
        assert.deepEqual(trashed, [])
        assert.deepEqual((await readdir(stage)).sort(), ['MEMORY.md', 'b.md'])
      } finally {
        if (locked) await chmod(locked, 0o700)
      }
    })
  })

  it('never puts a stage file back over a file of the same name', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await h.write('.claude-work/projects/-p/memory/b.md', 'b new\n')
      await h.write(`.claude-work/projects/-p/${FOLD_STAGE}/b.md`, 'b old\n')
      const r = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r.status, 'failed')
      assert.match(r.why ?? '', /still holds files whose names are taken/)
      assert.equal(await readFile(h.path('.claude-work/projects/-p/memory/b.md'), 'utf8'), 'b new\n')
      assert.equal(await readFile(h.path(`.claude-work/projects/-p/${FOLD_STAGE}/b.md`), 'utf8'), 'b old\n')
    })
  })

  for (const [what, prepare] of [
    ['an empty memory folder', (h: FakeHome) => h.mkdir('.claude-work/projects/-p/memory')],
    ['no memory folder', async (_h: FakeHome) => {}],
  ] as const)
    it(`finds and folds a stage left after the last file was staged, with ${what}`, async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('.claude/projects/-p/memory')
        await h.write('.claude/projects/-p/memory/b.md', 'b old\n')
        await h.write(`.claude-work/projects/-p/${FOLD_STAGE}/b.md`, 'b newer\n')
        await prepare(h)
        const listed = await accountMemories(h.path('.claude-work'))
        assert.deepEqual(
          listed.list.map((m) => [m.project, m.files]),
          [['-p', 1]],
        )
        const r = await foldAccount(ctx(h), work(h))
        assert.equal(r.ok, true, r.message)
        assert.equal(await exists(h.path('.claude-work/projects/-p', FOLD_STAGE)), false)
        const kept = (await readdir(h.path('.claude/projects/-p/memory'))).sort()
        assert.equal(kept.length, 2, kept.join(','))
        const texts = await Promise.all(
          kept.map((n) => readFile(h.path('.claude/projects/-p/memory', n), 'utf8')),
        )
        assert.ok(texts.includes('b newer\n') && texts.includes('b old\n'))
      })
    })

  it('puts back what a fold that stopped halfway left in its stage before it starts', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await h.write('.claude-work/projects/-p/memory/a.md', 'a\n')
      await h.write(`.claude-work/projects/-p/${FOLD_STAGE}/b.md`, 'b\n')
      const r = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r.status, 'moved')
      assert.deepEqual((await readdir(h.path('.claude/projects/-p/memory'))).sort(), ['a.md', 'b.md'])
      assert.equal(await exists(h.path('.claude-work/projects/-p', FOLD_STAGE)), false)
    })
  })

  it('gives each kept file a name neither folder uses, and rewrites index links in one pass', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/-p/memory/MEMORY.md', '- [A](a.md) — main a\n')
      await h.write('.claude/projects/-p/memory/a.md', 'main a\n')
      await h.write(
        '.claude-work/projects/-p/memory/MEMORY.md',
        '- [A](a.md#setup) — work a\n- [A2](../memory/a.md) — again\n- [A3](./a.md#notes) — notes\n- [AW](./a.work.md) — work a.work\n',
      )
      await h.write('.claude-work/projects/-p/memory/a.md', 'work a\n')
      await h.write('.claude-work/projects/-p/memory/a.work.md', 'work a.work\n')
      const r = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r.status, 'merged', r.why)
      // `a.work.md` belongs to the account's own file, so the account's different `a.md` gets the next free name;
      // every link that resolves to `a.md` follows it (its #fragment kept), the others stay as written.
      assert.deepEqual(r.renamed, [{ from: 'a.md', to: 'a.work-2.md' }])
      assert.deepEqual(r.moved, ['a.work.md'])
      const main = h.path('.claude/projects/-p/memory')
      assert.equal(await readFile(join(main, 'a.work-2.md'), 'utf8'), 'work a\n')
      assert.equal(await readFile(join(main, 'a.work.md'), 'utf8'), 'work a.work\n')
      assert.equal(
        await readFile(join(main, 'MEMORY.md'), 'utf8'),
        '- [A](a.md) — main a\n- [A](a.work-2.md#setup) — work a\n- [A2](a.work-2.md) — again\n- [A3](a.work-2.md#notes) — notes\n- [AW](./a.work.md) — work a.work\n',
      )
      const map = new Map([
        ['a.md', 'a.work.md'],
        ['a.work.md', 'a.work.work.md'],
      ])
      assert.equal(
        rewriteLinks(
          '[x](a.md) [y](./a.work.md) [z](a.md#h) [w](../memory/a.md) [o](../other/a.md) [u](https://x/a.md)',
          map,
        ),
        '[x](a.work.md) [y](a.work.work.md) [z](a.work.md#h) [w](a.work.md) [o](../other/a.md) [u](https://x/a.md)',
      )
      assert.deepEqual(
        indexTargets('[a](a.md#s) [b](./b.md) [c](../memory/c.md) [d](sub/d.md) [e](mailto:x)'),
        ['a.md', 'b.md', 'c.md'],
      )
    })
  })

  it('leaves nothing under the final name when a copy fails partway, so a retry uses the same name', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/projects/-p/memory/a.md', 'main a\n')
      await h.write('.claude-work/projects/-p/memory/a.md', 'work a, a longer note\n')
      const main = h.path('.claude/projects/-p/memory')
      const failing = async (fh: FileHandle, data: Buffer) => {
        await fh.write(data.subarray(0, 5))
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      const r1 = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
        write: failing,
      })
      assert.equal(r1.status, 'failed')
      assert.match(r1.why ?? '', /could not be written \(ENOSPC\)/)
      assert.deepEqual(await readdir(main), ['a.md'])
      const r2 = await foldProject({
        mainDir: h.path('.claude'),
        account: work(h),
        project: '-p',
        trash: ctx(h).trash,
      })
      assert.equal(r2.status, 'merged', r2.why)
      assert.deepEqual(r2.renamed, [{ from: 'a.md', to: 'a.work.md' }])
      assert.equal(await readFile(join(main, 'a.work.md'), 'utf8'), 'work a, a longer note\n')
    })
  })
})
