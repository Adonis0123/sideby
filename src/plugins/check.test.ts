import assert from 'node:assert/strict'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { demoFamily, demoPlugin } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { checkBuiltinPlugin, checkPlugin, defProblems, type PluginCheckResult } from './check.ts'
import { scaffoldPlugin, TODO_MARK } from './scaffold.ts'

/** A scaffold with every TODO line removed: its placeholder values are already fake. */
async function filled(h: FakeHome, id = 'mytool'): Promise<string> {
  const { dir } = await scaffoldPlugin({ id, dir: h.path('plugins') })
  for (const name of ['index.ts', 'index.test.ts']) {
    const p = join(dir, name)
    const text = await readFile(p, 'utf8')
    await writeFile(
      p,
      text
        .split('\n')
        .filter((l) => !l.includes(TODO_MARK))
        .join('\n'),
    )
  }
  return dir
}

async function edit(dir: string, from: string | RegExp, to: string, file = 'index.ts') {
  const p = join(dir, file)
  const text = await readFile(p, 'utf8')
  const next = text.replace(from, to)
  assert.notEqual(next, text, `edit did not apply: ${from}`)
  await writeFile(p, next)
}

function codes(r: PluginCheckResult): string[] {
  for (const p of r.problems) assert.ok(p.fix.length > 10, `${p.code} has a fix`)
  return r.problems.map((p) => p.code).sort()
}

describe('checkPlugin', () => {
  it('passes a filled-in scaffold and writes nothing into the plugin', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      const before = await snapshot(dir)
      const r = await checkPlugin({ dir })
      assert.deepEqual(r.problems, [])
      assert.equal(r.ok, true)
      assert.equal(r.plugin, 'mytool')
      assert.deepEqual(r.families, ['mytool'])
      assert.deepEqual(diffSnapshots(before, await snapshot(dir)), [])
    })
  })

  it('reports TODOs the skeleton still has', async () => {
    await withFakeHome(async (h) => {
      const { dir } = await scaffoldPlugin({ id: 'mytool', dir: h.path('plugins') })
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['todo.left'])
      assert.match(r.problems[0]!.message, /^index\.ts:\d+ /)
    })
  })

  it('reports Shared Item paths that leave the Account directory', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      await edit(
        dir,
        "[{ path: 'settings.json', mode: 'link-or-copy' }]",
        "[{ path: '../outside.json', mode: 'link' }, { path: '/etc/mytool.json', mode: 'link' }]",
      )
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['shared-item.absolute', 'shared-item.parent'])
      assert.match(r.problems.find((p) => p.code === 'shared-item.absolute')!.fix, /"mytool\.json"/)
    })
  })

  it('reports a home path, a personal email and a token, naming the line but not the value', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      const homePath = `/${'Users'}/alex/projects`
      const email = `alex${'@'}acme.dev`
      const token = `sk-${'a1B2'.repeat(6)}`
      await edit(
        dir,
        'const plugin',
        `// seen in ${homePath}\n// ask ${email} or me@example.com\nconst sample = '${token}'\nconst plugin`,
      )
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['leak.email', 'leak.home-path', 'leak.token'])
      const text = JSON.stringify(r)
      for (const value of [homePath, email, token])
        assert.ok(!text.includes(value), 'value stays out of the result')
    })
  })

  it('reports a value import from sideby', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      await edit(
        dir,
        "import type { FamilyDef, Plugin } from 'sideby'",
        "import { type FamilyDef, type Plugin } from 'sideby'",
      )
      const r = await checkPlugin({ dir })
      const problem = r.problems.find((p) => p.code === 'import.value')
      assert.ok(problem)
      assert.match(problem.message, /^index\.ts:4 /)
      assert.match(problem.fix, /import type/)
      assert.equal(r.ok, false)
    })
  })

  it('reports missing fields, a bad logo and a reader that throws', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      await edit(dir, "selectVar: 'MYTOOL_HOME',", "selectVar: '', logo: { path: '<svg/>' },")
      await edit(
        dir,
        "login: { args: ['login'], hint: 'run mytool login' },",
        "login: { args: ['login'], hint: 'run mytool login' }, loginState: async () => { throw new Error('boom') },",
      )
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['logo.invalid', 'round.discover', 'select-var.missing'])
      assert.match(r.problems.find((p) => p.code === 'round.discover')!.message, /login state: boom/)
    })
  })

  it('only reads a plugin the loader would not trust: it reports the trust problem and never runs it', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      const marker = h.path('loaded.txt')
      await edit(
        dir,
        'const plugin',
        `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nconst plugin`,
      )
      await chmod(join(dir, 'index.ts'), 0o664)
      const before = await snapshot(dir)
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['trust'])
      assert.deepEqual(r.families, [])
      assert.equal(r.plugin, 'mytool')
      await assert.rejects(stat(marker), 'the plugin was never loaded')
      assert.deepEqual(diffSnapshots(before, await snapshot(dir)), [], 'nothing was copied or chmod-ed')
      // The static checks still run.
      await edit(dir, 'const plugin', `const sample = '${`sk-${'a1B2'.repeat(6)}`}'\nconst plugin`)
      assert.deepEqual(codes(await checkPlugin({ dir })), ['leak.token', 'trust'])
    })
  })

  it('stops a plugin that never finishes loading, within the timeout', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      await edit(dir, 'const plugin', 'while (true) {}\nconst plugin')
      const started = Date.now()
      const r = await checkPlugin({ dir, timeoutMs: 1500 })
      assert.ok(Date.now() - started < 10_000, 'ended near the timeout')
      assert.deepEqual(codes(r), ['check.timeout'])
      assert.match(r.problems[0]!.fix, /register\(\)/)
    })
  })

  it('loads the plugin with HOME pointing at a throwaway folder, and reports a plugin that exits', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      const seen = h.path('seen.txt')
      await edit(
        dir,
        'const plugin',
        `import { appendFileSync } from 'node:fs'\nimport { homedir } from 'node:os'\nappendFileSync(${JSON.stringify(seen)}, homedir())\nconst plugin`,
      )
      assert.deepEqual((await checkPlugin({ dir })).problems, [])
      const home = await readFile(seen, 'utf8')
      assert.ok(home && home !== h.home && !home.startsWith(dir), "a throwaway HOME, not the caller's")
      await edit(dir, 'const plugin', 'process.exit(3)\nconst plugin')
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['check.crashed'])
      assert.match(r.problems[0]!.message, /exit code 3/)
    })
  })

  it('reports a missing directory and a broken manifest', async () => {
    await withFakeHome(async (h) => {
      assert.deepEqual(codes(await checkPlugin({ dir: h.path('nope') })), ['plugin.missing'])
      const dir = await filled(h)
      await writeFile(join(dir, 'plugin.json'), '{')
      assert.deepEqual(codes(await checkPlugin({ dir })), ['manifest.invalid'])
    })
  })

  it('reports a Family id a built-in already has', async () => {
    await withFakeHome(async (h) => {
      const dir = await filled(h)
      await edit(dir, "id: 'mytool',", "id: 'claude',")
      const r = await checkPlugin({ dir })
      assert.deepEqual(codes(r), ['load.failed'])
      assert.match(r.problems[0]!.message, /family claude is already provided by claude/)
    })
  })
})

describe('checkBuiltinPlugin', () => {
  it('runs the field checks and the round on an in-repo plugin', async () => {
    await withFakeHome(async (h) => {
      const src = await h.mkdir('src')
      assert.deepEqual((await checkBuiltinPlugin({ plugin: demoPlugin(), dir: src })).problems, [])
      const bad = demoPlugin(demoFamily({ layout: { main: '.demo', account: '.demo' } }))
      assert.deepEqual(codes(await checkBuiltinPlugin({ plugin: bad, dir: src })), ['field.layout'])
    })
  })
})

describe('defProblems: website', () => {
  it('reports a website sideby would drop, with a fix', () => {
    const ok = defProblems(demoFamily({ website: { url: 'https://example.com/app' } }))
    assert.ok(!ok.some((p) => p.code === 'website.invalid'))
    const bad = defProblems(demoFamily({ website: { url: 'https://example.com/?x=1&y' } }))
    const problem = bad.find((p) => p.code === 'website.invalid')
    assert.ok(problem)
    assert.match(problem.fix, /website\.url/)
  })
})
