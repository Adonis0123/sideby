// Orca tabs for the Sessions page: which Live Session runs in which Orca terminal, with a fake Orca only.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type OrcaDeps, orcaHandles, orcaTabs, runBounded, switchOrcaTab } from './orca.ts'

function fake(answer: string | Error, envs: Record<number, string | Error> = {}, exitCode = 0) {
  const calls: string[][] = []
  const deps: OrcaDeps = {
    async run(args) {
      calls.push(args)
      if (answer instanceof Error) throw answer
      return { exitCode, stdout: answer }
    },
    async envVar(pid) {
      const v = envs[pid]
      if (v instanceof Error) throw v
      return v
    },
  }
  return { deps, calls }
}
const listOf = (terminals: object[]) => JSON.stringify({ ok: true, result: { terminals } })

describe('orca tabs', () => {
  it('reads the handles of connected terminals only, and none when Orca is missing or answers otherwise', async () => {
    const live = fake(listOf([{ handle: 'a' }, { handle: 'b', connected: false }, { handle: 3 }, {}]))
    assert.deepEqual([...(await orcaHandles(live.deps))], ['a'])
    assert.deepEqual(live.calls[0], ['terminal', 'list', '--json', '--limit', '1000'])
    assert.equal((await orcaHandles(fake(new Error('Orca is not installed')).deps)).size, 0)
    assert.equal((await orcaHandles(fake('not json').deps)).size, 0)
    assert.equal((await orcaHandles(fake(JSON.stringify({ ok: false, error: {} })).deps)).size, 0)
    // Only an explicit success counts: no `ok`, a failing exit or a list that is not one gives no handles.
    const one = [{ handle: 'a' }]
    assert.equal((await orcaHandles(fake(JSON.stringify({ result: { terminals: one } })).deps)).size, 0)
    assert.equal((await orcaHandles(fake(listOf(one), {}, 1).deps)).size, 0)
    assert.equal(
      (await orcaHandles(fake(JSON.stringify({ ok: true, result: { terminals: {} } })).deps)).size,
      0,
    )
  })

  it('ties a Session to a tab only through a listed handle of its own process', async () => {
    const f = fake(listOf([{ handle: 'h1' }, { handle: 'h2' }]), {
      1: 'h1',
      2: 'stale',
      3: new Error('ps failed'),
    })
    const tabs = await orcaTabs(f.deps, [
      { sessionId: 's1', pid: 1 },
      { sessionId: 's2', pid: 2 },
      { sessionId: 's3', pid: 3 },
      { sessionId: 's4' },
    ])
    assert.deepEqual([...tabs], [['s1', 'h1']])
  })

  it('does not ask Orca when no Session has a process id', async () => {
    const f = fake(listOf([{ handle: 'h1' }]))
    assert.equal((await orcaTabs(f.deps, [{ sessionId: 's' }])).size, 0)
    assert.equal(f.calls.length, 0)
  })

  it('switches by handle and accepts only an explicit ok: true with a clean exit', async () => {
    const ok = fake(JSON.stringify({ ok: true }))
    await switchOrcaTab(ok.deps, 'h1')
    assert.deepEqual(ok.calls[0], ['terminal', 'switch', '--terminal', 'h1', '--json'])
    for (const [stdout, code] of [
      ['{}', 0],
      ['false', 0],
      ['[]', 0],
      ['null', 0],
      ['{"ok":true}', 1],
      ['', 0],
    ] as const)
      await assert.rejects(
        switchOrcaTab(fake(stdout, {}, code).deps, 'h1'),
        /did not confirm/,
        `${stdout} ${code}`,
      )
    await assert.rejects(
      switchOrcaTab(
        fake(JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } }), {}, 1).deps,
        'h1',
      ),
      /no longer exists/,
    )
    await assert.rejects(switchOrcaTab(fake(new Error('spawn ENOENT h1')).deps, 'h1'), /not running/)
  })

  it('ends a program that ignores SIGTERM with SIGKILL, so every call settles', async () => {
    const started = Date.now()
    const stubborn = "process.on('SIGTERM', () => {}); process.stdout.write('x'); setInterval(() => {}, 1000)"
    await assert.rejects(
      runBounded(process.execPath, ['-e', stubborn], {}, { timeoutMs: 200, graceMs: 200 }),
      /did not finish/,
    )
    assert.ok(Date.now() - started < 3000, 'settled soon after the grace')
    const done = await runBounded(
      process.execPath,
      ['-e', "process.stdout.write('hi'); process.exit(3)"],
      {},
      {},
    )
    assert.deepEqual(done, { exitCode: 3, stdout: 'hi' })
    await assert.rejects(runBounded('/nonexistent/orca-cli', [], {}, {}), /ENOENT/)
  })
})
