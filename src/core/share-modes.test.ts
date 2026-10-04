// Spec §3.3 matrix. Every "never" case asserts the Main Account snapshot is unchanged after `--fix`.
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import type { Finding } from '../types.ts'

async function setup(h: FakeHome, opts: { api?: boolean } = {}) {
  await seedDemoMain(h.write)
  const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
  const res = await rt.createAccount('demo', 'work', opts)
  assert.equal(res.ok, true, JSON.stringify(res.steps))
  return rt
}

async function findings(h: FakeHome, opts: { fix?: boolean; force?: boolean } = {}) {
  const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
  const report = await rt.doctor({ target: 'demo:work', ...opts })
  const acc = report.accounts.find((a) => a.ref === 'demo:work')!
  return { report, acc, all: acc.findings }
}

function byItem(fs: Finding[], item: string): Finding | undefined {
  return fs.find((f) => f.item === item)
}

/** Runs doctor --fix and asserts the Main Account and HOME-level main files did not change. */
async function fixKeepsMain(h: FakeHome, force = false) {
  const before = await snapshot(h.path('.demo'))
  const mainJson = await readFile(h.path('.demo.json'))
  const res = await findings(h, { fix: true, force })
  assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.demo'))), [])
  assert.ok(mainJson.equals(await readFile(h.path('.demo.json'))))
  return res
}

describe('new account', () => {
  it('lays out every Share Mode and is healthy right away', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const before = await snapshot(h.path('.demo'))
      const rt0 = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      assert.equal((await rt0.createAccount('demo', 'work')).ok, true)
      const w = (p: string) => h.path('.demo-work', p)
      assert.ok((await lstat(w('skills'))).isSymbolicLink())
      assert.ok((await lstat(w('hooks'))).isDirectory())
      assert.equal(((await stat(w('hooks/pre.sh'))).mode & 0o777).toString(8), '755')
      assert.ok((await lstat(w('theme.json'))).isSymbolicLink())
      assert.ok((await lstat(w('cli.json'))).isFile())
      assert.ok((await lstat(w('config.toml'))).isSymbolicLink())
      await assert.rejects(lstat(w('auth.json')))
      assert.deepEqual(JSON.parse(await readFile(w('.demo.json'), 'utf8')), { servers: { a: { cmd: 'a' } } })
      assert.equal((await stat(w('.demo.json'))).mode & 0o777, 0o600)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.demo'))), [])
      const { report, acc } = await findings(h)
      assert.equal(report.status, 'ok', JSON.stringify(acc.findings))
      assert.deepEqual(acc.shared, { ok: 8, total: 8 })
    })
  })

  it('gives an API account its own config copy and a 600 Secret File template', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { api: true })
      const st = await lstat(h.path('.demo-work', 'config.toml'))
      assert.ok(st.isFile())
      assert.equal((await stat(h.path('.demo-work', 'proxy.env'))).mode & 0o777, 0o600)
      assert.match(await readFile(h.path('.demo-work', 'proxy.env'), 'utf8'), /# DEMO_BASE_URL=/)
      const { report } = await findings(h)
      assert.equal(report.status, 'ok')
      assert.equal(report.accounts.find((a) => a.ref === 'demo:work')!.kind, 'api')
    })
  })

  it('refuses invalid names, existing directories and a missing Main Account', async () => {
    await withFakeHome(async (h) => {
      const rt0 = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await assert.rejects(rt0.createAccount('demo', 'work'), /no main account/)
      const rt = await setup(h)
      await assert.rejects(rt.createAccount('demo', 'work'), /already exists/)
      await assert.rejects(rt.createAccount('demo', 'Work'), /not a valid account name/)
      await assert.rejects(rt.createAccount('demo', 'main'), /not a valid account name/)
      await assert.rejects(rt.createAccount('nope', 'x'), /unknown family/)
    })
  })
})

describe('link', () => {
  it('reports a real file and never replaces it', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'rules.md')
      await rm(p)
      await writeFile(p, 'my own rules\n')
      const { all } = await findings(h)
      const f = byItem(all, 'rules.md')!
      assert.equal(f.code, 'link.real-file')
      assert.equal(f.fixable, false)
      assert.match(f.hint!, /mv/)
      await fixKeepsMain(h)
      assert.equal(await readFile(p, 'utf8'), 'my own rules\n')
    })
  })

  it('reports dangling or foreign links and never re-points them', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'skills')
      await rm(p)
      await symlink(h.path('nowhere'), p)
      assert.equal(byItem((await findings(h)).all, 'skills')!.code, 'link.dangling')
      await fixKeepsMain(h)
      assert.equal(await readlink(p), h.path('nowhere'))
      await rm(p)
      await symlink(h.path('.demo', 'rules.md'), p)
      const other = byItem((await findings(h)).all, 'skills')!
      assert.equal(other.code, 'link.other-target')
      assert.equal(other.level, 'warn')
      await fixKeepsMain(h)
      assert.equal(await readlink(p), h.path('.demo', 'rules.md'))
    })
  })

  it('accepts an equivalent relative link and repairs a missing one', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'skills')
      await rm(p)
      await symlink('../.demo/skills', p)
      assert.equal(byItem((await findings(h)).all, 'skills'), undefined)
      await rm(p)
      assert.equal(byItem((await findings(h)).all, 'skills')!.code, 'missing')
      const { acc } = await fixKeepsMain(h)
      assert.equal(byItem(acc.findings, 'skills'), undefined)
      assert.ok((await lstat(p)).isSymbolicLink())
    })
  })

  it('ignores an item the Main Account does not have: nothing to share, not counted', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await rm(h.path('.demo', 'rules.md'))
      await rm(h.path('.demo-work', 'rules.md'))
      const { report, acc } = await findings(h)
      assert.equal(byItem(acc.findings, 'rules.md'), undefined)
      assert.equal(acc.shared.total, 7)
      assert.equal(report.status, 'ok')
    })
  })
})

describe('copy', () => {
  it('replaces a link to the main item with a real copy without touching the main item', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'hooks')
      await rm(p, { recursive: true })
      await symlink(h.path('.demo', 'hooks'), p)
      const f = byItem((await findings(h)).all, 'hooks')!
      assert.equal(f.code, 'symlink-forbidden')
      assert.match(f.message, /hooks must be a real directory/)
      await fixKeepsMain(h)
      assert.ok((await lstat(p)).isDirectory())
      assert.equal(await readFile(join(p, 'pre.sh'), 'utf8'), '#!/bin/sh\n')
    })
  })

  it('syncs a stale copy, but not over a type mismatch or from an empty main directory', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'hooks')
      await writeFile(join(p, 'extra.sh'), 'x')
      assert.equal(byItem((await findings(h)).all, 'hooks')!.code, 'copy.stale')
      await fixKeepsMain(h)
      await assert.rejects(lstat(join(p, 'extra.sh')))

      await rm(p, { recursive: true })
      await writeFile(p, 'not a dir')
      assert.equal(byItem((await findings(h)).all, 'hooks')!.code, 'copy.type-mismatch')
      await fixKeepsMain(h)
      assert.equal(await readFile(p, 'utf8'), 'not a dir')

      await rm(p)
      await mkdir(p)
      await writeFile(join(p, 'mine.sh'), 'mine')
      await rm(h.path('.demo', 'hooks'), { recursive: true })
      await mkdir(h.path('.demo', 'hooks'))
      assert.equal(byItem((await findings(h)).all, 'hooks')!.code, 'copy.main-empty')
      await fixKeepsMain(h)
      assert.equal(await readFile(join(p, 'mine.sh'), 'utf8'), 'mine')
    })
  })
})

describe('link-or-copy, link-or-local, local', () => {
  it('accepts a link or an equal copy and fixes a stale copy', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'theme.json')
      await rm(p)
      await writeFile(p, '{"dark":true}\n')
      assert.equal(byItem((await findings(h)).all, 'theme.json'), undefined)
      await writeFile(p, '{"dark":false}\n')
      assert.equal(byItem((await findings(h)).all, 'theme.json')!.code, 'copy.stale')
      await fixKeepsMain(h)
      assert.equal(await readFile(p, 'utf8'), '{"dark":true}\n')
    })
  })

  it('keeps a local file with any content', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'trusted.toml')
      await rm(p)
      await writeFile(p, 'mine\n')
      assert.equal(byItem((await findings(h)).all, 'trusted.toml'), undefined)
      await fixKeepsMain(h)
      assert.equal(await readFile(p, 'utf8'), 'mine\n')
    })
  })

  it('local: copies when missing, only reports a link', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const p = h.path('.demo-work', 'cli.json')
      await rm(p)
      await fixKeepsMain(h)
      assert.ok((await lstat(p)).isFile())
      await rm(p)
      await symlink(h.path('.demo', 'cli.json'), p)
      assert.equal(byItem((await findings(h)).all, 'cli.json')!.code, 'local.is-link')
      await fixKeepsMain(h)
      assert.ok((await lstat(p)).isSymbolicLink())
    })
  })
})

describe('local-if-api', () => {
  it('an API account must own the file; links and gaps are only reported', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { api: true })
      const p = h.path('.demo-work', 'config.toml')
      await rm(p)
      await symlink(h.path('.demo', 'config.toml'), p)
      assert.equal(byItem((await findings(h)).all, 'config.toml')!.code, 'api.needs-own')
      await fixKeepsMain(h)
      assert.ok((await lstat(p)).isSymbolicLink())
      await rm(p)
      const f = byItem((await findings(h)).all, 'config.toml')!
      assert.equal(f.code, 'api.needs-own')
      assert.equal(f.fixable, false)
    })
  })
})

describe('credentials', () => {
  it('reports a credential link without copying credentials, and fixes modes', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const auth = h.path('.demo-work', 'auth.json')
      await symlink(h.path('.demo', 'auth.json'), auth)
      const f = byItem((await findings(h)).all, 'auth.json')!
      assert.equal(f.code, 'symlink-forbidden')
      assert.equal(f.fixable, false)
      await fixKeepsMain(h)
      assert.ok((await lstat(auth)).isSymbolicLink())

      await rm(auth)
      await writeFile(auth, '{}', { mode: 0o644 })
      await chmod(auth, 0o644)
      assert.equal(byItem((await findings(h)).all, 'auth.json')!.code, 'credential.mode')
      await fixKeepsMain(h)
      assert.equal((await stat(auth)).mode & 0o777, 0o600)
    })
  })

  it('checks Secret File and Main Account credential modes', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { api: true })
      await chmod(h.path('.demo-work', 'proxy.env'), 0o644)
      await chmod(h.path('.demo.json'), 0o644)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const r = await rt.doctor()
      const codes = r.accounts.flatMap((a) => a.findings.map((f) => `${a.ref}/${f.code}`))
      assert.ok(codes.includes('demo:work/credential.mode'))
      assert.ok(codes.includes('demo:main/credential.mode'))
      await rt.doctor({ fix: true })
      assert.equal((await stat(h.path('.demo-work', 'proxy.env'))).mode & 0o777, 0o600)
      assert.equal((await stat(h.path('.demo.json'))).mode & 0o777, 0o600)
    })
  })
})

describe('json-key', () => {
  it('adds new entries, guards removals behind --force, never writes a symlinked file', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const acc = h.path('.demo-work', '.demo.json')
      await writeFile(acc, JSON.stringify({ servers: { a: { cmd: 'a' } }, user: 'work' }), { mode: 0o600 })
      await h.write('.demo.json', '{"servers":{"a":{"cmd":"a"},"b":{"cmd":"b"}},"user":"main"}\n', 0o600)
      assert.equal(byItem((await findings(h)).all, '.demo.json#servers')!.code, 'json-key.drift')
      await fixKeepsMain(h)
      const synced = JSON.parse(await readFile(acc, 'utf8'))
      assert.deepEqual(Object.keys(synced.servers).sort(), ['a', 'b'])
      assert.equal(synced.user, 'work')
      assert.equal((await stat(acc)).mode & 0o777, 0o600)

      await h.write('.demo.json', '{"servers":{"b":{"cmd":"b"}}}\n', 0o600)
      assert.equal(byItem((await findings(h)).all, '.demo.json#servers')!.code, 'json-key.would-remove')
      await fixKeepsMain(h)
      assert.ok('a' in JSON.parse(await readFile(acc, 'utf8')).servers)
      await fixKeepsMain(h, true)
      assert.deepEqual(Object.keys(JSON.parse(await readFile(acc, 'utf8')).servers), ['b'])

      await rm(acc)
      await symlink(h.path('.demo.json'), acc)
      assert.equal(
        byItem((await findings(h, { force: true })).all, '.demo.json#servers')!.code,
        'json-key.symlink',
      )
      await fixKeepsMain(h, true)
      assert.ok((await lstat(acc)).isSymbolicLink())

      await rm(acc)
      await writeFile(acc, '[1,2]', { mode: 0o600 })
      assert.equal(
        byItem((await findings(h, { force: true })).all, '.demo.json#servers')!.code,
        'json-key.not-object',
      )
      await fixKeepsMain(h, true)
      assert.equal(await readFile(acc, 'utf8'), '[1,2]')
    })
  })
})

describe('doctor scope and leftovers', () => {
  it('counts backup leftovers, filters by family, and reports a family without a main account', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await h.write('.demo-work/settings.json.bak', 'x')
      await h.write('.demo-work/old-backup', 'x')
      await h.mkdir('.demo-work/backups')
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const all = await rt.doctor({ target: 'demo' })
      assert.equal(all.accounts.find((a) => a.ref === 'demo:work')!.backups, 2)
      assert.deepEqual(
        all.accounts.map((a) => a.ref),
        ['demo:main', 'demo:work'],
      )
      await rm(h.path('.demo'), { recursive: true })
      const orphan = await rt.doctor()
      assert.equal(orphan.general[0]!.code, 'main.missing')
      assert.equal(orphan.status, 'issues')
    })
  })

  it('json-key refuses malformed account files and a non-object main value', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const acc = h.path('.demo-work', '.demo.json')
      await writeFile(acc, '{ not json', { mode: 0o600 })
      assert.equal(
        byItem((await findings(h, { force: true })).all, '.demo.json#servers')!.code,
        'json-key.not-object',
      )
      await fixKeepsMain(h, true)
      assert.equal(await readFile(acc, 'utf8'), '{ not json')
      await writeFile(acc, '{}', { mode: 0o600 })
      await h.write('.demo.json', '{"servers":[1]}\n', 0o600)
      assert.equal(byItem((await findings(h)).all, '.demo.json#servers')!.code, 'json-key.main-not-object')
    })
  })
})

describe('discovery', () => {
  it('ignores bad names, configured refs and directories without account evidence; warns on backup-like names', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await h.mkdir('.demo-Bad')
      await h.write('.demo-old-copy/rules.md', 'x')
      await h.mkdir('.demo-empty')
      await h.write('.demo-router/config.sqlite', 'not an account')
      await h.write('.demo-file', 'x')
      await h.write('.demo-skipme/rules.md', 'x')
      await h.write('.config/sideby/config.json', JSON.stringify({ ignore: ['demo:skipme'] }))
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const refs = (await rt.accounts()).map((a) => a.ref)
      // An empty directory counts (a just-created account); another tool's non-empty directory does not.
      assert.deepEqual(refs, ['demo:main', 'demo:empty', 'demo:old-copy', 'demo:work'])
      const r = await rt.doctor({ target: 'demo:old-copy' })
      assert.ok(r.accounts[0]!.findings.some((f) => f.code === 'name.backup-like'))
    })
  })
})
