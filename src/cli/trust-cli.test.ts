// `sideby trust` (spec §3.43, ADR-0078) end to end, run as child processes in a folder inside a fake HOME: the switch
// with its preview and exit 10, the status with booleans only, a `sideby run` that copies the trust before the Host
// starts, and an undo that puts the file back.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, fakeHost, withFakeHome } from '../../testing/index.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const MARKER = 'not-a-secret-marker-only-for-this-test'

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

const claudeJson = (projects: Record<string, unknown>, email: string) =>
  `${JSON.stringify({ oauthAccount: { emailAddress: email, accessToken: MARKER }, projects, userID: MARKER }, null, 2)}\n`

/** claude:main trusts `code/app` (and another folder); claude:work has never been asked. */
async function setup(h: FakeHome) {
  const app = await h.mkdir('code/app')
  await h.write('.claude/settings.json', '{}\n')
  await h.write(
    '.claude.json',
    claudeJson(
      {
        [app]: { hasTrustDialogAccepted: true },
        [h.path('private/other')]: { hasTrustDialogAccepted: true, history: [MARKER] },
      },
      'me@example.com',
    ),
    0o600,
  )
  await h.write('.claude-work/settings.json', '{}\n')
  const work = await h.write('.claude-work/.claude.json', claudeJson({}, 'work@example.com'), 0o600)
  return { app, work }
}

describe('sideby trust', () => {
  it('turns on after a preview, shows booleans only, copies at `run`, and undo puts the file back', async () => {
    await withFakeHome(async (h) => {
      const { app, work } = await setup(h)
      const original = await readFile(work, 'utf8')
      const config = h.path('.config/sideby/config.json')

      const off = await sideby(h, ['trust', '--json'], app)
      assert.equal(off.code, 0, off.err)
      assert.deepEqual(checkSchema('trust', off.out), {
        schemaVersion: 1,
        action: 'status',
        on: false,
        carried: [],
      })

      const preview = await sideby(h, ['trust', 'on', '--json'], app)
      assert.equal(preview.code, 10)
      assert.deepEqual(
        [checkSchema('trust-set', preview.out).applied, await readFile(config, 'utf8').catch(() => null)],
        [false, null],
      )
      const human = await sideby(h, ['trust', 'on'], app)
      assert.equal(human.code, 10)
      assert.match(human.out, /claude\.carryTrust false → true/)
      assert.match(human.out, /sideby trust on --yes/)
      const on = await sideby(h, ['trust', 'on', '--yes', '--json'], app)
      assert.equal(on.code, 0, on.err)
      assert.equal(checkSchema('trust-set', on.out).on, true)
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).claude, { carryTrust: true })

      const st = await sideby(h, ['trust', '--json'], join(app))
      const status = checkSchema('trust', st.out)
      assert.deepEqual(status.accounts, [
        { ref: 'claude:main', trusts: true },
        { ref: 'claude:work', trusts: false, carryFrom: 'claude:main' },
      ])
      assert.deepEqual([status.dir, status.root], ['~/code/app', { kind: 'folder', path: '~/code/app' }])
      // Nothing of .claude.json but the booleans: no login, no token, no other folder it trusts.
      for (const leak of [MARKER, 'me@example.com', 'private/other']) assert.ok(!st.out.includes(leak), leak)

      await fakeHost(h, 'claude', {
        onStart: `fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'seen'), fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')))`,
      })
      const headless = await sideby(h, ['run', 'claude:work', '--', '-p', 'hi'], app)
      assert.equal(headless.code, 0, headless.err)
      assert.equal(await readFile(work, 'utf8'), original)
      const run = await sideby(h, ['run', 'claude:work'], app)
      assert.equal(run.code, 0, run.err)
      assert.match(
        run.err,
        /sideby: claude:work now trusts ~\/code\/app, as claude:main does \(claude\.carryTrust; undo: sideby trust undo\)/,
      )
      // Written before the Host started: the Host read it trusted.
      const seen = JSON.parse(await readFile(h.path('.claude-work/seen'), 'utf8'))
      assert.deepEqual(seen.projects, { [app]: { hasTrustDialogAccepted: true } })
      for (const leak of [MARKER, 'me@example.com', 'private/other']) assert.ok(!run.err.includes(leak), leak)

      const undoPreview = await sideby(h, ['trust', 'undo', '--json'], app)
      assert.equal(undoPreview.code, 10)
      const items = checkSchema('trust-undo', undoPreview.out).items as { status: string; path: string }[]
      assert.deepEqual(
        items.map((x) => [x.path, x.status]),
        [['~/code/app', 'undo']],
      )
      const undone = await sideby(h, ['trust', 'undo', '--yes', '--json'], app)
      assert.equal(undone.code, 0, undone.err)
      assert.equal((checkSchema('trust-undo', undone.out).items as { status: string }[])[0]?.status, 'undone')
      assert.equal(await readFile(work, 'utf8'), original)

      const offPreview = await sideby(h, ['trust', 'off'], app)
      assert.equal(offPreview.code, 10)
      assert.match(offPreview.out, /keeps the trust sideby already copied/)
    })
  })

  it('says what to use for an option that does not go with the subcommand', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['trust', 'on', '--dir', '.', '--json'], h.home)
      assert.equal(r.code, 2)
      const e = checkSchema('error', r.out)
      assert.match(e.error as string, /--dir does not go with `sideby trust on`; usage: sideby trust/)
    })
  })
})
