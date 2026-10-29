// `sideby sessions open-run <account|session>` (spec §3.32 step 2b, ADR-0041): opens the Run Board of a Live Session
// with the same checks and opener as the Panel's "Open run report", picking the Session as `sessions copy` does.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import type { ExecResult } from '../core/desktop-app.ts'
import { UserError } from '../core/errors.ts'
import { sessionIndexPath } from '../core/run-link.ts'
import { createRuntime } from '../runtime.ts'
import { parseArgs } from './args.ts'
import { cmdSessions } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const SID = '61230c3d-0000-4000-8000-000000000001'
const PROC_START = 'Tue Oct 20 02:14:43 2026'

/** cc002 (claude:work) runs one Live Session; `run` ties it to a Run whose board is in the orchestrator's folder. */
async function setUp(h: FakeHome, run = true) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-work/settings.json', '{}')
  await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:work' } }))
  await h.write(
    '.claude-work/sessions/4101.json',
    JSON.stringify({ pid: 4101, sessionId: SID, cwd: '/work/repo', status: 'idle', procStart: PROC_START }),
  )
  await writeFile(
    join(h.bin, 'ps'),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`4101 1 ${PROC_START} claude\n`)})\n`,
    { mode: 0o755 },
  )
  const board = await h.write('.local/state/agent-dispatch/boards/r1.html', '<!doctype html>\n', 0o600)
  if (run) {
    const index = {
      schemaVersion: 1,
      sessions: {
        [SID]: { entries: [{ runTitle: 'Run one', board, role: 'write', url: `file://${board}` }] },
      },
    }
    const path = sessionIndexPath(h.env, h.home)
    await h.write(path.slice(h.home.length + 1), JSON.stringify(index))
  }
  const calls: string[][] = []
  const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args])
    return { code: 0, stdout: '', stderr: '' }
  }
  const rt = await createRuntime({ env: h.env, desktop: { platform: 'darwin', exec } })
  return { board, calls, rt }
}

const run = (rt: Awaited<ReturnType<typeof createRuntime>>, argv: string[]) => {
  const out: string[] = []
  return cmdSessions(parseArgs(argv, ['json'], ['as']), { out: (s) => out.push(s), err: () => {} }, rt).then(
    (code) => ({ code, out: out.join('\n') }),
  )
}

describe('sessions open-run', () => {
  it('opens the Run Board of the session an account or session id names', async () => {
    await withFakeHome(async (h) => {
      const { board, calls, rt } = await setUp(h)
      const j = await run(rt, ['open-run', 'cc002', '--json'])
      assert.equal(j.code, 0)
      const data = JSON.parse(j.out) as Record<string, unknown>
      assert.ok(Value.Check(OUTPUT_SCHEMAS['sessions-open-run']!, data), j.out)
      assert.deepEqual(
        { opened: data.opened, board: data.board, sessionId: data.sessionId },
        { opened: true, board: '~/.local/state/agent-dispatch/boards/r1.html', sessionId: SID },
      )
      const text = await run(rt, ['open-run', '61230c3d'])
      assert.equal(text.code, 0)
      assert.match(text.out, /opened the run report of .*61230c3d/)
      assert.deepEqual(calls, [
        ['/usr/bin/open', board],
        ['/usr/bin/open', board],
      ])
    })
  })

  it('says what to do when the session has no run, and when nothing is running', async () => {
    await withFakeHome(async (h) => {
      const { calls, rt } = await setUp(h, false)
      await assert.rejects(
        run(rt, ['open-run', 'cc002']),
        (e: unknown) => e instanceof UserError && e.code === 'no-run',
      )
      await assert.rejects(
        run(rt, ['open-run', 'nobody']),
        (e: unknown) => e instanceof UserError && e.code === 'no-session',
      )
      await assert.rejects(run(rt, ['open-run']), /usage: sideby sessions open-run <account\|session-id>/)
      assert.deepEqual(calls, [])
    })
  })
})

describe('handed-over session ids (ADR-0057)', () => {
  const OLD = '05966d31-0000-4000-8000-000000000009'

  /** cc002 runs SID, which an Auto Handoff chain passed the task to from OLD; only OLD is in the Session Index. */
  async function handedOver(h: FakeHome) {
    const r = await setUp(h, false)
    const index = {
      schemaVersion: 1,
      sessions: { [OLD]: { entries: [{ runTitle: 'Run one', board: r.board, url: `file://${r.board}` }] } },
    }
    await h.write(sessionIndexPath(h.env, h.home).slice(h.home.length + 1), JSON.stringify(index))
    await h.write('.local/state/sideby/handoffs/c1/run-mvt4ly8k-a.json', JSON.stringify({ sessionId: OLD }))
    await h.write('.local/state/sideby/handoffs/c1/run-mvt4lz00-b.json', JSON.stringify({ sessionId: SID }))
    const clip = join(h.bin, 'clip.txt')
    await writeFile(
      join(h.bin, 'pbcopy'),
      `#!${process.execPath}\nlet d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(clip)},d))\n`,
      { mode: 0o755 },
    )
    return r
  }

  it('lists the earlier ids in sessions --json and keeps the Run linked through them', async () => {
    await withFakeHome(async (h) => {
      const { rt } = await handedOver(h)
      const j = await run(rt, ['--json'])
      const data = JSON.parse(j.out) as {
        sessions: { sessionId: string; handedOverFrom?: string[]; run?: { title: string } }[]
      }
      assert.ok(Value.Check(OUTPUT_SCHEMAS.sessions!, data), j.out)
      assert.deepEqual(
        data.sessions.map((s) => [s.sessionId, s.handedOverFrom, s.run?.title]),
        [[SID, [OLD], 'Run one']],
      )
    })
  })

  it('opens the run report and copies the session an old id was handed over to, saying so first', async () => {
    await withFakeHome(async (h) => {
      const { board, calls, rt } = await handedOver(h)
      const j = await run(rt, ['open-run', OLD, '--json'])
      const data = JSON.parse(j.out) as Record<string, unknown>
      assert.ok(Value.Check(OUTPUT_SCHEMAS['sessions-open-run']!, data), j.out)
      assert.equal(data.sessionId, SID)
      assert.equal(data.handedOverFrom, OLD)
      const text = await run(rt, ['open-run', OLD.slice(0, 8)])
      assert.match(
        text.out.split('\n')[0]!,
        /^05966d31 was handed over to cc002 · .*61230c3d; opening its run report$/,
      )
      assert.deepEqual(calls, [
        ['/usr/bin/open', board],
        ['/usr/bin/open', board],
      ])
      const c = await run(rt, ['copy', OLD, '--as', 'id', '--json'])
      const copied = JSON.parse(c.out) as Record<string, unknown>
      assert.ok(Value.Check(OUTPUT_SCHEMAS['sessions-copy']!, copied), c.out)
      assert.deepEqual([copied.text, copied.handedOverFrom], [SID, OLD])
      const ct = await run(rt, ['copy', OLD, '--as', 'id'])
      assert.match(ct.out.split('\n')[0]!, /^05966d31 was handed over to cc002 · .*; copying that one$/)
      // A session named by its own id says nothing about a handoff.
      const own = JSON.parse((await run(rt, ['copy', SID, '--as', 'id', '--json'])).out) as Record<
        string,
        unknown
      >
      assert.equal('handedOverFrom' in own, false)
    })
  })
})
