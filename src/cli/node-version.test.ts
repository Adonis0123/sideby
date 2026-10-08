import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { nodeTooOld } from './main.ts'

describe('node version check', () => {
  it('accepts 22.18 and newer, and refuses 22.17 and Node 20', () => {
    assert.equal(nodeTooOld('22.18.0'), false)
    assert.equal(nodeTooOld('22.18.1'), false)
    assert.equal(nodeTooOld('22.22.2'), false)
    assert.equal(nodeTooOld('24.11.0'), false)
    assert.equal(nodeTooOld('23.0.0'), false)
    assert.equal(nodeTooOld('22.17.9'), true)
    assert.equal(nodeTooOld('22.8.0'), true)
    assert.equal(nodeTooOld('20.19.5'), true)
    assert.equal(nodeTooOld('18.20.8'), true)
  })
})
