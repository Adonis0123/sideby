// Auto Handoff end to end with fake Hosts (spec §3.17): the parent ends a ready Host and starts the next Account in
// the same terminal, never kills a Host that will not exit, stays when cancelled, and does nothing when it is off.
import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { createRuntime } from '../runtime.ts'
import { runWithHandoff } from './handoff-run.ts'

const builtins = [claudePlugin, codexPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

/** The hook's job, done by the fake Host on its first run: mark the run ready, then wait to be ended. */
const READY_ON_FIRST_RUN = `
if (process.argv.includes('--')) process.exit(0)
if (process.env.SIDEBY_HANDOFF_DIR) fs.writeFileSync(path.join(process.env.SIDEBY_HANDOFF_DIR, 'ready.json'),
  JSON.stringify({ runId: process.env.SIDEBY_HANDOFF_RUN, at: new Date().toISOString(), trigger: 'manual', sessionId: 's1' }))
`

async function setup(h: FakeHome, handoff: object, accounts = ['001', '002']) {
  for (const a of accounts) await h.write(`.claude-${a}/projects/.keep`, '')
  await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc001: 'claude:001' }, handoff }))
  // The hook command must find a sideby with the hook entry on PATH; this one only answers the check.
  await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
  await chmod(join(h.bin, 'sideby'), 0o755)
  return createRuntime({ env: h.env, builtins })
}

function terminal(): PassThrough & { isTTY: boolean; setRawMode: () => void } {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
}

describe('runWithHandoff', () => {
  it('ends the ready Host and starts the next Account with the Brief path after --', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude', { sleep: 20, onStart: READY_ON_FIRST_RUN })
      const rt = await setup(h, { auto: true, sameFamily: true, countdownSeconds: 0 })
      const lines: string[] = []
      const code = await runWithHandoff(rt, 'cc001', ['--model', 'opus'], {
        err: (l) => lines.push(l),
        stdin: terminal(),
      })
      assert.equal(code, 0)
      const log = await readHostLog(h, 'claude')
      const starts = log.filter((r) => r.argv)
      assert.equal(starts.length, 2)
      assert.deepEqual(
        log.filter((r) => r.signal).map((r) => r.signal),
        ['SIGTERM'],
      )
      const [one, two] = starts as [(typeof starts)[0], (typeof starts)[0]]
      assert.ok(one.env.SIDEBY_HANDOFF_RUN)
      assert.ok(one.argv.includes('--settings'))
      assert.equal(two.env.CLAUDE_CONFIG_DIR, h.path('.claude-002'))
      // The next Account is part of the same chain and may hand over again, under a run id of its own.
      assert.ok(two.env.SIDEBY_HANDOFF_RUN && two.env.SIDEBY_HANDOFF_RUN !== one.env.SIDEBY_HANDOFF_RUN)
      assert.equal(two.env.SIDEBY_HANDOFF_DIR, one.env.SIDEBY_HANDOFF_DIR)
      assert.deepEqual(two.argv.slice(0, 2), ['--model', 'opus'])
      const dashes = two.argv.indexOf('--')
      assert.match(two.argv[dashes + 1]!, /handed over from claude:001.*Read .*1-claude-001\.md/)
      assert.ok(two.argv.includes('--add-dir'))
      assert.ok(lines.some((l) => /handing over from claude:001 to claude:002/.test(l)))
    })
  })

  it('puts sideby’s options before the user’s own --, so they are not read as prompt text', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude', { sleep: 1 })
      const rt = await setup(h, { auto: true, sameFamily: true, countdownSeconds: 0 })
      await runWithHandoff(rt, 'cc001', ['--model', 'opus', '--', 'fix the tests'], {
        err: () => {},
        stdin: terminal(),
      })
      const argv = (await readHostLog(h, 'claude')).find((r) => r.argv)!.argv
      const dashes = argv.indexOf('--')
      assert.ok(argv.indexOf('--settings') < dashes && argv.indexOf('--add-dir') < dashes)
      assert.deepEqual(argv.slice(dashes), ['--', 'fix the tests'])
    })
  })

  it('leaves a headless run alone, and turns off for a sideby on PATH without the hook entry', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      const rt = await setup(h, { auto: true, sameFamily: true })
      const lines: string[] = []
      assert.equal(
        await runWithHandoff(rt, 'cc001', ['-p', 'hi'], { err: (l) => lines.push(l), stdin: terminal() }),
        null,
      )
      assert.equal(lines.length, 0)
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\nexit 2\n')
      assert.equal(
        await runWithHandoff(rt, 'cc001', [], { err: (l) => lines.push(l), stdin: terminal() }),
        null,
      )
      assert.ok(lines.some((l) => /older than this one/.test(l)))
    })
  })

  it('leaves a Host that will not exit running and starts nothing else', async () => {
    await withFakeHome(async (h) => {
      const stubborn = `${READY_ON_FIRST_RUN}\nprocess.removeAllListeners('SIGTERM'); process.on('SIGTERM', () => {})`
      await fakeHost(h, 'claude', { sleep: 3, onStart: stubborn })
      const rt = await setup(h, { auto: true, sameFamily: true, countdownSeconds: 0 })
      const lines: string[] = []
      const code = await runWithHandoff(
        rt,
        'cc001',
        [],
        { err: (l) => lines.push(l), stdin: terminal() },
        { exitGraceMs: 300 },
      )
      assert.equal(code, 0)
      assert.equal((await readHostLog(h, 'claude')).filter((r) => r.argv).length, 1)
      assert.ok(lines.some((l) => /did not exit within/.test(l)))
    })
  })

  it('does not end the session when nothing can take over', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude', { sleep: 1, onStart: READY_ON_FIRST_RUN })
      const rt = await setup(h, { auto: true, sameFamily: true, countdownSeconds: 0 }, ['001'])
      const lines: string[] = []
      await runWithHandoff(rt, 'cc001', [], { err: (l) => lines.push(l), stdin: terminal() })
      const log = await readHostLog(h, 'claude')
      assert.deepEqual(
        log.filter((r) => r.signal),
        [],
      )
      assert.ok(lines.some((l) => /did not hand over/.test(l)))
    })
  })

  it('stays when the countdown is cancelled: resumes the session in the same account, without hooks', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude', {
        sleep: 20,
        onStart: `${READY_ON_FIRST_RUN.replace("process.argv.includes('--')", "process.argv.includes('--resume')")}`,
      })
      const rt = await setup(h, { auto: true, sameFamily: true, countdownSeconds: 5 })
      const tty = terminal()
      const lines: string[] = []
      const run = runWithHandoff(rt, 'cc001', [], {
        err: (l) => {
          lines.push(l)
          if (/press Enter to stay/.test(l)) tty.write('\r')
        },
        stdin: tty,
      })
      assert.equal(await run, 0)
      const starts = (await readHostLog(h, 'claude')).filter((r) => r.argv)
      assert.equal(starts.length, 2)
      assert.equal(starts[1]!.env.CLAUDE_CONFIG_DIR, h.path('.claude-001'))
      assert.deepEqual(starts[1]!.argv.slice(-2), ['--resume', 's1'])
      assert.equal(starts[1]!.env.SIDEBY_HANDOFF_RUN, undefined)
    })
  })

  it('does nothing when Auto Handoff is off or stdin is not a terminal', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'claude')
      const off = await setup(h, { auto: false })
      assert.equal(await runWithHandoff(off, 'cc001', [], { err: () => {}, stdin: terminal() }), null)
      const on = await setup(h, { auto: true })
      assert.equal(
        await runWithHandoff(on, 'cc001', [], {
          err: () => {},
          stdin: Object.assign(new PassThrough(), { isTTY: false }),
        }),
        null,
      )
      assert.deepEqual(await readHostLog(h, 'claude'), [])
    })
  })
})
