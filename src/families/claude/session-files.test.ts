// The transcript tail reader drops the first line of its window only when that line was cut.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../../testing/index.ts'
import { TAIL_BYTES, tailLinesWith } from './session-files.ts'

const TITLE = '{"type":"ai-title","aiTitle":"Fix the build"}'

describe('tailLinesWith', () => {
  it('keeps a whole line that starts exactly at the window boundary', async () => {
    await withFakeHome(async (h) => {
      const rest = `${TITLE}\n`
      const head = `${'x'.repeat(99)}\n`
      const file = await h.write('t.jsonl', head + rest + 'y'.repeat(TAIL_BYTES - rest.length))
      assert.deepEqual(await tailLinesWith(file, '"ai-title"'), [TITLE])
    })
  })

  it('drops the first line when the window cuts it', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('t.jsonl', `${TITLE}\n${'y'.repeat(TAIL_BYTES - 10)}`)
      assert.deepEqual(await tailLinesWith(file, '"ai-title"'), [])
    })
  })
})
