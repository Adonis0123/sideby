// `sideby memory` (spec §3.44, ADR-0081) end to end, run as child processes in a fake HOME: the switch with its preview
// and exit 10, the status that reads no account folder while off, and `sideby doctor --fix` folding an account's own
// memory into the main account (in a fake HOME the emptied folder goes to sideby's state folder, never the real trash).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { claudeProjectDirName } from '../families/claude/layout.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

function sideby(h: FakeHome, args: string[], cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: h.env as NodeJS.ProcessEnv, cwd })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

function checkSchema(name: string, text: string) {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

/** claude:main and claude:work; claude:work wrote memory of `code/app` in a session sideby did not start. */
async function setup(h: FakeHome) {
  const app = await h.mkdir('code/app')
  const name = claudeProjectDirName(app)
  await h.write('.claude/settings.json', '{}\n')
  await h.write(`.claude/projects/${name}/memory/MEMORY.md`, '- [Build](build.md) — how to build\n')
  await h.write(`.claude/projects/${name}/memory/build.md`, 'pnpm build\n')
  await h.write('.claude-work/settings.json', '{}\n')
  await h.write(
    `.claude-work/projects/${name}/memory/MEMORY.md`,
    '- [Build](build.md) — how to build\n- [Tests](tests.md) — how to test\n',
  )
  await h.write(`.claude-work/projects/${name}/memory/build.md`, 'pnpm build --watch\n')
  await h.write(`.claude-work/projects/${name}/memory/tests.md`, 'pnpm test\n')
  return { app, name, config: h.path('.config/sideby/config.json') }
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  )

describe('sideby memory', () => {
  it('shows the switch, previews a change with exit 10, and makes it with --yes', async () => {
    await withFakeHome(async (h) => {
      const { app, name, config } = await setup(h)
      const off = await sideby(h, ['memory', '--json'], app)
      assert.equal(off.code, 0)
      const st = checkSchema('memory', off.out)
      assert.equal(st.on, false)
      assert.equal(st.projects, undefined)
      assert.equal(st.dir, undefined)

      const preview = await sideby(h, ['memory', 'on', '--json'], app)
      assert.equal(preview.code, 10)
      assert.equal(checkSchema('memory-set', preview.out).applied, false)
      assert.equal(await exists(config), false)

      const on = await sideby(h, ['memory', 'on', '--yes', '--json'], app)
      assert.equal(on.code, 0)
      assert.equal(checkSchema('memory-set', on.out).on, true)
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).claude, { shareMemory: true })

      const now = checkSchema('memory', (await sideby(h, ['memory', '--json'], app)).out)
      assert.deepEqual(now.dir, { path: '~/code/app', name, memory: `~/.claude/projects/${name}/memory` })
      assert.deepEqual(now.projects, [
        { name, main: 2, pending: [{ account: 'claude:work', files: 3 }], folded: [] },
      ])

      const again = await sideby(h, ['memory', 'on', '--json'], app)
      assert.equal(again.code, 0)
      assert.equal(checkSchema('memory-set', again.out).changed, false)

      const offPreview = await sideby(h, ['memory', 'off'], app)
      assert.equal(offPreview.code, 10)
      assert.match(offPreview.out, /claude\.shareMemory true → false/)
      assert.equal((await sideby(h, ['memory', 'off', '--yes'], app)).code, 0)
      assert.equal(JSON.parse(await readFile(config, 'utf8')).claude, undefined)
    })
  })

  it('refuses what it does not take with exit 2', async () => {
    await withFakeHome(async (h) => {
      const { app } = await setup(h)
      assert.equal((await sideby(h, ['memory', 'sometimes'], app)).code, 2)
      assert.equal((await sideby(h, ['memory', 'on', '--dir', app], app)).code, 2)
      assert.equal((await sideby(h, ['memory', '--yes'], app)).code, 2)
    })
  })

  it('doctor reports memory an account wrote on its own only while on, and --fix folds it into the main account', async () => {
    await withFakeHome(async (h) => {
      const { app, name } = await setup(h)
      const codes = (out: string) =>
        (JSON.parse(out) as { accounts: { findings: { code: string }[] }[] }).accounts.flatMap((a) =>
          a.findings.map((f) => f.code),
        )
      const before = await sideby(h, ['doctor', 'claude', '--json'], app)
      assert.equal(codes(before.out).includes('memory.unfolded'), false)

      await sideby(h, ['memory', 'on', '--yes'], app)
      const report = await sideby(h, ['doctor', 'claude', '--json'], app)
      const found = (
        JSON.parse(report.out) as { accounts: { findings: { code: string; level: string }[] }[] }
      ).accounts
        .flatMap((a) => a.findings)
        .find((f) => f.code === 'memory.unfolded')
      // A warning: it never makes Doctor fail on its own.
      assert.equal(found?.level, 'warn')

      const fixed = await sideby(h, ['doctor', 'claude', '--fix', '--json'], app)
      const fix = (
        JSON.parse(fixed.out) as { fixes: { code: string; ok: boolean; message: string }[] }
      ).fixes.find((f) => f.code === 'memory.unfolded')
      assert.equal(fix?.ok, true, fix?.message)
      assert.equal(codes(fixed.out).includes('memory.unfolded'), false)
      const main = h.path('.claude/projects', name, 'memory')
      assert.deepEqual((await readdir(main)).sort(), ['MEMORY.md', 'build.md', 'build.work.md', 'tests.md'])
      assert.equal(await readFile(join(main, 'build.md'), 'utf8'), 'pnpm build\n')
      assert.equal(await readFile(join(main, 'build.work.md'), 'utf8'), 'pnpm build --watch\n')
      assert.equal(
        await readFile(join(main, 'MEMORY.md'), 'utf8'),
        '- [Build](build.md) — how to build\n- [Build](build.work.md) — how to build\n- [Tests](tests.md) — how to test\n',
      )
      assert.equal(await exists(h.path('.claude-work/projects', name, 'memory')), false)
      // A fake HOME never reaches the real trash: the emptied folder is kept in sideby's state folder.
      const kept = await readdir(h.path('.local/state/sideby/memory/trash'))
      assert.equal(kept.length, 1)

      const st = checkSchema('memory', (await sideby(h, ['memory', '--json'], app)).out)
      // Two notes reached the main account (one under a new name); MEMORY.md is merged, not counted.
      assert.deepEqual(st.projects, [
        { name, main: 4, pending: [], folded: [{ account: 'claude:work', files: 2 }] },
      ])
    })
  })
})
