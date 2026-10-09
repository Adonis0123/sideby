// Finishing the Handoff Brief (spec §3.17): where its text comes from, the repository state, the file mode, and a
// first prompt that carries only the path.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { firstPrompt } from '../handoff/messages.ts'
import { ASSEMBLED_NOTE, finishBrief, gitSection } from './handoff-brief.ts'

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

describe('gitSection', () => {
  it('lists the branch and uncommitted files in a repository, and is empty elsewhere', async () => {
    await withFakeHome(async (h) => {
      const repo = h.path('repo')
      await h.write('repo/a.txt', 'a\n')
      execFileSync('git', ['init', '-q', '-b', 'feat/x', repo], { env: gitEnv })
      const text = await gitSection(repo)
      assert.match(text, /Repository state/)
      assert.match(text, /\?\? a\.txt/)
      assert.equal(await gitSection(h.path('.')), '')
    })
  })
})

describe('finishBrief', () => {
  it('keeps the session’s Brief at the target, adds nothing else outside a repository, mode 600', async () => {
    await withFakeHome(async (h) => {
      const target = await h.write('chain/1-claude-001.md', '# Goal\nShip it\n')
      const r = await finishBrief({ target, ready: {}, assembled: 'unused', cwd: h.path('.') })
      assert.equal(r.source, 'agent')
      assert.equal(await readFile(target, 'utf8'), '# Goal\nShip it\n')
      assert.equal((await stat(target)).mode & 0o777, 0o600)
    })
  })

  it('uses the user’s Brief named in ready, then sideby’s assembly with a warning', async () => {
    await withFakeHome(async (h) => {
      const mine = await h.write('mine.md', 'my notes\n')
      const target = h.path('chain/1.md')
      await h.write('chain/.keep', '')
      assert.equal(
        (await finishBrief({ target, ready: { brief: mine, briefSource: 'user' }, cwd: h.path('.') })).source,
        'user',
      )
      assert.equal(await readFile(target, 'utf8'), 'my notes\n')
      const other = h.path('chain/2.md')
      const r = await finishBrief({ target: other, ready: {}, assembled: '## Task\nX\n', cwd: h.path('.') })
      assert.equal(r.source, 'sideby')
      const text = await readFile(other, 'utf8')
      assert.ok(text.startsWith(ASSEMBLED_NOTE))
      assert.match(text, /## Task/)
    })
  })
})

describe('firstPrompt', () => {
  it('names the previous account and the Brief path, not its text', () => {
    const p = firstPrompt('claude:001', '/state/handoffs/c/2-claude-002.md')
    assert.match(p, /claude:001/)
    assert.match(p, /\/state\/handoffs\/c\/2-claude-002\.md/)
  })
})
