// Using a Codex Limit Reset (spec §3.40, ADR-0072), against a scripted fake `codex app-server` only: the plan, the
// four outcomes, every way an answer can go missing, and what is kept on disk.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fakeHost, withFakeHome } from '../../../testing/index.ts'
import { listLimitResetRecords } from '../../core/limit-reset.ts'
import {
  checked,
  cli,
  cliSpawn,
  consumes,
  hostState,
  SECRET,
  setMode,
  setState,
  setup,
  USER,
  WS_A,
} from './limit-reset-test-helpers.ts'

describe('sideby quota reset', () => {
  it('shows the plan and exits 10; --yes uses one and exits 0; both print schema-valid JSON', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const plan = await cli(h, ['quota', 'reset', 'codex:main', '--json'])
      assert.equal(plan.status, 10, plan.stderr)
      const p = checked(plan.stdout, 'quota-reset')
      assert.equal(p.schemaVersion, 1)
      assert.equal(p.confirmationRequired, true)
      assert.match(p.operationId, /^lr-/)
      assert.deepEqual(p.sameLogin, ['codex:work'])
      assert.equal(p.limitResets.available, 1)
      assert.equal(p.expectedAfter, 0)
      assert.deepEqual(await consumes(h), [], 'the plan sends nothing')
      // In words: the windows, the count, that it cannot be undone, and the command that confirms.
      const text = await cli(h, ['quota', 'reset', 'codex:main'])
      assert.equal(text.status, 10)
      assert.match(text.stdout, /Also applies to: codex:work/)
      assert.match(text.stdout, /5h\s+72% used · resets/)
      assert.match(text.stdout, /1 available → 0 expected afterwards · the next one expires/)
      assert.match(text.stdout, /cannot be undone/)
      assert.match(text.stdout, /sideby quota reset codex:main --yes --operation lr-/)
      assert.deepEqual(await consumes(h), [])

      const used = await cli(h, [
        'quota',
        'reset',
        'codex:main',
        '--yes',
        '--operation',
        p.operationId,
        '--json',
      ])
      assert.equal(used.status, 0, used.stderr)
      const u = checked(used.stdout, 'quota-reset')
      assert.equal(u.outcome, 'reset')
      assert.equal(u.operationId, p.operationId)
      assert.equal(u.quota.windows[0].usedPercent, 0)
      assert.equal(u.quota.limitResets.available, 0)
      assert.equal((await consumes(h)).length, 1)
      for (const out of [plan.stdout, text.stdout, used.stdout, used.stderr])
        for (const no of [SECRET, WS_A, USER]) assert.equal(out.includes(no), false)

      // Nothing left: --yes reads the plan first, sees there is none, and sends nothing. Exit 1, with what to know.
      const none = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(none.status, 1)
      const e = checked(none.stdout, 'error')
      assert.equal(e.code, 'cannot-use')
      assert.match(e.error, /holds no limit reset; nothing was sent/)
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('exits 1 with "nothing was spent" for an answer that used none, and never asks twice by itself', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await setMode(h, 'nothing')
      const r = await cliSpawn(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(r.status, 1)
      const v = checked(r.stdout, 'quota-reset')
      assert.equal(v.outcome, 'nothing-to-reset')
      assert.match(v.message, /Nothing was spent/)
      assert.equal((await consumes(h)).length, 1)
    })
  })

  it('carries the operation in a failure, so the next --yes repeats the same request and not a new one', async () => {
    await withFakeHome(async (h) => {
      await setup(h, { credits: 2 })
      await setMode(h, 'lost')
      const lost = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'])
      assert.equal(lost.status, 1)
      const e = checked(lost.stdout, 'error')
      assert.equal(e.schemaVersion, 1)
      assert.equal(e.code, 'outcome-unknown')
      assert.equal(typeof e.error, 'string')
      assert.match(e.operationId, /^lr-/)
      assert.match(e.error, new RegExp(`sideby quota reset codex:main --yes --operation ${e.operationId}`))
      // Another process, with a bare --yes for the other account of the login: the unresolved one is resumed.
      await setMode(h, 'reset')
      const plan = checked((await cli(h, ['quota', 'reset', 'codex:work', '--json'])).stdout, 'quota-reset')
      assert.equal(plan.unresolved, true)
      assert.equal(plan.operationId, e.operationId)
      const again = await cli(h, ['quota', 'reset', 'codex:work', '--yes', '--json'])
      assert.equal(again.status, 0, again.stderr)
      const v = checked(again.stdout, 'quota-reset')
      assert.equal(v.outcome, 'already-done')
      assert.equal(v.resumed, true)
      assert.equal(v.operationId, e.operationId)
      const calls = await consumes(h)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]!.key, calls[1]!.key)
      assert.equal((await hostState(h)).spends, 1)
    })
  })

  it('refuses in CI and for a session under Unattended Mode, and rejects flags that do not belong', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const ci = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'], { CI: 'true' })
      assert.equal(ci.status, 1)
      assert.match(checked(ci.stdout, 'error').error, /off in CI/)
      const un = await cli(h, ['quota', 'reset', 'codex:main', '--yes', '--json'], {
        SIDEBY_ACCOUNT: 'codex:main',
        SIDEBY_UNATTENDED: '1',
      })
      assert.equal(un.status, 1)
      assert.match(checked(un.stdout, 'error').error, /Unattended Mode is on/)
      assert.deepEqual(await consumes(h), [])
      assert.equal(
        (await cli(h, ['quota', 'reset', 'codex:main', '--operation', 'lr-zzzzzzzz-00000000'])).status,
        2,
      )
      assert.equal((await cli(h, ['quota', 'reset'])).status, 2)
      assert.equal((await cli(h, ['quota', '--open'])).status, 2)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('for Claude Code prints the vendor page and its purpose, and for a tool with neither says what to do', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      await h.write('.claude/settings.json', '{}\n')
      await h.write(
        '.claude.json',
        JSON.stringify({ oauthAccount: { accountUuid: 'fake-uuid', emailAddress: 'me@example.com' } }),
        0o600,
      )
      await h.write('.grok/skills/x.md', 'x\n')
      await fakeHost(h, 'claude')
      const r = await cli(h, ['quota', 'reset', 'claude:main', '--json'])
      assert.equal(r.status, 0, r.stderr)
      const v = checked(r.stdout, 'quota-reset')
      assert.equal(v.outcome, 'open-vendor-page')
      assert.equal(v.url, 'https://claude.ai/settings/usage')
      assert.equal(v.opened, false)
      assert.equal(v.identity.email, 'me@example.com')
      assert.match(v.message, /cannot see whether claude:main holds one/)
      const text = await cli(h, ['quota', 'reset', 'claude:main'])
      assert.equal(text.status, 0)
      assert.match(text.stdout, /https:\/\/claude\.ai\/settings\/usage/)
      assert.match(text.stdout, /signed in as me@example\.com/)
      assert.match(text.stdout, /sideby quota reset claude:main --open/)
      // There is nothing to confirm on a page sideby only opens.
      const yes = await cli(h, ['quota', 'reset', 'claude:main', '--yes', '--json'])
      assert.equal(yes.status, 1)
      assert.equal(checked(yes.stdout, 'error').code, 'no-limit-reset')
      const grok = await cli(h, ['quota', 'reset', 'grok:main', '--json'])
      assert.equal(grok.status, 1)
      const e = checked(grok.stdout, 'error')
      assert.equal(e.code, 'no-limit-reset')
      assert.match(e.error, /check the vendor's own usage page/)
      assert.deepEqual(await consumes(h), [])
    })
  })

  it('`menubar reset` only opens the Panel on that account’s confirmation: it reads no plan and uses nothing', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      // The browser is a fake that writes down what it was asked to open.
      const opened = join(h.bin, 'open.log')
      await writeFile(join(h.bin, 'open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 })
      await writeFile(join(h.bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 })
      try {
        const r = await cli(h, ['menubar', 'reset', 'codex:work', '--json'])
        assert.equal(r.status, 0, r.stderr)
        const v = checked(r.stdout, 'menubar-reset')
        assert.equal(v.account, 'codex:work')
        assert.equal(v.opened, true)
        assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/#reset=codex%3Awork$/)
        assert.equal((await readFile(opened, 'utf8')).trim(), v.url)
        assert.deepEqual(await consumes(h), [])
        assert.deepEqual(await listLimitResetRecords(h.path('.local/state/sideby')), [])
        assert.equal((await cli(h, ['menubar', 'reset'])).status, 2)
      } finally {
        await cli(h, ['ui', '--stop'])
      }
    })
  })

  it('shows "Use a reset…" in the menu snapshot only where there is something to use', async () => {
    await withFakeHome(async (h) => {
      await setup(h)
      const snap = checked(
        (await cli(h, ['menubar', 'snapshot', '--json', '--refresh'])).stdout,
        'menubar-snapshot',
      )
      const rows = snap.sections.flatMap((s: { rows: unknown[]; more?: { rows: unknown[] } | null }) => [
        ...s.rows,
        ...(s.more?.rows ?? []),
      ]) as { ref: string; useReset?: { title: string; tip: string } }[]
      const by = Object.fromEntries(rows.map((r) => [r.ref, r.useReset?.title]))
      // One line for the login that holds one (not on its Same Login's line too); none where none is held.
      assert.equal(by['codex:main'], 'Use a reset…')
      assert.equal(by['codex:work'], undefined)
      assert.deepEqual(await consumes(h), [], 'drawing the menu uses nothing')
      await setState(h, { credits: 0 })
      const after = JSON.parse(
        (await cli(h, ['menubar', 'snapshot', '--json', '--ask', 'codex:main'])).stdout,
      )
      const again = after.sections.flatMap((s: { rows: { ref: string; useReset?: object }[] }) => s.rows)
      assert.equal(again.find((r: { ref: string }) => r.ref === 'codex:main').useReset, undefined)
      assert.deepEqual(await consumes(h), [])
    })
  })
})
