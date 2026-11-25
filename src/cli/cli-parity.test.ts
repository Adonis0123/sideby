import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import { checkSchema, codexMain, sideby, sidebySpawn } from './cli-test-helpers.ts'

describe('Panel CLI parity', () => {
  it('pins a Same Login once, preserves order, prunes stale names and enforces the limit', async () => {
    await withFakeHome(async (h) => {
      for (const name of ['main', 'work', 'team', 'lab', 'extra']) {
        const dir = name === 'main' ? '.claude' : `.claude-${name}`
        await h.write(`${dir}/settings.json`, '{}')
        const email = ['main', 'work'].includes(name) ? 'me@example.com' : `${name}@example.com`
        await h.write(
          name === 'main' ? '.claude.json' : `${dir}/.claude.json`,
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
          0o600,
        )
      }
      await fakeHost(h, 'claude')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({
          aliases: { cx: 'claude:work' },
          display: {
            families: ['claude'],
            accounts: { claude: ['lab', 'main'] },
            pinned: { claude: ['gone'] },
          },
        }),
      )
      const hostDirs = ['.claude', '.claude-work', '.claude-team', '.claude-lab', '.claude-extra']
      const before = await Promise.all(hostDirs.map((dir) => snapshot(h.path(dir))))
      const loginBefore = await readFile(h.path('.claude.json'), 'utf8')
      const pin = await sidebySpawn(h, ['pin', 'cx', '--json'])
      assert.equal(pin.code, 0, pin.out)
      const data = checkSchema('pin', pin.out)
      assert.equal(data.changed, true)
      let config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(new Set(config.display.pinned.claude), new Set(['main', 'work']))
      assert.deepEqual(config.display.accounts.claude, ['lab', 'main'])
      assert.deepEqual(config.display.families, ['claude'])
      assert.equal(checkSchema('pin', (await sideby(h, ['pin', 'claude:main', '--json'])).out).changed, false)
      for (const name of ['team', 'lab']) assert.equal((await sideby(h, ['pin', `claude:${name}`])).code, 0)
      const full = await sideby(h, ['pin', 'claude:extra', '--json'])
      assert.equal(full.code, 1)
      assert.match(String(checkSchema('error', full.out).error), /unpin/i)
      const unpin = await sidebySpawn(h, ['unpin', 'cx', '--json'])
      assert.equal(unpin.code, 0)
      assert.equal(checkSchema('unpin', unpin.out).pinned, false)
      config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(config.display.pinned.claude, ['team', 'lab'])
      const noop = await sideby(h, ['unpin', 'cx'])
      assert.equal(noop.code, 0)
      assert.match(noop.out, /not pinned/i)
      const missing = await sideby(h, ['pin', 'claude:missing', '--json'])
      assert.equal(missing.code, 1)
      checkSchema('error', missing.out)
      for (const [i, dir] of hostDirs.entries())
        assert.deepEqual(diffSnapshots(before[i]!, await snapshot(h.path(dir))), [])
      assert.equal(await readFile(h.path('.claude.json'), 'utf8'), loginBefore)
    })
  })

  it('hides a Same Login or a Family from list and the menu bar, keeps it in --json and through a reset', async () => {
    await withFakeHome(async (h) => {
      for (const name of ['main', 'work', 'old']) {
        const dir = name === 'main' ? '.claude' : `.claude-${name}`
        await h.write(`${dir}/settings.json`, '{}')
        const email = name === 'old' ? 'old@example.com' : 'me@example.com'
        await h.write(
          name === 'main' ? '.claude.json' : `${dir}/.claude.json`,
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
          0o600,
        )
      }
      await fakeHost(h, 'claude')
      await codexMain(h)
      await fakeHost(h, 'codex')
      const hostDirs = ['.claude', '.claude-work', '.claude-old', '.codex']
      const before = await Promise.all(hostDirs.map((dir) => snapshot(h.path(dir))))
      const hide = await sidebySpawn(h, ['hide', 'claude:work', '--json'])
      assert.equal(hide.code, 0, hide.out)
      const data = checkSchema('hide', hide.out)
      assert.equal(data.kind, 'account')
      assert.equal(data.changed, true)
      let config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      // The Same Login of main and work is hidden whole.
      assert.deepEqual(new Set(config.display.hidden.claude), new Set(['main', 'work']))
      assert.equal(
        checkSchema('hide', (await sideby(h, ['hide', 'claude:main', '--json'])).out).changed,
        false,
      )
      const text = await sideby(h, ['list'])
      assert.equal(text.code, 0)
      assert.doesNotMatch(text.out, /claude:main|claude:work/)
      assert.match(text.out, /claude:old/)
      assert.match(text.out, /2 hidden; sideby list --all/)
      assert.match((await sideby(h, ['list', '--all'])).out, /claude:work.*\(hidden\)/)
      const listed = checkSchema('list', (await sideby(h, ['list', '--json'])).out) as {
        accounts: { ref: string; hidden?: true }[]
      }
      assert.deepEqual(
        listed.accounts
          .filter((x) => x.hidden)
          .map((x) => x.ref)
          .sort(),
        ['claude:main', 'claude:work'],
      )
      const hideFamily = checkSchema('hide', (await sideby(h, ['hide', 'codex', '--json'])).out)
      assert.equal(hideFamily.kind, 'family')
      const menu = checkSchema('menubar-snapshot', (await sideby(h, ['menubar', 'snapshot', '--json'])).out)
      const refs = JSON.stringify(menu)
      assert.doesNotMatch(refs, /claude:work|codex:main/)
      assert.match(refs, /claude:old/)
      const order = checkSchema('order', (await sidebySpawn(h, ['order', '--reset', '--json'])).out)
      assert.deepEqual((order.display as { hiddenFamilies?: string[] }).hiddenFamilies, ['codex'])
      assert.ok(
        (order.families as { family: string; hidden: boolean }[]).find((f) => f.family === 'codex')?.hidden,
      )
      const blocked = await sidebySpawn(h, ['unhide', 'codex:main', '--json'])
      assert.equal(blocked.code, 1)
      assert.match(String(checkSchema('error', blocked.out).error), /sideby unhide codex/)
      assert.equal((await sideby(h, ['unhide', 'codex'])).code, 0)
      assert.equal((await sideby(h, ['unhide', 'claude:work'])).code, 0)
      config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.equal(config.display, undefined)
      for (const [i, dir] of hostDirs.entries())
        assert.deepEqual(diffSnapshots(before[i]!, await snapshot(h.path(dir))), [])
    })
  })

  it('shows empty families, sets orders, and resets while keeping pins', async () => {
    await withFakeHome(async (h) => {
      const empty = await sideby(h, ['order', '--json'])
      assert.equal(empty.code, 0)
      const initial = checkSchema('order', empty.out)
      assert.deepEqual(initial.display, {})
      // Desktop app groups (Grok Bot) depend on the apps this machine has installed; check the tools only.
      const tools = (initial.families as { family: string; accounts: unknown[] }[]).filter((f) =>
        ['claude', 'codex', 'grok', 'pi'].includes(f.family),
      )
      assert.equal(tools.length, 4)
      assert.ok(tools.every((f) => f.accounts.length === 0))
      assert.equal((await sideby(h, ['order', 'codex', 'work'])).code, 1)
      await codexMain(h)
      await h.write('.codex-work/config.toml', '')
      await fakeHost(h, 'codex')
      assert.equal((await sideby(h, ['pin', 'codex:main'])).code, 0)
      assert.equal((await sideby(h, ['order', 'codex', 'work', 'main'])).code, 0)
      assert.equal((await sideby(h, ['order', '--families', 'codex', 'claude'])).code, 0)
      const shown = checkSchema('order', (await sideby(h, ['order', '--json'])).out)
      assert.deepEqual(shown.display, {
        families: ['codex', 'claude'],
        accounts: { codex: ['work', 'main'] },
        pinned: { codex: ['main'] },
      })
      assert.match((await sideby(h, ['order'])).out, /main.*pinned/)
      const before = await readFile(h.path('.config/sideby/config.json'), 'utf8')
      const bad = await sideby(h, ['order', 'codex', 'missing', 'other', '--json'])
      assert.equal(bad.code, 1)
      assert.match(String(checkSchema('error', bad.out).error), /missing.*other/)
      assert.equal((await sideby(h, ['order', '--families', 'missing'])).code, 1)
      assert.equal((await sideby(h, ['order', 'codex', 'main', 'main'])).code, 2)
      assert.equal((await sideby(h, ['order', '--families', 'codex', 'codex'])).code, 2)
      assert.equal(await readFile(h.path('.config/sideby/config.json'), 'utf8'), before)
      const reset = await sideby(h, ['order', '--reset', '--json'])
      assert.equal(reset.code, 0)
      assert.deepEqual(checkSchema('order', reset.out).display, { pinned: { codex: ['main'] } })
    })
  })

  it('sets quota checks and Auto Update without touching Host files', async () => {
    await withFakeHome(async (h) => {
      for (const on of ['off', 'on']) {
        const r = await sideby(h, ['quota', 'check', 'grok', on, '--json'])
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('quota-check', r.out).on, on === 'on')
        const cfg = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.equal(cfg.quota?.check?.grok !== false, on === 'on')
      }
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ update: { check: false }, aliases: { cx: 'codex:main' } }),
      )
      for (const on of ['on', 'off']) {
        const r = await sideby(h, ['update', '--auto', on, '--json'])
        assert.equal(r.code, 0, r.out)
        assert.equal(checkSchema('update-auto', r.out).auto, on === 'on')
        const cfg = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(cfg.update, { check: false, auto: on === 'on' })
        assert.deepEqual(cfg.aliases, { cx: 'codex:main' })
      }
      for (const args of [
        ['quota', 'check', 'missing', 'on'],
        ['quota', 'check', 'pi', 'off'],
        ['update', '--auto', 'maybe'],
        ['order', '--reset', 'codex'],
      ]) {
        const r = await sideby(h, [...args, '--json'])
        assert.notEqual(r.code, 0)
        checkSchema('error', r.out)
      }
      const status = await sideby(h, ['handoff', 'status', '--json'])
      assert.equal(status.code, 0)
      const overview = checkSchema('handoff-status', status.out).overview as {
        takeover: unknown[]
        recent: unknown[]
      }
      assert.deepEqual(overview.takeover, [])
      assert.deepEqual(overview.recent, [])
      await codexMain(h)
      await fakeHost(h, 'codex')
      await h.write('.config/sideby/config.json', JSON.stringify({ handoff: { auto: true } }))
      await h.write(
        '.local/state/sideby/handoffs/example/chain.json',
        JSON.stringify({
          hops: [
            { ref: 'codex:main', trigger: 'threshold', briefSource: 'agent' },
            { ref: 'claude:work', startedAt: '2026-10-17T00:00:00Z', brief: 'must not be returned' },
          ],
        }),
      )
      const enabled = await sideby(h, ['handoff', 'status', '--json'])
      assert.equal(enabled.code, 0)
      const active = checkSchema('handoff-status', enabled.out).overview as {
        takeover: { ref: string; decision: { kind: string } }[]
        recent: unknown[]
      }
      assert.equal(active.takeover[0]?.ref, 'codex:main')
      assert.equal(active.takeover[0]?.decision.kind, 'none')
      assert.deepEqual(active.recent, [
        {
          from: 'codex:main',
          to: 'claude:work',
          at: '2026-10-17T00:00:00Z',
          trigger: 'threshold',
          briefSource: 'agent',
        },
      ])
      assert.doesNotMatch(enabled.out, /must not be returned/)

      // The Handoff Rules (ADR-0046): every rule with the settings that change it, and the `handoff enable` switches
      // (`--other-ai`, `--ai-order`, `--api`).
      const rules = await sideby(h, ['handoff', 'rules', '--json'])
      assert.equal(rules.code, 0, rules.out)
      const view = checkSchema('handoff-rules', rules.out) as {
        auto: boolean
        rules: { id: string; settings: string[] }[]
        apiUndecided: boolean
      }
      assert.equal(view.auto, true)
      assert.equal(view.apiUndecided, false)
      assert.deepEqual(view.rules.find((r) => r.id === 'api')?.settings, ['api'])
      const preview = await sideby(h, [
        'handoff',
        'enable',
        '--other-ai',
        '--ai-order',
        'codex,claude',
        '--api',
        '--json',
      ])
      assert.equal(preview.code, 10, preview.out)
      const shown = checkSchema('handoff-enable', preview.out) as {
        applied: boolean
        settings: { otherFamilies: boolean; familyOrder: string[]; api: boolean }
      }
      assert.equal(shown.applied, false)
      assert.deepEqual(
        [shown.settings.otherFamilies, shown.settings.familyOrder, shown.settings.api],
        [true, ['codex', 'claude'], true],
      )
      const bad = await sideby(h, ['handoff', 'enable', '--ai-order', 'nope', '--json'])
      assert.notEqual(bad.code, 0)
      checkSchema('error', bad.out)
    })
  })
})
