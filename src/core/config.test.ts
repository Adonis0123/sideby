// Config loading rules that are not about aliases: the `handoff` settings (spec §3.17).
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  ConfigError,
  configGet,
  describeConfigKey,
  editConfigDisplay,
  editConfigPanel,
  editConfigPath,
  editConfigQuotaCheck,
  handoffSettings,
  loadConfig,
  parseConfigValue,
  settableKeys,
} from './config.ts'

const CONFIG = '.config/sideby/config.json'

describe('handoff settings', () => {
  it('fills every default when the key is missing', () => {
    assert.deepEqual(handoffSettings({}), {
      auto: false,
      sameFamily: false,
      prepareAt: 80,
      threshold: 95,
      waitIfResetWithinMinutes: 30,
      countdownSeconds: 10,
      crossOrganization: [],
      families: {},
    })
  })

  it('keeps what the user wrote and defaults a family policy to pressure', () => {
    const s = handoffSettings({
      handoff: { auto: true, threshold: 90, families: { claude: { order: ['cc002', 'codex001'] } } },
    })
    assert.equal(s.auto, true)
    assert.equal(s.threshold, 90)
    assert.equal(s.prepareAt, 80)
    assert.deepEqual(s.families.claude, { policy: 'pressure', order: ['cc002', 'codex001'] })
  })

  it('rejects a preparing level at or above the threshold, naming the key and the fix', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify({ handoff: { prepareAt: 95, threshold: 95 } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /handoff\.prepareAt/)
        assert.match(err.message, /lower than handoff\.threshold/)
        return true
      })
    })
  })

  it('rejects a threshold above 100 through the schema', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify({ handoff: { threshold: 101 } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), ConfigError)
    })
  })

  it('rejects an unknown policy and an unknown key', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify({ handoff: { families: { claude: { policy: 'round-robin' } } } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), ConfigError)
      await h.write(CONFIG, JSON.stringify({ handoff: { rotate: true } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), ConfigError)
    })
  })
})

describe('display and quota checks (spec §3.25, §3.26)', () => {
  it('writes and removes `display` keeping every other key, and refuses a repeated name', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await h.write(
        CONFIG,
        `${JSON.stringify({ aliases: { cc1: 'claude:001' }, resumeRouting: true }, null, 2)}\n`,
      )
      const r = await editConfigDisplay(file, {
        families: ['codex'],
        accounts: { claude: ['003', 'main'], grok: [] },
        pinned: { claude: ['work'], codex: [] },
      })
      assert.deepEqual(r.after, {
        families: ['codex'],
        accounts: { claude: ['003', 'main'] },
        pinned: { claude: ['work'] },
      })
      const data = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(Object.keys(data), ['aliases', 'resumeRouting', 'display'])
      assert.deepEqual((await loadConfig(file)).display, r.after)
      await assert.rejects(editConfigDisplay(file, { families: ['codex', 'codex'] }), ConfigError)
      await assert.rejects(editConfigDisplay(file, { pinned: { claude: ['work', 'work'] } }), ConfigError)
      await editConfigDisplay(file, undefined)
      assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))), ['aliases', 'resumeRouting'])
      await h.write(CONFIG, JSON.stringify({ display: { accounts: { claude: 'main' } } }))
      await assert.rejects(loadConfig(file), ConfigError)
    })
  })

  it('turns a check off with `false` and on by removing the key', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await editConfigQuotaCheck(file, 'grok', false)
      assert.deepEqual((await loadConfig(file)).quota, { check: { grok: false } })
      await editConfigQuotaCheck(file, 'grok', true)
      assert.equal((await loadConfig(file)).quota, undefined)
    })
  })
})

describe('config get|set|unset (spec §3.29)', () => {
  const start = { aliases: { cc1: 'claude:001' }, handoff: { auto: true }, plugins: { mine: { token: 'x' } } }

  it('sets a nested key keeping every other key and its order, and dry runs write nothing', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      const raw = `${JSON.stringify(start, null, 2)}\n`
      await h.write(CONFIG, raw)
      const dry = await editConfigPath(file, 'handoff.threshold', 90, { dryRun: true })
      assert.deepEqual(dry, { key: 'handoff.threshold', before: undefined, after: 90, changed: true })
      assert.equal(await readFile(file, 'utf8'), raw)
      await editConfigPath(file, 'handoff.threshold', 90)
      await editConfigPath(file, 'panel.theme', 'dark')
      const data = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(Object.keys(data), ['aliases', 'handoff', 'plugins', 'panel'])
      assert.deepEqual(data.handoff, { auto: true, threshold: 90 })
      assert.deepEqual(data.plugins, start.plugins)
      assert.equal((await configGet(file, 'panel.theme')).value, 'dark')
      assert.equal((await editConfigPath(file, 'panel.theme', 'dark')).changed, false)
    })
  })

  it('unset removes the key and parents it leaves empty', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await h.write(CONFIG, JSON.stringify({ panel: { theme: 'light' }, quota: { check: { grok: false } } }))
      await editConfigPath(file, 'panel.theme', undefined)
      await editConfigPath(file, 'quota.check.grok', undefined)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {})
      assert.equal((await editConfigPath(file, 'panel.language', undefined)).changed, false)
    })
  })

  it('refuses a value the schema does not take, an unknown key and plugin settings, writing nothing', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      const raw = JSON.stringify(start)
      await h.write(CONFIG, raw)
      await assert.rejects(editConfigPath(file, 'panel.theme', 'pink'), /panel\.theme .*sideby config get/)
      await assert.rejects(editConfigPath(file, 'handoff.threshold', 101), /handoff\.threshold/)
      await assert.rejects(editConfigPath(file, 'handoff.prepareAt', 99), /lower than handoff\.threshold/)
      await assert.rejects(editConfigPath(file, 'nope', 1), /not a config key/)
      await assert.rejects(editConfigPath(file, 'aliases.__proto__', 'x'), /not a config key/)
      await assert.rejects(editConfigPath(file, 'aliases.if', 'claude:main'), /shell keyword/)
      await assert.rejects(editConfigPath(file, 'plugins.mine.token', 'y'), /may hold secrets/)
      await assert.rejects(editConfigPath(file, 'plugins.mine', {}), /may hold secrets/)
      await assert.rejects(configGet(file, 'plugins.mine.token'), /may hold secrets/)
      await assert.rejects(editConfigPath(file, 'plugins.mine.enabled', 'no'), /true or false/)
      await assert.rejects(editConfigPath(file, '$schema', 'x'), /not a setting/)
      assert.equal(await readFile(file, 'utf8'), raw)
      await editConfigPath(file, 'plugins.mine.enabled', false)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).plugins, {
        mine: { token: 'x', enabled: false },
      })
    })
  })

  it('takes only model and effort arguments for an account, and refuses without a checker', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      const argsProblem = (_ref: string, args: string[]) =>
        args.every((a) => a === '--model' || a === 'opus')
          ? null
          : `${args.join(' ')} is not a model argument`
      await assert.rejects(
        editConfigPath(file, 'accounts.claude:work.args', ['--model', 'opus']),
        /model and effort/,
      )
      await assert.rejects(
        editConfigPath(file, 'accounts.claude:work.args', ['--dangerously-skip-permissions'], {
          argsProblem,
        }),
        /alias add/,
      )
      await assert.rejects(
        editConfigPath(file, 'accounts', { 'claude:work': { args: ['--yolo'] } }, { argsProblem }),
        /not a model argument/,
      )
      await editConfigPath(file, 'accounts.claude:work.args', ['--model', 'opus'], { argsProblem })
      assert.deepEqual((await loadConfig(file)).accounts, { 'claude:work': { args: ['--model', 'opus'] } })
      // Unset needs no check.
      await editConfigPath(file, 'accounts.claude:work.args', undefined)
      assert.equal((await loadConfig(file)).accounts, undefined)
    })
  })

  it('refuses when the file changed while it was being written', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await h.write(CONFIG, '{}\n')
      const sneaky = (_ref: string, _args: string[]) => {
        writeFileSync(file, '{ "resumeRouting": true }\n')
        return null
      }
      await assert.rejects(
        editConfigPath(file, 'accounts.claude:work.args', ['--model', 'opus'], { argsProblem: sneaky }),
        /changed while sideby was writing/,
      )
      assert.equal(await readFile(file, 'utf8'), '{ "resumeRouting": true }\n')
    })
  })

  it('lists every settable key with a meaning, current values and entries, never plugin settings', () => {
    const keys = settableKeys({
      panel: { theme: 'dark' },
      quota: { check: { grok: false } },
      plugins: { mine: { token: 'secret-value' } },
    })
    const by = new Map(keys.map((k) => [k.key, k]))
    assert.equal(by.get('panel.theme')?.value, 'dark')
    assert.match(by.get('panel.theme')!.takes, /system, light, dark/)
    assert.deepEqual(by.get('quota.check.<family>')?.entries, [{ key: 'quota.check.grok', value: false }])
    assert.ok(by.has('accounts.<family>:<name>.args'))
    assert.ok(by.has('plugins.<plugin>.enabled'))
    assert.ok(!JSON.stringify(keys).includes('secret-value'))
    assert.ok(!by.has('$schema'))
    for (const k of keys) assert.ok(k.meaning.length > 10, `${k.key} has a meaning`)
    assert.match(describeConfigKey('handoff.threshold').takes, /1 to 100/)
  })

  it('reads a value as JSON when it parses, else as text', () => {
    assert.equal(parseConfigValue('90'), 90)
    assert.equal(parseConfigValue('true'), true)
    assert.deepEqual(parseConfigValue('["a"]'), ['a'])
    assert.equal(parseConfigValue('dark'), 'dark')
  })

  it('editConfigPanel sets and clears the theme and language', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await editConfigPanel(file, { theme: 'dark', language: 'zh' })
      assert.deepEqual((await loadConfig(file)).panel, { theme: 'dark', language: 'zh' })
      await editConfigPanel(file, { theme: null, language: null })
      assert.equal((await loadConfig(file)).panel, undefined)
    })
  })
})
