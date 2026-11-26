// WHY: ADR-0088 tests for terminal `agy` Launch Mod (`withAgyMod` and `rt.prepareLaunch` integration): session-scoped
// `--settings`, zero writes to `~/.gemini/antigravity-cli/`, config fidelity, skip rules, cleanup, and symlink safety.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, readFile, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, snapshot, withFakeHome } from '../../../testing/index.ts'
import { AGY_LAUNCH_PID_VAR, AGY_LIVE_DIR, AGY_ORIG_FLAG } from '../../agy/statusline.ts'
import { createRuntime } from '../../runtime.ts'
import { agyPlugin } from './index.ts'
import { AGY_LAUNCH_DIR, withAgyMod } from './mod.ts'

const MAIN = '.gemini/antigravity-cli'
const builtins = [{ plugin: agyPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

describe('Antigravity CLI Launch Mod (ADR-0088)', () => {
  it('injects session-scoped --settings with stack_with_default, writes nothing into agy dir, and cleans up on exit', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, JSON.stringify({ theme: 'dark' }))
      const rt = await createRuntime({ env: h.env, builtins })
      const beforeAgy = await snapshot(h.path(MAIN))
      const launch = await rt.prepareLaunch('agy:main', ['--model', 'demo'], 'run')

      assert.equal(launch.args[0], '--settings')
      const settingsFile = launch.args[1]!
      assert.ok(settingsFile.startsWith(h.path(`.local/state/sideby/${AGY_LAUNCH_DIR}/`)))
      assert.deepEqual(launch.args.slice(2), ['--model', 'demo'])
      assert.equal(launch.env[AGY_LAUNCH_PID_VAR], String(process.pid))
      assert.equal((await stat(settingsFile)).mode & 0o777, 0o600)
      assert.equal((await stat(h.path(`.local/state/sideby/${AGY_LAUNCH_DIR}`))).mode & 0o777, 0o700)

      const content = JSON.parse(await readFile(settingsFile, 'utf8'))
      assert.equal(content.statusLine.stack_with_default, true)
      assert.match(content.statusLine.command, /agy-statusline$/)
      assert.match(content.title.command, /agy-title$/)
      assert.equal(content.theme, undefined)
      assert.deepEqual(diffSnapshots(beforeAgy, await snapshot(h.path(MAIN))), [])

      const liveFile = await h.write(
        `.local/state/sideby/${AGY_LIVE_DIR}/54321.json`,
        '{"version":1}\n',
        0o600,
      )
      await launch.cleanup?.(54321)
      assert.equal(existsSync(settingsFile), false)
      assert.equal(existsSync(liveFile), false)
    })
  })

  it('skips when agyMod is false, on login, headless flags, non-interactive subcommands, or caller --settings', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}')
      const rtOff = await createRuntime({ env: h.env, builtins })
      await h.write('.config/sideby/config.json', JSON.stringify({ agyMod: false }))
      assert.deepEqual((await rtOff.prepareLaunch('agy:main', [], 'run')).args, [])

      await h.write('.config/sideby/config.json', JSON.stringify({ agyMod: true }))
      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual((await rt.prepareLaunch('agy:main', [], 'login')).args, [])
      for (const skip of [
        ['-p', 'hello'],
        ['--print', 'hello'],
        ['--prompt', 'hello'],
        ['--prompt=hello'],
        ['acp'],
        ['agentapi', 'send-message'],
        ['mcp', 'list'],
        ['plugin', 'list'],
        ['plugins', 'list'],
        ['update'],
        ['install'],
        ['models'],
        ['agent'],
        ['agents'],
        ['changelog'],
        ['remote-control', 'status'],
        ['mic-serve'],
        ['help'],
        ['--help'],
        ['--settings', '/tmp/user.json'],
        ['--settings=/tmp/user.json'],
      ]) {
        const res = await rt.prepareLaunch('agy:main', skip, 'run')
        assert.deepEqual(res.args, skip, `expected skip for ${skip.join(' ')}`)
      }
    })
  })

  it('respects disabled slots, preserves padding/stack_with_default, wraps custom commands, coordinates with accountTitle and rejects symlinks', async () => {
    await withFakeHome(async (h) => {
      const stateDir = h.path('.local/state/sideby')
      await h.write(
        `${MAIN}/settings.json`,
        JSON.stringify({
          statusLine: {
            command: 'echo my-status',
            padding: 2,
            stack_with_default: false,
          },
          title: { enabled: false, command: 'echo my-title' },
        }),
      )
      const wrapped = await withAgyMod([], { accountDir: h.path(MAIN), stateDir })
      const cfg = JSON.parse(await readFile(wrapped.settingsFile!, 'utf8'))
      assert.equal(cfg.statusLine.padding, 2)
      assert.equal(cfg.statusLine.stack_with_default, false)
      assert.ok(
        cfg.statusLine.command.includes(
          `${AGY_ORIG_FLAG} ${Buffer.from('echo my-status').toString('base64')}`,
        ),
      )
      assert.equal(cfg.title, undefined)
      await wrapped.cleanup?.()

      await h.write(`${MAIN}/settings.json`, JSON.stringify({ statusLine: { enabled: false } }))
      const titleOnly = await withAgyMod([], { accountDir: h.path(MAIN), stateDir })
      const cfg2 = JSON.parse(await readFile(titleOnly.settingsFile!, 'utf8'))
      assert.equal(cfg2.statusLine, undefined)
      assert.match(cfg2.title.command, /agy-title$/)
      await titleOnly.cleanup?.()

      const bothOff = await withAgyMod([], { accountDir: h.path(MAIN), stateDir, accountTitle: true })
      assert.deepEqual(bothOff.args, [])
      assert.equal(bothOff.settingsFile, undefined)

      await h.mkdir('real-target')
      const beforeTarget = await snapshot(h.path('real-target'))
      await h.mkdir('.local/state/sideby-sym')
      await symlink(h.path('real-target'), join(h.path('.local/state/sideby-sym'), AGY_LAUNCH_DIR))
      await h.write(`${MAIN}/settings.json`, '{}')
      const symWarns: string[] = []
      const symRes = await withAgyMod(['--model', 'demo'], {
        accountDir: h.path(MAIN),
        stateDir: h.path('.local/state/sideby-sym'),
        warn: (m) => symWarns.push(m),
      })
      assert.deepEqual(symRes.args, ['--model', 'demo'])
      assert.equal(symRes.settingsFile, undefined)
      assert.equal(symWarns.length, 1)
      assert.match(symWarns[0]!, /skipped agy status line setup/)
      assert.deepEqual(diffSnapshots(beforeTarget, await snapshot(h.path('real-target'))), [])

      if (process.platform !== 'win32') {
        const roState = h.path('.local/state/sideby-ro')
        await h.mkdir('.local/state/sideby-ro')
        await chmod(roState, 0o500)
        try {
          const roWarns: string[] = []
          const roRes = await withAgyMod(['--model', 'demo'], {
            accountDir: h.path(MAIN),
            stateDir: roState,
            warn: (m) => roWarns.push(m),
          })
          assert.deepEqual(roRes.args, ['--model', 'demo'])
          assert.equal(roRes.settingsFile, undefined)
          assert.equal(roWarns.length, 1)
          assert.match(roWarns[0]!, /skipped agy status line setup/)

          const rtRo = await createRuntime({
            env: { ...h.env, XDG_STATE_HOME: h.path('.local/state/ro-xdg') },
            builtins,
          })
          await h.mkdir('.local/state/ro-xdg/sideby')
          await chmod(h.path('.local/state/ro-xdg/sideby'), 0o500)
          const origWrite = process.stderr.write.bind(process.stderr)
          let stderrOut = ''
          process.stderr.write = ((chunk: string | Uint8Array) => {
            stderrOut += String(chunk)
            return true
          }) as typeof process.stderr.write
          try {
            const prepared = await rtRo.prepareLaunch('agy:main', ['--model', 'demo'], 'run')
            assert.deepEqual(prepared.args, ['--model', 'demo'])
            assert.match(stderrOut, /skipped agy status line setup/)
          } finally {
            process.stderr.write = origWrite
            await chmod(h.path('.local/state/ro-xdg/sideby'), 0o700)
          }
        } finally {
          await chmod(roState, 0o700)
        }
      }
    })
  })
})
