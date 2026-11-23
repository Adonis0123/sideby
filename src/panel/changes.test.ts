import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quotaWatchDirs } from '../families/quota-watch.ts'
import { changeClock, stateQuotaDir } from './changes.ts'

/** Timers driven by hand: `at(ms)` runs every timer due by then. */
function fakeTimers() {
  let now = 0
  let id = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    set: (fn: () => void, ms: number) => {
      due.set(++id, { at: now + ms, fn })
      return id
    },
    clear: (t: unknown) => void due.delete(t as number),
    at(ms: number) {
      for (;;) {
        const next = [...due].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > ms) break
        due.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = ms
    },
  }
}

describe('Panel change feed (spec §3.45, ADR-0084)', () => {
  it('counts a burst of events once, about 300 ms after the first', () => {
    const t = fakeTimers()
    const fired: number[] = []
    const clock = changeClock(() => fired.push(t.now()), t)
    clock.poke(1000)
    t.at(100)
    clock.poke(1000)
    t.at(1000)
    assert.deepEqual(fired, [300])
  })

  it('keeps each folder to its own gap, and a quick folder brings a slow one forward', () => {
    const t = fakeTimers()
    const fired: number[] = []
    const clock = changeClock(() => fired.push(t.now()), t)
    clock.poke(5000)
    t.at(400)
    // A session record again right after: not before 5 s after the last change.
    clock.poke(5000)
    t.at(2000)
    assert.deepEqual(fired, [300])
    // The status line cache changes meanwhile: it may count a second after the last change.
    clock.poke(1000)
    t.at(10_000)
    assert.deepEqual(fired, [300, 2300])
  })

  it('never counts sideby’s own locks, runs, records or temporary files under <state>/quota', () => {
    const { match } = stateQuotaDir('/state')
    for (const name of ['claude/main.json', 'codex/team.fetched.json', 'grok/lab.fetched.json'])
      assert.equal(match.test(name), true, name)
    for (const name of [
      'asking/0.lock',
      'claude-run/settings.json',
      'limit-reset/op-1.json',
      'claude/.main.json.sideby-0a1b2c.tmp',
      'claude/.main.json',
    ])
      assert.equal(match.test(name), false, name)
  })

  it('watches only the rollout files of Codex and the Quota log of Grok', () => {
    const acct = (family: string) => ({
      family,
      name: 'main',
      ref: `${family}:main`,
      dir: `/home/.${family}`,
      isMain: true,
      kind: 'subscription' as const,
    })
    const [codex, grok, ...rest] = quotaWatchDirs([acct('codex'), acct('grok'), acct('claude'), acct('pi')])
    assert.equal(rest.length, 0)
    assert.equal(codex?.dir, '/home/.codex/sessions')
    assert.equal(codex?.match.test('2026/11/23/rollout-2026-11-23T10-00-00-abc.jsonl'), true)
    assert.equal(codex?.match.test('2026/11/23/history.jsonl'), false)
    assert.equal(grok?.dir, '/home/.grok/logs')
    assert.equal(grok?.match.test('unified.jsonl'), true)
    assert.equal(grok?.match.test('other.jsonl'), false)
  })
})
