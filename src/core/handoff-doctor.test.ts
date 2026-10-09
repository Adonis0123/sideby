// Doctor's Auto Handoff warnings (spec §3.17): shown only with handoff.auto, never failures.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { grokPlugin } from '../families/grok/index.ts'
import { createRuntime } from '../runtime.ts'

const builtins = [claudePlugin, grokPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

async function doctorCodes(h: FakeHome, handoff: object) {
  await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { cc002: 'claude:002' }, handoff }))
  const rt = await createRuntime({ env: h.env, builtins })
  const report = await rt.doctor({ persist: false })
  return {
    codes: report.general
      .filter((f) => f.code.startsWith('handoff.'))
      .map((f) => f.code)
      .sort(),
    report,
  }
}

describe('handoff doctor findings', () => {
  it('warns about the missing Claude tap, Grok hook file and unknown order entries', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-002/settings.json', '{}\n')
      await h.write('.grok/skills/.keep', '')
      const { codes, report } = await doctorCodes(h, {
        auto: true,
        families: { claude: { policy: 'order', order: ['cc002', 'codex009'] } },
      })
      assert.deepEqual(codes, ['handoff.no-quota-tap', 'handoff.order-unknown', 'handoff.setup-missing'])
      const order = report.general.find((f) => f.code === 'handoff.order-unknown')!
      assert.match(order.message, /codex009/)
      assert.doesNotMatch(order.message, /cc002/)
      assert.ok(report.general.filter((f) => f.code.startsWith('handoff.')).every((f) => f.level === 'warn'))
    })
  })

  it('warns when an order policy has no accounts listed', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      const { codes } = await doctorCodes(h, { auto: true, families: { claude: { policy: 'order' } } })
      assert.ok(codes.includes('handoff.order-empty'))
    })
  })

  it('says nothing when Auto Handoff is off, or once the Grok hook file is there', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.grok/skills/.keep', '')
      assert.deepEqual((await doctorCodes(h, { auto: false })).codes, [])
      await h.write('.grok/hooks/sideby-handoff.json', '{}\n')
      assert.ok(!(await doctorCodes(h, { auto: true })).codes.includes('handoff.setup-missing'))
    })
  })
})
