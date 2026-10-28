import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PAGE_SCRIPT } from '../panel/page-script.ts'
import { COMMON_ENTRIES, SEARCH_CATALOG, type SearchEntry, searchCatalog } from './search-catalog.ts'

const ids = (q: string, cat: readonly SearchEntry[] = SEARCH_CATALOG) =>
  searchCatalog(q, cat).map((h) => h.entry.id)

function entry(id: string, en: string, zh: string, synonyms: string[] = []): SearchEntry {
  return {
    id,
    kind: 'setting',
    title: { en, zh },
    synonyms,
    panel: { en: 'Settings', zh: '设置' },
    target: { settings: 'general', find: id },
    cliCommand: null,
  }
}

describe('searchCatalog', () => {
  const cat = [
    entry('a', 'Hide theme', '隐藏'),
    entry('b', 'Theme colors', '主题'),
    entry('c', 'Theme', '颜色'),
  ]

  it('ranks exact before prefix before contains', () => {
    assert.deepEqual(ids('theme', cat), ['c', 'b', 'a'])
  })

  it('ignores case and spacing, and searches both languages', () => {
    assert.deepEqual(ids('  THEME  ', cat), ['c', 'b', 'a'])
    assert.deepEqual(ids('主题', cat), ['b'])
  })

  it('ranks a title above a synonym at the same level', () => {
    const two = [entry('syn', 'Other', '其他', ['language']), entry('title', 'Language', '语言')]
    assert.deepEqual(ids('language', two), ['title', 'syn'])
  })

  it('matches nothing for an empty query or unknown words', () => {
    assert.deepEqual(ids('', cat), [])
    assert.deepEqual(ids('zzzz', cat), [])
  })

  it('finds the language setting in English and Chinese', () => {
    assert.equal(ids('language')[0], 'setting.language')
    assert.equal(ids('语言')[0], 'setting.language')
    assert.equal(ids('dark mode')[0], 'setting.light-dark')
  })
})

describe('Search Catalog', () => {
  it('has unique ids, both languages and a known kind', () => {
    const seen = new Set<string>()
    for (const e of SEARCH_CATALOG) {
      assert.ok(!seen.has(e.id), `duplicate id ${e.id}`)
      seen.add(e.id)
      assert.ok(e.title.en && e.title.zh && e.panel.en && e.panel.zh, `${e.id} needs English and Chinese`)
      assert.ok(['page', 'setting', 'action'].includes(e.kind))
      assert.ok(e.id.startsWith(`${e.kind}.`), `${e.id} starts with its kind`)
      if (e.cliCommand) assert.match(e.cliCommand, /^sideby [a-z-]+/)
    }
    for (const id of COMMON_ENTRIES) assert.ok(seen.has(id), `common entry ${id} is in the catalog`)
  })

  it('gives the command that turns Auto Handoff on', () => {
    assert.equal(searchCatalog('开启自动接力', SEARCH_CATALOG)[0]?.entry.cliCommand, 'sideby handoff enable')
  })

  it('points every entry at something the Panel has', () => {
    const actions = PAGE_SCRIPT.slice(PAGE_SCRIPT.indexOf('const PALETTE_ACTIONS = {'))
    const actionKeys = actions.slice(0, actions.indexOf('\n  }\n'))
    for (const e of SEARCH_CATALOG) {
      const t = e.target
      // The Accounts page is the one without a hash; pageFromHash falls back to it.
      if ('page' in t)
        assert.ok(t.page === 'accounts' || PAGE_SCRIPT.includes(`'#${t.page}'`), `page ${t.page} has a hash`)
      else if ('settings' in t) {
        assert.ok(
          PAGE_SCRIPT.includes(`{ id: '${t.settings}', title:`),
          `${e.id}: settings section ${t.settings}`,
        )
        assert.ok(
          PAGE_SCRIPT.includes(`fm('${t.find}',`),
          `${e.id}: a settings row marked fm('${t.find}', …)`,
        )
      } else if ('display' in t)
        assert.ok(
          PAGE_SCRIPT.includes(`fm('${t.display}',`),
          `${e.id}: a Display row marked fm('${t.display}', …)`,
        )
      else
        assert.ok(
          new RegExp(`^ {4}'?${t.action}'?: \\{ run: `, 'm').test(actionKeys),
          `${e.id}: PALETTE_ACTIONS has ${t.action}`,
        )
    }
  })
})
