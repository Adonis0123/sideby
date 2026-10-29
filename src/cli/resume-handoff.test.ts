// `sideby resume` into the Main Account keeps Auto Handoff (spec §3.15, ADR-0058): with config `handoff.auto` on it
// starts the Main Account exactly as `sideby run` would; off, or with the select variable set, the Host runs unchanged.
import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cmdResume } from './commands.ts'

const ID = '0a4964a7-fb75-40c0-a9eb-f0755cc54449'

function terminal(): PassThrough & { isTTY: boolean; setRawMode: () => void } {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
}

/** Claude main plus `claude:work`; `saved` puts session `ID` in the main one, else only the main one started it. */
async function setUp(h: FakeHome, auto: boolean, saved = true) {
  await h.mkdir('.claude/projects')
  await h.mkdir('.claude-work/projects')
  if (saved) await h.write(`.claude/projects/-work-app/${ID}.jsonl`, '{}\n')
  else await h.mkdir(`.claude/session-env/${ID}`)
  await h.write(
    '.config/sideby/config.json',
    JSON.stringify({ handoff: { auto, sameFamily: true, countdownSeconds: 0 } }),
  )
  // The hook command must find a sideby with the hook entry on PATH; this one only answers the check.
  await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
  await chmod(join(h.bin, 'sideby'), 0o755)
  await fakeHost(h, 'claude')
}

async function resume(h: FakeHome, argv: string[], env: Record<string, string> = {}) {
  const rt = await createRuntime({ env: { ...h.env, ...env } })
  const err: string[] = []
  const code = await cmdResume(
    parseArgs(['claude', '--', ...argv], [], []),
    { out: () => {}, err: (s) => err.push(s), stdin: terminal() },
    rt,
  )
  return { code, err: err.join('\n') }
}

const handoffVars = (env: Record<string, string>) =>
  Object.keys(env).filter((k) => k.startsWith('SIDEBY_HANDOFF'))

describe('resume into the Main Account (ADR-0058)', () => {
  it('with handoff.auto on, starts it as `sideby run` would, with Auto Handoff', async () => {
    await withFakeHome(async (h) => {
      await setUp(h, true)
      const r = await resume(h, ['--resume', ID])
      assert.equal(r.code, 0, r.err)
      assert.match(
        r.err,
        new RegExp(`sideby: session ${ID} is in claude:main; starting it there with Auto Handoff`),
      )
      const [rec] = (await readHostLog(h, 'claude')).filter((x) => x.argv)
      assert.ok(rec!.env.SIDEBY_HANDOFF_RUN)
      assert.ok(rec!.argv.includes('--resume') && rec!.argv.includes(ID))
    })
  })

  it('with handoff.auto off, runs the Host unchanged', async () => {
    await withFakeHome(async (h) => {
      await setUp(h, false)
      const r = await resume(h, ['--resume', ID])
      assert.equal(r.code, 0, r.err)
      assert.equal(r.err, '')
      const [rec] = await readHostLog(h, 'claude')
      assert.deepEqual(handoffVars(rec!.env), [])
      assert.deepEqual(rec!.argv, ['--resume', ID])
    })
  })

  it('with the select variable set, runs the Host unchanged even with handoff.auto on', async () => {
    await withFakeHome(async (h) => {
      await setUp(h, true)
      const r = await resume(h, ['--resume', ID], { CLAUDE_CONFIG_DIR: h.path('.claude') })
      assert.equal(r.code, 0, r.err)
      assert.doesNotMatch(r.err, /Auto Handoff/)
      const [rec] = await readHostLog(h, 'claude')
      assert.deepEqual(handoffVars(rec!.env), [])
      assert.deepEqual(rec!.argv, ['--resume', ID])
    })
  })

  it('a never-saved session the Main Account started starts anew as `sideby run` would', async () => {
    await withFakeHome(async (h) => {
      await setUp(h, true, false)
      const r = await resume(h, ['--resume', ID])
      assert.equal(r.code, 0, r.err)
      assert.match(r.err, new RegExp(`session ${ID} was never saved; starting a new session in claude:main`))
      const [rec] = (await readHostLog(h, 'claude')).filter((x) => x.argv)
      assert.ok(rec!.env.SIDEBY_HANDOFF_RUN)
      assert.ok(!rec!.argv.includes('--resume') && !rec!.argv.includes(ID))
    })
  })
})
