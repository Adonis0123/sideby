import assert from 'node:assert/strict'
import { symlink, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { Account, ReadContext } from '../../types.ts'
import { readClaudeQuota } from './quota.ts'
import { claudeQuotaCacheFile } from './quota-cache.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')

function ctx(h: FakeHome): ReadContext {
  return { home: h.home, now: NOW, stateDir: h.path('.local/state/sideby'), env: h.env }
}

function acct(h: FakeHome, name: string): Account {
  return {
    family: 'claude',
    name,
    ref: `claude:${name}`,
    dir: name === 'main' ? h.path('.claude') : h.path(`.claude-${name}`),
    isMain: name === 'main',
    kind: 'subscription',
  }
}

async function writeCache(h: FakeHome, name: string, data: unknown): Promise<void> {
  const file = claudeQuotaCacheFile(ctx(h).stateDir, name)
  await h.write(file.slice(h.home.length + 1), JSON.stringify(data))
}

describe('claude quota cache', () => {
  it('is not-enabled without a cache while the status line is not wrapped', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      const r = await readClaudeQuota(acct(h, 'main'), ctx(h))
      assert.equal(r.status === 'unavailable' && r.reason, 'not-enabled')
    })
  })

  it('is no-session without a cache once the status line is wrapped', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.claude/settings.json',
        JSON.stringify({ statusLine: { type: 'command', command: 'sideby statusline-tap' } }),
      )
      await h.mkdir('.claude-work')
      await symlink(h.path('.claude/settings.json'), h.path('.claude-work/settings.json'))
      for (const name of ['main', 'work']) {
        const r = await readClaudeQuota(acct(h, name), ctx(h))
        assert.equal(r.status === 'unavailable' && r.reason, 'no-session', name)
      }
    })
  })

  it('is not-enabled for an account with its own unwrapped settings.json', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.claude/settings.json',
        JSON.stringify({ statusLine: { command: 'sideby statusline-tap' } }),
      )
      await h.write('.claude-own/settings.json', '{}')
      const r = await readClaudeQuota(acct(h, 'own'), ctx(h))
      assert.equal(r.status, 'unavailable')
      if (r.status === 'unavailable') {
        assert.equal(r.reason, 'not-enabled')
        assert.match(r.detail ?? '', /not shared/)
      }
    })
  })

  it('returns cached windows, keeping ones already past resetsAt', async () => {
    await withFakeHome(async (h) => {
      const windows = [
        { label: '5h', windowMinutes: 300, usedPercent: 42.4, resetsAt: '2026-10-05T10:00:00.000Z' },
        { label: '7d', windowMinutes: 10080, usedPercent: 10, resetsAt: '2026-10-11T12:00:00.000Z' },
      ]
      await writeCache(h, 'work', { version: 1, observedAt: '2026-10-05T09:00:00.000Z', windows })
      const r = await readClaudeQuota(acct(h, 'work'), ctx(h))
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      assert.deepEqual(r.windows, windows)
      assert.equal(r.observedAt, '2026-10-05T09:00:00.000Z')
      const expired = r.windows.filter((w) => Date.parse(w.resetsAt) <= NOW.getTime())
      assert.deepEqual(
        expired.map((w) => w.label),
        ['5h'],
      )
    })
  })

  it('reports unrecognized for a damaged cache', async () => {
    await withFakeHome(async (h) => {
      const file = claudeQuotaCacheFile(ctx(h).stateDir, 'main')
      await h.write(file.slice(h.home.length + 1), '{')
      const bad = await readClaudeQuota(acct(h, 'main'), ctx(h))
      assert.equal(bad.status === 'unavailable' && bad.reason, 'unrecognized')
      await writeFile(
        file,
        JSON.stringify({ observedAt: '2026-10-05T09:00:00.000Z', windows: [{ label: '5h' }] }),
      )
      const empty = await readClaudeQuota(acct(h, 'main'), ctx(h))
      assert.equal(empty.status === 'unavailable' && empty.reason, 'unrecognized')
    })
  })
})
