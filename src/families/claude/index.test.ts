import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readlink, stat, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import { createRuntime } from '../../runtime.ts'
import { claudePlugin } from './index.ts'

const builtins = [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }]

async function mainAccount(h: FakeHome): Promise<void> {
  await h.write('.claude/settings.json', JSON.stringify({ model: 'opus' }))
  await h.write('.claude/CLAUDE.md', '# rules\n')
  await h.mkdir('.claude/skills/demo')
  await h.mkdir('.claude/commands')
  await h.write(
    '.claude.json',
    JSON.stringify({
      oauthAccount: { emailAddress: 'fake@example.invalid' },
      mcpServers: { fake: { command: 'x' } },
    }),
    0o600,
  )
}

describe('claude family', () => {
  it('discovers accounts, reports drift and login state in a fake HOME', async () => {
    await withFakeHome(async (h) => {
      await mainAccount(h)
      await h.mkdir('.claude-work')
      for (const item of ['settings.json', 'skills', 'commands'])
        await symlink(h.path('.claude', item), h.path('.claude-work', item))
      await h.write('.claude-work/CLAUDE.md', 'my own rules\n')
      await h.write('.claude-work/.claude.json', JSON.stringify({ mcpServers: {} }), 0o644)

      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['claude:main', 'claude:work'],
      )
      const report = await rt.doctor()
      const work = report.accounts.find((a) => a.ref === 'claude:work')!
      const codes = work.findings.map((f) => `${f.item}:${f.code}`).sort()
      assert.deepEqual(codes, [
        '.claude.json#mcpServers:json-key.drift',
        '.claude.json:credential.mode',
        'CLAUDE.md:link.real-file',
      ])
      assert.equal(report.status, 'issues')

      const [main, w] = await rt.accounts()
      const ms = await rt.status(main!)
      assert.equal(ms.login, 'logged-in')
      assert.equal(ms.model, 'opus')
      const ws = await rt.status(w!)
      assert.equal(ws.login, 'logged-out')
      assert.equal(ws.model, 'opus')
    })
  })

  it('creates an account with links and a 600 .claude.json holding only mcpServers', async () => {
    await withFakeHome(async (h) => {
      await mainAccount(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const res = await rt.createAccount('claude', 'work2')
      assert.equal(res.ok, true)
      const dir = h.path('.claude-work2')
      for (const item of ['settings.json', 'CLAUDE.md', 'skills', 'commands']) {
        assert.ok((await lstat(`${dir}/${item}`)).isSymbolicLink(), item)
        assert.equal(await readlink(`${dir}/${item}`), h.path('.claude', item))
      }
      const cj = `${dir}/.claude.json`
      assert.equal((await stat(cj)).mode & 0o777, 0o600)
      assert.deepEqual(JSON.parse(await readFile(cj, 'utf8')), { mcpServers: { fake: { command: 'x' } } })
      assert.deepEqual(res.nextSteps.slice(0, 2), ['sideby login claude:work2', 'sideby run claude:work2'])

      const acct = await rt.resolve('claude:work2')
      assert.equal((await rt.status(acct)).login, 'logged-out')
      const after = await rt.doctor({ target: 'claude:work2' })
      assert.deepEqual(
        after.accounts[0]!.findings.filter((f) => f.level === 'fail'),
        [],
      )
      const launch = await rt.prepareLaunch('claude:work2', [], 'login')
      assert.deepEqual(launch.args, ['auth', 'login'])
      assert.equal(launch.env.CLAUDE_CONFIG_DIR, dir)
    })
  })

  it('reports unknown login state when .claude.json cannot be read, and models from proxy.env', async () => {
    await withFakeHome(async (h) => {
      await mainAccount(h)
      await mkdir(h.path('.claude-api'))
      await h.write('.claude-api/proxy.env', 'ANTHROPIC_MODEL=fake-model\nANTHROPIC_AUTH_TOKEN=fake\n', 0o600)
      await h.write('.claude-broken/.claude.json', '{ not json')
      const rt = await createRuntime({ env: h.env, builtins })
      const api = await rt.status(await rt.resolve('claude:api'))
      assert.equal(api.kind, 'api')
      assert.equal(api.model, 'fake-model')
      assert.equal(api.login, 'not-needed')
      assert.equal((await rt.status(await rt.resolve('claude:broken'))).login, 'unknown')
      await h.write('.claude-api/proxy.env', 'ANTHROPIC_MODEL=fake-model\n', 0o644)
      assert.equal((await rt.status(await rt.resolve('claude:api'))).model, undefined)
      assert.equal((await rt.quota(await rt.resolve('claude:api'))).status, 'unavailable')
    })
  })
  it('does not mistake claude-code-router for an account, even with a plugins directory', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.mkdir('.claude/plugins')
      await h.write('.claude-code-router/config.json', '{}')
      await h.mkdir('.claude-code-router/plugins')
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['claude:main'],
      )
    })
  })
  it('never treats a symlinked account directory as an account, so repairs cannot write into its target', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude.json', JSON.stringify({ mcpServers: { a: { command: 'a' } } }), 0o600)
      await h.mkdir('projects')
      await symlink(h.path('.claude'), h.path('.claude-work'))
      await symlink(h.home, h.path('.claude-evil'))
      await h.write('.claude-real/settings.json', '{}')
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['claude:main', 'claude:real'],
      )
      await rt.doctor({ fix: true })
      await assert.rejects(lstat(h.path('.claude/.claude.json')))
      await assert.rejects(lstat(h.path('settings.json')))
    })
  })

  it('still accepts a Main Account that is itself a symlink', async () => {
    await withFakeHome(async (h) => {
      await h.write('real-claude/settings.json', '{}')
      await symlink(h.path('real-claude'), h.path('.claude'))
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['claude:main'],
      )
    })
  })
})
