import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ALIAS_NAME, RESERVED_ALIASES } from '../core/config.ts'
import { remoteControlTodo } from '../core/remote-control.ts'
import { checkHotkey } from '../menubar/hotkey.ts'
import { MESSAGES } from './i18n.ts'
import { renderPage } from './page.ts'
import {
  AI_TASK_KINDS,
  aiTaskAccounts,
  aliasArgsOf,
  aliasIssue,
  askCopy,
  attentionReasons,
  attentionWhy,
  autostartNote,
  bindingWindow,
  cacheHitRate,
  canLeaveLocal,
  categoryOrder,
  codeSwapOutcome,
  enableOutcome,
  fileSize,
  fixPrompt,
  foldSkips,
  foldToolCalls,
  formatDuration,
  handoffChangeOf,
  handoffHintAccount,
  handoffTaskFacts,
  hiddenIn,
  highlightParts,
  histFilters,
  historyEmpty,
  historyWhen,
  hotkeyFromKey,
  hotkeyPressKind,
  inDisplayOrder,
  type LogicAccount,
  type LogicSession,
  loginClusters,
  loginKey,
  maskEmail,
  matchesQuery,
  mdBlocks,
  mdInline,
  menuPlacement,
  mergeDaily,
  mergeUsage,
  messageChip,
  messageNews,
  newAccountDir,
  nextReset,
  panelFixes,
  panelHint,
  panelLang,
  panelMigration,
  panelPrefs,
  passedWindow,
  pinnedIn,
  quotaAskable,
  quotaHighLevel,
  quotaPressure,
  remoteControlSummary,
  reorder,
  rowBadge,
  runCodeSwap,
  saveHandoffChange,
  sendBlock,
  sendFileProblem,
  sendResultView,
  sessionAge,
  sessionLabelParts,
  shortCwd,
  sortAccounts,
  sortSessions,
  steadyOrder,
  stripSecrets,
  suggestAlias,
  suggestName,
  switchFailure,
  tailInView,
  taskFindings,
  taskPrompt,
  updatedAge,
  widthFollower,
  widthTier,
  windowState,
  withPinned,
} from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'
import { pageStyles } from './page-styles.ts'

// Fake key prefixes, joined at run time so the source never holds a key-shaped string (leak-check).
const SK = 'sk' + '-'
const XAI = 'xai' + '-'

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

  it('shows the limit that binds first when one model group has several', () => {
    const w = (label: string, u: number, h = 1) => ({ label, usedPercent: u, resetsAt: at(h) })
    assert.equal(bindingWindow([w('7d', 56), w('5h', 100)], NOW, 60, 85)?.label, '5h')
    // A limit whose reset passed counts as empty, so the other one binds.
    assert.equal(bindingWindow([w('7d', 40), w('5h', 100, -1)], NOW, 60, 85)?.label, '7d')
    assert.equal(bindingWindow([w('5h', 30), w('7d', 30)], NOW, 60, 85)?.label, '5h')
    assert.equal(bindingWindow([], NOW, 60, 85), undefined)
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

  it('says why an Account needs attention, naming the fullest live window over the warning level', () => {
    assert.deepEqual(attentionWhy(acct('a', { quota: quota(40, 62) }), null, NOW, 60), {
      key: 'why.quota-high',
      vars: { label: '7d', pct: 62, warn: 60 },
    })
    assert.deepEqual(attentionWhy(acct('a', { quota: quota(91.6, 70) }), null, NOW, 60)?.vars, {
      label: '5h',
      pct: 92,
      warn: 60,
    })
    // The most serious reason wins, and a window that has reset no longer counts.
    assert.deepEqual(attentionWhy(acct('a', { error: 'x', quota: quota(90) }), null, NOW, 60), {
      key: 'why.error',
      vars: {},
    })
    const passed = quota(90, 10)
    passed!.windows![0]!.resetsAt = at(-1)
    assert.equal(attentionWhy(acct('a', { quota: passed }), { fail: 0, warn: 0 }, NOW, 60), null)
  })

  it('colors a running-low label like its bar: red from the fail level, amber below', () => {
    assert.equal(quotaHighLevel(acct('a', { quota: quota(40, 62) }), NOW, 85), 'warn')
    assert.equal(quotaHighLevel(acct('a', { quota: quota(40, 91) }), NOW, 85), 'fail')
    // A window that has reset, or a Quota read from another Account of the same login, does not count.
    const passed = quota(95, 10)
    passed!.windows![0]!.resetsAt = at(-1)
    assert.equal(quotaHighLevel(acct('a', { quota: passed }), NOW, 85), 'warn')
    const shared = quota(95)
    shared!.from = 'claude:main'
    assert.equal(quotaHighLevel(acct('a', { quota: shared }), NOW, 85), 'warn')
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

  it('shows one badge per row: a fix, then running low, then the other looks, then recommended, then API', () => {
    assert.equal(
      rowBadge(['error', 'signed-out', 'quota-high', 'health-fail'], { next: true, api: true }),
      'health-fail',
    )
    assert.equal(rowBadge(['signed-out', 'quota-high'], { next: true }), 'quota-high')
    assert.equal(rowBadge(['health-warn', 'not-installed', 'signed-out'], { next: true }), 'signed-out')
    assert.equal(rowBadge(['health-warn', 'not-installed'], {}), 'not-installed')
    assert.equal(rowBadge(['health-warn'], { next: true }), 'health-warn')
    assert.equal(rowBadge([], { next: true, api: true }), 'next')
    assert.equal(rowBadge([], { api: true }), 'api')
    // A read error has its own note under the row, not a badge.
    assert.equal(rowBadge(['error'], {}), null)
  })

  it('warns about a shared Quota once per Same Login: only where it was read, not where it is borrowed', () => {
    const own = acct('001', { quota: quota(64), sameLogin: ['claude:main'] })
    const borrowed = acct('main', { quota: { ...quota(64)!, from: 'claude:001' }, sameLogin: ['claude:001'] })
    assert.deepEqual(attentionReasons(own, null, NOW, 60), ['quota-high'])
    assert.deepEqual(attentionReasons(borrowed, null, NOW, 60), [])
    assert.equal(attentionWhy(borrowed, null, NOW, 60), null)
  })

  it('puts the shown members of a Same Login together, at the place of the first one', () => {
    const list = [
      acct('001', { sameLogin: ['claude:main'] }),
      acct('work'),
      acct('main', { sameLogin: ['claude:001'] }),
      acct('solo', { sameLogin: ['claude:hidden'] }),
    ]
    const names = loginClusters(list).map((x) => (Array.isArray(x) ? x.map((a) => a.name) : x.name))
    // A login whose other member is filtered out stays one plain row.
    assert.deepEqual(names, [['001', 'main'], 'work', 'solo'])
    assert.deepEqual(loginClusters([]), [])
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

  it('sorts by my order: listed names first, the others after in name order (spec §3.25)', () => {
    const list = [acct('b'), acct('a'), acct('main'), acct('c10'), acct('c9')]
    assert.deepEqual(
      sortAccounts(list, 'manual', NOW, ['c10', 'gone', 'a']).map((a) => a.name),
      ['c10', 'a', 'main', 'b', 'c9'],
    )
    assert.deepEqual(
      sortAccounts(list, 'manual', NOW).map((a) => a.name),
      ['main', 'a', 'b', 'c9', 'c10'],
      'without an order it is the name order',
    )
    assert.deepEqual(
      inDisplayOrder(['claude', 'codex', 'grok', 'pi'], (x) => x, ['grok', 'claude']),
      ['grok', 'claude', 'codex', 'pi'],
    )
  })

  it('moves one unit after a drag, from the order on screen, keeping hidden keys in place', () => {
    const all = ['main', '001', '002', '003']
    // The screen showed them by pressure: 003, main, 002 (001 is filtered out).
    assert.deepEqual(reorder(all, [['003'], ['main'], ['002']], 2, 0), ['002', '001', '003', 'main'])
    // A Same Login group moves as one unit and keeps its inside order.
    assert.deepEqual(reorder(all, [['main', '002'], ['001'], ['003']], 0, 2), ['001', '003', 'main', '002'])
    // A key the order did not have yet (a new account) goes where it was dropped.
    assert.deepEqual(reorder(['a'], [['a'], ['b']], 1, 0), ['b', 'a'])
    assert.deepEqual(reorder(all, [['main']], 0, 5), all, 'an index outside the list changes nothing')
  })

  it('does not ask for attention for a window that covers only some models', () => {
    const q = quota(10, 95)!
    q.windows![1]!.name = 'Other models'
    assert.equal(attentionWhy(acct('a', { quota: q }), null, NOW, 60), null)
  })

  it('matches every search word against name, ref, alias, tool, model and plan', () => {
    const a = acct('work', { aliases: ['cc004'], model: 'deepseek-v4', quota: { ...quota(1)!, plan: 'max' } })
    assert.ok(matchesQuery(a, '', 'Claude Code'))
    assert.ok(matchesQuery(a, 'CC004', 'Claude Code'))
    assert.ok(matchesQuery(a, 'claude max', 'Claude Code'))
    assert.ok(matchesQuery(a, 'deepseek', 'Claude Code'))
    assert.equal(matchesQuery(a, 'codex', 'Claude Code'), false)
    const pi = acct('main', {
      aliases: ['pi001', 'pi-kimi'],
      aliasArgs: { 'pi-kimi': ['--model', 'kimi-coding/k3'] },
    })
    assert.ok(matchesQuery(pi, 'kimi-coding', 'pi'))
  })

  it('reads alias arguments from own keys only', () => {
    const pi = acct('main', {
      aliases: ['constructor', 'pi-kimi'],
      aliasArgs: { 'pi-kimi': ['--model', 'k3'] },
    })
    assert.deepEqual(aliasArgsOf(pi, 'pi-kimi'), ['--model', 'k3'])
    for (const name of ['constructor', 'toString', '__proto__', 'pi001'])
      assert.equal(aliasArgsOf(pi, name), null)
    assert.equal(aliasArgsOf(acct('main', { aliases: ['constructor'] }), 'constructor'), null)
    const signed = acct('work', { identity: { email: 'work@example.com', org: 'Fake Team' } })
    assert.ok(matchesQuery(signed, 'work@example', 'Claude Code'))
    assert.ok(matchesQuery(signed, 'fake team', 'Claude Code'))
  })

  it('masks the local part of an email and keeps the domain', () => {
    assert.equal(maskEmail('alice@example.com'), 'a•••@example.com')
    assert.equal(maskEmail('a@b.co'), 'a•••@b.co')
    assert.equal(maskEmail('x.y+tag@sub.example.org'), 'x•••@sub.example.org')
    assert.equal(maskEmail('noatsign'), 'n•••')
    assert.equal(maskEmail(''), '')
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
    for (const v of ['system', 'light', 'dark']) assert.ok(`set.theme.${v}` in MESSAGES.en)
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

describe('fixPrompt', () => {
  const words = { lead: 'LEAD', hint: 'Hint: ', fixFirst: 'FIRST', check: 'CHECK' }
  const manual = {
    account: 'claude:work',
    item: 'skills',
    level: 'warn',
    message: 'is a real directory',
    hint: 'move it aside',
  }
  const auto = {
    account: 'codex:team',
    item: 'AGENTS.md',
    level: 'fail',
    message: 'is missing',
    fixable: true,
  }
  it('lists only the Findings without an automatic fix, with their hints', () => {
    assert.equal(
      fixPrompt([manual, { ...manual, account: 'grok:lab', hint: undefined }], words),
      'LEAD\n\n1. [warn] claude:work · skills\n   is a real directory\n   Hint: move it aside\n\n2. [warn] grok:lab · skills\n   is a real directory\n\nCHECK',
    )
  })
  it('asks for doctor --fix first when some Findings have an automatic fix', () => {
    const out = fixPrompt([auto, manual], words)
    assert.ok(out.endsWith('\n\nFIRST\n\nCHECK'))
    assert.ok(!out.includes('codex:team'))
  })
  it('is empty when every Finding has an automatic fix, or there are none', () => {
    assert.equal(fixPrompt([auto], words), '')
    assert.equal(fixPrompt([], words), '')
  })
})

describe('switchFailure', () => {
  it('waits on a lost connection, checks the state on a 5xx, and fails on what the server refused', () => {
    assert.equal(switchFailure({ network: true, status: 0 }), 'wait')
    assert.equal(switchFailure({ status: 502 }), 'check')
    assert.equal(switchFailure({ status: 400 }), 'fail')
    assert.equal(switchFailure({}), 'fail')
  })
})

describe('runCodeSwap', () => {
  // A fake clock: `pause` and a slow `send` move it; `states` answers each read in turn (the last one repeats).
  const run = async (o: {
    sendMs?: number
    send?: 'ok' | 'network' | 502 | 400
    states?: (boolean | null)[]
    newBuildAt?: number
  }) => {
    let t = 0
    const seen: string[] = []
    let reads = 0
    const states = o.states ?? [null]
    let last: boolean | null = null
    await runCodeSwap({
      send: async () => {
        t += o.sendMs ?? 0
        if (o.send === 'network') throw { network: true, status: 0 }
        if (o.send === 502 || o.send === 400) throw { status: o.send }
        return { updated: true }
      },
      readState: async () => {
        last = states[Math.min(reads++, states.length - 1)] ?? null
        return last !== null
      },
      landed: () => last,
      newBuild: () => o.newBuildAt !== undefined && t >= o.newBuildAt,
      reload: () => seen.push('reload'),
      now: () => t,
      pause: async (ms) => {
        t += ms
      },
      windowMs: 20000,
      pollMs: 1500,
      confirming: () => seen.push('confirming'),
      done: () => (seen.push('done'), true),
      stuck: () => seen.push('stuck'),
      fail: () => seen.push('fail'),
      unknown: () => seen.push('unknown'),
    })
    return { seen, t, reads }
  }

  it('starts the wait after a slow install, so a 5xx that landed is confirmed, not failed', async () => {
    const r = await run({ sendMs: 30000, send: 502, states: [false, false, true] })
    assert.deepEqual(r.seen.slice(0, 2), ['confirming', 'done'])
    assert.equal(r.reads >= 3, true)
  })
  it('waits the whole window for the new build after a slow successful answer', async () => {
    const r = await run({ sendMs: 30000, send: 'ok', newBuildAt: 40000 })
    assert.deepEqual(r.seen, ['done', 'reload'])
  })
  it('says stuck only after a full window without a new build', async () => {
    const r = await run({ sendMs: 30000, send: 'ok' })
    assert.deepEqual(r.seen, ['done', 'stuck'])
    assert.equal(r.t > 50000, true)
  })
  it('fails when the state still shows the old code at the end, and cannot confirm when it never answers', async () => {
    assert.deepEqual((await run({ send: 502, states: [false] })).seen, ['confirming', 'fail'])
    assert.deepEqual((await run({ send: 'network', states: [null] })).seen, ['confirming', 'unknown'])
  })
  it('fails at once on what the server refused, and reloads as soon as a new build answers', async () => {
    assert.deepEqual((await run({ send: 400 })).seen, ['fail'])
    assert.deepEqual((await run({ send: 'network', newBuildAt: 0 })).seen, ['confirming', 'reload'])
  })
})

describe('codeSwapOutcome', () => {
  const at = (failure: 'wait' | 'check' | 'fail' | null, landed: boolean | null, waitedOut: boolean) =>
    codeSwapOutcome({ failure, landed, waitedOut })
  it('trusts an answer, and a refusal', () => {
    assert.equal(at(null, null, false), 'done')
    assert.equal(at(null, false, true), 'done')
    assert.equal(at('fail', true, false), 'failed')
    assert.equal(at('fail', null, true), 'failed')
  })
  it('after a cut answer claims success only once the state shows the change', () => {
    for (const f of ['wait', 'check'] as const) {
      assert.equal(at(f, true, false), 'done')
      assert.equal(at(f, true, true), 'done')
    }
  })
  it('keeps reading while the wait lasts, whether the state is unreadable or not there yet', () => {
    for (const f of ['wait', 'check'] as const) {
      assert.equal(at(f, null, false), 'waiting')
      assert.equal(at(f, false, false), 'waiting')
    }
  })
  it('after the wait fails when the state shows no change and says so plainly when it cannot be read', () => {
    for (const f of ['wait', 'check'] as const) {
      assert.equal(at(f, false, true), 'failed')
      assert.equal(at(f, null, true), 'unknown')
    }
  })
})

describe('canLeaveLocal', () => {
  it('offers the switch as the update only while the global sideby runs the Local Build and the Panel may write', () => {
    assert.equal(canLeaveLocal({ localSwitch: { running: 'local' } }, false), true)
    assert.equal(canLeaveLocal({ localSwitch: { running: 'local' } }, true), false)
    assert.equal(canLeaveLocal({ localSwitch: { running: 'npm' } }, false), false)
    assert.equal(canLeaveLocal({}, false), false)
    assert.equal(canLeaveLocal(null, false), false)
  })
})

describe('panelFixes', () => {
  it('takes an outdated skill only while sideby may update it', () => {
    assert.equal(panelFixes({ code: 'skill.outdated' }, true), true)
    assert.equal(panelFixes({ code: 'skill.outdated' }, false), false)
    assert.equal(panelFixes({ code: 'link.dangling' }, true), false)
    assert.equal(panelFixes({}, true), false)
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

describe('panelLang', () => {
  it('uses a host lang of en or zh over the saved choice and the browser', () => {
    assert.equal(panelLang('zh', 'en', 'en-US'), 'zh')
    assert.equal(panelLang('en', 'zh', 'zh-CN'), 'en')
    assert.equal(panelLang('en', '', 'zh-TW'), 'en')
  })
  it('keeps the saved choice, then the browser language, for auto or no host lang', () => {
    for (const host of ['auto', undefined as unknown as string]) {
      assert.equal(panelLang(host, 'zh', 'en-US'), 'zh')
      assert.equal(panelLang(host, 'en', 'zh-CN'), 'en')
      assert.equal(panelLang(host, '', 'zh-CN'), 'zh')
      assert.equal(panelLang(host, '', 'ZH'), 'zh')
      assert.equal(panelLang(host, '', 'en-GB'), 'en')
      assert.equal(panelLang(host, '', undefined as unknown as string), 'en')
    }
  })
})

describe('panel page lang', () => {
  const boot = (html: string) =>
    JSON.parse(
      /<script type="application\/json" id="sideby-boot">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}',
    )
  it('carries a host lang into the boot data, the html element and a settings button hidden until the page decides', () => {
    const zh = renderPage({ basePath: '', token: 't', lang: 'zh' })
    assert.equal(boot(zh).lang, 'zh')
    assert.match(zh, /<html lang="zh-CN">/)
    assert.match(zh, /<button id="settings" [^>]*hidden>/)
    const en = renderPage({ basePath: '', token: 't', lang: 'en' })
    assert.equal(boot(en).lang, 'en')
    assert.match(en, /<html lang="en">/)
    assert.match(en, /<button id="settings" [^>]*hidden>/)
  })
  it('leaves the page as before for auto or no lang', () => {
    for (const html of [
      renderPage({ basePath: '', token: 't' }),
      renderPage({ basePath: '', token: 't', lang: 'auto' }),
    ]) {
      assert.equal(boot(html).lang, 'auto')
      assert.match(html, /<html lang="en">/)
      assert.match(
        html,
        /<button id="settings" class="btn" type="button" aria-haspopup="dialog" aria-expanded="false">/,
      )
    }
  })
  it('carries a Local Build into the boot data, so the version pill can name its commit', () => {
    const local = { commit: 'abc1234', dirty: true, builtAt: '2026-10-16T12:00:00.000Z' }
    assert.deepEqual(boot(renderPage({ basePath: '', token: 't', local })).local, local)
    assert.equal(boot(renderPage({ basePath: '', token: 't' })).local, null)
    assert.match(
      PAGE_SCRIPT,
      /'-dev' \+ \(l\.commit \? ' · ' \+ l\.commit \+ \(l\.dirty \? '\+' : ''\) : ''\)/,
    )
  })
  it('picks the language through panelLang and never saves it while the host fixes it', () => {
    assert.match(
      PAGE_SCRIPT,
      /let lang = panelLang\(BOOT\.lang, viewPrefs\(\)\.language, navigator\.language\)/,
    )
    assert.match(PAGE_SCRIPT, /if \(!LANG_FIXED\) out\.push\('lang'\)/)
    // The only writes of the language are in setLang, after its guard: config, or the browser when read-only.
    assert.equal(PAGE_SCRIPT.match(/prefs\.lang =/g)?.length, 1)
    assert.equal(PAGE_SCRIPT.match(/cfgPanel\.language =/g)?.length, 1)
    assert.match(
      PAGE_SCRIPT,
      /if \(LANG_FIXED \|\| v === lang\) return\n\s+if \(CFG\) \{ cfgPanel\.language = v; saveCfg\(\{ language: v \}\) \} else \{ prefs\.lang = v; savePrefs\(\) \}/,
    )
  })
  it('takes theme and language from config, writes them there, and migrates the browser choice once (spec §3.29)', () => {
    const body = (name: string) => {
      const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
      assert.ok(at >= 0, name)
      return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
    }
    assert.match(PAGE_SCRIPT, /const CFG = !BOOT\.readOnly/)
    assert.match(
      body('setTheme'),
      /if \(CFG\) \{ cfgPanel\.theme = v; saveCfg\(\{ theme: v \}\) \} else \{ prefs\.theme = v; savePrefs\(\) \}/,
    )
    assert.match(body('applyTheme'), /viewPrefs\(\)\.theme/)
    assert.match(
      PAGE_SCRIPT,
      /async function saveCfg\(patch, quiet\) \{\n[^\n]*\n\s+try \{ await api\('\/api\/panel\/settings', patch\)/,
    )
    // A change made elsewhere shows at the next read, but never while a write is on its way.
    assert.match(body('adoptPanel'), /if \(!CFG \|\| cfgSaving\) return/)
    assert.match(PAGE_SCRIPT, /adoptPanel\(state\.panel\)/)
    assert.match(
      PAGE_SCRIPT,
      /if \(CFG && !prefs\.cfgDone\) \{\n\s+if \(!cfgMigrate\) \{ prefs\.cfgDone = true; savePrefs\(\) \}/,
    )
  })
})

describe('updatedAge', () => {
  it('says just now for the whole first minute, so the header does not tick between auto refreshes', () => {
    for (const ms of [0, 4999, 5000, 20000, 59999])
      assert.deepEqual(updatedAge(ms), { key: 'time.justNow' }, String(ms))
  })
  it('counts whole minutes, hours and days after that', () => {
    assert.deepEqual(updatedAge(60000), { key: 'time.minAgo', n: 1 })
    assert.deepEqual(updatedAge(119999), { key: 'time.minAgo', n: 1 })
    assert.deepEqual(updatedAge(59 * 60000 + 59999), { key: 'time.minAgo', n: 59 })
    assert.deepEqual(updatedAge(3600000), { key: 'time.hAgo', n: 1 })
    assert.deepEqual(updatedAge(24 * 3600000), { key: 'time.dAgo', n: 1 })
  })
  it('treats a negative or unknown age as just now', () => {
    assert.deepEqual(updatedAge(-5000), { key: 'time.justNow' })
    assert.deepEqual(updatedAge(Number.NaN), { key: 'time.justNow' })
  })
})

describe('Auto Handoff helpers', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const acct = (ref: string, used: number, kind = 'subscription') => {
    const [family, name] = ref.split(':') as [string, string]
    return {
      ref,
      family,
      name,
      kind,
      quota: {
        status: 'ok',
        windows: [{ label: '5h', windowMinutes: 300, usedPercent: used, resetsAt: '2026-10-09T15:00:00Z' }],
      },
    }
  }
  it('hints at the fullest starter account at the threshold, only while Auto Handoff is off', () => {
    const accounts = [
      acct('claude:001', 96),
      acct('claude:002', 98),
      acct('codex:main', 99, 'api'),
      acct('pi:main', 99),
    ]
    assert.deepEqual(handoffHintAccount(accounts, { auto: false, threshold: 95 }, ['claude'], now), {
      ref: 'claude:002',
      pressure: 98,
    })
    assert.equal(handoffHintAccount(accounts, { auto: true, threshold: 95 }, ['claude'], now), null)
    assert.equal(
      handoffHintAccount([acct('claude:001', 90)], { auto: false, threshold: 95 }, ['claude'], now),
      null,
    )
  })
  it('turns the form into only what changed; an empty order goes back to ranking by quota', () => {
    const s = {
      auto: false,
      sameFamily: false,
      prepareAt: 80,
      threshold: 95,
      waitIfResetWithinMinutes: 30,
      countdownSeconds: 10,
      families: { claude: { policy: 'order' as const, order: ['cc002'] } },
      adaptive: true,
      otherFamilies: false,
      familyOrder: [],
      api: false,
      crossOrganization: [],
    }
    const same = {
      auto: false,
      sameFamily: false,
      prepareAt: 80,
      threshold: 95,
      wait: 30,
      countdown: 10,
      orders: { claude: { policy: 'order', order: ['cc002'] } },
    }
    assert.deepEqual(handoffChangeOf(s, same), {})
    assert.deepEqual(
      handoffChangeOf(s, {
        ...same,
        auto: true,
        threshold: 90,
        orders: { claude: { policy: 'pressure', order: ['cc002'] } },
      }),
      {
        auto: true,
        threshold: 90,
        orders: [{ family: 'claude', order: [] }],
      },
    )
    assert.deepEqual(handoffChangeOf(s, { ...same, crossOrganization: ['codex:team'] }), {
      crossOrganization: ['codex:team'],
    })
  })
})

describe('Display Order in the page (spec §3.25)', () => {
  const body = (name: string) => {
    const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
    return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
  }
  it('puts the grip on group heads and on arrange-mode rows only, not on ordinary rows', () => {
    assert.match(body('group'), /dragHandle\('family'/)
    assert.match(body('group'), /ui\.order\.units\[fam\]/)
    assert.match(body('arrangeRow'), /dragHandle\('account'/)
    assert.doesNotMatch(body('row'), /dragHandle/)
    assert.doesNotMatch(body('loginRow'), /dragHandle/)
    assert.match(body('dragHandle'), /!ui\.arrange\) return null/)
    assert.doesNotMatch(body('appRow'), /dragHandle/)
  })
  it('keeps pins in the menu and the arrange mode, and puts the pin before the name, not at its end', () => {
    assert.doesNotMatch(PAGE_SCRIPT, /pinButton|row-pin/)
    for (const name of ['row', 'loginRow', 'card']) assert.doesNotMatch(body(name), /pin/i)
    // The slot before the name (spec §3.27, 2026-10-18): a button that pins or unpins; read-only, the mark only.
    assert.match(body('nameLine'), /pinSlot\(a\),\s*h\('span', \{ class: 'name'/)
    assert.match(body('pinSlot'), /if \(BOOT\.readOnly\) return pinMark\(a\)/)
    assert.match(body('pinSlot'), /t\(on \? 'pin\.unpin' : 'pin\.pin'\)/)
    assert.match(body('pinSlot'), /e\.stopPropagation\(\); togglePin\(a\)/)
    assert.match(body('arrangeRow'), /pinMark\(a\),\s*h\('span', \{ class: 'name'/)
    assert.match(body('pinMark'), /isPinned\(a\)[\s\S]*'aria-label': t\('pin\.mark'\)/)
    assert.match(body('pinItem'), /togglePin\(a\)/)
    assert.match(body('accountMenu'), /\[pinItem\(a\)/)
    assert.match(body('loginMenu'), /accountMenu\(ms\[0\], anchor, ms\.slice\(1\)\)/)
    // A Same Login row lists the shared actions once; each other directory is one item that opens its own actions.
    assert.match(
      body('accountMenu'),
      /sub: \[up, '-', \{ header: [\s\S]*\.\.\.dirItems\(m\), \.\.\.dirTools\(m\)\]/,
    )
    assert.match(body('accountMenu'), /t\('menu\.groupOtherDirs'\)/)
    assert.match(body('arrangeRow'), /togglePin\(a\)/)
    assert.match(body('arrangeRow'), /t\('pin\.full'/)
  })
  it('opens the arrange mode from Settings too, not only from the sort menu', () => {
    assert.match(body('settingsSections'), /out\.push\('order'\)/)
    assert.match(body('settingsGroups'), /t\('set\.order'\)[\s\S]*startArrange\(\)/)
  })
  it('never switches the sort to my order behind the user, only the arrange mode does', () => {
    assert.doesNotMatch(body('moveUnit'), /prefs\.sort/)
    assert.match(body('startArrange'), /prefs\.sort = 'manual'/)
  })
  it('puts pinned accounts first in every sort', () => {
    assert.match(
      PAGE_SCRIPT,
      /withPinned\(sortAccounts\(list, prefs\.sort, now, accountOrder\(fam\)\), pinnedOf\(fam\)\)/,
    )
  })
})

describe('menuPlacement', () => {
  const view = { width: 1280, height: 700 }
  const at = (top: number, left = 1000) => ({ top, bottom: top + 28, left, right: left + 28 })
  it('opens below when the whole menu fits there, its right edge on the anchor', () => {
    assert.deepEqual(menuPlacement(at(100), { width: 260, height: 300 }, view, 'end'), {
      left: 768,
      top: 132,
      maxHeight: 560,
      above: false,
    })
  })
  it('fits exactly below at the edge, and flips above one pixel later', () => {
    // Room below: 700 - 8 - 128 - 4 = 560.
    assert.equal(menuPlacement(at(100), { width: 260, height: 560 }, view, 'end').above, false)
    const up = menuPlacement(at(600), { width: 260, height: 561 }, view, 'end')
    assert.deepEqual(up, { left: 768, top: 35, maxHeight: 588, above: true })
    assert.equal(up.top + 561, 600 - 4)
  })
  it('opens above near the bottom of the window when it fits there', () => {
    const p = menuPlacement(at(620), { width: 260, height: 400 }, view, 'end')
    assert.deepEqual(p, { left: 768, top: 216, maxHeight: 608, above: true })
  })
  it('caps a menu taller than either side at the larger side, so it scrolls inside', () => {
    assert.deepEqual(menuPlacement(at(500), { width: 260, height: 900 }, view, 'end'), {
      left: 768,
      top: 8,
      maxHeight: 488,
      above: true,
    })
    assert.deepEqual(menuPlacement(at(150), { width: 260, height: 900 }, view, 'end'), {
      left: 768,
      top: 182,
      maxHeight: 510,
      above: false,
    })
  })
  it('takes the whole height of a tiny window when neither side has room', () => {
    const tiny = { width: 390, height: 200 }
    const p = menuPlacement(
      { top: 90, bottom: 118, left: 340, right: 368 },
      { width: 260, height: 500 },
      tiny,
      'end',
    )
    assert.deepEqual(p, { left: 108, top: 8, maxHeight: 184, above: false })
    // A short menu that fits one side of a tiny window still goes there.
    assert.equal(
      menuPlacement({ top: 20, bottom: 48, left: 0, right: 28 }, { width: 200, height: 60 }, tiny, 'start')
        .top,
      52,
    )
    assert.equal(
      menuPlacement(at(0), { width: 200, height: 60 }, { width: 100, height: 10 }, 'end').maxHeight,
      0,
    )
  })
  it('keeps it inside the window sideways', () => {
    assert.equal(menuPlacement(at(100, 4), { width: 260, height: 100 }, view, 'end').left, 8)
    assert.equal(menuPlacement(at(100, 1270), { width: 260, height: 100 }, view, 'start').left, 1012)
    assert.equal(menuPlacement(at(100, 40), { width: 260, height: 100 }, view, 'start').left, 40)
  })
})

describe('floating menus in the page', () => {
  const body = (name: string) => {
    const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
    return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
  }
  it('caps its height with menuPlacement and lets it scroll inside without closing', () => {
    assert.match(body('placeFloat'), /menuPlacement\(/)
    assert.match(body('placeFloat'), /'max-height', p\.maxHeight/)
    assert.match(
      PAGE_SCRIPT,
      /addEventListener\('scroll', \(e\) => \{ if \(menu\.el && !menu\.el\.contains\(e\.target\)\) placeFloat\(\) \}/,
    )
    assert.doesNotMatch(PAGE_SCRIPT, /addEventListener\('scroll', \(\) => closeMenu\(\)/)
    assert.match(pageStyles(), /\.menu \{[^}]*overflow-y: auto; overscroll-behavior: contain;/)
  })
})

describe('whole-Panel UX pass (three-way audit, 2026-10-17)', () => {
  const body = (name: string) => {
    const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
    return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
  }
  it('explains Suggested on click instead of copying a command without a word', () => {
    assert.match(body('nextTag'), /openPopover\(/)
    assert.doesNotMatch(body('nextTag'), /addEventListener\('click', \(\) => copyText/)
  })
  it("shows a Health finding in plain words, with the check's own text under Details", () => {
    assert.match(body('findingRow'), /'finding\.' \+ f\.code/)
    assert.match(body('findingRow'), /h\('details', \{ class: 'finding-raw' \}/)
    for (const code of [
      'link.real-file',
      'symlink-forbidden',
      'missing',
      'copy.stale',
      'credential.mode',
      'json-key.drift',
    ])
      assert.ok(MESSAGES.zh[`finding.${code}` as keyof typeof MESSAGES.zh], code)
  })
  it('keeps the colour of old quota and says its age in words', () => {
    assert.match(body('quotaBlock'), /q-asof/)
    assert.doesNotMatch(body('meter'), /m-asof/)
  })
  it('puts the start command on the row, and groups the menu by open, copy and manage', () => {
    assert.match(body('row'), /runButton\(a\)/)
    assert.match(body('accountMenu'), /menu\.groupOpen[\s\S]*menu\.groupCopy[\s\S]*menu\.groupManage/)
  })
  it('shows only the empty state when there is no account: no summary, no health check', () => {
    assert.match(body('renderPageChrome'), /none && id !== 'accounts-page'/)
  })
  it('lets the user choose which directory names a Same Login row, through the Display Order', () => {
    assert.match(body('loginMembers'), /accountOrder\(members\[0\]\.family\)/)
    assert.match(body('loginDetail'), /showLoginAs\(ms, m\)/)
    assert.match(body('showLoginAs'), /next\.accounts\[m\.family\] = names/)
  })
  it('puts desktop app groups (Grok Bot) in the Display Order, draggable like the tools', () => {
    assert.match(body('familyOrder'), /appIds\(\)/)
    assert.match(body('appGroup'), /dragHandle\('family', id, id, app\)/)
    assert.match(body('appGroup'), /appArrangeRow\(p, id\)/)
    assert.match(body('appArrangeRow'), /dragHandle\('account', id, p\.name, name\)/)
  })
  it('points to the sideby skill from Settings, the arrange bar and the empty state', () => {
    assert.match(body('settingsSections'), /out\.push\('ai'\)/)
    assert.match(body('arrangeBar'), /openAsk\(/)
    assert.match(body('emptyState'), /openAsk\(\{ task: 'account'/)
    assert.match(body('askYourself'), /BOOT\.skillInstall/)
  })
  it('offers every AI Task entry of spec §3.28 and keeps the copy fallbacks', () => {
    const asyncBody = (name: string) => {
      const at = PAGE_SCRIPT.indexOf(`  async function ${name}(`)
      assert.ok(at >= 0, name)
      return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
    }
    // Settings: the general box, a plugin and the terminal choice (the last one only where it can be saved).
    assert.match(body('aiLink'), /t\('ai\.title'\)[^\n]*openAsk\(\)/)
    assert.match(body('settingsGroups'), /task: 'plugin'/)
    assert.match(body('settingsGroups'), /if \(!BOOT\.readOnly\) general\.push\(link\(t\('term\.title'\)/)
    // Auto Handoff: Let AI tune it, with the handoff facts (spec §3.29).
    assert.match(body('askHandoff'), /task: 'handoff', context: \{ handoff: handoffTaskFacts\(/)
    assert.match(body('renderHandoffPage'), /onclick: askHandoff/)
    assert.match(body('renderHandoff'), /onclick: askHandoff/)
    // Health check: Let AI fix it with those findings; the read-only Panel keeps Copy for AI.
    assert.match(body('renderCheckup'), /prompt && BOOT\.readOnly \? [^\n]*fix\.copyAi/)
    assert.match(
      body('renderCheckup'),
      /prompt && !BOOT\.readOnly \? [^\n]*task: 'fix', context: \{ findings: taskFindings\(forAi\(findings\)\)/,
    )
    // Quota cell, new-account dialog (Let AI set it up, Other tool…).
    assert.match(body('askWhy'), /quotaAskable\(q\.reason\)/)
    assert.match(body('askWhy'), /task: 'quota'/)
    assert.match(body('renderCreate'), /task: 'host'/)
    assert.match(body('renderCreate'), /task: 'account'/)
    // Sign in opens the terminal and copies the command when it cannot; read-only copies at once.
    assert.match(asyncBody('signIn'), /if \(BOOT\.readOnly\) \{ copyText\(cmd\); return \}/)
    assert.match(asyncBody('signIn'), /api\('\/api\/login'/)
    assert.match(asyncBody('signIn'), /await copyText\(cmd, cmd\)/)
    // The dialog copies the prompt when no account can run it or the Panel is read-only.
    assert.match(
      body('renderAsk'),
      /const canOpen = !BOOT\.readOnly && !ak\.loading && !ak\.error && ak\.account/,
    )
    assert.match(asyncBody('askCopyPrompt'), /api\('\/api\/ask\/prompt'/)
    // The key never stays in the page state: it is read from the field when saving.
    assert.match(asyncBody('keySave'), /const value = ky\.els\.value\.value/)
    assert.doesNotMatch(asyncBody('keySave'), /ky\.value =/)
    assert.match(body('renderKey'), /type: 'password'/)
  })
})

describe('withPinned', () => {
  const list = [{ name: 'main' }, { name: 'work' }, { name: '001' }, { name: '002' }]
  const names = (x: { name: string }[]) => x.map((a) => a.name)
  it('leaves the list as it is with nothing pinned', () => {
    assert.deepEqual(names(withPinned(list)), ['main', 'work', '001', '002'])
    assert.deepEqual(names(withPinned(list, [])), ['main', 'work', '001', '002'])
  })
  it('puts pinned names first, in pin order, and keeps the order of the rest', () => {
    assert.deepEqual(names(withPinned(list, ['002', 'work'])), ['002', 'work', 'main', '001'])
  })
  it('keeps a Same Login together when only one of its directories is pinned', () => {
    const login = [
      { name: 'main', sameLogin: ['claude:001'] },
      { name: 'work' },
      { name: '001', sameLogin: ['claude:main'] },
    ]
    assert.deepEqual(names(withPinned(login, ['001'])), ['main', '001', 'work'])
  })
  it('skips pinned names that are gone or filtered out', () => {
    assert.deepEqual(names(withPinned(list, ['gone', '001'])), ['001', 'main', 'work', '002'])
  })
})

describe('hiddenIn', () => {
  it('hides a whole Family, a named Account, and a Same Login through any of its directories', () => {
    const display = { hiddenFamilies: ['pi'], hidden: { claude: ['old'] } }
    assert.equal(hiddenIn({ family: 'pi', name: 'main' }, display), true)
    assert.equal(hiddenIn({ family: 'claude', name: 'old' }, display), true)
    assert.equal(hiddenIn({ family: 'claude', name: 'main', sameLogin: ['claude:old'] }, display), true)
    assert.equal(hiddenIn({ family: 'claude', name: 'work' }, display), false)
    assert.equal(hiddenIn({ family: 'codex', name: 'old' }, display), false)
    assert.equal(hiddenIn({ family: 'claude', name: 'old' }, {}), false)
  })
})

describe('pinnedIn', () => {
  it('pins a Same Login as a whole, whichever directory the pin names', () => {
    assert.equal(pinnedIn({ name: 'main', sameLogin: ['claude:001'] }, ['001']), true)
    assert.equal(pinnedIn({ name: '001', sameLogin: ['claude:main'] }, ['001']), true)
    assert.equal(pinnedIn({ name: 'work' }, ['001']), false)
    assert.equal(pinnedIn({ name: 'work' }, []), false)
  })
})

describe('arrange mode keys', () => {
  it('leaves Escape to a menu or popover that already took it', () => {
    assert.match(PAGE_SCRIPT, /e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| !ui\.arrange/)
  })
})

describe('Same Login rows', () => {
  it('are one row with the quota once, and list each directory when opened (ADR-0026)', () => {
    const at = PAGE_SCRIPT.indexOf('  function loginRow(')
    const loginRow = PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
    assert.equal((loginRow.match(/quotaBlock\(/g) || []).length, 1)
    assert.match(loginRow, /lastUsed\(newestOf\(ms\)\)/)
    assert.match(loginRow, /loginDetail\(ms\)/)
    assert.doesNotMatch(PAGE_SCRIPT, /function sharedQuota\(/)
  })
})

describe('Same Login fold key', () => {
  it('names the group by its members in a fixed order, so the fold survives another sort', () => {
    assert.equal(loginKey(['claude:main', 'claude:001']), 'login:claude:001,claude:main')
    assert.equal(loginKey(['claude:001', 'claude:main']), loginKey(['claude:main', 'claude:001']))
  })
})

describe('Remote Control button state', () => {
  const g = (state: string, ...accounts: string[]) => ({ state, accounts })
  it('says on while a subscription Account starts it, default when one is left to Claude Code, off otherwise', () => {
    assert.equal(remoteControlSummary([], []), null)
    assert.equal(remoteControlSummary([g('off', 'claude:main'), g('on', 'claude:001')], []), 'on')
    assert.equal(remoteControlSummary([g('off', 'claude:main'), g('default', 'claude:001')], []), 'default')
    assert.equal(
      remoteControlSummary([g('off', 'claude:main', 'claude:001'), g('missing', 'claude:002')], []),
      'off',
    )
  })
  it('changes the groups that do not hold the chosen side yet, a default counting as either', () => {
    const gs = [g('on', 'a'), g('off', 'b'), g('default', 'c'), g('missing', 'd'), g('blocked', 'e')]
    assert.deepEqual(
      remoteControlTodo(gs, 'on').map((x) => x.accounts[0]),
      ['b', 'c'],
    )
    assert.deepEqual(
      remoteControlTodo(gs, 'off').map((x) => x.accounts[0]),
      ['a', 'c'],
    )
  })
  it('ignores groups used only by API Accounts', () => {
    assert.equal(remoteControlSummary([g('off', 'claude:main'), g('on', 'claude:ds')], ['claude:ds']), 'off')
    assert.equal(remoteControlSummary([g('on', 'claude:main', 'claude:ds')], ['claude:ds']), 'on')
  })
})

describe('stripSecrets', () => {
  const random40 = 'q8Zr3kLm0vXy7TbN2wPc9HdJ4sGf1aEu6iOo5nRt'
  it('removes keys with a known prefix and long random strings', () => {
    const out = stripSecrets(
      `key ${SK}ant-api03-AbCdEfGh1234567890_xyz and ${XAI}0123456789abcdefABCD, also ${random40}.`,
    )
    assert.equal(out.text, 'key [key removed] and [key removed], also [key removed].')
    assert.equal(out.removed, true)
  })
  it('keeps a variable name before its value and a key glued to Chinese text', () => {
    assert.equal(stripSecrets(`ANTHROPIC_API_KEY=${random40}`).text, 'ANTHROPIC_API_KEY=[key removed]')
    assert.equal(stripSecrets(`我的密钥是${SK}abcdefghij0123456789`).text, '我的密钥是[key removed]')
    for (const key of [
      'gsk_abcdefghij0123456789',
      'AIzaSyA1b2C3d4E5f6G7h8',
      'ghp_abcdefghij0123456789',
      'github_pat_11ABCDEFG0123456789',
    ])
      assert.equal(stripSecrets(key).text, '[key removed]', key)
  })
  // Joined at run time so this file never holds a key-shaped string (leak-check).
  const akia = ['AK', 'IA', 'ABCDEFGHIJ012345'].join('')
  const asia = ['AS', 'IA', 'Z9Y8X7W6V5U4T3S2'].join('')
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'a'.repeat(43)].join('.')
  it('removes AWS access key ids, JWTs and sk-proj- keys, also inside URLs and query strings', () => {
    for (const key of [akia, asia, jwt, `${SK}proj-Ab12Cd34Ef56Gh78Ij90`, `${jwt.slice(0, -43)}`])
      assert.deepEqual(stripSecrets(`key ${key} end`), { text: 'key [key removed] end', removed: true }, key)
    assert.equal(
      stripSecrets(`https://bucket.example.com/x?AWSAccessKeyId=${akia}&Signature=abc`).text,
      'https://bucket.example.com/x?AWSAccessKeyId=[key removed]&Signature=abc',
    )
    assert.equal(
      stripSecrets(`https://app.example.com/cb?token=${jwt}`).text,
      'https://app.example.com/cb?token=[key removed]',
    )
    assert.equal(stripSecrets(`Authorization: Bearer ${jwt}`).text, 'Authorization: Bearer [key removed]')
    assert.equal(stripSecrets(`AWS_ACCESS_KEY_ID=${akia}`).text, 'AWS_ACCESS_KEY_ID=[key removed]')
  })
  it('keeps words that only look close to an AWS key id or a JWT', () => {
    const text = [
      'AKIAabcdefghijklmnop is lowercase, AKIA0123 is short',
      'see /tmp/eyJ/notes.md and eyJhbG.short.x',
      'https://example.com/page?id=eyJ',
    ].join('\n')
    assert.deepEqual(stripSecrets(text), { text, removed: false })
  })
  it('may remove a 40-character git SHA, as any long mixed run', () => {
    assert.equal(stripSecrets('commit 0a1b2c3d4e5f60718293a4b5c6d7e8f901234567').text, 'commit [key removed]')
  })
  it('keeps URLs, file paths, emails, words and Chinese text', () => {
    const text = [
      'Docs: https://docs.example.com/api/keys?session=0123456789abcdefghijABCDEFGHIJ0123456789&lang=en',
      'Path: /tmp/sideby-demo/home/.cache/0123456789abcdef0123456789abcdef/settings.json',
      'Mail me@example.com about internationalization-and-localization-guidelines',
      '把 claude:work 的额度修好，谢谢 task-skip-xai-handling risk-assessment-guidelines-v2',
    ].join('\n')
    assert.deepEqual(stripSecrets(text), { text, removed: false })
  })
  it('passes quotes, command substitution, backticks and newlines through verbatim', () => {
    const text = `say "hi" and 'bye'\n$(rm -rf ~) \`whoami\`; rm x\n\n  indented`
    assert.deepEqual(stripSecrets(text), { text, removed: false })
  })
  it('handles empty text', () => {
    assert.deepEqual(stripSecrets(''), { text: '', removed: false })
  })
})

describe('fileSize', () => {
  it('shows KB below a megabyte and MB from there', () => {
    assert.equal(fileSize(10), '1 KB')
    assert.equal(fileSize(300 * 1024), '300 KB')
    assert.equal(fileSize(1.25 * 1024 * 1024), '1.3 MB')
    assert.equal(fileSize(150 * 1024 * 1024), '150 MB')
  })
})

describe('askCopy', () => {
  const free = ['ai.ask.quota', 'ai.ask.new']
  for (const lang of ['en', 'zh'] as const)
    it(`gives every task kind its own title, placeholder and examples in ${lang}`, () => {
      const table = MESSAGES[lang]
      const has = (k: string) => Object.hasOwn(table, k)
      for (const task of AI_TASK_KINDS) {
        const copy = askCopy(task, has, free)
        if (task === 'free') {
          assert.deepEqual(copy, { title: 'ask.title', placeholder: 'ask.ph.free', chips: free })
          continue
        }
        assert.equal(copy.title, `ask.title.${task}`)
        assert.equal(copy.placeholder, `ask.ph.${task}`)
        assert.ok(copy.chips.length >= 2 && copy.chips.length <= 3, task)
        for (const k of [copy.title, copy.placeholder, ...copy.chips])
          assert.ok(table[k]?.trim(), `${lang} ${k}`)
      }
      for (const k of ['ask.title', 'ask.ph.free', ...free]) assert.ok(table[k]?.trim(), `${lang} ${k}`)
    })
  it("falls back to free's strings for a task without its own", () => {
    assert.deepEqual(
      askCopy('later', () => false, free),
      { title: 'ask.title', placeholder: 'ask.ph.free', chips: free },
    )
    const partial = askCopy('later', (k) => k === 'ask.title.later', free)
    assert.deepEqual(partial, { title: 'ask.title.later', placeholder: 'ask.ph.free', chips: free })
  })
})

describe('taskPrompt', () => {
  const context = {
    account: 'claude:work',
    family: 'claude',
    findings: [
      {
        code: 'link.dangling',
        account: 'claude:work',
        item: 'skills',
        message: 'points nowhere',
        hint: 'remove it',
      },
    ],
    quotaReason: 'no status line tap',
    version: '0.16.1',
  }
  const tasks = ['free', 'fix', 'quota', 'account', 'host', 'plugin'] as const
  const expect: Record<string, Record<(typeof tasks)[number], string[]>> = {
    en: {
      free: ['What to do\nAsk me what I want to do with sideby, then do it for me.'],
      fix: [
        "What to do\nFix the problems below that sideby's health check cannot fix by itself.",
        'Pointers\nRun `sideby doctor --json` first',
      ],
      quota: [
        'What to do\nsideby shows no quota for claude:work. Find out why and make it show.',
        'Pointers\nUse `sideby quota --json`',
      ],
      account: [
        'What to do\nHelp me add a claude account to sideby',
        "vendor's official docs",
        '`sideby key <account>`, then try it with `sideby try <account>`',
        'run `sideby login <account>`',
      ],
      host: [
        'first as a local Family Plugin',
        '`sideby plugins new <id>`',
        'Host version and the date',
        '`sideby plugins check <id>` and try it in a demo HOME',
      ],
      plugin: ['What to do\nHelp me write a sideby plugin or hook.', 'docs/guide/plugins.md'],
    },
    zh: {
      free: ['要做的事\n问我想用 sideby 做什么，然后帮我做。'],
      fix: ['要做的事\nsideby 的体检发现了下面这些不能自动修复的问题', '提示\n先运行 `sideby doctor --json`'],
      quota: ['额度格没有显示 claude:work 的额度', '提示\n用 `sideby quota --json`'],
      account: [
        '帮我在 sideby 里加一个 claude 账号',
        '厂商的官方文档',
        '`sideby try <账号>`',
        '`sideby login <账号>`',
      ],
      host: ['先做成本机的 Family 插件', '`sideby plugins new <id>`', '宿主的版本和日期', '演示 HOME'],
      plugin: ['帮我写一个 sideby 插件或 hook。', 'docs/guide/plugins.zh-CN.md'],
    },
  }
  const fixed = {
    en: [
      'Context\n- Account: claude:work\n- Family: claude\n- Health check findings:\n  1. [link.dangling] claude:work · skills: points nowhere\n     remove it\n- Quota reason: no status line tap\n- sideby version: 0.16.1\n- Panel language: English',
      'Rules\n- Use the sideby skill; its references/ai-tasks.md says how.',
      '`npx skills add Adonis0123/sideby -g`',
      'add `--yes` only after I agree',
      'Never sign in for me and never ask me to send you an API key',
      'ask me whether to share the improvement with sideby. Only with my yes, follow the CONTRIBUTING.md',
      'remove my own account names, paths and emails.',
    ],
    zh: [
      '上下文\n- 账号：claude:work\n- 家族：claude\n- 体检发现：\n  1. [link.dangling] claude:work · skills: points nowhere\n     remove it\n- 额度原因：no status line tap\n- sideby 版本：0.16.1\n- 面板语言：中文',
      '规则\n- 先用 sideby skill，怎么做见它的 references/ai-tasks.md。',
      '`npx skills add Adonis0123/sideby -g`',
      '我同意后才加 `--yes`',
      '不要替我登录，也不要让我把密钥发给你',
      '问我愿不愿意把这次的改进分享给 sideby。我同意后，按 sideby 仓库的 CONTRIBUTING.md',
      '去掉我自己的账号名、路径和邮箱。',
    ],
  }
  for (const lang of ['en', 'zh'] as const)
    for (const task of tasks)
      it(`writes the ${task} prompt in ${lang}`, () => {
        const out = taskPrompt({ task, context, lang }, stripSecrets)
        for (const part of [...expect[lang]![task], ...fixed[lang]])
          assert.ok(out.includes(part), `${part}\n---\n${out}`)
        assert.ok(out.startsWith(lang === 'zh' ? '要做的事\n' : 'What to do\n'))
        assert.ok(out.endsWith(lang === 'zh' ? '邮箱。' : 'emails.'))
      })

  it('writes the terminal prompt with the saved command, the installed terminals and the terminal-table invitation', () => {
    const ctx = {
      terminalCustom: 'my-term --cwd {cwd} -e {cmd}',
      terminals: ['Terminal', 'Ghostty'],
      version: '0.16.1',
    }
    const en = taskPrompt({ task: 'terminal', text: 'I use Warp', context: ctx, lang: 'en' }, stripSecrets)
    for (const part of [
      'What to do\nHelp sideby open AI Tasks in the terminal I use: write a custom terminal command.\nIn my words: I use Warp',
      'Context\n- Custom terminal command now: my-term --cwd {cwd} -e {cmd}\n- Supported terminals installed here: Terminal, Ghostty\n- sideby version: 0.16.1',
      "Pointers\nAsk me which terminal I use first. Read only that terminal's official docs and its `--help`",
      '`{cmd}` is the command and `{cwd}` the folder',
      "Save it with `sideby terminal --custom '<template>'`, which changes sideby's settings, so ask me first.",
      'click Let AI do it in the Panel once to try it',
      'add a row to the terminal table in src/core/terminal.ts of the sideby repository with tests',
    ])
      assert.ok(en.includes(part), `${part}\n---\n${en}`)
    assert.ok(en.endsWith('emails.'))
    assert.ok(!en.includes('share the improvement'))
    const zh = taskPrompt({ task: 'terminal', context: { terminals: [] }, lang: 'zh' }, stripSecrets)
    for (const part of [
      '要做的事\n帮我让 sideby 能在我用的终端里打开 AI 任务：写一条自定义终端命令。',
      '上下文\n- 本机没找到 sideby 支持的终端\n- 面板语言：中文',
      '提示\n先问我用的是什么终端。只看这个终端的官方文档和它的 `--help`',
      "`sideby terminal --custom '<模板>'`，它会改 sideby 的设置，先问我",
      '在面板上点一次「让 AI 帮我」试一下',
      '在 sideby 仓库 src/core/terminal.ts 的终端表里加一行并补上测试',
    ])
      assert.ok(zh.includes(part), `${part}\n---\n${zh}`)
    assert.ok(zh.endsWith('邮箱。'))
    assert.ok(!zh.includes('现在的自定义终端命令'))
  })

  it('keeps terminal context out of other tasks', () => {
    const out = taskPrompt({ task: 'fix', context: { terminals: ['Ghostty'] }, lang: 'en' }, stripSecrets)
    assert.ok(!out.includes('Ghostty'))
  })

  it('puts the order of sections as the spec gives it', () => {
    const out = taskPrompt({ task: 'host', text: 'Add Example Code', lang: 'en' }, stripSecrets)
    assert.equal(
      out,
      [
        'What to do\nHelp me add an AI coding tool (Host) that sideby does not support yet, first as a local Family Plugin.\nIn my words: Add Example Code',
        'Context\n- Panel language: English (talk to me in English)',
        'Rules\n- Use the sideby skill; its references/ai-tasks.md says how. If the skill is not installed, ask me first, and with my yes run `npx skills add Adonis0123/sideby -g`.\n- Show me the preview of any command that changes files; add `--yes` only after I agree.\n- Never sign in for me and never ask me to send you an API key: I enter keys myself with `sideby key <account>`.',
        'Pointers\nStart with `sideby plugins new <id>`; note the Host version and the date with every fact you gather; check it with `sideby plugins check <id>` and try it in a demo HOME.',
        'When it works, ask me whether to share the improvement with sideby. Only with my yes, follow the CONTRIBUTING.md of the sideby repository to open a pull request, and first remove my own account names, paths and emails.',
      ].join('\n\n'),
    )
  })

  it('lists attached files with their kind after the context, and says how to look at a video', () => {
    const attachments = [
      { path: '/tmp/sideby-demo/state/sideby/ai/attachments/0123456789abcdef/1.png', kind: 'image' },
      { path: '/tmp/sideby-demo/state/sideby/ai/attachments/0123456789abcdef/2.mp4', kind: 'video' },
    ]
    const en = taskPrompt({ task: 'free', text: 'Why this error?', attachments, lang: 'en' }, stripSecrets)
    assert.ok(
      en.includes(
        '\n\nAttached files\n- /tmp/sideby-demo/state/sideby/ai/attachments/0123456789abcdef/1.png (image)\n- /tmp/sideby-demo/state/sideby/ai/attachments/0123456789abcdef/2.mp4 (video)\nTo see what a video shows, extract a few frames with ffmpeg first',
      ),
    )
    assert.ok(
      en.indexOf('Context\n') < en.indexOf('Attached files') &&
        en.indexOf('Attached files') < en.indexOf('Rules\n'),
    )
    const zh = taskPrompt({ task: 'free', attachments: attachments.slice(0, 1), lang: 'zh' }, stripSecrets)
    assert.ok(
      zh.includes(
        '\n\n附件\n- /tmp/sideby-demo/state/sideby/ai/attachments/0123456789abcdef/1.png (图片)\n\n规则',
      ),
    )
    assert.ok(!zh.includes('ffmpeg'))
    for (const none of [undefined, []]) {
      const out = taskPrompt({ task: 'free', attachments: none, lang: 'en' }, stripSecrets)
      assert.ok(!out.includes('Attached files'))
    }
  })

  it("uses the user's text as the free task, without key-shaped strings", () => {
    const text = `Use https://api.example.com/v1?ref=0123456789abcdef0123456789abcdef with key ${SK}ant-api03-AbCdEfGh1234567890`
    const out = taskPrompt({ task: 'free', text, lang: 'en' }, stripSecrets)
    assert.ok(
      out.startsWith(
        'What to do\nUse https://api.example.com/v1?ref=0123456789abcdef0123456789abcdef with key [key removed]\n\n',
      ),
    )
    assert.ok(!out.includes('sk-ant'))
    assert.ok(!out.includes('Pointers'))
  })

  it('strips key-shaped strings from context too, and falls back to free for an unknown task', () => {
    const out = taskPrompt(
      { task: 'nope', context: { quotaReason: `got ${XAI}0123456789abcdefABCD back` }, lang: 'zh' },
      stripSecrets,
    )
    assert.ok(out.includes('- 额度原因：got [key removed] back'))
    assert.ok(out.startsWith('要做的事\n问我想用 sideby 做什么'))
  })

  it("keeps the user's quotes, command substitution, backticks and newlines verbatim", () => {
    const text = `fix "it" and 'that'\n$(touch /tmp/x) \`id\`; rm y`
    const out = taskPrompt({ task: 'free', text, lang: 'en' }, stripSecrets)
    assert.ok(out.startsWith(`What to do\n${text}\n\n`))
  })

  it('treats empty text as no text', () => {
    assert.equal(
      taskPrompt({ task: 'plugin', text: '   ', lang: 'en' }, stripSecrets),
      taskPrompt({ task: 'plugin', lang: 'en' }, stripSecrets),
    )
  })
})

describe('AI Task helpers (spec §3.28)', () => {
  it('lists signed-in subscriptions first, then API accounts, each by ref', () => {
    const list = [
      { ref: 'codex:main', kind: 'subscription', login: 'logged-in' },
      { ref: 'claude:api', kind: 'api', login: 'not-needed' },
      { ref: 'claude:work', kind: 'subscription', login: 'logged-out' },
      { ref: 'claude:main', kind: 'subscription', login: 'logged-in' },
      { ref: 'grok:lab', kind: 'subscription', login: 'unknown' },
    ]
    assert.deepEqual(
      aiTaskAccounts(list).map((a) => a.ref),
      ['claude:main', 'codex:main', 'claude:api'],
    )
    assert.deepEqual(aiTaskAccounts([]), [])
  })
  it('asks AI about quota only where no button of its own helps', () => {
    for (const r of ['no-session', 'fetch-failed', 'unrecognized', 'read-failed'])
      assert.equal(quotaAskable(r), true, r)
    for (const r of ['not-enabled', 'api-account', 'no-source', undefined, ''])
      assert.equal(quotaAskable(r), false, String(r))
  })
  it('passes only the fields a Task Prompt shows', () => {
    const f = {
      code: 'link.dangling',
      account: 'claude:work',
      item: 'skills',
      message: 'dangling',
      level: 'fail',
      fixable: false,
    }
    assert.deepEqual(taskFindings([f]), [
      { code: 'link.dangling', account: 'claude:work', item: 'skills', message: 'dangling' },
    ])
    assert.deepEqual(taskFindings([{ message: 'x', hint: 'run it' }]), [{ message: 'x', hint: 'run it' }])
  })
})

describe('settings in config, start at login and Auto Handoff facts (spec §3.29)', () => {
  it('shows config panel.* when the Panel can write, and the browser choice when read-only', () => {
    const local = { theme: 'dark', lang: 'zh' }
    assert.deepEqual(panelPrefs({}, local, true), { theme: 'system', language: '' })
    assert.deepEqual(panelPrefs({ theme: 'light', language: 'en' }, local, true), {
      theme: 'light',
      language: 'en',
    })
    assert.deepEqual(panelPrefs({ language: 'auto' }, local, true), { theme: 'system', language: '' })
    assert.deepEqual(panelPrefs({ theme: 'light' }, local, false), { theme: 'dark', language: 'zh' })
  })
  it('migrates only a choice the browser made and config lacks', () => {
    assert.deepEqual(panelMigration({}, { theme: 'dark', lang: 'zh' }), { theme: 'dark', language: 'zh' })
    assert.deepEqual(panelMigration({ theme: 'light' }, { theme: 'dark', lang: '' }), null)
    assert.deepEqual(panelMigration({ language: 'en' }, { theme: 'system', lang: 'zh' }), null)
    assert.deepEqual(panelMigration({}, { theme: 'system', lang: '' }), null)
    assert.deepEqual(panelMigration({ language: 'auto' }, { theme: 'light', lang: 'zh' }), { theme: 'light' })
  })
  it('turns a key press into config menubar.hotkey, by key position, waiting while only modifiers are held', () => {
    const k = (
      code: string,
      mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
    ) => hotkeyFromKey({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
    // ⌥S types "ß" on a Mac; the position (KeyS) is what the shortcut is.
    assert.equal(k('KeyS', { altKey: true, metaKey: true }), 'opt+cmd+s')
    assert.equal(k('Digit0', { ctrlKey: true, shiftKey: true }), 'ctrl+shift+0')
    assert.equal(k('KeyK'), null)
    assert.equal(k('MetaLeft', { metaKey: true }), null)
    assert.equal(k('Space', { ctrlKey: true }), null)
    // The picker's presets are ones the server accepts, so choosing one never ends in a refusal.
    const presets = /HOTKEY_PRESETS = \[([^\]]*)\]/
      .exec(PAGE_SCRIPT)![1]!
      .match(/'[^']+'/g)!
      .map((x) => x.slice(1, -1))
    assert.equal(presets[0], 'opt+x')
    for (const p of presets) assert.ok(checkHotkey(p).ok, p)
    // While only modifiers are held it waits; an arrow, F-key or Space is refused at once, not ignored.
    assert.deepEqual(
      ['KeyS', 'Digit7', 'MetaLeft', 'AltRight', 'ArrowDown', 'F5', 'Space', 'Enter'].map(hotkeyPressKind),
      ['key', 'key', 'wait', 'wait', 'unsupported', 'unsupported', 'unsupported', 'unsupported'],
    )
  })
  it('explains each start-at-login state with one line and the right action', () => {
    const s = (state: string, current = true, supported = true) => ({ supported, state, current })
    assert.deepEqual(autostartNote(null, false), {
      key: 'as.checking',
      on: false,
      toggle: false,
      action: null,
    })
    assert.deepEqual(autostartNote(s('off', false, false), false), {
      key: 'as.unsupported',
      on: false,
      toggle: false,
      action: null,
    })
    assert.deepEqual(autostartNote(s('off', false), false), {
      key: 'as.hint',
      on: false,
      toggle: true,
      action: null,
    })
    assert.deepEqual(autostartNote(s('on'), false), { key: 'as.hint', on: true, toggle: true, action: null })
    assert.deepEqual(autostartNote(s('on', false), false), {
      key: 'as.other',
      on: true,
      toggle: true,
      action: 'fix',
    })
    assert.deepEqual(autostartNote(s('stale', false), false), {
      key: 'as.stale',
      on: true,
      toggle: true,
      action: 'fix',
    })
    // On, but launchd let it go: the switch still says on, and the action starts it again.
    assert.deepEqual(autostartNote({ ...s('on', false), loaded: false }, false), {
      key: 'as.notRunning',
      on: true,
      toggle: true,
      action: 'fix',
    })
    assert.deepEqual(autostartNote({ ...s('stale', false), loaded: false }, false).key, 'as.stale')
    assert.deepEqual(autostartNote({ ...s('on'), loaded: true }, false).key, 'as.hint')
    assert.deepEqual(autostartNote(s('foreign', false), false), {
      key: 'as.foreign',
      on: false,
      toggle: false,
      action: null,
    })
    // Read-only: the state, never a switch or an action.
    assert.deepEqual(autostartNote(s('stale', false), true), {
      key: 'as.stale',
      on: true,
      toggle: false,
      action: null,
    })
    for (const key of ['as.checking', 'as.unsupported', 'as.hint', 'as.other', 'as.stale', 'as.foreign'])
      assert.ok(MESSAGES.en[key] && MESSAGES.zh[key], key)
  })
  it('lists the Auto Handoff facts by ref, never an email', () => {
    const settings = {
      auto: false,
      sameFamily: true,
      threshold: 90,
      prepareAt: 75,
      waitIfResetWithinMinutes: 30,
      countdownSeconds: 10,
      families: { claude: { policy: 'order', order: ['work', 'main'] } },
    }
    const future = new Date(Date.now() + 3600000).toISOString()
    const accounts: LogicAccount[] = [
      {
        family: 'claude',
        name: 'main',
        ref: 'claude:main',
        kind: 'subscription',
        login: 'logged-in',
        identity: { email: 'me@example.com' },
        quota: {
          status: 'ok',
          source: 'claude-tap',
          windows: [{ label: '5h', windowMinutes: 300, usedPercent: 41.6, resetsAt: future }],
        } as LogicAccount['quota'],
      },
      {
        family: 'claude',
        name: 'work',
        ref: 'claude:work',
        kind: 'subscription',
        login: 'logged-out',
        quota: { status: 'unavailable', reason: 'no-session' } as LogicAccount['quota'],
      },
      { family: 'claude', name: 'ds', ref: 'claude:ds', kind: 'api' },
    ]
    const facts = handoffTaskFacts(settings, ['claude'], accounts, Date.now(), {
      families: [{ family: 'claude', ready: false, problems: ['Claude reports no quota to sideby yet'] }],
      nextSteps: ['sideby handoff enable', 'sideby quota setup claude'],
    })
    assert.deepEqual(facts, [
      'auto: false',
      'sameFamily: true',
      'threshold: 90',
      'prepareAt: 75',
      'waitIfResetWithinMinutes: 30',
      'countdownSeconds: 10',
      'families that can start a handoff: claude',
      'order of claude: order [work, main]',
      'claude:main: quota from claude-tap, 42% used',
      'claude:work: no quota data (no-session), logged-out',
      'claude:ds: API account, no quota',
      'not ready, claude: Claude reports no quota to sideby yet',
      'next steps: sideby handoff enable; sideby quota setup claude',
    ])
    assert.ok(!facts.join('\n').includes('example.com'))
  })
  it('puts the handoff facts in the Task Prompt with its own sentence and pointer', () => {
    for (const lang of ['en', 'zh']) {
      const p = taskPrompt(
        {
          task: 'handoff',
          context: { handoff: ['threshold: 90', `${SK}ant-api03-abcdefghijklmnopqrstu`] },
          lang,
        },
        stripSecrets,
      )
      assert.match(p, /sideby handoff status --json/)
      assert.match(p, /- threshold: 90/)
      assert.match(p, /sideby handoff enable/)
      assert.match(p, /sideby config set handoff\./)
      assert.ok(!p.includes('abcdefghijklmnopqrstu'), 'key-shaped context is removed')
    }
    assert.ok(AI_TASK_KINDS.includes('handoff'))
    // "Can't see the icon?": the AI starts from the menu bar item's own state, in either language.
    for (const lang of ['en', 'zh']) {
      const p = taskPrompt({ task: 'menubar', lang }, stripSecrets)
      assert.match(p, /sideby menubar --json/)
      assert.match(p, /sideby menubar on --yes/)
      assert.match(p, /Bartender/)
    }
    // Every task but free has its own dialog line and title in both languages, or the dialog shows a raw key.
    for (const k of AI_TASK_KINDS.filter((x) => x !== 'free'))
      for (const key of [`ask.task.${k}`, `ask.title.${k}`])
        assert.ok(MESSAGES.en[key] && MESSAGES.zh[key], key)
  })
  it('opens the row menu on a right-click and from the keyboard, and leaves inputs, links and buttons alone (spec §3.27)', () => {
    const fn = (name: string) => {
      const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
      assert.ok(at >= 0, name)
      return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
    }
    assert.match(
      fn('onContextMenu'),
      /e\.target\.closest\('input, textarea, select, a, button, \[contenteditable\], \.tip'\)\) return/,
    )
    assert.match(
      fn('onContextMenu'),
      /e\.preventDefault\(\)\n\s+openContextMenu\(target, e\.clientX, e\.clientY/,
    )
    assert.match(fn('onMenuKey'), /e\.key !== 'ContextMenu' && !\(e\.key === 'F10' && e\.shiftKey\)/)
    assert.match(fn('row'), /\(anchor\) => accountMenu\(a, anchor\)\)/)
    assert.match(fn('loginRow'), /\(anchor\) => loginMenu\(ms, anchor\)\)/)
    assert.match(fn('card'), /\(anchor\) => accountMenu\(a, anchor\)\)/)
    // Placed like the "…" menu, to the left of the point near the right edge; Escape returns focus.
    assert.match(
      fn('openContextMenu'),
      /menu\.align = x \+ menu\.el\.offsetWidth \+ 8 > window\.innerWidth \? 'end' : 'start'/,
    )
    assert.match(fn('closeMenu'), /const back = menu\.returnTo \|\| menu\.anchor/)
    assert.match(PAGE_SCRIPT, /document\.addEventListener\('contextmenu', onContextMenu\)/)
  })
  it('orders the settings sections as the spec says and keeps the popover short', () => {
    const at = PAGE_SCRIPT.indexOf('  function settingsGroups(')
    const groups = PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
    const order = [
      'set.g.general',
      'set.g.menubar',
      'set.g.accounts',
      'set.g.quota',
      'ah.button',
      'set.g.ai',
    ].map((k) => groups.indexOf(`t('${k}')`))
    assert.ok(
      order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!)),
      String(order),
    )
    const pop = PAGE_SCRIPT.slice(
      PAGE_SCRIPT.indexOf('  function settingsPop('),
      PAGE_SCRIPT.indexOf('  function openSettingsDialog('),
    )
    assert.match(pop, /lookRows\(\)[\s\S]*ahLink\(leave\)[\s\S]*aiLink\(leave\)[\s\S]*openSettingsDialog\(\)/)
    assert.doesNotMatch(pop, /autostartRow|setCheck|quotaChecks/)
  })
})

describe('card view', () => {
  const fn = (name: string) => {
    const at = PAGE_SCRIPT.indexOf(`  function ${name}(`)
    assert.ok(at >= 0, name)
    return PAGE_SCRIPT.slice(at, PAGE_SCRIPT.indexOf('\n  function ', at + 10))
  }
  it('marks a Same Login with its link but keeps its own badge, and leaves health to the label after the name', () => {
    // The fake peers only name the directories: statusBadge must not see them, or isNext() would mark every card.
    assert.match(fn('card'), /nameLine\(a, null, \{ linked: peers \}\)/)
    assert.match(fn('nameLine'), /loginMark\(o\.linked \|\| members\)[\s\S]*statusBadge\(a, members\)/)
    assert.match(
      fn('card'),
      /usageBlock\(a\), h\('div', \{ class: 'card-side' \}, deskButton\(a\), runButton\(a\)\)/,
    )
    assert.doesNotMatch(fn('card'), /healthChip/)
  })
  it('shows a Same Login as one card, as the list shows it as one row', () => {
    assert.match(
      PAGE_SCRIPT,
      /loginClusters\(list\)\.map\(\(x\) => Array\.isArray\(x\) \? loginCard\(x, now, cols\) : card\(x, now, cols\)\)/,
    )
    const body = fn('loginCard')
    assert.equal((body.match(/quotaBlock\(/g) || []).length, 1)
    assert.match(body, /mergeUsage\(ms\.map\(\(m\) => m\.usage\)\)/)
    assert.match(body, /loginMenu\(ms, anchor\)/)
    assert.match(body, /deskButton\(a, ms\)/)
  })
  it('makes a health label open the account findings, and leaves the quota label as text', () => {
    assert.match(fn('attentionWord'), /reason !== 'quota-high'[\s\S]*filterHealth\(subject\.ref\)/)
  })
  it('shows a session count when the records have no token totals', () => {
    const body = fn('usageBlock')
    assert.match(body, /!u\.totalTokens && u\.sessions > 0/)
    assert.match(body, /t\('usage\.noTokenCounts'\)/)
    assert.match(body, /t\('usage\.noTokens'/)
  })
  it('offers the settings file for a read error only when the error names it', () => {
    assert.match(PAGE_SCRIPT, /a\.error\.includes\(family\(a\.family\)\.settingsFile\) \? item : null/)
  })
})

describe('mergeUsage', () => {
  const u = (total: number, at: string, daily: { date: string; totalTokens: number }[]) => ({
    status: 'ok',
    sessions: 2,
    inputTokens: total / 2,
    outputTokens: 1,
    cacheReadTokens: total / 4,
    cacheWriteTokens: 0,
    totalTokens: total,
    daily,
    lastActivityAt: at,
  })
  it('adds up the tokens and days of every readable directory and keeps the newest use', () => {
    const got = mergeUsage([
      u(100, '2026-10-19T10:00:00Z', [
        { date: '2026-10-18', totalTokens: 40 },
        { date: '2026-10-19', totalTokens: 60 },
      ]),
      { status: 'unreadable' },
      u(20, '2026-10-20T08:00:00Z', [
        { date: '2026-10-19', totalTokens: 5 },
        { date: '2026-10-20', totalTokens: 15 },
      ]),
    ])
    assert.equal(got?.totalTokens, 120)
    assert.equal(got?.sessions, 4)
    assert.equal(got?.cacheReadTokens, 30)
    assert.equal(got?.lastActivityAt, '2026-10-20T08:00:00Z')
    assert.deepEqual(got?.daily, [
      { date: '2026-10-18', totalTokens: 40 },
      { date: '2026-10-19', totalTokens: 65 },
      { date: '2026-10-20', totalTokens: 15 },
    ])
  })
  it('gives the one readable usage, or the first as it is when none is readable', () => {
    const one = u(7, '2026-10-19T10:00:00Z', [])
    assert.equal(mergeUsage([{ status: 'no-session' }, one]), one)
    assert.deepEqual(mergeUsage([{ status: 'no-session' }, { status: 'unreadable' }]), {
      status: 'no-session',
    })
    assert.equal(mergeUsage([]), undefined)
  })
})

describe('widthTier', () => {
  it('puts each width in the band its narrow-screen rules were written for, edges included', () => {
    assert.deepEqual([1300, 1101, 1100, 761, 760, 561, 560, 320].map(widthTier), [
      'wide',
      'wide',
      'medium',
      'medium',
      'narrow',
      'narrow',
      'phone',
      'phone',
    ])
  })
})

describe('widthFollower', () => {
  function setup(shown = 'wide') {
    const applied: string[] = []
    let now = 0
    let timers: { at: number; fn: () => void; id: number }[] = []
    let nextId = 1
    const follow = widthFollower(shown, widthTier, (t) => applied.push(t), 90, {
      set: (fn, ms) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id
      },
      clear: (id) => {
        timers = timers.filter((t) => t.id !== id)
      },
    })
    const tick = (ms: number) => {
      now += ms
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t)
        t.fn()
      }
    }
    return { applied, follow, tick }
  }

  it('changes the band as soon as the width crosses, then once more where a long slide comes to rest', () => {
    const { applied, follow, tick } = setup('wide')
    for (let w = 1300; w >= 600; w -= 20) {
      follow(w)
      tick(16)
      // The first crossing (1100) applies at once, with the sliding edge; the rest wait for the width to settle.
      if (w <= 1100) assert.deepEqual(applied, ['medium'])
    }
    tick(90)
    assert.deepEqual(applied, ['medium', 'narrow'])
  })

  it('changes once, mid-slide, for a sidebar that slides across one breakpoint', () => {
    const { applied, follow, tick } = setup('medium')
    for (const w of [864, 845, 820, 790, 760, 735, 712, 704, 700]) {
      follow(w)
      tick(16)
      if (w === 760)
        assert.deepEqual(applied, ['narrow'], 'it follows the edge as it crosses, not after it stops')
    }
    tick(200)
    assert.deepEqual(applied, ['narrow'])
    for (const w of [700, 735, 790, 845, 864]) {
      follow(w)
      tick(16)
    }
    tick(200)
    assert.deepEqual(applied, ['narrow', 'medium'])
  })

  it('goes back once when the width returns to the old band during the same gesture', () => {
    const { applied, follow, tick } = setup('medium')
    follow(740)
    tick(40)
    follow(780)
    tick(200)
    assert.deepEqual(applied, ['narrow', 'medium'])
  })

  it('ignores moves inside the shown band and follows the next crossing from the band it applied', () => {
    const { applied, follow, tick } = setup('medium')
    follow(1000)
    tick(200)
    follow(700)
    tick(90)
    follow(720)
    tick(200)
    follow(920)
    tick(90)
    assert.deepEqual(applied, ['narrow', 'medium'])
  })
})

describe('layout bands in the page', () => {
  it('sets the band in the head, before the first paint, and hangs the narrow rules on it', () => {
    const html = renderPage({ basePath: '/sideby', token: 't', nonce: 'n' })
    const head = html.slice(0, html.indexOf('</head>'))
    assert.match(head, /<script nonce="n">document\.documentElement\.dataset\.width = \(function widthTier/)
    const css = /<style nonce="n">([\s\S]*?)<\/style>/.exec(html)![1]!
    assert.doesNotMatch(css, /max-width: \d+px\)/, 'no breakpoint media queries are left')
    assert.match(css, /:where\(:root\[data-width=narrow\], :root\[data-width=phone\]\) \{/)
  })
})

describe('foldSkips', () => {
  // A stand-in for Element.closest: matches when the click sits inside an element of one of the given classes or tags.
  const at = (...inside: string[]) => ({
    closest: (selector: string) => selector.split(', ').some((s) => inside.includes(s)) || null,
  })
  it('folds on a click on the row itself', () => {
    assert.equal(foldSkips(at('.row')), false)
  })
  it('leaves the row alone for controls, tooltips and anything in the open details', () => {
    for (const where of ['button', 'a', 'input', '.tip', '.row-detail'])
      assert.equal(foldSkips(at(where)), true, where)
  })
})

describe('Sessions page', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  const s = (sessionId: string, over: Partial<LogicSession> = {}): LogicSession => ({
    account: 'claude:002',
    accountLabel: 'cc002',
    sessionId,
    title: 'knip cleanup',
    label: `cc002 · knip cleanup · ${sessionId.slice(0, 8)}`,
    status: 'busy',
    cwd: '~/code/app',
    ...over,
  })

  it('puts a Session that needs the user first, then the most recent, then by label', () => {
    const list = [
      s('aaaaaaaa1', { updatedAt: '2026-10-20T11:50:00Z' }),
      s('bbbbbbbb2', { status: 'idle', updatedAt: '2026-10-20T11:59:00Z' }),
      s('cccccccc3', { status: 'needs-you', updatedAt: '2026-10-20T10:00:00Z' }),
      s('dddddddd4', { startedAt: '2026-10-20T11:55:00Z' }),
      s('eeeeeeee5', { label: 'a first' }),
      s('ffffffff6', { label: 'b second' }),
    ]
    assert.deepEqual(
      sortSessions(list).map((x) => x.sessionId),
      ['cccccccc3', 'bbbbbbbb2', 'dddddddd4', 'aaaaaaaa1', 'eeeeeeee5', 'ffffffff6'],
    )
    assert.deepEqual(sortSessions([]), [])
    assert.equal(list[0]!.sessionId, 'aaaaaaaa1', 'leaves the given list alone')
  })

  it('keeps shown Sessions in place on a refresh, puts new ones ahead and one that needs the user first', () => {
    const first = steadyOrder(
      [],
      [
        s('aaaaaaaa1', { updatedAt: '2026-10-20T11:50:00Z' }),
        s('bbbbbbbb2', { updatedAt: '2026-10-20T11:40:00Z' }),
      ],
    )
    assert.deepEqual(
      first.map((x) => x.sessionId),
      ['aaaaaaaa1', 'bbbbbbbb2'],
    )
    const shown = first.map((x) => x.sessionId)
    const later = [
      s('aaaaaaaa1', { updatedAt: '2026-10-20T11:50:00Z' }),
      s('bbbbbbbb2', { updatedAt: '2026-10-20T11:58:00Z' }),
      s('cccccccc3', { updatedAt: '2026-10-20T11:55:00Z' }),
    ]
    assert.deepEqual(
      steadyOrder(shown, later).map((x) => x.sessionId),
      ['cccccccc3', 'aaaaaaaa1', 'bbbbbbbb2'],
    )
    later[1] = s('bbbbbbbb2', { status: 'needs-you', updatedAt: '2026-10-20T11:58:00Z' })
    assert.deepEqual(
      steadyOrder(shown, later).map((x) => x.sessionId),
      ['bbbbbbbb2', 'cccccccc3', 'aaaaaaaa1'],
    )
  })

  it('says how long ago a Session was active, from updatedAt or else startedAt', () => {
    assert.deepEqual(sessionAge(s('a', { updatedAt: '2026-10-20T11:53:00Z' }), now), {
      key: 'time.minAgo',
      n: 7,
    })
    assert.deepEqual(sessionAge(s('a', { startedAt: '2026-10-20T09:00:00Z' }), now), {
      key: 'time.hAgo',
      n: 3,
    })
    assert.deepEqual(sessionAge(s('a', { updatedAt: '2026-10-20T12:00:30Z' }), now), { key: 'time.justNow' })
    assert.equal(sessionAge(s('a'), now), null)
    assert.equal(sessionAge(s('a', { updatedAt: 'soon' }), now), null)
  })

  it('splits the Session Label into account, title and short id', () => {
    assert.deepEqual(sessionLabelParts(s('61230c3d-0000-4000')), {
      account: 'cc002',
      title: 'knip cleanup',
      id: '61230c3d',
    })
    // No title from the Host: the working directory's name, as the Session Label does.
    assert.deepEqual(sessionLabelParts(s('61230c3d', { title: '', cwd: '~/code/sideby/' })), {
      account: 'cc002',
      title: 'sideby',
      id: '61230c3d',
    })
    // No title and no working directory (a guessed Session can have neither), no alias: the ref.
    assert.deepEqual(
      sessionLabelParts(s('ab', { title: undefined, cwd: undefined, accountLabel: undefined })),
      {
        account: 'claude:002',
        title: '',
        id: 'ab',
      },
    )
  })

  it('shortens a long working directory and keeps a short one', () => {
    assert.equal(shortCwd(undefined), '')
    assert.equal(shortCwd('~/code/app'), '~/code/app')
    assert.equal(shortCwd('~/code/clients/example/monorepo/packages/web', 30), '~/…/packages/web')
    assert.equal(shortCwd('/srv/build/workspaces/team/project/apps/api', 30), '/srv/…/apps/api')
    const deep = '~/x/a-very-long-folder-name-that-goes-on/another-very-long-folder-name'
    const short = shortCwd(deep, 30)
    assert.equal(short.length, 30)
    assert.ok(short.startsWith('…') && deep.endsWith(short.slice(1)))
  })
})

describe('send to a session (spec §3.32 step 2)', () => {
  it('shows a delivered Message with the bypass note as a hint', () => {
    assert.deepEqual(sendResultView({ status: 'delivered', pasteText: 'Read /m.md' }, true), {
      kind: 'done',
      key: 'send.done',
      pasteText: 'Read /m.md',
      reason: '',
      hint: '',
      jump: false,
    })
    const bypass = sendResultView({ status: 'delivered', note: ' It must approve it first. ' }, false)
    assert.equal(bypass.hint, 'It must approve it first.')
    assert.equal(sendResultView({ status: 'read' }, false).key, 'send.read')
    // Held for approval in the target terminal (ADR-0045): its own headline, the note as the reason.
    assert.deepEqual(
      sendResultView(
        { status: 'delivered', needsApproval: true, note: ' Approve it there. ', pasteText: 'Read /m.md' },
        false,
      ),
      {
        kind: 'approve',
        key: 'send.approve',
        pasteText: 'Read /m.md',
        reason: 'Approve it there.',
        hint: '',
        jump: false,
      },
    )
  })

  it('shows the line to paste, why, and the Orca tab only when there is one', () => {
    const paste = sendResultView(
      { status: 'paste-needed', pasteText: 'Read /m.md', note: 'Codex cannot receive it.' },
      true,
    )
    assert.deepEqual(paste, {
      kind: 'paste',
      key: 'send.paste',
      pasteText: 'Read /m.md',
      reason: 'Codex cannot receive it.',
      hint: '',
      jump: true,
    })
    assert.equal(sendResultView({ status: 'paste-needed', pasteText: 'Read /m.md' }, false).jump, false)
    assert.equal(sendResultView({ status: 'paste-needed' }, true).jump, false, 'nothing to paste, no jump')
    assert.equal(sendResultView({ status: 'stored', pasteText: 'Read /m.md' }, true).kind, 'stored')
  })

  it('maps the latest status to a chip', () => {
    assert.deepEqual(messageChip('delivered'), { key: 'send.chip.delivered', tone: 'accent' })
    assert.deepEqual(messageChip('delivered', true), { key: 'send.chip.approve', tone: 'warn' })
    assert.deepEqual(
      messageChip('read', true),
      { key: 'send.chip.read', tone: 'ok' },
      'read wins over waiting',
    )
    assert.deepEqual(messageChip('read'), { key: 'send.chip.read', tone: 'ok' })
    assert.deepEqual(messageChip('paste-needed'), { key: 'send.chip.paste', tone: 'warn' })
    assert.equal(messageChip('stored'), null)
    assert.equal(messageChip(undefined), null)
    for (const lang of ['en', 'zh'] as const)
      for (const key of [
        'send.chip.delivered',
        'send.chip.read',
        'send.chip.paste',
        'send.chip.approve',
        'send.approve',
        'send.done',
        'send.paste',
        'send.stored',
        'send.read',
      ])
        assert.ok(MESSAGES[lang][key], `${key} ${lang}`)
  })

  it('announces a new, read or paste-needed Message, but nothing on the first reading', () => {
    const to = 'cc002 · knip cleanup · 61230c3d'
    const first = { s1: { id: 'a1', status: 'delivered', to } }
    assert.deepEqual(messageNews(null, first), [])
    assert.deepEqual(messageNews(first, first), [])
    assert.deepEqual(
      messageNews(first, { s1: { id: 'a2', status: 'delivered', to, from: 'cc008 · app · 0d6e4079' } }),
      [{ kind: 'new', sessionId: 's1', id: 'a2', to: 'cc002 · knip cleanup', from: 'cc008 · app' }],
    )
    assert.deepEqual(messageNews(first, { s1: { id: 'a1', status: 'read', to } }), [
      { kind: 'read', sessionId: 's1', id: 'a1', to: 'cc002 · knip cleanup', from: '' },
    ])
    assert.deepEqual(
      messageNews(first, { s1: first.s1, s2: { id: 'b1', status: 'paste-needed', to: 'gk · lab' } }),
      [{ kind: 'paste', sessionId: 's2', id: 'b1', to: 'gk · lab', from: '' }],
    )
    // A status that only moves on from read, or a reading that lost a Session, announces nothing.
    assert.deepEqual(
      messageNews({ s1: { id: 'a1', status: 'read' } }, { s1: { id: 'a1', status: 'delivered' } }),
      [],
    )
    assert.deepEqual(messageNews(first, {}), [])
    // A new Message held for approval says so instead of "got a message".
    assert.deepEqual(messageNews(first, { s1: { id: 'a4', status: 'delivered', to, needsApproval: true } }), [
      { kind: 'approve', sessionId: 's1', id: 'a4', to: 'cc002 · knip cleanup', from: '' },
    ])
    // A Message only kept so far waits; it is new once it is delivered.
    const kept = { s1: { id: 'a3', status: 'stored', to } }
    assert.deepEqual(messageNews(first, kept), [])
    assert.deepEqual(messageNews(kept, { s1: { id: 'a3', status: 'delivered', to } }), [
      { kind: 'new', sessionId: 's1', id: 'a3', to: 'cc002 · knip cleanup', from: '' },
    ])
    for (const lang of ['en', 'zh'] as const)
      for (const key of [
        'msgn.new',
        'msgn.newFrom',
        'msgn.read',
        'msgn.paste',
        'msgn.approve',
        'msgn.aSession',
        'msgn.show',
      ])
        assert.ok(MESSAGES[lang][key], `${key} ${lang}`)
  })

  it('refuses a file that is not an image, is over 20 MB, or is one too many', () => {
    const png = { type: 'image/png', size: 1000 }
    assert.equal(sendFileProblem(png, 0), null)
    assert.equal(sendFileProblem({ type: 'image/webp', size: 20 * 1024 * 1024 }, 4), null)
    assert.equal(sendFileProblem(png, 5), 'send.max')
    assert.equal(sendFileProblem({ type: 'video/mp4', size: 10 }, 0), 'send.notImage')
    assert.equal(sendFileProblem({ type: 'image/heic', size: 10 }, 0), 'send.notImage')
    assert.equal(sendFileProblem({ type: '', size: 10 }, 0), 'send.notImage')
    assert.equal(sendFileProblem({ type: 'image/jpeg', size: 20 * 1024 * 1024 + 1 }, 0), 'send.tooBig')
  })
})

describe('send blocked by a failed screenshot (spec §3.32 step 2)', () => {
  it('lets a message go only when no screenshot failed', () => {
    assert.equal(sendBlock([]), null)
    assert.equal(sendBlock([{ name: 'a.png', status: 'ready' }]), null)
    assert.deepEqual(
      sendBlock([
        { name: 'a.png', status: 'ready' },
        { name: 'b.png', status: 'error' },
        { name: 'c.png', status: 'error' },
      ]),
      { key: 'send.blocked', names: 'b.png, c.png' },
    )
    for (const lang of ['en', 'zh'] as const) {
      assert.ok(MESSAGES[lang]['send.blocked']?.includes('{names}'), lang)
      assert.ok(MESSAGES[lang]['send.retry'], lang)
    }
  })
})

describe('Session History page logic (spec §3.33)', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  it('says how long ago within a week, and the date after', () => {
    assert.deepEqual(historyWhen('2026-10-20T11:30:00Z', now), { key: 'time.minAgo', n: 30 })
    assert.deepEqual(historyWhen('2026-10-14T11:59:00Z', now), { key: 'time.dAgo', n: 6 })
    assert.equal(historyWhen('2026-10-13T12:00:00Z', now)!.key, 'time.on')
    assert.match(historyWhen('2026-09-01T12:00:00Z', now)!.date!, /^2026-09-0[12]$/)
    assert.equal(historyWhen('not a date', now), null)
    assert.equal(historyWhen(undefined, now), null)
  })
  it('marks every word in any case, merges overlaps, and keeps the text whole', () => {
    const parts = highlightParts('Login page: fix the LOGIN button', ['login', 'button'])
    assert.equal(parts.map((p) => p.text).join(''), 'Login page: fix the LOGIN button')
    assert.deepEqual(
      parts.filter((p) => p.hit).map((p) => p.text),
      ['Login', 'LOGIN', 'button'],
    )
    assert.deepEqual(highlightParts('登录页改蓝色', ['登录', '登录页']), [
      { text: '登录页', hit: true },
      { text: '改蓝色', hit: false },
    ])
    assert.deepEqual(highlightParts('abc', []), [{ text: 'abc', hit: false }])
    assert.deepEqual(highlightParts('', ['x']), [])
  })
  it('says why the list is empty and which way out it offers', () => {
    const base = {
      q: '',
      since: '30d',
      state: 'ready',
      total: 0,
      tools: false,
      project: '',
      accounts: 2,
      stored: 9,
    }
    assert.equal(historyEmpty({ ...base, total: 3 }), null)
    assert.deepEqual(historyEmpty({ ...base, state: 'building', q: 'x' }), {
      key: 'hist.emptyBuilding',
      widen: false,
      tools: false,
    })
    assert.deepEqual(historyEmpty({ ...base, q: 'login' }), {
      key: 'hist.emptyMatch',
      widen: true,
      tools: true,
    })
    assert.deepEqual(historyEmpty({ ...base, q: 'login', since: 'all', tools: true }), {
      key: 'hist.emptyMatch',
      widen: false,
      tools: false,
    })
    assert.equal(historyEmpty({ ...base, project: '~/code/app' })!.key, 'hist.emptyProject')
    assert.deepEqual(historyEmpty({ ...base, q: 'login', project: '~/code/app' }), {
      key: 'hist.emptyMatchProject',
      widen: true,
      tools: true,
      everywhere: true,
    })
    assert.deepEqual(historyEmpty({ ...base, q: 'login', unreadable: true }), {
      key: 'hist.emptyUnreadable',
      widen: false,
      tools: false,
    })
    assert.equal(historyEmpty(base)!.key, 'hist.emptySince')
    assert.equal(historyEmpty({ ...base, since: 'all' })!.key, 'hist.emptyNone')
    assert.deepEqual(historyEmpty({ ...base, accounts: 0, stored: 0 }), {
      key: 'hist.emptyNoAccounts',
      widen: false,
      tools: false,
      accounts: true,
    })
    assert.deepEqual(historyEmpty({ ...base, stored: 0 }), {
      key: 'hist.emptyNone',
      widen: false,
      tools: false,
    })
  })
  it('folds each run of tool calls into one line and keeps the rest in order', () => {
    const m = (n: number, role: string, text: string, tool?: string) =>
      tool ? { n, role, text, tool } : { n, role, text }
    const out = foldToolCalls([
      m(0, 'user', 'q'),
      m(1, 'tool', 'Read', 'Read'),
      m(2, 'tool', 'Bash', 'Bash'),
      m(3, 'assistant', 'a'),
      m(4, 'tool', 'Edit', 'Edit'),
    ])
    assert.deepEqual(
      out.map((x) => (x.role === 'tools' ? `tools:${(x as { tools: string[] }).tools.join(',')}` : x.role)),
      ['user', 'tools:Read,Bash', 'assistant', 'tools:Edit'],
    )
  })
  it('has every History text the page uses in both languages', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('./page-script.ts', import.meta.url), 'utf8')
    const used = new Set([...src.matchAll(/'((?:hist|hv)\.[a-zA-Z.0-9]*[a-zA-Z0-9])'/g)].map((x) => x[1]!))
    used.add('time.on')
    for (const k of used) {
      // Keys picked by count are written once in the source and stored as .one / .other.
      const keys = MESSAGES.en[k] === undefined ? [`${k}.one`, `${k}.other`] : [k]
      for (const key of keys) {
        assert.ok(MESSAGES.en[key], `en ${key}`)
        assert.ok(MESSAGES.zh[key], `zh ${key}`)
      }
    }
  })
})

describe('tailInView', () => {
  it('loads the next page only when the end of the list is near the bottom of the window', () => {
    // The page scrolls: the list's box ends with its last row, far below the window.
    assert.equal(tailInView(5000, 5010, 800), false)
    assert.equal(tailInView(900, 5010, 800), true)
    // A box shorter than the window: its own bottom counts.
    assert.equal(tailInView(300, 320, 800), true)
  })
})

describe('mdBlocks', () => {
  it('reads a GitHub table with alignment, filling short rows', () => {
    const b = mdBlocks('Intro\n\n| Name | Count |\n| :--- | ---: |\n| a \\| b | 2 |\n| c |\n\nAfter')
    assert.deepEqual(b, [
      { type: 'p', text: 'Intro' },
      {
        type: 'table',
        head: ['Name', 'Count'],
        align: ['left', 'right'],
        rows: [
          ['a | b', '2'],
          ['c', ''],
        ],
      },
      { type: 'p', text: 'After' },
    ])
  })

  it('reads headings, fences, lists, quotes and rules, and runs an unclosed fence to the end', () => {
    const b = mdBlocks(
      '## Plan\n- one\n  more\n- two\n1. first\n> said\n---\n```ts\nconst a = 1\n| not | table |',
    )
    assert.deepEqual(b, [
      { type: 'h', level: 2, text: 'Plan' },
      { type: 'list', ordered: false, items: ['one\nmore', 'two'] },
      { type: 'list', ordered: true, items: ['first'] },
      { type: 'quote', text: 'said' },
      { type: 'hr' },
      { type: 'code', lang: 'ts', text: 'const a = 1\n| not | table |' },
    ])
  })

  it('starts a list right under a paragraph line, a numbered one only from 1', () => {
    assert.deepEqual(mdBlocks('Why CI is red\n- lint\n- tests'), [
      { type: 'p', text: 'Why CI is red' },
      { type: 'list', ordered: false, items: ['lint', 'tests'] },
    ])
    assert.deepEqual(mdBlocks('In 2026\n7. ok'), [{ type: 'p', text: 'In 2026\n7. ok' }])
  })

  it('keeps a line with a bar but no rule under it as a paragraph', () => {
    assert.deepEqual(mdBlocks('a | b\nc'), [{ type: 'p', text: 'a | b\nc' }])
  })
})

describe('mdInline', () => {
  it('keeps code inside bold for the page to read again', () => {
    assert.deepEqual(mdInline('**use `a.png`**'), [{ t: 'b', text: 'use `a.png`' }])
    assert.deepEqual(mdInline('use `a.png`'), [
      { t: 'text', text: 'use ' },
      { t: 'code', text: 'a.png' },
    ])
  })

  it('reads code, bold, italic and web links, and leaves other links as text', () => {
    assert.deepEqual(
      mdInline('run `x*y` **now** *then* [docs](https://example.com) [no](javascript:alert(1))'),
      [
        { t: 'text', text: 'run ' },
        { t: 'code', text: 'x*y' },
        { t: 'text', text: ' ' },
        { t: 'b', text: 'now' },
        { t: 'text', text: ' ' },
        { t: 'i', text: 'then' },
        { t: 'text', text: ' ' },
        { t: 'a', text: 'docs', href: 'https://example.com' },
        { t: 'text', text: ' [no](javascript:alert(1))' },
      ],
    )
  })
})

describe('histFilters', () => {
  it('keeps the saved filters and drops malformed ones to their defaults', () => {
    const all = {
      q: 'auth',
      since: '7d',
      family: 'claude',
      account: 'claude:work',
      project: '/a/app',
      category: 'Work',
      scripts: true,
    }
    assert.deepEqual(histFilters(all), all)
    assert.deepEqual(histFilters({ q: 3, since: 'forever', scripts: 'yes', tools: true }), {
      q: '',
      since: '30d',
      family: '',
      account: '',
      project: '',
      category: '',
      scripts: false,
    })
    assert.deepEqual(histFilters(null), histFilters({}))
  })
})

describe('categoryOrder', () => {
  it('keeps the latest-Session order when nothing was dragged, with uncategorized Projects last', () => {
    assert.deepEqual(categoryOrder(['coding', '', 'docs'], []), ['coding', 'docs', ''])
  })
  it('puts dragged categories first and new ones after them, dropping gone and repeated names', () => {
    assert.deepEqual(categoryOrder(['coding', 'docs', 'work', ''], ['work', 'gone', 'docs', 'work']), [
      'work',
      'docs',
      'coding',
      '',
    ])
  })
  it('never moves the empty category out of last place', () => {
    assert.deepEqual(categoryOrder(['a', '', 'b'], ['', 'b']), ['b', 'a', ''])
  })
})

describe('Handoff page actions', () => {
  it('saves a change with confirm and offers the undo the server read, but no undo of an undo', async () => {
    const sent: unknown[] = []
    const post = async (path: string, body: object) => {
      sent.push([path, body])
      return { undo: { threshold: null } }
    }
    assert.deepEqual(await saveHandoffChange(post, { threshold: 90 }), { undo: { threshold: null } })
    assert.deepEqual(sent, [['/api/handoff/configure', { change: { threshold: 90 }, confirm: true }]])
    assert.deepEqual(await saveHandoffChange(post, { threshold: null }, { noUndo: true }), { undo: null })
    assert.deepEqual(await saveHandoffChange(async () => ({}), { auto: true }), { undo: null })
  })

  it('shows a changed or blocked plan again, the first failed step, or done', () => {
    const plan = { alreadyOn: false }
    assert.deepEqual(enableOutcome({ changed: true, plan, results: [] }), { kind: 'changed', plan })
    // A plan that changed only because it is on already counts as done.
    assert.deepEqual(enableOutcome({ changed: true, plan: { alreadyOn: true }, results: [] }), {
      kind: 'done',
    })
    assert.deepEqual(enableOutcome({ plan: { blocked: 'npx' }, results: [] }).kind, 'blocked')
    const results = [
      { ok: true, id: 'a' },
      { ok: false, id: 'b' },
    ]
    assert.deepEqual(enableOutcome({ plan, results }), { kind: 'failed', step: results[1], plan })
    assert.deepEqual(enableOutcome({ plan, results: [{ ok: true }] }), { kind: 'done' })
  })
})
