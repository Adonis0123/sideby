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
  editConfigAccounts,
  editConfigAdvisor,
  editConfigClaude,
  editConfigDisplay,
  editConfigPanel,
  editConfigPath,
  editConfigQuotaCheck,
  editConfigUnattended,
  handoffSettings,
  loadConfig,
  parseConfigValue,
  readConfig,
  removeConfigAlias,
  settableKeys,
  unknownConfigKeyNote,
} from './config.ts'

const CONFIG = '.config/sideby/config.json'

describe('handoff settings', () => {
  it('fills every default when the key is missing', () => {
    assert.deepEqual(handoffSettings({}), {
      auto: false,
      sameFamily: false,
      prepareAt: 80,
      threshold: 95,
      adaptive: true,
      waitIfResetWithinMinutes: 30,
      countdownSeconds: 10,
      crossOrganization: [],
      otherFamilies: false,
      familyOrder: [],
      api: false,
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

  it('rejects an unknown policy, and ignores an unknown key (ADR-0080)', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify({ handoff: { families: { claude: { policy: 'round-robin' } } } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), ConfigError)
      await h.write(CONFIG, JSON.stringify({ handoff: { rotate: true } }))
      assert.deepEqual(await readConfig(h.path(CONFIG)), {
        config: { handoff: {} },
        unknownKeys: ['handoff.rotate'],
      })
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

describe('keys a newer sideby wrote (spec §3.10, ADR-0080)', () => {
  // What a newer sideby may leave: keys this one does not know, at the top and inside known objects.
  const newer = {
    $schema: 'x',
    futureTop: { a: [1, { b: 2 }] },
    claude: { futureKey: 1, carryTrust: true, apiBetasOff: true },
    aliases: { cc1: 'claude:001', pk: { account: 'pi:main', args: ['-m', 'x'] } },
    pickCommands: { cx: 'codex' },
    accounts: { 'claude:001': { args: ['--model', 'opus'], futureArg: true } },
    unattended: {
      schedule: [
        { days: ['mon'], start: '09:00', end: '17:00', futureSlot: 'a' },
        { days: ['sat'], start: '10:00', end: '11:00', futureSlot: 'b' },
      ],
    },
  }

  it('loads them, leaves them out of the config and lists them; prints nothing', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify(newer))
      const r = await readConfig(h.path(CONFIG))
      assert.deepEqual(r.unknownKeys, [
        'futureTop',
        'claude.futureKey',
        'accounts.claude:001.futureArg',
        'unattended.schedule.0.futureSlot',
        'unattended.schedule.1.futureSlot',
      ])
      assert.deepEqual(r.config.claude, { carryTrust: true, apiBetasOff: true })
      assert.deepEqual(r.config.aliases, newer.aliases)
      assert.deepEqual(r.config.pickCommands, newer.pickCommands)
      assert.deepEqual(r.config.accounts, { 'claude:001': { args: ['--model', 'opus'] } })
      assert.equal(r.config.unattended?.schedule?.length, 2)
      assert.ok(!('futureTop' in r.config))
      assert.deepEqual(await loadConfig(h.path(CONFIG)), r.config)
      const note = unknownConfigKeyNote('claude.futureKey', '1.2.3')
      assert.match(note, /sideby 1\.2\.3/)
      assert.match(note, /newer sideby wrote it, or it is a typo/)
      assert.match(note, /sideby update/)
      assert.match(note, /sideby config unset claude\.futureKey --yes/)
    })
  })

  it('still refuses a known key with a wrong value, also next to unknown keys', async () => {
    await withFakeHome(async (h) => {
      await h.write(CONFIG, JSON.stringify({ futureTop: 1, claude: { futureKey: 1, carryTrust: 'yes' } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), /\/claude\/carryTrust must be boolean/)
      // Inside an alias object nothing but `account` and `args` is taken (ADR-0005).
      await h.write(CONFIG, JSON.stringify({ aliases: { x: { account: 'pi:main', env: { K: 'v' } } } }))
      await assert.rejects(loadConfig(h.path(CONFIG)), /aliases\/x/)
      // A change refuses a broken file and says which key, not "run sideby list".
      await h.write(CONFIG, JSON.stringify({ claude: { carryTrust: 'yes' } }))
      await assert.rejects(
        editConfigPath(h.path(CONFIG), 'panel.theme', 'dark'),
        /claude\.carryTrust must be boolean/,
      )
    })
  })

  it('keeps them, their values and their order through every change', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await h.write(CONFIG, `${JSON.stringify(newer, null, 2)}\n`)
      const read = async () => JSON.parse(await readFile(file, 'utf8'))
      // A change of the very object that holds an unknown key.
      await editConfigClaude(file, (c) => ({ ...c, carryTrust: false }))
      await editConfigPath(file, 'claude.apiBetasOff', undefined)
      await editConfigPath(file, 'panel.theme', 'dark')
      await editConfigAccounts(file, (a) => ({ ...a, 'claude:001': { args: ['--model', 'sonnet'] } }))
      let data = await read()
      assert.deepEqual(Object.keys(data), [
        '$schema',
        'futureTop',
        'claude',
        'aliases',
        'pickCommands',
        'accounts',
        'unattended',
        'panel',
      ])
      assert.deepEqual(data.futureTop, newer.futureTop)
      assert.deepEqual(Object.entries(data.claude), [
        ['futureKey', 1],
        ['carryTrust', false],
      ])
      assert.deepEqual(data.accounts, { 'claude:001': { args: ['--model', 'sonnet'], futureArg: true } })
      assert.deepEqual(data.aliases, newer.aliases)
      assert.deepEqual(data.pickCommands, newer.pickCommands)
      // A list item the change keeps keeps its unknown key; one it changes or removes goes with it.
      await editConfigUnattended(file, (u) => ({
        ...u,
        schedule: [u!.schedule![1]!, { days: ['sun'], start: '01:00', end: '02:00' }],
      }))
      data = await read()
      assert.deepEqual(data.unattended.schedule, [
        { days: ['sat'], start: '10:00', end: '11:00', futureSlot: 'b' },
        { days: ['sun'], start: '01:00', end: '02:00' },
      ])
      // A section emptied of known keys keeps the unknown ones; a record entry removed goes with its own.
      await editConfigClaude(file, () => undefined)
      await editConfigAccounts(file, () => ({}))
      await removeConfigAlias(file, 'pk')
      data = await read()
      assert.deepEqual(data.claude, { futureKey: 1 })
      assert.deepEqual(data.accounts, {})
      assert.deepEqual(data.aliases, { cc1: 'claude:001' })
      // Unset of the section itself removes all of it.
      await editConfigPath(file, 'claude', undefined)
      assert.ok(!('claude' in (await read())))
      assert.deepEqual((await readConfig(file)).unknownKeys, [
        'futureTop',
        'unattended.schedule.0.futureSlot',
      ])
    })
  })

  it('keeps an unknown key in a section a helper removes when it is empty', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      await h.write(
        CONFIG,
        JSON.stringify({ advisor: { unlock: true, futureKey: 'x' }, display: { futureKey: 2 } }),
      )
      await editConfigAdvisor(file, () => undefined)
      await editConfigDisplay(file, { families: ['codex'] })
      const data = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(data.advisor, { futureKey: 'x' })
      assert.deepEqual(data.display, { futureKey: 2, families: ['codex'] })
      // A section with only unknown keys left is not changed again.
      const raw = await readFile(file, 'utf8')
      assert.equal((await editConfigAdvisor(file, () => undefined)).changed, false)
      assert.equal(await readFile(file, 'utf8'), raw)
    })
  })

  it('refuses a new unknown key from config set, writing nothing', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      const raw = JSON.stringify({ claude: { futureKey: 1 } })
      await h.write(CONFIG, raw)
      await assert.rejects(editConfigPath(file, 'claude.typoKey', true), /not a config key/)
      await assert.rejects(
        editConfigPath(file, 'claude', { carryTrust: true, typoKey: 1 }),
        /claude\.typoKey is not a config key/,
      )
      await assert.rejects(editConfigPath(file, 'claude.futureKey', 2), /not a config key/)
      await assert.rejects(editConfigPath(file, 'typoTop', 1), /not a config key/)
      assert.equal(await readFile(file, 'utf8'), raw)
    })
  })

  it('config unset removes an unknown key the file has, and the object it leaves empty', async () => {
    await withFakeHome(async (h) => {
      const file = h.path(CONFIG)
      const raw = JSON.stringify({ futureTop: true, claude: { futureKey: 1 }, panel: { theme: 'dark' } })
      await h.write(CONFIG, raw)
      const dry = await editConfigPath(file, 'claude.futureKey', undefined, { dryRun: true })
      assert.deepEqual(dry, { key: 'claude.futureKey', before: 1, after: undefined, changed: true })
      assert.equal(await readFile(file, 'utf8'), raw)
      await editConfigPath(file, 'claude.futureKey', undefined)
      await editConfigPath(file, 'futureTop', undefined)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { panel: { theme: 'dark' } })
      await assert.rejects(editConfigPath(file, 'futureTop', undefined), /not a config key/)
    })
  })
})
