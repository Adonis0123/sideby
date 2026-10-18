import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BAI, mirrorPath, SAI } from '../src/core/brand-mark.ts'
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

  it('puts the back buddy (Bai) in .h0 and the front one (Sai) in .h1, each with its props and a light halo', () => {
    const svg = outroMark()
    const [h0 = '', h1 = ''] = svg.split('<g class="h1">')
    assert.match(h0, /^<g class="h0">/)
    assert.ok(h0.includes(mirrorPath(BAI.above[0]!.d)), 'Bai wears the antenna (mirrored, as in the mark)')
    assert.ok(h0.includes(mirrorPath(BAI.behind[0]!.d)), 'Bai wears the battery')
    assert.ok(h1.includes(SAI.above[0]!.d), 'Sai wears the crown')
    assert.ok(h1.includes('#e0685a'), 'Sai wears the red cape')
    for (const part of [h0, h1]) assert.match(part, /stroke="#f6f0e5"[^>]*stroke-width="7\.6"/)
    assert.ok(!svg.includes('M30 27 L34 29.31'), 'the old forehead chevron is gone')
  })

  it('reads the markers from demo.html', () => {
    assert.equal(markBetweenMarkers('a<!-- mark:start -->X<!-- mark:end -->b'), 'X')
    assert.equal(markBetweenMarkers('no markers'), null)
  })
})
