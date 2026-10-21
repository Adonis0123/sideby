// The Project of a Session (spec §3.33): repository root, subfolders and worktrees fold into it; a gone folder keeps
// the Host's root or itself; names get their parent folder when two Projects share one.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { ProjectResolver, projectNames } from './history-project.ts'

describe('ProjectResolver', () => {
  it('finds the repository root from the root and from a subfolder', async () => {
    await withFakeHome(async (h) => {
      const repo = await h.mkdir('code/app')
      await h.mkdir('code/app/.git')
      await h.mkdir('code/app/src/login')
      const r = new ProjectResolver()
      assert.deepEqual(await r.resolve(repo), { path: repo, gone: false })
      assert.deepEqual(await r.resolve(h.path('code/app/src/login')), { path: repo, gone: false })
    })
  })

  it('folds a worktree into its main repository, with an absolute or relative gitdir', async () => {
    await withFakeHome(async (h) => {
      const repo = await h.mkdir('code/app')
      await h.mkdir('code/app/.git/worktrees/wt')
      await h.write('code/app-wt/.git', `gitdir: ${h.path('code/app/.git/worktrees/wt')}\n`)
      await h.mkdir('code/app-wt/pkg')
      await h.write('code/app-rel/.git', 'gitdir: ../app/.git/worktrees/rel\n')
      const r = new ProjectResolver()
      assert.deepEqual(await r.resolve(h.path('code/app-wt/pkg')), { path: repo, gone: false })
      assert.deepEqual(await r.resolve(h.path('code/app-rel')), { path: repo, gone: false })
      // A `.git` file of another shape (a submodule) is its own Project.
      await h.write('code/sub/.git', `gitdir: ${h.path('code/app/.git/modules/sub')}\n`)
      assert.deepEqual(await r.resolve(h.path('code/sub')), { path: h.path('code/sub'), gone: false })
    })
  })

  it('uses the folder itself outside a repository', async () => {
    await withFakeHome(async (h) => {
      const dir = await h.mkdir('notes/today')
      assert.deepEqual(await new ProjectResolver().resolve(dir), { path: dir, gone: false })
    })
  })

  it('keeps the Host root, else the folder, when the folder is gone', async () => {
    await withFakeHome(async (h) => {
      const repo = await h.mkdir('code/app')
      await h.mkdir('code/app/.git/worktrees/wt')
      await h.write('code/app-wt/.git', `gitdir: ${h.path('code/app/.git/worktrees/wt')}\n`)
      const r = new ProjectResolver()
      const gone = h.path('code/removed/sub')
      assert.deepEqual(await r.resolve(gone), { path: gone, gone: true })
      assert.deepEqual(await r.resolve(gone, repo), { path: repo, gone: true })
      // The Host's root is itself a worktree: folded too.
      assert.deepEqual(await r.resolve(h.path('code/app-wt/gone'), h.path('code/app-wt')), {
        path: repo,
        gone: true,
      })
      // A relative root from the Host is not trusted.
      assert.deepEqual(await r.resolve(gone, 'relative/root'), { path: gone, gone: true })
    })
  })

  it('answers without a working directory and remembers what it found', async () => {
    await withFakeHome(async (h) => {
      const r = new ProjectResolver()
      assert.deepEqual(await r.resolve(undefined), { path: '', gone: false })
      assert.deepEqual(await r.resolve(undefined, '/work/app'), { path: '/work/app', gone: false })
      const dir = await h.mkdir('code/late')
      assert.deepEqual(await r.resolve(dir), { path: dir, gone: false })
      await h.mkdir('code/late/.git')
      assert.deepEqual(await r.resolve(dir), { path: dir, gone: false })
      assert.equal(r.resolve(dir), r.resolve(dir))
    })
  })
})

describe('projectNames', () => {
  it('uses the folder name, with its parent when two Projects share it', () => {
    const names = projectNames(['/work/a/app', '/work/b/app', '/work/web', '/work/web', '/'])
    assert.deepEqual(Object.fromEntries(names), {
      '/work/a/app': 'a/app',
      '/work/b/app': 'b/app',
      '/work/web': 'web',
      '/': '/',
    })
  })

  it('adds parent folders until the names differ', () => {
    const names = projectNames(['/x/src/app', '/y/src/app', '/z/lib/app'])
    assert.deepEqual(Object.fromEntries(names), {
      '/x/src/app': 'x/src/app',
      '/y/src/app': 'y/src/app',
      '/z/lib/app': 'lib/app',
    })
  })
})
