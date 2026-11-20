// Carried trust at Launch (spec §3.43, ADR-0078): only with config `claude.carryTrust`, only for an interactive Claude
// session sideby is about to start (Auto Handoff hops included), written before the Host starts, one line printed.
import assert from 'node:assert/strict'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import {
  diffSnapshots,
  type FakeHome,
  fakeHost,
  readHostLog,
  snapshot,
  withFakeHome,
} from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { createRuntime } from '../runtime.ts'
import { runWithHandoff } from './handoff-run.ts'

const builtins = [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }]

// Two logins: one login in both would make them a Same Login, and a Handoff never moves between those.
const json = (projects: Record<string, unknown>, email: string) =>
  `${JSON.stringify({ oauthAccount: { emailAddress: email }, projects }, null, 2)}\n`

/** claude:001 trusts `code/app`; claude:002 has never been asked. */
async function setup(h: FakeHome, config: object) {
  await h.mkdir('code/app')
  await h.write(
    '.claude-001/.claude.json',
    json({ [h.path('code/app')]: { hasTrustDialogAccepted: true } }, 'me@example.com'),
    0o600,
  )
  await h.write('.claude-002/.claude.json', json({}, 'work@example.com'), 0o600)
  await h.write('.config/sideby/config.json', JSON.stringify(config))
  const lines: string[] = []
  const rt = await createRuntime({
    env: h.env,
    builtins,
    trust: { cwd: () => h.path('code/app'), print: (l) => lines.push(l) },
  })
  return { rt, lines }
}

const trusted = async (h: FakeHome, name: string) =>
  (
    JSON.parse(await readFile(h.path(`.claude-${name}/.claude.json`), 'utf8')) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>
    }
  ).projects[h.path('code/app')]?.hasTrustDialogAccepted === true

const hostFiles = async (h: FakeHome) => {
  const all = await snapshot(h.home)
  return new Map([...all].filter(([p]) => p.startsWith('.claude-')))
}

describe('carried trust at Launch', () => {
  it('reads and writes nothing while config claude.carryTrust is off', async () => {
    await withFakeHome(async (h) => {
      const { rt, lines } = await setup(h, {})
      const before = await hostFiles(h)
      await rt.prepareLaunch('claude:002', [], 'run')
      assert.deepEqual(diffSnapshots(before, await hostFiles(h)), [])
      assert.deepEqual(lines, [])
    })
  })

  it('copies the trust before an interactive session, and prints one line', async () => {
    await withFakeHome(async (h) => {
      const { rt, lines } = await setup(h, { claude: { carryTrust: true } })
      const before = await hostFiles(h)
      await rt.prepareLaunch('claude:002', ['--model', 'opus'], 'run')
      assert.deepEqual(diffSnapshots(before, await hostFiles(h)), ['.claude-002/.claude.json'])
      assert.equal(await trusted(h, '002'), true)
      assert.deepEqual(lines, [
        'claude:002 now trusts ~/code/app, as claude:001 does (claude.carryTrust; undo: sideby trust undo)',
      ])
    })
  })

  for (const [what, args, command] of [
    ['a headless run (-p)', ['-p', 'hi'], 'run'],
    ['a headless run (--print=…)', ['--print=hi'], 'run'],
    ['a headless run in a group of short flags (-cp)', ['-cp', 'hi'], 'run'],
    ['a headless run in a group of short flags (-pc)', ['-pc', 'hi'], 'run'],
    ['a sign-in', [], 'login'],
  ] as const)
    it(`writes nothing for ${what}`, async () => {
      await withFakeHome(async (h) => {
        const { rt, lines } = await setup(h, { claude: { carryTrust: true } })
        const before = await hostFiles(h)
        await rt.prepareLaunch('claude:002', [...args], command)
        assert.deepEqual(diffSnapshots(before, await hostFiles(h)), [])
        assert.deepEqual(lines, [])
      })
    })

  it('a launch Auto Handoff prepares and then leaves to `run` prints its line once', async () => {
    await withFakeHome(async (h) => {
      const { rt, lines } = await setup(h, {
        claude: { carryTrust: true },
        handoff: { auto: true, sameFamily: true },
      })
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
      await chmod(join(h.bin, 'sideby'), 0o755)
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
      // The user's own --settings keeps Auto Handoff out of this run after it prepared the Launch.
      const own = ['--settings', h.path('mine.json')]
      assert.equal(await runWithHandoff(rt, 'claude:002', own, { err: () => {}, stdin }), null)
      await rt.prepareLaunch('claude:002', own, 'run')
      assert.equal(lines.length, 1)
      assert.match(lines[0]!, /^claude:002 now trusts ~\/code\/app/)
    })
  })

  it('an Auto Handoff hop gets the trust before its Host starts', async () => {
    await withFakeHome(async (h) => {
      const seen = join(h.bin, 'seen.jsonl')
      const key = h.path('code/app')
      // Each start records whether its account trusted the folder at that moment; the first marks itself ready.
      await fakeHost(h, 'claude', {
        sleep: 20,
        onStart: `
const f = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
const p = (JSON.parse(fs.readFileSync(f, 'utf8')).projects || {})[${JSON.stringify(key)}]
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ dir: process.env.CLAUDE_CONFIG_DIR, trusted: Boolean(p && p.hasTrustDialogAccepted) }) + '\\n')
if (process.argv.includes('--')) process.exit(0)
if (process.env.SIDEBY_HANDOFF_DIR) fs.writeFileSync(path.join(process.env.SIDEBY_HANDOFF_DIR, 'ready.json'),
  JSON.stringify({ runId: process.env.SIDEBY_HANDOFF_RUN, at: new Date().toISOString(), trigger: 'manual', sessionId: 's1' }))
`,
      })
      const { rt, lines } = await setup(h, {
        claude: { carryTrust: true },
        handoff: { auto: true, sameFamily: true, countdownSeconds: 0 },
      })
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
      await chmod(join(h.bin, 'sideby'), 0o755)
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
      assert.equal(await runWithHandoff(rt, 'claude:001', [], { err: () => {}, stdin }), 0)
      assert.equal((await readHostLog(h, 'claude')).filter((r) => r.argv).length, 2)
      const starts = (await readFile(seen, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { dir: string; trusted: boolean })
      assert.deepEqual(starts, [
        { dir: h.path('.claude-001'), trusted: true },
        { dir: h.path('.claude-002'), trusted: true },
      ])
      assert.deepEqual(lines, [
        'claude:002 now trusts ~/code/app, as claude:001 does (claude.carryTrust; undo: sideby trust undo)',
      ])
    })
  })
})
