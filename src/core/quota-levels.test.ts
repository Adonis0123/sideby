// How old a Quota number is, per window (ADR-0073), with both rules of ADR-0051 kept.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitResetOffer, quotaAge, quotaIsStale, windowAge } from './quota-levels.ts'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const quota = (minutes: number, extra: object = {}) => ({
  observedAt: ago(minutes),
  source: 'test',
  ...extra,
})

test('a reading under an hour is current; an older one is old unless this computer has not used the login since', () => {
  assert.equal(windowAge(quota(59), null, NOW).stale, false)
  // ADR-0051, first rule: Usage that cannot be read counts as old.
  assert.equal(windowAge(quota(61), null, NOW).stale, true)
  assert.equal(windowAge(quota(61), null, NOW, null).stale, true)
  assert.equal(windowAge(quota(61), null, NOW, 'not a time').stale, true)
  // ADR-0051, second rule: the newest local use came at most 10 minutes after the reading, so it stands.
  const unused = windowAge(quota(180), null, NOW, ago(171))
  assert.deepEqual([unused.stale, unused.quiet], [false, true])
  assert.equal(windowAge(quota(180), null, NOW, ago(169)).stale, true)
})

test('no one-day limit: a week-old reading nobody used since is still current', () => {
  const week = windowAge(quota(7 * 24 * 60), null, NOW, ago(7 * 24 * 60 + 5))
  assert.deepEqual([week.stale, week.quiet], [false, true])
})

test('a failed check or an impossible time is old at once, whatever the age', () => {
  assert.equal(windowAge(quota(1, { fetchError: 'no answer' }), null, NOW).stale, true)
  assert.equal(windowAge({ observedAt: 'yesterday', source: 'test' }, null, NOW).stale, true)
  assert.equal(windowAge(quota(-5), null, NOW).stale, true, 'a time ahead of the clock')
  assert.equal(windowAge(quota(-0.5), null, NOW).stale, false, 'within a minute of clock drift')
})

test('the age is written only once a number is older than the Family asks, or old', () => {
  assert.equal(windowAge(quota(14), null, NOW, undefined, 15).showAge, false)
  assert.equal(windowAge(quota(16), null, NOW, undefined, 15).showAge, true)
  // A Family that is not asked says the age only once the number is old.
  assert.equal(windowAge(quota(45), null, NOW).showAge, false)
  assert.equal(windowAge(quota(61), null, NOW).showAge, true)
  assert.equal(windowAge(quota(1, { fetchError: 'no answer' }), null, NOW, undefined, 15).showAge, true)
})

test('each window is judged by its own read time and source, else the Quota’s', () => {
  const q = quota(5)
  const own = { observedAt: ago(200), source: 'asked the Host' }
  const lastUse = ago(100)
  const fresh = windowAge(q, {}, NOW, lastUse, 15)
  assert.deepEqual(fresh, { observedAt: ago(5), source: 'test', stale: false, quiet: false, showAge: false })
  // The same Quota, a window read 200 minutes ago and used since: old, while the others stay current.
  const older = windowAge(q, own, NOW, lastUse, 15)
  assert.deepEqual(older, {
    observedAt: ago(200),
    source: 'asked the Host',
    stale: true,
    quiet: false,
    showAge: true,
  })
  // Moving the Quota's time does not change what the window's own time says.
  assert.deepEqual(windowAge(quota(0), own, NOW, lastUse, 15), older)
})

test('a row speaks for its oldest window, and is old when any window is', () => {
  const q = { ...quota(5), windows: [{}, { observedAt: ago(200) }, { observedAt: ago(30) }] }
  const row = quotaAge(q, NOW, ago(100), 15)
  assert.deepEqual([row.observedAt, row.stale, row.showAge], [ago(200), true, true])
  const calm = quotaAge({ ...quota(5), windows: [{}, { observedAt: ago(30) }] }, NOW, ago(100), 15)
  assert.deepEqual([calm.observedAt, calm.stale, calm.showAge], [ago(30), false, true])
  // Without windows the Quota's own time stands; an unreadable window time is the oldest there is.
  assert.equal(quotaAge({ ...quota(5), windows: [] }, NOW).observedAt, ago(5))
  assert.equal(quotaAge({ ...quota(5), windows: [{ observedAt: '?' }, {}] }, NOW).stale, true)
})

test('the per-window rule is `quotaIsStale` on the window’s own time', () => {
  for (const minutes of [1, 59, 61, 500])
    for (const lastUse of [undefined, ago(minutes - 5), ago(minutes - 20)])
      assert.equal(
        windowAge(quota(0), { observedAt: ago(minutes) }, NOW, lastUse).stale,
        quotaIsStale({ observedAt: ago(minutes) }, NOW, lastUse),
      )
})

// When "use a reset" is a visible button (spec §3.40, ADR-0072).
const WARN = { short: 60, long: 85 }
const win = (label: string, usedPercent: number, extra: object = {}) => ({
  label,
  windowMinutes: label === '5h' ? 300 : 10_080,
  usedPercent,
  ...extra,
})

test('where the Host uses a reset, the button needs one in stock and a tight plan-wide window or an expiry near', () => {
  const stock = { available: 1 }
  assert.equal(
    limitResetOffer({ windows: [win('5h', 59), win('7d', 84)], limitResets: stock }, 'use', NOW, WARN),
    null,
  )
  assert.deepEqual(
    limitResetOffer({ windows: [win('5h', 60), win('7d', 84)], limitResets: stock }, 'use', NOW, WARN),
    {
      tight: [0],
      expiring: false,
    },
  )
  assert.deepEqual(
    limitResetOffer({ windows: [win('5h', 10), win('7d', 85)], limitResets: stock }, 'use', NOW, WARN),
    {
      tight: [1],
      expiring: false,
    },
  )
  // Nothing in stock, or a count the Host did not tell: no button, however full.
  assert.equal(
    limitResetOffer({ windows: [win('5h', 99)], limitResets: { available: 0 } }, 'use', NOW, WARN),
    null,
  )
  assert.equal(limitResetOffer({ windows: [win('5h', 99)] }, 'use', NOW, WARN), null)
  // A model group's window does not count here: the reset is for the plan-wide ones.
  assert.equal(
    limitResetOffer({ windows: [win('7d', 99, { name: 'Fable' })], limitResets: stock }, 'use', NOW, WARN),
    null,
  )
  // A known one that expires within 72 hours shows it even with room left; a later or passed expiry does not.
  const expires = (hours: number) => ({
    windows: [win('5h', 1)],
    limitResets: { available: 1, nextExpiresAt: new Date(NOW + hours * 3600_000).toISOString() },
  })
  assert.deepEqual(limitResetOffer(expires(72), 'use', NOW, WARN), { tight: [], expiring: true })
  assert.equal(limitResetOffer(expires(73), 'use', NOW, WARN), null)
  assert.equal(limitResetOffer(expires(-1), 'use', NOW, WARN), null)
})

test('where only the vendor page uses a reset, any window at its warning level shows the button, a model group too', () => {
  assert.equal(limitResetOffer({ windows: [win('5h', 59), win('7d', 84)] }, 'page', NOW, WARN), null)
  assert.deepEqual(
    limitResetOffer(
      { windows: [win('5h', 10), win('7d', 20), win('7d', 90, { name: 'Fable' })] },
      'page',
      NOW,
      WARN,
    ),
    { tight: [2], expiring: false },
  )
  assert.deepEqual(limitResetOffer({ windows: [win('5h', 61), win('7d', 91)] }, 'page', NOW, WARN), {
    tight: [0, 1],
    expiring: false,
  })
  assert.equal(limitResetOffer(null, 'page', NOW, WARN), null)
})

test('a window whose reset time has passed still counts: the numbers are read again before anything is used', () => {
  const passed = {
    windows: [win('5h', 95, { resetsAt: new Date(NOW - 60_000).toISOString() })],
    limitResets: { available: 2 },
  }
  assert.deepEqual(limitResetOffer(passed, 'use', NOW, WARN), { tight: [0], expiring: false })
})
