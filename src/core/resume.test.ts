// Session routing for `sideby resume` (spec §3.15, ADR-0007).
import assert from 'node:assert/strict'
import { utimes } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { claudeFamily, claudePlugin } from '../families/claude/index.ts'
import { codexFamily, codexPlugin } from '../families/codex/index.ts'
import { grokFamily, grokPlugin } from '../families/grok/index.ts'
import { piFamily, piPlugin } from '../families/pi/index.ts'
import { createRuntime } from '../runtime.ts'

const ID = '0a4964a7-fb75-40c0-a9eb-f0755cc54449'
const builtins = [claudePlugin, codexPlugin, grokPlugin, piPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

/** A Claude Account holding session `ID` (the `projects` directory also marks it as an Account). */
async function claudeSession(h: FakeHome, dir: string, mtime?: Date) {
  const p = await h.write(`${dir}/projects/-work-app/${ID}.jsonl`, '{}\n')
  if (mtime) await utimes(p, mtime, mtime)
}

/** A Claude Account that started session `ID` but saved nothing for it (ADR-0009). */
async function claudeStarted(h: FakeHome, dir: string, mtime?: Date) {
  await h.mkdir(`${dir}/projects`)
  const p = h.path(`${dir}/session-env/${ID}`)
  await h.mkdir(`${dir}/session-env/${ID}`)
  if (mtime) await utimes(p, mtime, mtime)
}

describe('resumedSession', () => {
  it('reads the id from --resume, --resume= and -r for Claude and Grok, and only before --', () => {
    for (const f of [claudeFamily, grokFamily]) {
      assert.equal(f.resumedSession!(['--dangerously-skip-permissions', '--resume', ID]), ID)
      assert.equal(f.resumedSession!([`--resume=${ID}`]), ID)
      assert.equal(f.resumedSession!(['-r', ID]), ID)
      // Titles, a bare --resume and --continue stay with the Host.
      assert.equal(f.resumedSession!(['--resume', 'fix login']), undefined)
      assert.equal(f.resumedSession!(['--resume']), undefined)
      assert.equal(f.resumedSession!(['--continue']), undefined)
      assert.equal(f.resumedSession!(['--', '--resume', ID]), undefined)
    }
  })

  it('reads the first UUID after the resume subcommand for Codex', () => {
    const f = codexFamily
    assert.equal(f.resumedSession!(['resume', ID]), ID)
    assert.equal(f.resumedSession!(['-c', 'model="x"', 'resume', '-c', 'a=b', ID, 'go on']), ID)
    assert.equal(f.resumedSession!(['resume', '--last']), undefined)
    assert.equal(f.resumedSession!(['exec', ID]), undefined)
  })

  it('is not offered by pi', () => {
    assert.equal(piFamily.resumedSession, undefined)
    assert.equal(piFamily.sessionWrittenAt, undefined)
  })

  it('drops only the by-id resume for Claude, before --', () => {
    const f = claudeFamily
    assert.deepEqual(f.withoutResume!(['--dangerously-skip-permissions', '--resume', ID]), [
      '--dangerously-skip-permissions',
    ])
    assert.deepEqual(f.withoutResume!([`--resume=${ID}`, '--model', 'opus']), ['--model', 'opus'])
    assert.deepEqual(f.withoutResume!(['-r', ID, '-p', 'hi']), ['-p', 'hi'])
    assert.deepEqual(f.withoutResume!(['--resume', 'fix login']), ['--resume', 'fix login'])
    assert.deepEqual(f.withoutResume!(['-p', 'x', '--', '--resume', ID]), ['-p', 'x', '--', '--resume', ID])
  })

  it('leaves never-saved sessions to Claude alone', () => {
    for (const f of [codexFamily, grokFamily, piFamily]) {
      assert.equal(f.sessionStartedAt, undefined)
      assert.equal(f.withoutResume, undefined)
    }
  })
})

describe('resumeLaunch', () => {
  it('starts the non-main Claude Account that holds the session as run would', async () => {
    await withFakeHome(async (h) => {
      await claudeSession(h, '.claude-work')
      await h.mkdir('.claude/projects')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ accounts: { 'claude:work': { args: ['--model', 'opus'] } } }),
      )
      const rt = await createRuntime({ env: { ...h.env, ANTHROPIC_API_KEY: 'leak' }, builtins })
      const r = await rt.resumeLaunch('claude', ['--resume', ID])
      assert.equal(r.account?.ref, 'claude:work')
      assert.equal(r.sessionId, ID)
      assert.equal(r.launch.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.equal(r.launch.env.ANTHROPIC_API_KEY, undefined)
      assert.deepEqual(r.launch.args, ['--model', 'opus', '--resume', ID])
    })
  })

  it('runs the Host unchanged when the session is in the Main Account, nowhere, or an Account is already chosen', async () => {
    await withFakeHome(async (h) => {
      await claudeSession(h, '.claude')
      await h.mkdir('.claude-work/projects')
      const env = { ...h.env, ANTHROPIC_API_KEY: 'kept' }
      const rt = await createRuntime({ env, builtins })
      const main = await rt.resumeLaunch('claude', ['--resume', ID])
      assert.equal(main.account, undefined)
      assert.equal(main.sessionId, ID)
      assert.equal(main.launch.env, env)
      assert.deepEqual(main.launch.args, ['--resume', ID])

      const other = '1b4964a7-fb75-40c0-a9eb-f0755cc54449'
      const none = await rt.resumeLaunch('claude', ['--resume', other])
      assert.equal(none.account, undefined)
      assert.deepEqual(none.launch.args, ['--resume', other])

      await claudeSession(h, '.claude-work')
      const chosen = await createRuntime({ env: { ...env, CLAUDE_CONFIG_DIR: '/picked' }, builtins })
      const kept = await chosen.resumeLaunch('claude', ['--resume', ID])
      assert.equal(kept.account, undefined)
      assert.equal(kept.launch.env.CLAUDE_CONFIG_DIR, '/picked')
    })
  })

  it('picks the Account that wrote the session last when several hold it', async () => {
    await withFakeHome(async (h) => {
      await claudeSession(h, '.claude-a', new Date('2026-10-01T00:00:00Z'))
      await claudeSession(h, '.claude-b', new Date('2026-10-07T00:00:00Z'))
      const rt = await createRuntime({ env: h.env, builtins })
      assert.equal((await rt.resumeLaunch('claude', ['-r', ID])).account?.ref, 'claude:b')
    })
  })

  it('finds Codex rollout files and Grok session directories', async () => {
    await withFakeHome(async (h) => {
      await h.write('.codex-team/AGENTS.md', '# rules\n')
      await h.write(`.codex-team/sessions/2026/10/08/rollout-2026-10-08T09-00-00-${ID}.jsonl`, '{}\n')
      await h.mkdir('.grok-lab/skills')
      await h.mkdir(`.grok-lab/sessions/%2Fwork%2Fapp/${ID}`)
      const rt = await createRuntime({ env: h.env, builtins })
      const codex = await rt.resumeLaunch('codex', ['resume', ID])
      assert.equal(codex.account?.ref, 'codex:team')
      assert.equal(codex.launch.env.CODEX_HOME, h.path('.codex-team'))
      const grok = await rt.resumeLaunch('grok', ['--resume', ID])
      assert.equal(grok.account?.ref, 'grok:lab')
      assert.equal(grok.launch.env.GROK_HOME, h.path('.grok-lab'))
    })
  })

  it('starts a new session in the Account that started a never-saved session (ADR-0009)', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('.claude/projects')
      await claudeStarted(h, '.claude-work')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ accounts: { 'claude:work': { args: ['--model', 'opus'] } } }),
      )
      const rt = await createRuntime({ env: { ...h.env, ANTHROPIC_API_KEY: 'leak' }, builtins })
      const r = await rt.resumeLaunch('claude', ['--dangerously-skip-permissions', '--resume', ID])
      assert.equal(r.newSession, true)
      assert.equal(r.account?.ref, 'claude:work')
      assert.equal(r.sessionId, ID)
      assert.equal(r.launch.env.CLAUDE_CONFIG_DIR, h.path('.claude-work'))
      assert.equal(r.launch.env.ANTHROPIC_API_KEY, undefined)
      assert.deepEqual(r.launch.args, ['--model', 'opus', '--dangerously-skip-permissions'])
    })
  })

  it('starts a new session in the Main Account with the environment kept when it started the session', async () => {
    await withFakeHome(async (h) => {
      await claudeStarted(h, '.claude')
      await h.mkdir('.claude-work/projects')
      const env = { ...h.env, ANTHROPIC_API_KEY: 'kept' }
      const rt = await createRuntime({ env, builtins })
      const r = await rt.resumeLaunch('claude', ['--resume', ID])
      assert.equal(r.newSession, true)
      assert.equal(r.account?.ref, 'claude:main')
      assert.equal(r.launch.env, env)
      assert.deepEqual(r.launch.args, [])
    })
  })

  it('prefers a saved session over a started one, and the newest start among several', async () => {
    await withFakeHome(async (h) => {
      await claudeStarted(h, '.claude-a', new Date('2026-10-07T00:00:00Z'))
      await claudeStarted(h, '.claude-b', new Date('2026-10-08T00:00:00Z'))
      const rt = await createRuntime({ env: h.env, builtins })
      const started = await rt.resumeLaunch('claude', ['--resume', ID])
      assert.equal(started.account?.ref, 'claude:b')
      assert.equal(started.newSession, true)

      await claudeSession(h, '.claude-a')
      const saved = await rt.resumeLaunch('claude', ['--resume', ID])
      assert.equal(saved.account?.ref, 'claude:a')
      assert.equal(saved.newSession, undefined)
      assert.deepEqual(saved.launch.args, ['--resume', ID])
    })
  })

  it('refuses a Family that cannot route sessions', async () => {
    await withFakeHome(async (h) => {
      const rt = await createRuntime({ env: h.env, builtins })
      await assert.rejects(rt.resumeLaunch('pi', ['--resume', ID]), /cannot be routed.*sideby run/)
      await assert.rejects(rt.resumeLaunch('nope', []), /unknown family/)
    })
  })
})
