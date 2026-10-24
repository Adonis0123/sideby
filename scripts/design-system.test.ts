import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pageStyles } from '../src/panel/page-styles.ts'
import { THEME_TOKENS } from '../src/panel/theme.ts'
import { BUILTIN_THEMES } from '../src/panel/themes.ts'
import { buildTokens, bundleCss, type Notes, ruleOf, SOURCE_DIR, tokenVars } from './design-system.ts'

const notes = JSON.parse(readFileSync(join(SOURCE_DIR, 'notes.json'), 'utf8')) as Notes
const tokens = buildTokens(notes, { ref: 'main@0000000', date: '2026-01-01' })
const color = (name: string) => tokens.color.tokens.find((t) => t.name === name)

describe('the Design System built from code', () => {
  it('has a light and a dark theme per Built-in Theme', () => {
    assert.deepEqual(
      tokens.color.themes.map((t) => t.id),
      BUILTIN_THEMES.flatMap((t) => [`${t.id}-light`, `${t.id}-dark`]),
    )
  })

  it('takes every color from themes.ts, or from the Panel default when a Theme sets none', () => {
    const byTheme = (name: string) => color(name)?.value as Record<string, string>
    assert.equal(byTheme('surface-2')['leaf-dark'], '#0e1511')
    assert.equal(color('btn-text')?.value, '{text}', 'var(--text) becomes an alias')
    assert.equal(color('logo-fg')?.value, '#3f8fc4', 'one value when every Theme agrees')
    assert.equal(byTheme('logo-line')['sky-dark'], '#00000000', 'transparent')
    const keys = Object.keys(THEME_TOKENS) as (keyof typeof THEME_TOKENS)[]
    assert.deepEqual(
      tokens.color.tokens.map((t) => `--${t.name}`),
      keys.slice(keys.indexOf('bg'), keys.indexOf('shadow')).map((k) => THEME_TOKENS[k]),
    )
  })

  it('reads text styles from the rules of page-styles.ts', () => {
    const title = tokens.type.groups[0]?.styles.find((s) => s.name === 'title')
    assert.deepEqual(
      { size: title?.fontSize, weight: title?.fontWeight, lh: title?.lineHeight, ls: title?.letterSpacing },
      { size: '22px', weight: 750, lh: 1.3, ls: '-0.02em' },
    )
    const pill = tokens.type.groups[1]?.styles.find((s) => s.name === 'version-pill')
    assert.deepEqual([pill?.fontSize, pill?.lineHeight, pill?.fontWeight], ['11.5px', '18px', 500])
  })

  it('names the selector to fix when a rule is gone', () => {
    assert.throws(() => ruleOf('.a { color: red; }', '.gone'), /no rule "\.gone \{ … \}".*TYPE_STYLES/)
  })

  it('ships the Panel rules as bundle.css, after the variables they read that are no token', () => {
    const css = bundleCss()
    const [support = '', ...rest] = css.split('\n')
    assert.ok(pageStyles().endsWith(rest.join('\n')), 'the rules as the Panel has them')
    assert.match(support, /^:root \{ .*--font-size: 14px;.*--focus-outline: 2px solid var\(--focus\);.* \}$/)
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const tokenVar = tokenVars()
    for (const t of tokens.color.tokens) assert.ok(tokenVar.has(`--${t.name}`))
    // --qr is set per row by page-script.ts.
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g))
      if (m[1] !== '--qr') assert.ok(declared.has(m[1]) || tokenVar.has(m[1]!), `${m[1]} is defined`)
    assert.ok(!/:root \{[^}]*--accent:/.test(css), 'never overrides a token the system sets')
  })

  it('keeps no usage note for a token the code no longer has', () => {
    const built = new Set(tokens.color.tokens.map((t) => t.name))
    for (const name of Object.keys(notes.color))
      assert.ok(built.has(name), `notes.json color.${name} is stale`)
    const styles = new Set(tokens.type.groups.flatMap((g) => g.styles.map((s) => s.name)))
    for (const name of Object.keys(notes.type))
      assert.ok(styles.has(name), `notes.json type.${name} is stale`)
  })
})
