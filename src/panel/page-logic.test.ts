import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ALIAS_NAME, RESERVED_ALIASES } from '../core/config.ts'
import { MESSAGES } from './i18n.ts'
import { renderPage } from './page.ts'
import {
  aliasIssue,
  attentionReasons,
  cacheHitRate,
  formatDuration,
  type LogicAccount,
  matchesQuery,
  mergeDaily,
  newAccountDir,
  nextReset,
  panelHint,
  passedWindow,
  quotaPressure,
  sortAccounts,
  suggestAlias,
  suggestName,
  windowState,
} from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
const acct = (name: string, extra: Partial<LogicAccount> = {}): LogicAccount => ({
  family: 'claude',
  name,
  ref: `claude:${name}`,
  isMain: name === 'main',
  kind: 'subscription',
  ...extra,
})
const quota = (...used: number[]): LogicAccount['quota'] => ({
  status: 'ok',
  observedAt: at(-0.1),
  windows: used.map((u, i) => ({
    label: i ? '7d' : '5h',
    windowMinutes: i ? 10080 : 300,
    usedPercent: u,
    resetsAt: at(i ? 50 : 2),
  })),
})

describe('page logic', () => {
  it('formats countdowns with a fixed shape in both languages', () => {
    assert.equal(formatDuration(30_000, 'en'), '<1m')
    assert.equal(formatDuration(12 * 60_000, 'en'), '12m')
    assert.equal(formatDuration((2 * 60 + 5) * 60_000, 'en'), '2h 05m')
    assert.equal(formatDuration((3 * 24 + 4) * 3_600_000, 'en'), '3d 4h')
    assert.equal(formatDuration((2 * 60 + 5) * 60_000, 'zh'), '2小时05分')
    assert.equal(formatDuration(Number.NaN, 'en'), '<1m')
  })

  it('levels a window by the shared thresholds and treats a passed reset as empty', () => {
    const w = (u: number, h = 1) => ({ usedPercent: u, resetsAt: at(h) })
    assert.deepEqual(windowState(w(59.4), NOW, 60, 85), { pct: 59, passed: false, level: 'ok' })
    assert.equal(windowState(w(60), NOW, 60, 85).level, 'warn')
    assert.equal(windowState(w(85), NOW, 60, 85).level, 'fail')
    assert.deepEqual(windowState(w(97, -1), NOW, 60, 85), { pct: 0, passed: true, level: 'reset' })
    assert.equal(windowState(w(140), NOW, 60, 85).pct, 100)
  })

  it('marks a window whose reset passed with the time its data was last seen, and skips it as the next reset', () => {
    const live = { resetsAt: at(3) }
    const passed = { resetsAt: at(-24 * 20) }
    assert.equal(passedWindow(live, at(-24 * 26), NOW), null)
    assert.deepEqual(passedWindow(passed, at(-24 * 26), NOW), { since: at(-24 * 26) })
    // Without a usable observation time, the reset itself is the last moment the numbers held.
    assert.deepEqual(passedWindow(passed, undefined, NOW), { since: passed.resetsAt })
    assert.deepEqual(passedWindow(passed, 'garbage', NOW), { since: passed.resetsAt })
    assert.equal(passedWindow({ resetsAt: 'garbage' }, at(-1), NOW), null)
    // codex:002 shape: only a passed 7d window. It is not the header's next reset; a live one elsewhere is.
    const stale = acct('002', {
      family: 'codex',
      ref: 'codex:002',
      quota: {
        status: 'ok',
        observedAt: at(-24 * 26),
        windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 0, resetsAt: passed.resetsAt }],
      },
    })
    assert.equal(nextReset([stale], NOW), null)
    assert.equal(nextReset([stale, acct('a', { quota: quota(1, 1) })], NOW)?.ref, 'claude:a')
  })

  it('measures pressure from live windows only', () => {
    assert.equal(quotaPressure(acct('a', { quota: quota(20, 70) }), NOW), 70)
    assert.equal(quotaPressure(acct('a', { quota: { status: 'unavailable' } }), NOW), -1)
    const passed = quota(90)
    passed!.windows![0]!.resetsAt = at(-1)
    assert.equal(quotaPressure(acct('a', { quota: passed }), NOW), 0)
  })

  it('lists attention reasons, most serious first', () => {
    const a = acct('w', { error: 'bad json', login: 'logged-out', quota: quota(65) })
    assert.deepEqual(attentionReasons(a, { fail: 1, warn: 0 }, NOW, 60), [
      'error',
      'health-fail',
      'signed-out',
      'quota-high',
    ])
    assert.deepEqual(attentionReasons(acct('ok', { quota: quota(10) }), { fail: 0, warn: 0 }, NOW, 60), [])
    // An API Account has no sign-in, and warnings alone still count.
    assert.deepEqual(
      attentionReasons(acct('k', { kind: 'api', login: 'logged-out' }), { fail: 0, warn: 2 }, NOW, 60),
      ['health-warn'],
    )
  })

  it('sorts by pressure, name or last use, the Main Account leading ties', () => {
    const list = [
      acct('b', { quota: quota(10, 90) }),
      acct('a', { usage: { status: 'ok', lastActivityAt: at(-5) } }),
      acct('main', { usage: { status: 'ok', lastActivityAt: at(-1) } }),
      acct('c10', { quota: quota(40) }),
      acct('c9', { quota: quota(40) }),
    ]
    assert.deepEqual(
      sortAccounts(list, 'pressure', NOW).map((a) => a.name),
      ['b', 'c9', 'c10', 'main', 'a'],
    )
    assert.deepEqual(
      sortAccounts(list, 'name', NOW).map((a) => a.name),
      ['main', 'a', 'b', 'c9', 'c10'],
    )
    assert.deepEqual(
      sortAccounts(list, 'recent', NOW).map((a) => a.name),
      ['main', 'a', 'b', 'c9', 'c10'],
    )
    assert.equal(list[0]!.name, 'b', 'the input is not reordered')
  })

  it('matches every search word against name, ref, alias, tool, model and plan', () => {
    const a = acct('work', { aliases: ['cc004'], model: 'deepseek-v4', quota: { ...quota(1)!, plan: 'max' } })
    assert.ok(matchesQuery(a, '', 'Claude Code'))
    assert.ok(matchesQuery(a, 'CC004', 'Claude Code'))
    assert.ok(matchesQuery(a, 'claude max', 'Claude Code'))
    assert.ok(matchesQuery(a, 'deepseek', 'Claude Code'))
    assert.equal(matchesQuery(a, 'codex', 'Claude Code'), false)
  })

  it('derives a new Account folder from a sibling or a dot-folder Main Account, else gives up', () => {
    const accounts = [
      acct('main', { dir: '/h/.claude' }),
      { ...acct('main'), family: 'pi', ref: 'pi:main', dir: '/h/.pi/agent' },
      { ...acct('work'), family: 'pi', ref: 'pi:work', dir: '/h/.pi-work/agent' },
      { ...acct('main'), family: 'odd', ref: 'odd:main', dir: '/h/odd/agent' },
    ]
    assert.equal(newAccountDir(accounts, 'claude', 'lab'), '/h/.claude-lab')
    assert.equal(newAccountDir(accounts, 'pi', 'lab'), '/h/.pi-lab/agent')
    assert.equal(newAccountDir(accounts, 'odd', 'lab'), null)
    assert.equal(newAccountDir(accounts, 'none', 'lab'), null)
  })

  it('computes cache hits, merges days and finds the next reset', () => {
    assert.equal(
      cacheHitRate({ status: 'ok', inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 }),
      0.8,
    )
    assert.equal(
      cacheHitRate({ status: 'ok', inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      null,
    )
    assert.equal(cacheHitRate({ status: 'unavailable' }), null)
    assert.deepEqual(
      mergeDaily([
        [
          { date: '2026-10-04', totalTokens: 5 },
          { date: '2026-10-05', totalTokens: 1 },
        ],
        undefined,
        [{ date: '2026-10-05', totalTokens: 2 }],
      ]),
      [
        { date: '2026-10-04', totalTokens: 5 },
        { date: '2026-10-05', totalTokens: 3 },
      ],
    )
    const soon = nextReset(
      [acct('a', { quota: quota(1, 1) }), acct('b', { quota: { status: 'unavailable' } })],
      NOW,
    )
    assert.deepEqual(soon, {
      at: Date.parse(at(2)),
      label: '5h',
      ref: 'claude:a',
      name: 'a',
      family: 'claude',
    })
    assert.equal(nextReset([], NOW), null)
  })
})

describe('short command for a new account', () => {
  const fam = (family: string, pairs: [string, string[]][]): LogicAccount[] =>
    pairs.map(([name, aliases]) => ({
      family,
      name,
      ref: `${family}:${name}`,
      isMain: name === 'main',
      aliases,
    }))

  it("continues the prefix the Family's aliases share, ignoring aliases that do not end in their name", () => {
    const claude = fam('claude', [
      ['main', []],
      ...['001', '002', '003', '004', '005', '006', '007'].map((n): [string, string[]] => [n, [`cc${n}`]]),
    ])
    const codex = fam('codex', [
      ['main', ['codex001']],
      ['002', ['codex002']],
      ['003', ['codex003']],
    ])
    const others = [...fam('pi', [['main', ['pi001']]]), ...fam('cursor', [['002', ['cursor-cli002']]])]
    const all = [...claude, ...codex, ...others]
    assert.equal(suggestAlias(all, 'claude', '008'), 'cc008')
    assert.equal(suggestAlias(all, 'codex', '004'), 'codex004')
    assert.equal(suggestAlias(all, 'cursor', '003'), 'cursor-cli003')
    // pi001 points at pi:main, so it shows no pattern.
    assert.equal(suggestAlias(all, 'pi', '002'), '')
    assert.equal(suggestAlias(all, 'grok', '001'), '')
    assert.equal(suggestAlias(all, 'claude', ''), '')
    // The most common prefix wins.
    const mixed = fam('claude', [
      ['001', ['cc001', 'c001']],
      ['002', ['cc002']],
    ])
    assert.equal(suggestAlias(mixed, 'claude', 'work'), 'ccwork')
  })

  it('checks an alias with the config rules', () => {
    const rules: [string, string[]] = [ALIAS_NAME.source, [...RESERVED_ALIASES]]
    const taken = { cc001: 'claude:001' }
    assert.equal(aliasIssue('cc008', ...rules, taken, 'claude:008'), '')
    assert.equal(aliasIssue('', ...rules, taken, 'claude:008'), '')
    assert.equal(aliasIssue('8cc', ...rules, taken, 'claude:008'), 'pattern')
    assert.equal(aliasIssue('cc 8', ...rules, taken, 'claude:008'), 'pattern')
    assert.equal(aliasIssue('cd', ...rules, taken, 'claude:008'), 'reserved')
    assert.equal(aliasIssue('sideby', ...rules, taken, 'claude:008'), 'reserved')
    assert.equal(aliasIssue('cc001', ...rules, taken, 'claude:008'), 'taken')
    assert.equal(aliasIssue('cc001', ...rules, taken, 'claude:001'), '')
    assert.equal(aliasIssue('toString', ...rules, taken, 'claude:008'), '')
  })
})

describe('page text', () => {
  it('has the same keys and placeholders in English and Chinese', () => {
    const keys = (o: Record<string, string>) => Object.keys(o).sort()
    assert.deepEqual(keys(MESSAGES.zh), keys(MESSAGES.en))
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const k of Object.keys(MESSAGES.en)) assert.equal(vars(MESSAGES.zh[k]!), vars(MESSAGES.en[k]!), k)
  })

  it('defines every key the script asks for', () => {
    const used = new Set<string>()
    for (const m of PAGE_SCRIPT.matchAll(/\bt[nx]?\('([a-zA-Z.-]+)'/g)) used.add(m[1]!)
    for (const m of PAGE_SCRIPT.matchAll(/\btip\('(\w+)'\)/g))
      used.add(`tip.${m[1]}.term`).add(`tip.${m[1]}.body`)
    const missing = [...used]
      .filter((k) => !k.endsWith('.'))
      .filter((k) => !(k in MESSAGES.en) && !(`${k}.one` in MESSAGES.en && `${k}.other` in MESSAGES.en))
    assert.deepEqual(missing, [])
    for (const v of ['pressure', 'name', 'recent']) assert.ok(`sort.${v}` in MESSAGES.en)
    for (const v of ['system', 'light', 'dark']) assert.ok(`theme.${v}` in MESSAGES.en)
    for (const r of ['error', 'health-fail', 'signed-out', 'not-installed', 'quota-high', 'health-warn'])
      assert.ok(`need.${r}.one` in MESSAGES.en, r)
  })

  it('ships a script that parses and text that cannot end its script element', () => {
    const html = renderPage({ basePath: '', token: 't', nonce: 'n' })
    const script = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    assert.doesNotThrow(() => new Function(script))
    assert.equal(html.match(/<\/script>/g)?.length, html.match(/<script/g)?.length)
    assert.match(html, /<script type="application\/json" id="sideby-i18n">/)
  })
})

describe('suggestName', () => {
  it('continues numbered names with the same width', () => {
    assert.equal(suggestName(['main', '001', '002', '003', '004', '005', '006', '007']), '008')
    assert.equal(suggestName(['main', '002']), '003')
    assert.equal(suggestName(['main', '01', '7', 'work']), '08')
    assert.equal(suggestName(['main', '099']), '100')
    assert.equal(suggestName(['main', '9']), '10')
  })
  it('offers work, then the next free workN', () => {
    assert.equal(suggestName(['main']), 'work')
    assert.equal(suggestName([]), 'work')
    assert.equal(suggestName(['main', 'work', 'deepseek']), 'work2')
    assert.equal(suggestName(['main', 'work', 'work2', 'work3']), 'work4')
  })
})

describe('panelHint', () => {
  const action = 'use Fix all'
  it('names the Panel action for fixable Findings', () => {
    assert.equal(panelHint('run `sideby doctor --fix`', true, action), 'Use Fix all')
    assert.equal(
      panelHint('run `sideby doctor --fix` to replace the link with a copy', true, action),
      'Use Fix all to replace the link with a copy',
    )
    assert.equal(panelHint('run `sideby doctor --fix`', true, '点「全部修复」'), '点「全部修复」')
  })
  it('keeps the command when Fix all would not do it', () => {
    const typeMismatch =
      'sideby does not change the type of an existing item; move it aside and run `sideby doctor --fix`'
    assert.equal(panelHint(typeMismatch, false, action), typeMismatch)
    const force = 'add them to the main account first, or run `sideby doctor --fix --force` to remove them'
    assert.equal(panelHint(force, false, action), force)
    assert.equal(panelHint(force, true, action), force)
    assert.equal(panelHint('', true, action), '')
  })
})
