// What the Menu Bar Item shows (spec §3.31): the title, each row and the language, from given Handoff plans.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planHandoff } from '../core/handoff.ts'
import type { QuotaResult } from '../types.ts'
import {
  type MenubarFamilyInput,
  type MenubarRow,
  menubarHotkey,
  menubarLang,
  menubarSnapshot,
  untilText,
} from './snapshot.ts'
import { MENUBAR_STRINGS } from './strings.ts'

// Reset times are local; pin the zone so the words are the same on every machine.
process.env.TZ = 'UTC'
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
      assert.match(row.tip, /^Quota read 2h \d+m ago\nThese numbers may be old/)
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

  it('keeps a reading over an hour old current while this computer has not used the login since', () => {
    const old = { ...quota(10, 58), observedAt: at(-600) }
    const rowWith = (lastUseAt: string | undefined, refreshable = false) =>
      menubarSnapshot(
        [
          {
            ...family('claude', 'Claude Code', [{ ...sub('002', old), ...(lastUseAt ? { lastUseAt } : {}) }]),
            refreshable,
          },
        ],
        NOW,
        'en',
      )
    // Last used before the reading, or within 10 minutes after it: no "older reading", and the hover says what it cannot see.
    for (const used of [at(-700), at(-595)]) {
      const snap = rowWith(used)
      const row = snap.sections[0]!.rows[0]!
      assert.equal(row.stale, false)
      assert.doesNotMatch(row.detail, /older reading/)
      assert.match(row.tip, /^Quota read 10h 0m ago\nNot used on this computer since/)
      assert.notEqual(snap.card?.status, 'Quota needs refreshing')
    }
    // Used later, or no usage to go by: old, and a Host that cannot be asked says a session updates it.
    for (const used of [at(-500), undefined]) {
      const snap = rowWith(used)
      const row = snap.sections[0]!.rows[0]!
      assert.equal(row.stale, true)
      assert.match(row.tip, /they update when a session runs in this account/)
      assert.equal(
        snap.card?.detail,
        'Some readings are old · they update when a session runs in that account',
      )
    }
    // A Family that "Refresh" can ask keeps the refresh hint.
    const asked = rowWith(undefined, true)
    assert.match(asked.sections[0]!.rows[0]!.tip, /click Refresh/)
    assert.equal(asked.card?.detail, 'Some readings are old · refresh to check')
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
    // The reset names its window: the one closest to its own red level (7d 30% of 95 before 5h 20% of 85).
    assert.equal(rows[0]!.detail, '5h 20% · 7d 30% · 7d resets Wed 4:05 PM')
    assert.deepEqual(rows[0]!.bars, [
      { label: '5h', percent: 20, level: 'ok' },
      { label: '7d', percent: 30, level: 'ok' },
    ])
    assert.equal(rows[0]!.reset, '7d · Wed 4:05 PM')
    // Drawn apart: the window in grey, the time in the text colour.
    assert.equal(rows[0]!.resetLabel, '7d')
    assert.equal(rows[0]!.resetTime, 'Wed 4:05 PM')
    assert.equal(rows[0]!.note, '')
    assert.equal(
      rows[1]!.tip,
      'Quota read just now\n\n5-hour window: 90% used · resets Mon, Oct 19, 2:05 PM (in 2h 5m)\n7-day window: 40% used · resets Wed, Oct 21, 4:05 PM (in 2d 4h)\n\nStart claude:main in your terminal',
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
      windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 88, resetsAt: at(90) }],
      observedAt: NOW.toISOString(),
      source: 'test',
    }
    const snap = menubarSnapshot([family('codex', 'Codex', [sub('main', one, 'codex')])], NOW, 'en')
    const r = snap.sections[0]!.rows[0]!
    assert.deepEqual(r.bars, [null, { label: '7d', percent: 88, level: 'warn' }])
    assert.deepEqual(snap.sections[0]!.columns, [null, '7d'])
    assert.equal(r.reset, '7d · in 1h 30m')
  })

  it('shows the least used account when every account of a Family is past the fail level, in red', () => {
    const snap = menubarSnapshot(
      [family('claude', 'Claude Code', [sub('main', quota(100, 50)), sub('work', quota(20, 96))])],
      NOW,
      'zh',
    )
    assert.equal(snap.title, 'Claude Code 96%')
    assert.equal(snap.level, 'fail')
    assert.equal(snap.headline, 'Claude Code 额度告急 · 首选 claude:work 已用 96%')
    const rows = snap.sections[0]!.rows
    assert.equal(rows[0]!.detail, '5h 100% · 7d 50% · 5h 2小时5分后重置')
    assert.equal(rows[0]!.reset, '5h · 2小时5分后')
    assert.deepEqual(
      rows.map((r) => [r.level, r.recommended]),
      [
        ['fail', false],
        ['fail', false],
      ],
    )
  })

  it('colors a weekly window by its own levels and names it in the reset column (spec §3.26)', () => {
    const snap = menubarSnapshot(
      [family('claude', 'Claude Code', [sub('main', quota(43, 87)), sub('work', quota(86, 10))])],
      NOW,
      'en',
    )
    const [first, second] = snap.sections[0]!.rows
    // main: 7d 87% is 91.6% of its limit of 95, so it is ready and picked before work, whose 5h 86% is past 85.
    assert.equal(first!.label, 'main')
    assert.equal(first!.recommended, true)
    assert.deepEqual(first!.bars, [
      { label: '5h', percent: 43, level: 'ok' },
      { label: '7d', percent: 87, level: 'warn' },
    ])
    assert.equal(first!.level, 'warn', 'a weekly 87% warns but is not red')
    assert.equal(first!.reset, '7d · Wed 4:05 PM')
    assert.equal(second!.level, 'fail')
    assert.equal(second!.reset, '5h · in 2h 5m')
    assert.equal(snap.title, 'Claude Code 87%')
    assert.equal(snap.level, 'warn')
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

it('shows every model group of a Host as its own line under the account, with its 5h and 7d bars', () => {
  const w = (name: string, label: '5h' | '7d', used: number, resetIn = 120) => ({
    name,
    label,
    windowMinutes: label === '5h' ? 300 : 10080,
    usedPercent: used,
    resetsAt: at(resetIn),
  })
  const q: QuotaResult = {
    status: 'ok',
    windows: [
      w('Gemini Models', '5h', 53),
      w('Gemini Models', '7d', 16, 5000),
      w('Claude and GPT models', '5h', 100, -5),
      w('Claude and GPT models', '7d', 56, 9000),
      w('Gemini 4 Argon', '7d', 100, 4000),
    ],
    observedAt: NOW.toISOString(),
    source: 'test',
  }
  const snap = menubarSnapshot([family('agy', 'Antigravity CLI', [sub('main', q, 'agy')])], NOW, 'en')
  const section = snap.sections[0]!
  const r = section.rows[0]!
  assert.equal(r.bars, null)
  // Every limit shows, in the order the Host lists the groups; a window past its reset keeps its old bar, in grey.
  assert.deepEqual(
    r.groups?.map((g) => [g.label, g.bars?.map((b) => b && [b.label, b.percent])]),
    [
      [
        'Gemini',
        [
          ['5h', 53],
          ['7d', 16],
        ],
      ],
      [
        'Claude and GPT',
        [
          ['5h', 100],
          ['7d', 56],
        ],
      ],
      ['Gemini 4 Argon', [null, ['7d', 100]]],
    ],
  )
  assert.deepEqual(section.columns, ['5h', '7d'])
  assert.deepEqual(r.groups![1]!.bars![0], { label: '5h', percent: 100, level: 'none', passed: true })
  // The other window is still open, so the reset cell speaks about it.
  assert.equal(r.groups![1]!.reset, '7d · Sun 6:00 PM')
  assert.equal(r.level, 'fail')
  // The hover text says when the numbers were read and gives each window's use and reset, by group.
  assert.match(r.tip, /^Quota read just now\n/)
  assert.match(
    r.tip,
    /Gemini Models\n {3}5-hour window: 53% used · resets Mon, Oct 19, 2:00 PM \(in 2h 0m\)\n {3}7-day window: 16% used · resets Thu, Oct 22, 11:20 PM \(in 3d 11h\)/,
  )
  assert.match(
    r.tip,
    /Claude and GPT models\n {3}5-hour window: reset at Mon, Oct 19, 11:55 AM · new numbers/,
  )
  assert.match(r.groups![2]!.tip, /Gemini 4 Argon\n {3}7-day window: 100% used/)
  assert.doesNotMatch(r.groups![2]!.tip, /Gemini Models/)
})

it('keeps a plan-wide window on the account line and draws each model group under it', () => {
  const w = (used: number, name?: string) => ({
    ...(name ? { name } : {}),
    label: '31d',
    windowMinutes: 44640,
    usedPercent: used,
    resetsAt: at(9000),
  })
  const q: QuotaResult = {
    status: 'ok',
    windows: [w(9), w(6, 'Cursor models'), w(96, 'Other models')],
    observedAt: NOW.toISOString(),
    source: 'test',
  }
  const snap = menubarSnapshot([family('cursor', 'Cursor CLI', [sub('main', q, 'cursor')])], NOW, 'en')
  const r = snap.sections[0]!.rows[0]!
  assert.deepEqual(r.bars, [null, { label: '31d', percent: 9, level: 'ok' }])
  assert.deepEqual(
    r.groups?.map((g) => [g.label, g.bars?.map((b) => b && [b.label, b.percent])]),
    [
      ['Cursor', [null, ['31d', 6]]],
      ['Other', [null, ['31d', 96]]],
    ],
  )
  // The account's colour warns when one model group is nearly used up, though the plan total is low.
  assert.notEqual(r.level, 'ok')
  assert.match(r.tip, /31-day window: 9% used[^\n]*\n\nCursor models\n {3}31-day window: 6% used/)
})

it('gives an unused model group no line of its own under plan-wide bars, keeping it in the hover text', () => {
  const w = (label: string, used: number, name?: string) => ({
    ...(name ? { name } : {}),
    label,
    windowMinutes: label === '5h' ? 300 : 10080,
    usedPercent: used,
    resetsAt: at(label === '5h' ? 120 : 9000),
  })
  const q = (fable: number): QuotaResult => ({
    status: 'ok',
    windows: [w('5h', 5), w('7d', 23), w('7d', fable, 'Fable')],
    observedAt: NOW.toISOString(),
    source: 'test',
  })
  const rows = menubarSnapshot(
    [family('claude', 'Claude Code', [sub('main', q(0)), sub('work', q(3))])],
    NOW,
    'en',
  ).sections[0]!.rows
  const by = (name: string) => rows.find((r) => r.label === name)!
  assert.deepEqual(by('main').groups, [])
  assert.match(by('main').tip, /Fable\n {3}7-day window: 0% used/)
  assert.deepEqual(
    by('work').groups?.map((g) => g.label),
    ['Fable'],
  )
})

it('writes the hover text in words: how long ago the numbers were read, and why they may be old', () => {
  const q: QuotaResult = {
    status: 'ok',
    windows: [{ label: '5h', windowMinutes: 300, usedPercent: 40, resetsAt: at(90) }],
    observedAt: new Date(NOW.getTime() - 25 * 60000).toISOString(),
    source: 'test',
    fetchError: 'no answer within 20 seconds',
  }
  const tip = menubarSnapshot([family('agy', 'Antigravity CLI', [sub('main', q, 'agy')])], NOW, 'zh')
    .sections[0]!.rows[0]!.tip
  assert.match(tip, /^额度读于 25分前\n/)
  assert.match(tip, /上次检查没成功：no answer within 20 seconds/)
  assert.match(tip, /5小时窗口：已用 40% · 10月19日周一 13:30 重置（1小时30分后）/)
  assert.doesNotMatch(tip, /\d{4}-\d{2}-\d{2}T/)
})

describe('reset cell and windows past their reset (spec §3.31)', () => {
  it('draws a window past its reset grey, leaves it out of the level, and speaks about the window still open', () => {
    const q: QuotaResult = {
      status: 'ok',
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: 97, resetsAt: at(-10) },
        { label: '7d', windowMinutes: 10080, usedPercent: 30, resetsAt: at(3000) },
      ],
      observedAt: NOW.toISOString(),
      source: 'test',
    }
    const r = menubarSnapshot([family('claude', 'Claude Code', [sub('main', q)])], NOW, 'en').sections[0]!
      .rows[0]!
    assert.deepEqual(r.bars, [
      { label: '5h', percent: 97, level: 'none', passed: true },
      { label: '7d', percent: 30, level: 'ok' },
    ])
    assert.equal(r.level, 'ok', 'a used-up window that has reset no longer colours the row')
    assert.deepEqual([r.resetLabel, r.resetTime], ['7d', 'Wed 2:00 PM'])
    assert.equal(r.reset, '7d · Wed 2:00 PM')
    assert.match(r.detail, /^5h – · 7d 30% · 7d resets /)
    assert.match(r.tip, /5-hour window: reset at Mon, Oct 19, 11:50 AM/)
  })

  it('says the reset is due once every window has passed, and that Refresh checks now only where it can', () => {
    const q: QuotaResult = {
      status: 'ok',
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: 40, resetsAt: at(-10) },
        { label: '7d', windowMinutes: 10080, usedPercent: 30, resetsAt: at(-5) },
      ],
      observedAt: NOW.toISOString(),
      source: 'test',
    }
    const f = family('claude', 'Claude Code', [sub('main', q)])
    const zh = menubarSnapshot([f], NOW, 'zh').sections[0]!.rows[0]!
    assert.equal(zh.resetLabel, '')
    assert.equal(zh.resetTime, '已到重置时间，待更新')
    assert.equal(zh.reset, '已到重置时间，待更新')
    assert.ok(zh.bars!.every((b) => b?.passed))
    assert.match(zh.tip, /点“刷新”马上检查/)
    const en = menubarSnapshot([{ ...f, refreshable: false }], NOW, 'en').sections[0]!.rows[0]!
    assert.equal(en.reset, 'Reset due; awaiting update')
    assert.doesNotMatch(en.tip, /Refresh/)
  })

  it('marks rows a refresh is still asking, and rows whose answer failed, keeping their old bars', () => {
    const f = family('codex', 'Codex', [
      { ...sub('main', quota(20, 30), 'codex'), refresh: 'waiting' },
      { ...sub('work', quota(10, 5), 'codex'), refresh: 'failed' },
      { ...sub('lab', none, 'codex'), refresh: 'waiting' },
      sub('team', quota(1, 2), 'codex'),
    ])
    const rows = menubarSnapshot([f], NOW, 'zh').sections[0]!.rows
    const by = (name: string) => rows.find((r) => r.label === name)!
    assert.equal(by('main').refreshing, true)
    assert.equal(by('main').resetTime, '刷新中…')
    assert.equal(by('main').resetLabel, '')
    assert.equal(by('main').bars?.[1]?.percent, 30)
    assert.equal(by('work').refreshFailed, true)
    assert.equal(by('work').resetTime, '刷新失败')
    assert.equal(by('lab').note, '刷新中…')
    assert.equal(by('team').refreshing, undefined)
    assert.equal(by('team').resetLabel, '7d')
  })
})

it('marks an account whose sign-in expired and never recommends it (ADR-0071)', () => {
  const expired = { ...sub('main', quota(5, 5)), loginExpired: true as const }
  const f = family('claude', 'Claude Code', [expired, sub('work', quota(40, 10))])
  f.plan = planHandoff(
    'claude',
    f.accounts.map((a) => ({
      ...a,
      isMain: a.name === 'main',
      ...(a.loginExpired ? { loginProblem: { kind: 'expired' as const, message: 'x' } } : {}),
    })),
    NOW,
  )
  for (const lang of ['en', 'zh'] as const) {
    const rows = menubarSnapshot([f], NOW, lang).sections[0]!.rows
    const main = rows.find((r) => r.label === 'main')!
    assert.equal(main.note, MENUBAR_STRINGS[lang].loginExpired)
    assert.equal(main.recommended, false)
    assert.equal(rows.find((r) => r.label === 'work')!.recommended, true)
  }
})

it('keeps a Same Login row’s quota when its first directory’s sign-in expired (ADR-0071)', () => {
  const first = { ...sub('main', quota(30, 20)), sameLogin: ['claude:001'], loginExpired: true as const }
  const second = { ...sub('001', quota(30, 20)), sameLogin: ['claude:main'] }
  const sec = menubarSnapshot([family('claude', 'Claude Code', [first, second])], NOW, 'en').sections[0]!
  const shown = sec.rows.find((r) => r.label === '001')!
  assert.ok(shown.bars, 'the shared quota stays on show')
  assert.equal(
    sec.rows.some((r) => r.label === 'main'),
    false,
  )
  assert.equal(sec.more!.rows.find((r) => r.label === 'main')!.note, MENUBAR_STRINGS.en.loginExpired)
})

describe('Limit Resets and per-window age (ADR-0072, ADR-0073)', () => {
  const holding = (available: number, nextExpiresAt?: string): QuotaResult => ({
    ...(quota(30, 40) as Extract<QuotaResult, { status: 'ok' }>),
    limitResets: { available, observedAt: NOW.toISOString(), ...(nextExpiresAt ? { nextExpiresAt } : {}) },
  })
  const rows = (accounts: Acc[], lang: 'en' | 'zh' = 'en', extra: Partial<MenubarFamilyInput> = {}) => {
    const s = menubarSnapshot([{ ...family('codex', 'Codex', accounts), ...extra }], NOW, lang).sections[0]!
    return [...s.rows, ...(s.more?.rows ?? [])]
  }

  it('says the Limit Resets an account holds on its line, with the next expiry in the hover text', () => {
    const [one, two, zero, unknown] = rows([
      sub('main', holding(1, at(3 * 1440)), 'codex'),
      sub('team', holding(2), 'codex'),
      sub('none', holding(0), 'codex'),
      sub('plain', quota(30, 40), 'codex'),
    ]) as [MenubarRow, MenubarRow, MenubarRow, MenubarRow]
    assert.equal(one.limitResets, '1 reset available')
    assert.match(one.detail, / · 1 reset available$/)
    assert.match(one.tip, /Limit resets: 1 available[^\n]*\nThe next one expires Thu, Oct 22, 12:00 PM\n/)
    assert.equal(two.limitResets, '2 resets available')
    assert.doesNotMatch(two.tip, /expires/)
    // None, and a Host that cannot tell, say nothing.
    for (const r of [zero, unknown]) {
      assert.equal('limitResets' in r, false)
      assert.doesNotMatch(`${r.detail}\n${r.tip}`, /reset available|Limit resets/)
    }
    assert.equal(rows([sub('main', holding(1), 'codex')], 'zh')[0]!.limitResets, '可用重置 1 次')
  })

  it('says a Same Login’s Limit Resets once, on the row that shows its quota', () => {
    const all = rows([
      { ...sub('team', holding(1), 'codex'), sameLogin: ['codex:main'] },
      { ...sub('main', holding(1), 'codex'), sameLogin: ['codex:team'] },
    ])
    assert.deepEqual(
      all.map((r) => [r.label, r.limitResets]),
      [
        ['team', '1 reset available'],
        ['main', undefined],
      ],
    )
  })

  it('offers "Use a reset…" where the Host can use one and the account holds one, once per login', () => {
    const use = { limitReset: 'use' as const }
    const three = rows(
      [
        sub('main', holding(1), 'codex'),
        sub('none', holding(0), 'codex'),
        sub('plain', quota(96, 96), 'codex'),
      ],
      'en',
      use,
    )
    const [has, none, unknown] = ['main', 'none', 'plain'].map((l) => three.find((r) => r.label === l)!) as [
      MenubarRow,
      MenubarRow,
      MenubarRow,
    ]
    assert.deepEqual(has.useReset, {
      title: 'Use a reset…',
      tip: 'Opens the Panel, which shows what a reset would do and asks before using one',
    })
    // Nothing to use, or a count the Host did not tell: no line, however full the windows are.
    assert.equal('useReset' in none, false)
    assert.equal('useReset' in unknown, false)
    // A Family that offers no way to use one never shows the line.
    assert.equal('useReset' in rows([sub('main', holding(1), 'codex')])[0]!, false)
    assert.equal(rows([sub('main', holding(1), 'codex')], 'zh', use)[0]!.useReset?.title, '使用重置…')
    const login = rows(
      [
        { ...sub('team', holding(1), 'codex'), sameLogin: ['codex:main'] },
        { ...sub('main', holding(1), 'codex'), sameLogin: ['codex:team'] },
      ],
      'en',
      use,
    )
    assert.deepEqual(
      login.map((r) => [r.label, Boolean(r.useReset)]),
      [
        ['team', true],
        ['main', false],
      ],
    )
  })

  it('offers it where only the vendor page can, once a window is at its warning level, naming the page', () => {
    const page = { limitReset: 'page' as const, limitResetSite: 'claude.ai' }
    const fable = {
      ...(quota(10, 20) as Extract<QuotaResult, { status: 'ok' }>),
    }
    fable.windows = [
      ...fable.windows,
      { label: '7d', name: 'Fable', windowMinutes: 10_080, usedPercent: 90, resetsAt: at(2000) },
    ]
    const all = rows(
      [
        sub('roomy', quota(59, 84), 'codex'),
        sub('short', quota(60, 10), 'codex'),
        sub('long', quota(10, 85), 'codex'),
        sub('group', fable, 'codex'),
      ],
      'en',
      page,
    )
    const by = (label: string) => all.find((r) => r.label === label)!
    assert.equal('useReset' in by('roomy'), false)
    for (const r of [by('short'), by('long'), by('group')]) {
      assert.equal(r.useReset?.title, 'Use a reset…', r.label)
      assert.equal(
        r.useReset?.tip,
        'Opens claude.ai, where a reset is used · sideby cannot see whether this account holds one',
      )
    }
  })

  it('writes the age on the line only once the numbers are older than the Family asks', () => {
    const read = (minutes: number): QuotaResult =>
      ({ ...quota(30, 40), observedAt: at(-minutes) }) as QuotaResult
    const [fresh, aging] = rows([sub('main', read(10), 'codex'), sub('team', read(25), 'codex')], 'en', {
      everyMinutes: 15,
    })
    assert.equal('age' in fresh!, false)
    assert.equal(aging!.age, 'read 25m ago')
    assert.equal(aging!.stale, false)
    // The hover text says when the numbers were read either way.
    assert.match(fresh!.tip, /^Quota read 10m ago/)
    // A Family that is not asked says the age only once the reading is old.
    assert.equal('age' in rows([sub('main', read(25), 'codex')])[0]!, false)
    assert.equal(rows([sub('main', read(25), 'codex')], 'zh', { everyMinutes: 15 })[0]!.age, '25分前读取')
  })

  it('marks only the model group that was read long ago as old, not the plan-wide bars above it', () => {
    const q: QuotaResult = {
      status: 'ok',
      windows: [
        { label: '5h', windowMinutes: 300, usedPercent: 5, resetsAt: at(125) },
        { label: '7d', windowMinutes: 10080, usedPercent: 23, resetsAt: at(3000) },
        {
          label: '7d',
          name: 'Fable',
          windowMinutes: 10080,
          usedPercent: 60,
          resetsAt: at(3000),
          observedAt: at(-300),
          source: 'claude /usage',
        },
      ],
      observedAt: at(-2),
      source: 'claude statusline',
    }
    const [row] = rows([{ ...sub('main', q), lastUseAt: at(-1) }])
    // Any old window makes the row old for readers of the JSON; the lines say which.
    assert.equal(row!.stale, true)
    assert.equal(row!.barsStale, false)
    assert.equal(row!.note, '')
    assert.equal(row!.groups![0]!.stale, undefined, 'as old as the row says')
    assert.match(row!.tip, /Fable\n {3}7-day window: 60% used[^\n]*\n {3}Quota read 5h 0m ago/)
    // The same group read with the rest: nothing is old, and no line carries a mark of its own.
    const { observedAt: _at, source: _source, ...sameTime } = q.windows[2]!
    const [calm] = rows([
      { ...sub('main', { ...q, windows: [q.windows[0]!, q.windows[1]!, sameTime] }), lastUseAt: at(-1) },
    ])
    assert.equal(calm!.stale, false)
    assert.equal('barsStale' in calm!, false)
  })
})
