// Config loading rules that are not about aliases: the `handoff` settings (spec §3.17).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  ConfigError,
  editConfigDisplay,
  editConfigQuotaCheck,
  handoffSettings,
  loadConfig,
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
      })
      assert.deepEqual(r.after, { families: ['codex'], accounts: { claude: ['003', 'main'] } })
      const data = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(Object.keys(data), ['aliases', 'resumeRouting', 'display'])
      assert.deepEqual((await loadConfig(file)).display, r.after)
      await assert.rejects(editConfigDisplay(file, { families: ['codex', 'codex'] }), ConfigError)
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
