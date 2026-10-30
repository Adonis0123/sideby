// The Handoff Rules (spec §3.17 "接力规则", ADR-0046): what each rule says for given settings.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Runtime } from '../runtime.ts'
import { type Config, handoffSettings } from './config.ts'
import { apiUndecided, type HandoffRule, handoffRules } from './handoff-rules.ts'

const ctx = {
  titles: { claude: 'Claude Code', codex: 'Codex' },
  families: ['claude', 'codex'],
  apiAccounts: 1,
}
const rules = (handoff: Config['handoff']) => handoffRules(handoffSettings({ handoff } as Config), ctx)
const rule = (rs: HandoffRule[], id: string) => rs.find((r) => r.id === id)!

describe('handoffRules', () => {
  it('says the defaults: no same AI, no other AIs, no API, takeover limit 10 below the threshold', () => {
    const rs = rules(undefined)
    assert.deepEqual(
      rs.map((r) => r.id),
      [
        'when',
        'windows',
        'takeover',
        'wait',
        'sameFamily',
        'otherFamilies',
        'api',
        'organization',
        'countdown',
      ],
    )
    assert.equal(rule(rs, 'takeover').params.limit, 85)
    assert.equal(rule(rs, 'takeover').params.longLimit, 95)
    assert.match(
      rule(rs, 'takeover').text,
      /5-hour window is 85% used .* weekly or longer window is 95% used/,
    )
    assert.equal(rule(rs, 'sameFamily').params.on, false)
    assert.equal(rule(rs, 'otherFamilies').text, 'Other AIs do not take over.')
    assert.match(rule(rs, 'api').text, /do not take over/)
    assert.deepEqual(rule(rs, 'windows').settings, [])
    assert.match(rule(rs, 'when').text, /until sideby has measured/)
  })

  it('follows the settings', () => {
    const rs = rules({
      threshold: 90,
      prepareAt: 70,
      adaptive: false,
      waitIfResetWithinMinutes: 0,
      otherFamilies: true,
      familyOrder: ['codex'],
      api: true,
      crossOrganization: ['codex:team'],
      countdownSeconds: 0,
      families: { claude: { policy: 'order', order: ['cc002', 'codex001'] } },
    })
    assert.equal(rule(rs, 'when').text, 'From 70% the session writes a handoff note. It hands over at 90%.')
    assert.equal(rule(rs, 'takeover').params.limit, 80)
    assert.equal(rule(rs, 'takeover').params.longLimit, 90, 'the weekly limit follows the threshold too')
    assert.match(rule(rs, 'wait').text, /never waits/)
    // familyOrder first, the rest after; titles, not ids.
    assert.deepEqual(rule(rs, 'otherFamilies').params.order, ['codex', 'claude'])
    assert.match(rule(rs, 'otherFamilies').text, /Codex → Claude Code/)
    assert.match(rule(rs, 'api').text, /does not cap spending/)
    assert.match(rule(rs, 'organization').text, /except codex:team/)
    assert.deepEqual(rule(rs, 'order').params, { family: 'claude', order: ['cc002', 'codex001'] })
    assert.equal(rule(rs, 'countdown').text, 'The next account starts without a countdown.')
  })
})

describe('apiUndecided', () => {
  const rt = (handoff: Config['handoff']) => {
    const config = { handoff } as Config
    return { config, handoffSettings: () => handoffSettings(config) } as unknown as Runtime
  }

  it('asks only a user with Auto Handoff on, API accounts and no answer yet', () => {
    assert.equal(apiUndecided(rt({ auto: true }), 1), true)
    assert.equal(apiUndecided(rt({ auto: true }), 0), false)
    assert.equal(apiUndecided(rt({ auto: false }), 1), false)
    assert.equal(apiUndecided(rt({ auto: true, api: false }), 1), false)
    assert.equal(apiUndecided(rt({ auto: true, api: true }), 1), false)
  })
})
