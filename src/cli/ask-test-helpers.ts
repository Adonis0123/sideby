// Shared by the src/cli/ask*.test.ts files. Kept out of dist/ by tsconfig.build.json.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Value } from 'typebox/value'
import type { FakeHome } from '../../testing/index.ts'
import type { Env } from '../types.ts'
import { runMain, spawnMain } from './cli-test-helpers.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

// Joined at run time so the source never holds a key-shaped string (leak-check).
export const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-')

export function cli(
  h: FakeHome,
  args: string[],
  env: Env = h.env,
): Promise<{ code: number | null; out: string; err: string }> {
  return runMain(args, { env })
}

export function cliSpawn(
  h: FakeHome,
  args: string[],
  env: Env = h.env,
): Promise<{ code: number | null; out: string; err: string }> {
  return spawnMain(args, { env })
}
export function shape(name: string, out: string) {
  const data = JSON.parse(out)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[name]!, data),
    JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[name]!, data)]),
  )
  return data as Record<string, string | boolean | null>
}

export function ttyInput() {
  return Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw
      return this
    },
  })
}

export const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
export const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])
