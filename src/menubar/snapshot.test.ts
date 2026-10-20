// What the Menu Bar Item shows (spec §3.31): the title, each row and the language, from given Handoff plans.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planHandoff } from '../core/handoff.ts'
import type { QuotaResult } from '../types.ts'
import {
  type MenubarFamilyInput,
  menubarHotkey,
  menubarLang,
  menubarSnapshot,
  untilText,
} from './snapshot.ts'
import { MENUBAR_STRINGS } from './strings.ts'

const NOW = new Date('2026-10-19T12:00:00Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60000).toISOString()

function quota(h5: number, d7: number, resets = 125): QuotaResult {
  return {
    status: 'ok',
    windows: [
      { label: '5h', windowMinutes: 300, usedPercent: h5, resetsAt: at(resets) },
      { label: '7d', windowMinutes: 10080, usedPercent: d7, resetsAt: at(resets + 3000) },
    ],
    observedAt: NOW.toISOString(),
    source: 'test',
  }
}
const none: QuotaResult = { status: 'unavailable', reason: 'no-session' }

type Acc = MenubarFamilyInput['accounts'][number]
const sub = (name: string, q: QuotaResult, family = 'claude'): Acc => ({
  ref: `${family}:${name}`,
  name,
  kind: 'subscription',
  login: 'logged-in',
  quota: q,
})

function family(id: string, title: string, accounts: Acc[]): MenubarFamilyInput {
  const candidates = accounts.map((a) => ({ ...a, isMain: a.name === 'main' }))
  return { id, title, plan: planHandoff(id, candidates, NOW), accounts }
}

it('carries each Family logo path and brand colour, without its title', () => {
  const f = { ...family('grok', 'Grok', []), accounts: [sub('main', quota(1, 1), 'grok')] }
  const logo = { path: 'M0 0h24v24H0Z', fillRule: 'evenodd' as const, color: '#000000', title: 'Grok' }
  const snap = menubarSnapshot(
    [
      { ...f, logo },
      { ...f, id: 'x', logo: null },
    ],
    NOW,
    'en',
  )
  assert.deepEqual(
    snap.sections.map((s) => s.logo),
    [{ path: 'M0 0h24v24H0Z', fillRule: 'evenodd', color: '#000000' }, null],
  )
})

describe('menubarSnapshot', () => {
  it('dates quota observations independently of repeated successful snapshot checks', () => {
    const old = { ...quota(59, 68), observedAt: at(-120) }
    const input = [family('codex', 'Codex', [sub('main', old, 'codex')])]
    for (const now of [NOW, new Date(NOW.getTime() + 60000)]) {
      const snap = menubarSnapshot(input, now, 'en')
      const row = snap.sections[0]!.rows[0]!
      assert.equal(row.observedAt, at(-120))
      assert.equal(row.stale, true)
      assert.match(row.detail, /older reading/)
      assert.match(row.tip, /2026-10-19T10:00:00.000Z/)
      assert.equal(row.bars?.[1]?.percent, 68)
      assert.match(snap.labels.updatedJustNow, /Checked/)
      assert.equal(snap.card?.status, 'Quota needs refreshing')
    }
  })

  it('marks a failed query stale even when the last successful quota is recent', () => {
    const q = { ...quota(1, 2), fetchError: 'Could not query; refresh to try again' }
    const row = menubarSnapshot([family('codex', 'Codex', [sub('main', q, 'codex')])], NOW, 'en').sections[0]!
      .rows[0]!
    assert.equal(row.stale, true)
    assert.match(row.tip, /Could not query/)
    assert.match(row.detail, /older reading/)
  })

  it('marks unreadable observation times stale and fresh observations current', () => {
    for (const [observedAt, stale] of [
      ['invalid', true],
      [at(120), true],
      [NOW.toISOString(), false],
    ] as const) {
      const q = { ...quota(1, 2), observedAt }
      const row = menubarSnapshot([family('codex', 'Codex', [sub('main', q, 'codex')])], NOW, 'zh')
        .sections[0]!.rows[0]!
      assert.equal(row.stale, stale)
    }
  })

  it('titles each Family by the account sideby would pick and shows the highest', () => {
    const snap = menubarSnapshot(
      [
        family('claude', 'Claude Code', [sub('main', quota(90, 40)), sub('work', quota(20, 30))]),
        family('codex', 'Codex', [sub('main', quota(65, 10), 'codex')]),
      ],
      NOW,
      'en',
    )
    // Claude's pick is work (30%), Codex's only account is at 65%: the title is the tighter tool.
    assert.equal(snap.title, 'Codex 65%')
    assert.equal(snap.level, 'warn')
    assert.match(snap.tooltip, /^Codex is running low: even its best account \(codex:main\) has used 65%/)
    assert.equal(snap.headline, 'Codex is running low · codex:main is at 65%')
    assert.deepEqual(snap.card, {
      status: 'Codex is running low',
      detail: 'codex:main is at 65% · switch tools or wait',
      level: 'warn',
    })
    // Each tool names its windows once, over the bar columns.
    assert.deepEqual(snap.sections[0]!.columns, ['5h', '7d'])
    // The recommended account comes first; the others keep Display Order.
    const rows = snap.sections[0]!.rows
    assert.deepEqual(
      rows.map((r) => [r.label, r.recommended, r.level]),
      [
        ['work', true, 'ok'],
        ['main', false, 'fail'],
      ],
    )
    assert.equal(rows[0]!.detail, '5h 20% · 7d 30% · resets in 2d 4h')
    assert.deepEqual(rows[0]!.bars, [
      { label: '5h', percent: 20, level: 'ok' },
      { label: '7d', percent: 30, level: 'ok' },
    ])
    assert.equal(rows[0]!.reset, '2d 4h')
    assert.equal(rows[0]!.note, '')
    assert.equal(
      rows[1]!.tip,
      'Quota recorded at 2026-10-19T12:00:00.000Z\n5h resets in 2h 5m\n7d resets in 2d 4h\nStart claude:main in your terminal',
    )
  })

  it('shows the fullest of the longer windows when there are three, so a used-up one is not hidden', () => {
    const three: QuotaResult = {
      status: 'ok',
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: at(60) },
        { label: '1d', windowMinutes: 1440, usedPercent: 99, resetsAt: at(600) },
        { label: '7d', windowMinutes: 10080, usedPercent: 20, resetsAt: at(6000) },
      ],
      observedAt: NOW.toISOString(),
      source: 'test',
    }
    const r = menubarSnapshot([family('claude', 'Claude Code', [sub('main', three)])], NOW, 'en').sections[0]!
      .rows[0]!
    assert.deepEqual(
      r.bars?.map((b) => b && [b.label, b.percent, b.level]),
      [
        ['5h', 10, 'ok'],
        ['1d', 99, 'fail'],
      ],
    )
  })

  it('puts a single window in the second bar column, so long windows line up across Families', () => {
    const one: QuotaResult = {
      status: 'ok',
      windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 62, resetsAt: at(90) }],
      observedAt: NOW.toISOString(),
      source: 'test',
    }
    const snap = menubarSnapshot([family('codex', 'Codex', [sub('main', one, 'codex')])], NOW, 'en')
    const r = snap.sections[0]!.rows[0]!
    assert.deepEqual(r.bars, [null, { label: '7d', percent: 62, level: 'warn' }])
    assert.deepEqual(snap.sections[0]!.columns, [null, '7d'])
    assert.equal(r.reset, '1h 30m')
  })

  it('shows the least used account when every account of a Family is past the fail level, in red', () => {
    const snap = menubarSnapshot(
      [family('claude', 'Claude Code', [sub('main', quota(100, 50)), sub('work', quota(20, 91))])],
      NOW,
      'zh',
    )
    assert.equal(snap.title, 'Claude Code 91%')
    assert.equal(snap.level, 'fail')
    assert.equal(snap.headline, 'Claude Code 额度告急 · 首选 claude:work 已用 91%')
    const rows = snap.sections[0]!.rows
    assert.equal(rows[0]!.detail, '5h 100% · 7d 50% · 2小时 5分后重置')
    assert.deepEqual(
      rows.map((r) => [r.level, r.recommended]),
      [
        ['fail', false],
        ['fail', false],
      ],
    )
  })

  it('describes API, signed-out and quota-less accounts and leaves the title empty without any data', () => {
    const snap = menubarSnapshot(
      [
        family('claude', 'Claude Code', [
          { ...sub('api', none), kind: 'api', login: 'not-needed' },
          { ...sub('off', none), login: 'logged-out' },
          sub('main', none),
        ]),
        { id: 'pi', title: 'pi', plan: null, accounts: [sub('main', none, 'pi')] },
        { id: 'grok', title: 'Grok Build', plan: null, accounts: [] },
      ],
      NOW,
      'en',
    )
    assert.equal(snap.title, '')
    assert.equal(snap.level, 'none')
    assert.equal(snap.tooltip, MENUBAR_STRINGS.en.tooltipEmpty)
    // A Family without accounts gets no section; a guess is never tagged as recommended.
    assert.deepEqual(
      snap.sections.map((s) => s.family),
      ['claude', 'pi'],
    )
    // API key and signed-out accounts go behind one submenu while another row is left to show.
    const claude = snap.sections[0]!
    assert.deepEqual(
      claude.rows.map((r) => [r.label, r.note, r.bars, r.recommended]),
      [['main', 'no quota yet', null, false]],
    )
    assert.equal(claude.more!.title, '2 more')
    assert.deepEqual(
      claude.more!.rows.map((r) => [r.label, r.note]),
      [
        ['api', 'API key'],
        ['off', 'signed out'],
      ],
    )
    assert.equal(snap.headline, '')
    assert.equal(snap.card, null)
    assert.deepEqual(snap.sections[0]!.columns, [null, null])
  })

  it('shows a Same Login once, named after its first directory in Display Order like the Panel', () => {
    // team comes first in Display Order (the Panel's shown name); main, its Same Login, is the one the plan picks.
    const snap = menubarSnapshot(
      [
        family('claude', 'Claude Code', [
          { ...sub('team', quota(30, 40)), sameLogin: ['claude:main'] },
          sub('work', quota(50, 60)),
          { ...sub('main', quota(30, 40)), sameLogin: ['claude:team'] },
        ]),
      ],
      NOW,
      'en',
    )
    const s = snap.sections[0]!
    assert.deepEqual(
      s.rows.map((r) => [r.label, r.recommended]),
      [
        ['team', true],
        ['work', false],
      ],
    )
    assert.match(s.rows[0]!.tip, /^Same login as main — they share this quota\n/)
    assert.equal(s.more!.title, '1 more')
    assert.deepEqual(
      s.more!.rows.map((r) => [r.label, r.note, r.bars, r.recommended]),
      [['main', 'same login as team', null, false]],
    )
  })

  it('titles the submenu by what it holds, and keeps API-only Families in the menu itself', () => {
    const api = (name: string): Acc => ({ ...sub(name, none), kind: 'api', login: 'not-needed' })
    const snap = menubarSnapshot(
      [
        family('claude', 'Claude Code', [sub('main', quota(10, 10)), api('a'), api('b')]),
        family('codex', 'Codex', [
          sub('main', quota(10, 10), 'codex'),
          { ...sub('x', none, 'codex'), login: 'logged-out' },
        ]),
        { id: 'grok', title: 'Grok Build', plan: null, accounts: [api('k')] },
      ],
      NOW,
      'zh',
    )
    assert.deepEqual(
      snap.sections.map((s) => [s.rows.length, s.more?.title ?? null]),
      [
        [1, '2 个 API 密钥账号'],
        [1, '1 个未登录账号'],
        [1, null],
      ],
    )
  })

  it('skips the reset part when nothing is used and carries every footer word', () => {
    const snap = menubarSnapshot([family('claude', 'Claude Code', [sub('main', quota(0, 0))])], NOW, 'en')
    assert.equal(snap.sections[0]!.rows[0]!.detail, '5h 0% · 7d 0%')
    // Every tool has quota left: the icon stands alone, and the menu says which account is highest.
    assert.equal(snap.title, '')
    assert.equal(snap.level, 'ok')
    assert.equal(snap.headline, 'Plenty of quota · highest is claude:main (Claude Code, 0%)')
    assert.equal(snap.card?.status, 'Plenty of quota')
    assert.deepEqual(Object.keys(snap.labels).sort(), [
      'addAccount',
      'cancel',
      'empty',
      'hide',
      'hideBody',
      'hideTitle',
      'hideYes',
      'hotkeyTaken',
      'loading',
      'openPanel',
      'recommended',
      'refresh',
      'refreshFailed',
      'refreshing',
      'resetsHeader',
      'updatedJustNow',
      'updatedMinutes',
    ])
  })
})

describe('menubarHotkey', () => {
  it('reads config menubar.hotkey into a key code and Carbon modifiers, with ⌥X by default', () => {
    assert.deepEqual(menubarHotkey(undefined), { keyCode: 7, modifiers: 2048, label: '⌥X' })
    assert.deepEqual(menubarHotkey('cmd+shift+0'), { keyCode: 29, modifiers: 512 + 256, label: '⇧⌘0' })
    assert.equal(menubarHotkey('off'), null)
    // No modifier, an unknown key or a repeated or unknown modifier is not a shortcut.
    for (const bad of ['s', 'ctrl+f13', 'ctrl+ctrl+s', 'hyper+s', ''])
      assert.equal(menubarHotkey(bad), null, bad)
  })

  it('says the shortcut in the tooltip and passes it to the script', () => {
    const h = menubarHotkey(undefined)
    const snap = menubarSnapshot(
      [family('claude', 'Claude Code', [sub('main', quota(10, 10))])],
      NOW,
      'en',
      h,
    )
    assert.deepEqual(snap.hotkey, h)
    assert.match(snap.tooltip, /\nPress ⌥X to open this menu from anywhere$/)
    assert.equal(menubarSnapshot([], NOW, 'en').hotkey, null)
  })
})

describe('untilText and menubarLang', () => {
  it('formats durations of minutes, hours and days, at least one minute', () => {
    const en = MENUBAR_STRINGS.en
    assert.equal(untilText(at(0), NOW, en), '1m')
    assert.equal(untilText(at(45), NOW, en), '45m')
    assert.equal(untilText(at(125), NOW, en), '2h 5m')
    assert.equal(untilText(at(3 * 1440 + 61), NOW, en), '3d 1h')
  })

  it('follows panel.language, else the system language', () => {
    assert.equal(menubarLang('zh', 'en-US'), 'zh')
    assert.equal(menubarLang('en', 'zh-Hans-CN'), 'en')
    assert.equal(menubarLang('auto', 'zh-Hans-CN'), 'zh')
    assert.equal(menubarLang(undefined, undefined), 'en')
  })

  it('has the same words in both languages, with the same placeholders', () => {
    const keys = Object.keys(MENUBAR_STRINGS.en)
    assert.deepEqual(Object.keys(MENUBAR_STRINGS.zh), keys)
    const holes = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort()
    for (const k of keys)
      assert.deepEqual(
        holes(MENUBAR_STRINGS.zh[k as keyof typeof MENUBAR_STRINGS.zh]),
        holes(MENUBAR_STRINGS.en[k as keyof typeof MENUBAR_STRINGS.en]),
        k,
      )
  })
})
