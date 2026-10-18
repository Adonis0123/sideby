import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fakeHost, withFakeHome } from '../../testing/index.ts'
import { codexFamily, codexPlugin } from '../families/codex/index.ts'
import { HookBus } from '../plugins/bus.ts'
import { createRuntime } from '../runtime.ts'
import type { Account, Env, FamilyDef } from '../types.ts'
import { UserError } from './errors.ts'
import { prepareLaunch } from './launch.ts'
import {
  PROBE_OUTPUT_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  type ProbeSpawnRequest,
  type ProbeSpawnResult,
  runProbe,
} from './probe.ts'

const codexBuiltins = [{ plugin: codexPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

function labAccount(): Account {
  return {
    family: 'lab',
    name: 'work',
    ref: 'lab:work',
    dir: '/nowhere',
    isMain: false,
    kind: 'api',
  }
}

describe('runProbe', () => {
  it('uses the Launch environment and arguments, with Hijack Variables cleared', async () => {
    await withFakeHome(async (h) => {
      await h.write('.codex/config.toml', 'model = "m"\n')
      await h.write(
        '.codex-work/proxy.env',
        'OPENAI_API_KEY=account-openai-key\nOPENAI_BASE_URL=https://example.invalid/v1\n',
        0o600,
      )
      const baseEnv: Env = {
        ...h.env,
        OPENAI_API_KEY: 'inherited-key',
        OPENAI_BASE_URL: 'https://inherited.invalid',
        CODEX_API_BASE_URL: 'https://inherited-api.invalid',
        CODEX_HOME: '/inherited-home',
      }
      const rt = await createRuntime({ env: baseEnv, builtins: codexBuiltins })
      const account = await rt.resolve('codex:work')
      const launch = await prepareLaunch({
        account,
        family: codexFamily,
        baseEnv,
        accountArgs: [],
        userArgs: codexFamily.probe!.args,
        command: 'run',
        bus: new HookBus(),
      })
      let seen: ProbeSpawnRequest | undefined
      const result = await runProbe(account, {
        family: codexFamily,
        baseEnv,
        cwd: h.path('probe-tmp'),
        bus: new HookBus(),
        spawn: async (req) => {
          seen = req
          return { exitCode: 0, stdout: 'OK account-openai-key', stderr: '', timedOut: false }
        },
      })
      assert.ok(seen)
      assert.deepEqual(seen.env, launch.env)
      assert.deepEqual(seen.args, launch.args)
      assert.deepEqual(seen.args, [
        '-c',
        'cli_auth_credentials_store="file"',
        'exec',
        '--skip-git-repo-check',
        'Reply with OK',
      ])
      assert.equal(seen.bin, 'codex')
      assert.equal(seen.stdin, 'ignore')
      assert.equal(seen.timeoutMs, PROBE_TIMEOUT_MS)
      assert.equal(seen.cwd, h.path('probe-tmp'))
      assert.equal(seen.env.OPENAI_API_KEY, 'account-openai-key')
      assert.equal(seen.env.OPENAI_BASE_URL, 'https://example.invalid/v1')
      assert.equal(seen.env.CODEX_API_BASE_URL, undefined)
      assert.equal(seen.env.CODEX_HOME, account.dir)
      assert.equal(result.ok, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.timedOut, false)
      assert.equal(result.output, 'OK ***')
      assert.equal(result.output.includes('account-openai-key'), false)
    })
  })

  it('redacts secret values before keeping the first 2 KiB, including one split by the cut', async () => {
    await withFakeHome(async (h) => {
      const secret = 'ZZSPLITKEY0123456789'
      await h.write('.codex/config.toml', 'model = "m"\n')
      await h.write('.codex-work/proxy.env', `TINY=ab\nFOUR=WXYZ\nLONG=${secret}\n`, 0o600)
      const rt = await createRuntime({ env: h.env, builtins: codexBuiltins })
      const account = await rt.resolve('codex:work')
      // The secret starts 6 bytes before the 2 KiB cut, so truncating first would keep "ZZSPLI".
      const marker = 'ab WXYZ '
      const pad = PROBE_OUTPUT_MAX_BYTES - 6 - marker.length
      const spawned = await runProbe(account, {
        family: codexFamily,
        baseEnv: h.env,
        cwd: h.path('probe-tmp'),
        spawn: async () => ({
          exitCode: 2,
          stdout: `${marker}${'A'.repeat(pad)}${secret.slice(0, 6)}`,
          stderr: `${secret.slice(6)}TAIL`,
          timedOut: false,
        }),
      })
      assert.equal(spawned.ok, false)
      assert.equal(spawned.exitCode, 2)
      assert.equal(spawned.output, `ab *** ${'A'.repeat(pad)}***TAIL`)
      assert.ok(Buffer.byteLength(spawned.output) <= PROBE_OUTPUT_MAX_BYTES)
      assert.equal(spawned.output.includes(secret), false)
      assert.equal(spawned.output.includes('ZZSPLI'), false)
      assert.equal(spawned.output.includes('WXYZ'), false)
    })
  })

  it('reports a timeout and still redacts what the Host printed', async () => {
    await withFakeHome(async (h) => {
      const secret = 'timeout-token-value'
      await h.write('.codex/config.toml', 'model = "m"\n')
      await h.write('.codex-work/proxy.env', `OPENAI_API_KEY=${secret}\n`, 0o600)
      const rt = await createRuntime({ env: h.env, builtins: codexBuiltins })
      const account = await rt.resolve('codex:work')
      let timeoutMs = 0
      const result = await runProbe(account, {
        family: codexFamily,
        baseEnv: h.env,
        cwd: h.path('probe-tmp'),
        spawn: async (req) => {
          timeoutMs = req.timeoutMs
          const out: ProbeSpawnResult = {
            exitCode: null,
            stdout: secret,
            stderr: `err ${secret}`,
            timedOut: true,
          }
          return out
        },
      })
      assert.equal(timeoutMs, PROBE_TIMEOUT_MS)
      assert.equal(result.ok, false)
      assert.equal(result.timedOut, true)
      assert.equal(result.exitCode, null)
      assert.equal(result.output, '***err ***')
      assert.equal(result.output.includes(secret), false)
    })
  })

  it('says this tool cannot be tried, and what to do instead, when the family has no probe', async () => {
    const family: FamilyDef = { ...codexFamily, probe: undefined }
    let spawned = false
    await assert.rejects(
      () =>
        runProbe(labAccount(), {
          family,
          baseEnv: {},
          cwd: '/nowhere',
          spawn: async () => {
            spawned = true
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof UserError)
        assert.equal(err.code, 'no-probe')
        assert.match(err.message, /cannot be tried/)
        assert.match(err.message, /sideby run lab:work/)
        return true
      },
    )
    assert.equal(spawned, false)
  })
})

describe('spawnProbe', () => {
  it('stops the Host and a child holding its output at the timeout, and answers at once', async () => {
    await withFakeHome(async (h) => {
      const { spawnProbe } = await import('./probe.ts')
      const { readFile } = await import('node:fs/promises')
      const bin = await fakeHost(h, 'stuck', {
        onStart: `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); fs.writeFileSync(path.join(process.env.HOME, 'grandchild.pid'), String(c.pid)); console.log('started')`,
      })
      const started = Date.now()
      const result = await spawnProbe({
        bin,
        args: [],
        env: h.env,
        cwd: h.home,
        timeoutMs: 1500,
        stdin: 'ignore',
      })
      assert.ok(Date.now() - started < 5000)
      assert.equal(result.timedOut, true)
      assert.equal(result.exitCode, null)
      assert.match(result.stdout, /started/)
      const pid = Number(await readFile(h.path('grandchild.pid'), 'utf8'))
      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0)
          await new Promise((r) => setTimeout(r, 20))
        } catch {
          alive = false
        }
      }
      assert.equal(alive, false)
    })
  })
})
