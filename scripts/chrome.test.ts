import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { panelLoaded, pollUntil } from './chrome.ts'

/** Runs a page expression against a stand-in `document`, as Runtime.evaluate would. */
const evaluateIn = (expression: string, document: unknown) =>
  new Function('document', `return (${expression})`)(document) as unknown

const panel = (lang: string, quota: string) => ({
  documentElement: { lang },
  querySelector: (sel: string) => (sel.includes('claude:work') ? { innerText: quota } : null),
})

describe('README media: waiting on the Panel', () => {
  it('is not ready, and does not throw, while a navigation has no document element yet', () => {
    const between = { documentElement: null, querySelector: () => null }
    assert.equal(evaluateIn(panelLoaded('en-US'), between), false)
    assert.equal(evaluateIn(panelLoaded(), between), false)
  })

  it('is ready once the Panel in the asked language shows a quota percentage', () => {
    assert.equal(evaluateIn(panelLoaded('zh-CN'), panel('en', '42%')), false)
    assert.equal(evaluateIn(panelLoaded('zh-CN'), panel('zh-CN', '…')), false)
    assert.equal(evaluateIn(panelLoaded('zh-CN'), panel('zh-CN', '42%')), true)
    assert.equal(evaluateIn(panelLoaded(), panel('en', '7%')), true)
  })

  it('keeps polling past a check that throws while the page navigates', async () => {
    let calls = 0
    const r = await pollUntil(
      async () => {
        calls++
        if (calls < 3) throw new Error('Execution context was destroyed.')
        return true
      },
      { tries: 5, waitMs: 1 },
    )
    assert.deepEqual(r, { ok: true })
    assert.equal(calls, 3)
  })

  it('gives up after its tries and names the last error', async () => {
    const r = await pollUntil(
      async () => {
        throw new Error("Cannot read properties of null (reading 'lang')")
      },
      { tries: 3, waitMs: 1 },
    )
    assert.equal(r.ok, false)
    assert.match(String(r.ok === false && r.lastError), /reading 'lang'/)
  })
})
