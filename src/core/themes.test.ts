// Themes (spec §3.34, ADR-0050): Theme Files are data checked like a Portal Theme, colors pass contrast, and switching
// writes only `panel.colorTheme` and can be undone.
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { BUILTIN_THEMES } from '../panel/themes.ts'
import { loadConfig } from './config.ts'
import { resolvePaths } from './paths.ts'
import {
  accentTokens,
  checkThemeData,
  contrast,
  contrastPairs,
  listThemes,
  removeThemeFile,
  resolveColors,
  saveThemeFile,
  type ThemeFile,
  themeColors,
  themesDir,
  undoTheme,
  useTheme,
} from './themes.ts'

describe('Theme Files', () => {
  it('accepts base, accent and known tokens, ignores unknown keys, and refuses unsafe values', () => {
    const ok = checkThemeData({
      schemaVersion: 1,
      name: 'Mine',
      base: 'leaf',
      accent: '#2F7FBF',
      light: { bg: '#ffffff', glow: '#fff' },
      extra: 1,
    })
    assert.deepEqual(ok.problems, [])
    assert.equal(ok.theme?.accent, '#2f7fbf')
    assert.deepEqual(ok.theme?.light, { bg: '#ffffff' })
    assert.equal(ok.warnings.length, 2)
    const bad = checkThemeData({
      schemaVersion: 2,
      name: '',
      base: 'ocean',
      accent: 'blue',
      dark: { bg: 'red; } body { x' },
    })
    assert.equal(bad.theme, undefined)
    assert.equal(bad.problems.length, 5)
    assert.match(bad.problems.join('\n'), /dark\.bg may hold only/)
  })

  it('lists Built-in Themes first and a broken or link file with its problem, never following the link', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const dir = themesDir(paths)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'good.json'),
        JSON.stringify({ schemaVersion: 1, name: 'Good', accent: '#cc3366' }),
      )
      await writeFile(join(dir, 'broken.json'), '{ nope')
      await writeFile(join(h.home, 'outside.json'), JSON.stringify({ schemaVersion: 1, name: 'Outside' }))
      await symlink(join(h.home, 'outside.json'), join(dir, 'linked.json'))
      await writeFile(join(dir, 'sky.json'), JSON.stringify({ schemaVersion: 1, name: 'Fake sky' }))
      const list = await listThemes(paths)
      assert.deepEqual(
        list.slice(0, BUILTIN_THEMES.length).map((t) => t.id),
        BUILTIN_THEMES.map((t) => t.id),
      )
      const by = Object.fromEntries(list.map((t) => [t.id, t]))
      assert.deepEqual(by.good?.problems, [])
      assert.equal(by.good?.swatches.length, 4)
      assert.match(by.broken?.problems[0] ?? '', /not valid JSON/)
      assert.match(by.linked?.problems[0] ?? '', /links are not followed/)
      assert.match(by.sky?.problems.at(-1) ?? '', /Built-in Theme/)
      assert.equal(by.sky?.source, 'file')
    })
  })
})

describe('Theme colors', () => {
  it('keeps every Built-in pair readable in light and dark', () => {
    for (const t of BUILTIN_THEMES) {
      const failing = contrastPairs(t).filter((p) => !p.ok)
      assert.deepEqual(failing, [], t.id)
      assert.ok(
        contrastPairs(t).every((p) => p.ratio !== undefined),
        `${t.id} has every checked token`,
      )
    }
  })

  it('makes the accent roles from one color with white main-button text at 3:1 or more, leaving warnings alone', () => {
    for (const accent of [
      '#82b241',
      '#ffd400',
      '#3f8fc4',
      '#7a1f99',
      '#cc3366',
      '#1a1a40',
      '#00c2a8',
      '#ff7a00',
    ]) {
      const c = accentTokens(accent)
      assert.ok(contrast(c.light.onPrimary as string, c.light.primary as string) >= 3, accent)
      assert.equal(c.light.okBar, accent)
      assert.equal(c.light.warn, undefined)
      const full = themeColors({ schemaVersion: 1, name: 'x', accent })
      // A color picked in Settings must never need the Panel to fix it, in light or dark, on either base.
      for (const base of BUILTIN_THEMES.map((t) => t.id))
        assert.deepEqual(
          contrastPairs(themeColors({ schemaVersion: 1, name: 'x', base, accent })).filter((p) => !p.ok),
          [],
          `${accent} on ${base}`,
        )
      assert.equal(full.light.warnBar, BUILTIN_THEMES[0]?.light.warnBar)
    }
  })

  it('suggests a passing value for a faint color and the Panel uses it; a broken choice falls back to Teal', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await saveThemeFile(paths, 'faint', { schemaVersion: 1, name: 'Faint', light: { muted: '#bbbbbb' } })
      const pair = contrastPairs(
        themeColors({ schemaVersion: 1, name: 'Faint', light: { muted: '#bbbbbb' } }),
      ).find((p) => p.mode === 'light' && p.fg === 'muted' && p.bg === 'surface')
      assert.equal(pair?.ok, false)
      assert.ok(pair?.suggest && contrast(pair.suggest, '#fefefe') >= 4.5)
      const r = await resolveColors(paths, 'faint')
      assert.equal(r.id, 'faint')
      assert.ok(r.adjusted >= 1)
      assert.ok(contrast(r.light.muted as string, r.light.surface as string) >= 4.5)
      const missing = await resolveColors(paths, 'gone')
      assert.equal(missing.id, 'teal')
      assert.match(missing.fallback ?? '', /cannot be used/)
    })
  })
})

describe('switching Themes', () => {
  it('writes only panel.colorTheme, undoes only what it wrote, and removing the Theme in use goes back to Teal', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await mkdir(paths.configDir, { recursive: true })
      await writeFile(
        paths.configFile,
        JSON.stringify({ panel: { theme: 'dark' }, aliases: { cc: 'claude:main' } }),
      )
      assert.deepEqual(await useTheme(paths, 'codex'), { before: 'default', after: 'codex', changed: true })
      const cfg = await loadConfig(paths.configFile)
      assert.deepEqual(cfg.panel, { theme: 'dark', colorTheme: 'codex' })
      assert.deepEqual(cfg.aliases, { cc: 'claude:main' })
      assert.deepEqual(await undoTheme(paths), { before: 'codex', after: 'default' })
      assert.deepEqual((await loadConfig(paths.configFile)).panel, { theme: 'dark' })
      // Teal picked by name is kept (inside a Portal it wins over the Portal's colors); "default" drops the choice.
      await useTheme(paths, 'teal')
      assert.equal((await loadConfig(paths.configFile)).panel?.colorTheme, 'teal')
      assert.deepEqual(await useTheme(paths, 'default'), { before: 'teal', after: 'default', changed: true })
      assert.deepEqual((await loadConfig(paths.configFile)).panel, { theme: 'dark' })
      assert.deepEqual(await undoTheme(paths), { before: 'default', after: 'teal' })
      await assert.rejects(undoTheme(paths), /nothing to undo/)

      await useTheme(paths, 'codex')
      await useTheme(paths, 'teal')
      // Changed elsewhere since the last switch: undo refuses rather than overwrite it.
      await writeFile(paths.configFile, JSON.stringify({ panel: { colorTheme: 'codex' } }))
      await assert.rejects(undoTheme(paths), /changed since/)

      await saveThemeFile(paths, 'mine', { schemaVersion: 1, name: 'Mine', accent: '#cc3366' })
      await useTheme(paths, 'mine')
      const removed = await removeThemeFile(paths, 'mine')
      assert.equal(removed.wasActive, true)
      assert.equal((await loadConfig(paths.configFile)).panel?.colorTheme, undefined)
      await assert.rejects(useTheme(paths, 'mine'), /no Theme named mine/)
      await assert.rejects(removeThemeFile(paths, 'teal'), /Built-in Themes cannot be removed/)
      for (const id of ['codex', 'default', 'leaf'])
        await assert.rejects(
          saveThemeFile(paths, id, { schemaVersion: 1, name: 'x' }),
          /cannot be a Theme name/,
        )
      assert.match(await readFile(paths.configFile, 'utf8'), /\n$/)
    })
  })
})

describe('renamed Built-in Themes', () => {
  it('reads the old sky as celeste in config, Theme Files and commands, and leaf stays leaf', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await mkdir(paths.configDir, { recursive: true })
      // A config written before the design system keeps a Theme instead of falling back.
      await writeFile(paths.configFile, JSON.stringify({ panel: { colorTheme: 'sky' } }))
      assert.equal((await loadConfig(paths.configFile)).panel?.colorTheme, 'celeste')
      // New Leaf kept its id: a config naming it gets the design system's leaf.
      await writeFile(paths.configFile, JSON.stringify({ panel: { colorTheme: 'leaf' } }))
      assert.equal((await loadConfig(paths.configFile)).panel?.colorTheme, 'leaf')
      const leaf = await resolveColors(paths, 'leaf')
      assert.equal(leaf.id, 'leaf')
      assert.equal(leaf.fallback, undefined)
      const sky = await resolveColors(paths, 'sky')
      assert.equal(sky.id, 'celeste')
      assert.equal(sky.fallback, undefined)
      // A Theme File based on an old name starts from the Theme it became.
      const file = checkThemeData({ schemaVersion: 1, name: 'Old', base: 'sky' })
      assert.deepEqual(file.problems, [])
      const celeste = BUILTIN_THEMES.find((t) => t.id === 'celeste')
      assert.equal(themeColors(file.theme as ThemeFile).light.primary, celeste?.light.primary)
      // `sideby theme use sky` saves the new name.
      assert.equal((await useTheme(paths, 'sky')).after, 'celeste')
      assert.match(await readFile(paths.configFile, 'utf8'), /"colorTheme": "celeste"/)
    })
  })
})
