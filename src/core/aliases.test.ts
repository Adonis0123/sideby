// Short commands: writing config aliases and keeping the shell-init files in sync (Panel and `new --alias`).
import assert from 'node:assert/strict'
import { chmod, readFile, stat, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { asBuiltin, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { addConfigAlias, ConfigError, loadConfig } from './config.ts'
import { SHELL_INIT_HEADER, shellInitScript, writeShellInitFile } from './shell-init.ts'

const CONFIG = '.config/sideby/config.json'

describe('addConfigAlias', () => {
  it('keeps every other key, their order and $schema, writes 2-space JSON and keeps the mode', async () => {
    await withFakeHome(async (h) => {
      const before = {
        $schema: 'https://unpkg.com/sideby/schemas/config.json',
        accounts: { 'claude:001': { args: ['--x'] } },
        aliases: { cc001: 'claude:001', codex001: 'codex:main' },
        plugins: { 'account-script': { enabled: true } },
        extraSharedItems: { claude: [{ path: 'scripts', mode: 'link' }] },
      }
      await h.write(CONFIG, JSON.stringify(before))
      await chmod(h.path(CONFIG), 0o644)
      const r = await addConfigAlias(h.path(CONFIG), 'cc008', 'claude:008')
      assert.equal(r.status, 'added')
      const text = await readFile(h.path(CONFIG), 'utf8')
      const expected = { ...before, aliases: { ...before.aliases, cc008: 'claude:008' } }
      assert.equal(text, `${JSON.stringify(expected, null, 2)}\n`)
      assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(before))
      assert.equal((await stat(h.path(CONFIG))).mode & 0o777, 0o644)
      // The same alias for the same Account again is a no-op.
      assert.equal((await addConfigAlias(h.path(CONFIG), 'cc008', 'claude:008')).status, 'exists')
      assert.equal(await readFile(h.path(CONFIG), 'utf8'), text)
    })
  })

  it('adds an aliases key at the end, or creates the file with $schema, mode 600', async () => {
    await withFakeHome(async (h) => {
      await addConfigAlias(h.path(CONFIG), 'cc001', 'claude:001')
      assert.deepEqual(JSON.parse(await readFile(h.path(CONFIG), 'utf8')), {
        $schema: 'https://unpkg.com/sideby/schemas/config.json',
        aliases: { cc001: 'claude:001' },
      })
      assert.equal((await stat(h.path(CONFIG))).mode & 0o777, 0o600)
      await h.write(CONFIG, JSON.stringify({ ignore: ['claude:x'] }))
      await addConfigAlias(h.path(CONFIG), 'cc002', 'claude:002')
      assert.deepEqual(Object.keys(JSON.parse(await readFile(h.path(CONFIG), 'utf8'))), ['ignore', 'aliases'])
      assert.ok((await loadConfig(h.path(CONFIG))).aliases?.cc002)
    })
  })

  it('refuses an invalid config, an invalid or taken alias, and never changes the file', async () => {
    await withFakeHome(async (h) => {
      for (const broken of ['{ "aliases": ', '[1]', JSON.stringify({ pluginDirs: 'nope' })]) {
        await h.write(CONFIG, broken)
        await assert.rejects(addConfigAlias(h.path(CONFIG), 'cc008', 'claude:008'), ConfigError)
        assert.equal(await readFile(h.path(CONFIG), 'utf8'), broken)
      }
      const good = JSON.stringify({ aliases: { cc001: 'claude:001' } })
      await h.write(CONFIG, good)
      await assert.rejects(addConfigAlias(h.path(CONFIG), 'cc001', 'claude:008'), /already starts claude:001/)
      await assert.rejects(addConfigAlias(h.path(CONFIG), 'cd', 'claude:008'), /shell keyword/)
      await assert.rejects(addConfigAlias(h.path(CONFIG), 'x;rm', 'claude:008'), /must match/)
      assert.equal(await readFile(h.path(CONFIG), 'utf8'), good)
    })
  })

  it('writes the target of a linked config file and keeps the link', async () => {
    await withFakeHome(async (h) => {
      await h.write('dotfiles/sideby.json', JSON.stringify({ aliases: {} }))
      await h.mkdir('.config/sideby')
      await symlink(h.path('dotfiles/sideby.json'), h.path(CONFIG))
      await addConfigAlias(h.path(CONFIG), 'cc001', 'claude:001')
      assert.ok((await (await import('node:fs/promises')).lstat(h.path(CONFIG))).isSymbolicLink())
      assert.match(await readFile(h.path('dotfiles/sideby.json'), 'utf8'), /"cc001": "claude:001"/)
    })
  })
})

describe('writeShellInitFile', () => {
  it('writes, reports unchanged content, keeps the mode and refuses files sideby did not write', async () => {
    await withFakeHome(async (h) => {
      const script = shellInitScript([], { cc001: 'claude:001' })
      const first = await writeShellInitFile('zsh', '~/.config/sideby/shell-init.zsh', h.home, script)
      assert.deepEqual(first, {
        shell: 'zsh',
        path: '~/.config/sideby/shell-init.zsh',
        ok: true,
        action: 'written',
      })
      assert.equal(await readFile(h.path('.config/sideby/shell-init.zsh'), 'utf8'), script)
      assert.equal((await stat(h.path('.config/sideby/shell-init.zsh'))).mode & 0o777, 0o644)
      await chmod(h.path('.config/sideby/shell-init.zsh'), 0o600)
      const same = await writeShellInitFile('zsh', h.path('.config/sideby/shell-init.zsh'), h.home, script)
      assert.equal(same.action, 'unchanged')
      const next = shellInitScript([], { cc001: 'claude:001', cc002: 'claude:002' })
      assert.equal(
        (await writeShellInitFile('zsh', '~/.config/sideby/shell-init.zsh', h.home, next)).action,
        'written',
      )
      assert.equal((await stat(h.path('.config/sideby/shell-init.zsh'))).mode & 0o777, 0o600)

      await h.write('.zshrc', 'export PATH=/x\n')
      const rc = await writeShellInitFile('zsh', '~/.zshrc', h.home, script)
      assert.equal(rc.ok, false)
      assert.match(rc.message!, /not written by sideby shell-init/)
      assert.equal(await readFile(h.path('.zshrc'), 'utf8'), 'export PATH=/x\n')
      const rel = await writeShellInitFile('bash', 'shell-init.bash', h.home, script)
      assert.equal(rel.ok, false)
      assert.match(rel.message!, /absolute or ~\/ path/)
    })
  })
})

describe('Runtime createAccount with an alias', () => {
  const rtFor = (env: NodeJS.ProcessEnv) => createRuntime({ env, builtins: [asBuiltin(demoPlugin())] })

  it('adds the alias after creating the Account and rewrites the shell-init file to match shell-init', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write(
        CONFIG,
        JSON.stringify({ aliases: { dm001: 'demo:main' }, shellInitFile: { zsh: '~/.sideby.zsh' } }, null, 2),
      )
      const rt = await rtFor(h.env)
      const r = await rt.createAccount('demo', '008', { alias: 'dm008' })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.deepEqual(r.alias, { name: 'dm008', added: true })
      assert.deepEqual(r.shellInitFiles, [
        { shell: 'zsh', path: '~/.sideby.zsh', ok: true, action: 'written' },
      ])
      const file = await readFile(h.path('.sideby.zsh'), 'utf8')
      const fresh = await rtFor(h.env)
      assert.equal(file, await fresh.shellInitScript('zsh'))
      assert.ok(file.startsWith(SHELL_INIT_HEADER))
      assert.match(file, /^dm008\(\) \{ command sideby run 'demo:008' -- "\$@"; \}$/m)
      assert.match(file, /^sideby-demo-008\(\) /m)
      assert.equal(fresh.config.aliases?.dm008, 'demo:008')
      // Without an alias the file still gains the new Account's function.
      await rt.createAccount('demo', '009')
      assert.match(await readFile(h.path('.sideby.zsh'), 'utf8'), /^sideby-demo-009\(\) /m)
    })
  })

  it('refuses an invalid or taken alias before creating anything', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write(CONFIG, JSON.stringify({ aliases: { dw: 'demo:main' } }))
      const rt = await rtFor(h.env)
      for (const alias of ['dw', 'cd', 'bad name'])
        await assert.rejects(rt.createAccount('demo', 'work', { alias }), (e: Error & { code?: string }) => {
          assert.equal(e.code, 'alias-invalid')
          assert.match(e.message, /nothing was created/)
          return true
        })
      assert.equal((await rt.accounts()).length, 1)
    })
  })

  it('keeps the Account and reports it when the alias cannot be written', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write(CONFIG, JSON.stringify({}))
      const rt = await rtFor(h.env)
      // The config breaks after the Runtime loaded it (someone is editing it).
      await h.write(CONFIG, '{ "aliases": ')
      const r = await rt.createAccount('demo', 'work', { alias: 'dw' })
      assert.equal(r.ok, false)
      assert.equal(r.alias?.added, false)
      assert.match(r.alias!.message!, /demo:work was created, but the alias was not added: .*not valid JSON/)
      assert.equal(await readFile(h.path(CONFIG), 'utf8'), '{ "aliases": ')
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['demo:main', 'demo:work'],
      )
    })
  })
})
