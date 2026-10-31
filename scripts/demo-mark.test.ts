import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { markDataUri } from '../src/core/brand-mark.ts'
import { DEMO_HTML, markBetweenMarkers, outroMark } from './demo-mark.ts'

describe('the demo outro mark', () => {
  it('is the mark brand-mark.ts draws; after changing it, run node scripts/demo-mark.ts', () => {
    const html = readFileSync(DEMO_HTML, 'utf8')
    assert.equal(
      markBetweenMarkers(html),
      outroMark(),
      'docs/assets/demo.html has an old outro mark. Run `node scripts/demo-mark.ts`, then retake the GIF.',
    )
  })

  it('is the painted Sai on the light logo tile, in the .h1 group the scene slides in', () => {
    const svg = outroMark()
    assert.match(svg, /^<g class="h1"><rect [^>]*fill="#e5f2fb"\/><image [^>]*href="data:image\/png;base64,/)
    assert.ok(svg.includes(markDataUri(256)), 'the painting is the 256 px one')
    assert.ok(!svg.includes('class="h0"'), 'the second buddy of the old mark is gone')
  })

  it('reads the markers from demo.html', () => {
    assert.equal(markBetweenMarkers('a<!-- mark:start -->X<!-- mark:end -->b'), 'X')
    assert.equal(markBetweenMarkers('no markers'), null)
  })
})
