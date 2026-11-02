// A Portal tells the Panel in its frame to read its state again (ADR-0006, 2026-11-02 amendment), so a switch the
// Portal shows next to the Panel (Unattended Mode, say) and the Panel's own page agree at once.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { portalRefresh } from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'

const ORIGIN = 'http://localhost:17420'
const parent = {}
const framed = { parent, location: { origin: ORIGIN } }
const msg = { type: 'local-tools:refresh', version: 1 }

describe('portalRefresh', () => {
  it('accepts the refresh message from the parent at the same origin', () => {
    assert.equal(portalRefresh({ source: parent, origin: ORIGIN, data: msg }, framed), true)
  })

  it('ignores a message from anything but the parent', () => {
    assert.equal(portalRefresh({ source: {}, origin: ORIGIN, data: msg }, framed), false)
    assert.equal(portalRefresh({ source: null, origin: ORIGIN, data: msg }, framed), false)
  })

  it('ignores a message from another origin', () => {
    assert.equal(
      portalRefresh({ source: parent, origin: 'http://evil.localhost:17420', data: msg }, framed),
      false,
    )
  })

  it('ignores other messages and other versions', () => {
    for (const data of [
      null,
      'local-tools:refresh',
      { type: 'local-tools:ask', version: 1 },
      { ...msg, version: 2 },
    ])
      assert.equal(portalRefresh({ source: parent, origin: ORIGIN, data }, framed), false)
  })

  it('does nothing for a Panel opened on its own', () => {
    const win: { parent: unknown; location: { origin: string } } = {
      parent: null,
      location: { origin: ORIGIN },
    }
    win.parent = win
    assert.equal(portalRefresh({ source: win, origin: ORIGIN, data: msg }, win), false)
  })

  it('is what the page listens with', () => {
    assert.match(
      PAGE_SCRIPT,
      /addEventListener\('message', \(e\) => \{\n\s+if \(!portalRefresh\(e, window\)\) return/,
    )
  })
})
