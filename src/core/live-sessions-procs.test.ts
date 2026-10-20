// The process helpers of Live Sessions (spec §3.32): reading one variable from `ps eww`, the directory check, and
// which processes `ps` is asked for.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { envFromPs, isInside, systemDeps } from './live-sessions-procs.ts'

describe('process helpers', () => {
  it('reads one variable after the arguments, also a path with spaces', () => {
    const argv = 'codex --model x'
    const out = `${argv} PATH=/usr/bin:/bin CODEX_HOME=/tmp/My Accounts/.codex-team TERM=xterm\n`
    assert.equal(envFromPs(argv, out, 'CODEX_HOME'), '/tmp/My Accounts/.codex-team')
    assert.equal(envFromPs(argv, out, 'PI_CODING_AGENT_DIR'), undefined)
    // A prompt that mentions the variable is an argument, not the environment.
    const prompt = 'codex set CODEX_HOME=/tmp'
    assert.equal(envFromPs(prompt, `${prompt} PATH=/bin CODEX_HOME=/real`, 'CODEX_HOME'), '/real')
    assert.throws(() => envFromPs('codex exec', 'codex exec\n', 'CODEX_HOME'), /cannot be read/)
  })

  it('tells a directory from its neighbour', () => {
    assert.equal(isInside('/h/.codex/sessions', '/h/.codex/sessions/2026/r.jsonl'), true)
    assert.equal(isInside('/h/.codex/sessions/', '/h/.codex/sessions-backup/r.jsonl'), false)
    assert.equal(isInside('/h/.codex/sessions', '/h/.codex/sessions'), false)
    assert.equal(isInside('/h/.codex/sessions', '/h/.codex/sessions/../auth.json'), false)
  })

  it("asks ps for this user's processes only", async () => {
    await withFakeHome(async (h) => {
      const log = join(h.bin, 'ps.args')
      await writeFile(
        join(h.bin, 'ps'),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n`,
        { mode: 0o755 },
      )
      await systemDeps({ PATH: h.bin }).processes()
      const args = JSON.parse(await readFile(log, 'utf8')) as string[]
      assert.deepEqual(args.slice(0, 2), ['-U', String(process.getuid!())])
      assert.ok(!args.includes('-A'))
    })
  })
})
