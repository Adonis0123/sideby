import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import { createRuntime } from '../../runtime.ts'
import type { Account } from '../../types.ts'
import { codexFamily, codexPlugin } from './index.ts'

const builtins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]
const FILE_STORE = ['-c', 'cli_auth_credentials_store="file"']

function account(name: string): Account {
  return {
    family: 'codex',
    name,
    ref: `codex:${name}`,
    dir: `/nowhere/.codex-${name}`,
    isMain: name === 'main',
    kind: 'subscription',
  }
}

async function seedMain(h: FakeHome) {
  await h.write('.codex/AGENTS.md', '# rules\n')
  await h.write('.codex/config.toml', 'model = "gpt-main"\n\n[profiles.x]\nmodel = "other"\n')
  await h.mkdir('.codex/skills/one')
  await h.write('.codex/auth.json', '{}', 0o600)
}

describe('codex defaultArgs', () => {
  it('adds the file store only for non-main accounts without the key', () => {
    const f = codexFamily.defaultArgs!
    assert.deepEqual(f(account('main'), []), [])
    assert.deepEqual(f(account('work'), []), FILE_STORE)
    assert.deepEqual(f(account('work'), ['--model', 'x']), FILE_STORE)
    assert.deepEqual(f(account('work'), ['-c', 'cli_auth_credentials_store="keyring"']), [])
    assert.deepEqual(f(account('work'), ['--config=cli_auth_credentials_store=auto']), [])
  })
})

describe('codex family', () => {
  it('creates subscription and API accounts', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const work = await rt.createAccount('codex', 'work')
      assert.equal(work.ok, true)
      assert.equal((await lstat(h.path('.codex-work/AGENTS.md'))).isSymbolicLink(), true)
      assert.equal((await lstat(h.path('.codex-work/config.toml'))).isSymbolicLink(), true)
      assert.equal(await lstat(h.path('.codex-work/auth.json')).catch(() => null), null)

      const api = await rt.createAccount('codex', 'api1', { api: true })
      assert.equal(api.ok, true)
      assert.equal(api.account.kind, 'api')
      const cfg = await lstat(h.path('.codex-api1/config.toml'))
      assert.equal(cfg.isFile(), true)
      const env = await lstat(h.path('.codex-api1/proxy.env'))
      assert.equal(env.mode & 0o777, 0o600)
      assert.match(await readFile(h.path('.codex-api1/proxy.env'), 'utf8'), /# OPENAI_API_KEY=/)

      const report = await rt.doctor()
      assert.equal(report.status, 'ok', JSON.stringify(report.accounts.map((a) => a.findings)))
    })
  })

  it('prepares launches with the file store, CODEX_HOME and cleared hijack variables', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const env = {
        ...h.env,
        OPENAI_API_KEY: 'k',
        OPENAI_BASE_URL: 'u',
        CODEX_API_BASE_URL: 'c',
        CODEX_HOME: '/x',
      }
      const rt = await createRuntime({ env, builtins })
      await rt.createAccount('codex', 'work')

      const work = await rt.prepareLaunch('codex:work', ['--model', 'm'], 'run')
      assert.equal(work.bin, 'codex')
      assert.deepEqual(work.args, [...FILE_STORE, '--model', 'm'])
      assert.equal(work.env.CODEX_HOME, h.path('.codex-work'))
      for (const v of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_BASE_URL'])
        assert.equal(work.env[v], undefined)

      const login = await rt.prepareLaunch('codex:work', [], 'login')
      assert.deepEqual(login.args, [...FILE_STORE, 'login'])

      const main = await rt.prepareLaunch('codex:main', ['resume'], 'run')
      assert.deepEqual(main.args, ['resume'])
      assert.equal(main.env.CODEX_HOME, undefined)
      assert.equal(env.CODEX_HOME, '/x')
    })
  })

  it('reports login state and model without reading credentials', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      await rt.createAccount('codex', 'work')
      const main = await rt.status(await rt.resolve('codex:main'))
      assert.equal(main.login, 'logged-in')
      assert.equal(main.model, 'gpt-main')
      const work = await rt.status(await rt.resolve('codex:work'))
      assert.equal(work.login, 'logged-out')
      assert.equal(work.model, 'gpt-main')
    })
  })

  it('wires quota and usage through the runtime', async () => {
    await withFakeHome(async (h) => {
      await seedMain(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const main = await rt.resolve('codex:main')
      const q = await rt.quota(main)
      assert.equal(q.status === 'unavailable' && q.reason, 'no-session')
      const u = await rt.usage(main)
      assert.equal(u.status === 'unavailable' && u.reason, 'no-session')
    })
  })
})
