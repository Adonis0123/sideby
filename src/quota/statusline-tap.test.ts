import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import {
  accountNameFromEnv,
  claudeQuotaCacheFile,
  cacheStateDir as tapStateDir,
} from '../families/claude/quota-cache.ts'
import type { Env } from '../types.ts'
import { runStatuslineTap } from './statusline-tap.ts'

const INPUT = fileURLToPath(new URL('../families/claude/fixtures/statusline-input.json', import.meta.url))

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

async function tap(argv: string[], env: Env, input: Buffer | string) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on('data', (c: Buffer) => out.push(c))
  stderr.on('data', (c: Buffer) => err.push(c))
  const code = await runStatuslineTap(argv, env, Readable.from([Buffer.from(input)]), stdout, stderr)
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
}

function cacheFile(h: FakeHome, name: string): string {
  return claudeQuotaCacheFile(tapStateDir(h.env), name)
}

describe('statusline-tap', () => {
  it('caches rate limits and passes output and exit code of the original command through', async () => {
    await withFakeHome(async (h) => {
      const input = await readFile(INPUT)
      const r = await tap(
        ['--orig-b64', b64('cat >/dev/null; printf hi; printf oops >&2; exit 3')],
        h.env,
        input,
      )
      assert.equal(r.code, 3)
      assert.equal(r.stdout, 'hi')
      assert.equal(r.stderr, 'oops')
      const file = cacheFile(h, 'main')
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      const cache = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(cache.version, 1)
      assert.ok(Number.isFinite(Date.parse(cache.observedAt)))
      assert.deepEqual(cache.windows, [
        { label: '5h', windowMinutes: 300, usedPercent: 42.4, resetsAt: '2026-10-05T12:00:00.000Z' },
        { label: '7d', windowMinutes: 10080, usedPercent: 10, resetsAt: '2026-10-11T12:00:00.000Z' },
      ])
    })
  })

  it('feeds the original command the exact stdin bytes', async () => {
    await withFakeHome(async (h) => {
      const input = await readFile(INPUT)
      const r = await tap(['--orig-b64', b64('cat')], h.env, input)
      assert.equal(r.code, 0)
      assert.equal(r.stdout, input.toString('utf8'))
    })
  })

  it('still passes through when stdin is not JSON, and writes no cache', async () => {
    await withFakeHome(async (h) => {
      const r = await tap(['--orig-b64', b64('cat; exit 7')], h.env, 'not json at all')
      assert.equal(r.code, 7)
      assert.equal(r.stdout, 'not json at all')
      await assert.rejects(stat(cacheFile(h, 'main')))
    })
  })

  it('prints a default line without an original command', async () => {
    await withFakeHome(async (h) => {
      const r = await tap([], h.env, await readFile(INPUT))
      assert.equal(r.code, 0)
      assert.equal(r.stdout, '5h 42% · 7d 10%\n')
      const empty = await tap([], h.env, '{}')
      assert.equal(empty.stdout, '\n')
    })
  })

  it('names the cache after CLAUDE_CONFIG_DIR and skips unknown directories', async () => {
    await withFakeHome(async (h) => {
      const input = await readFile(INPUT)
      await tap([], { ...h.env, CLAUDE_CONFIG_DIR: h.path('.claude-work') }, input)
      await stat(cacheFile(h, 'work'))
      await tap([], { ...h.env, CLAUDE_CONFIG_DIR: h.path('elsewhere') }, input)
      await assert.rejects(stat(cacheFile(h, 'elsewhere')))
      await assert.rejects(stat(cacheFile(h, 'main')))
    })
  })

  it('derives account names', () => {
    const home = '/home/u'
    assert.equal(accountNameFromEnv({ HOME: home }), 'main')
    assert.equal(accountNameFromEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/home/u/.claude/' }), 'main')
    assert.equal(accountNameFromEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/home/u/.claude-004/' }), '004')
    assert.equal(accountNameFromEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/x/.claude-Bad_Name' }), null)
    assert.equal(accountNameFromEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/x/.claude-main' }), null)
    assert.equal(accountNameFromEnv({ HOME: home, CLAUDE_CONFIG_DIR: '/x/other' }), null)
  })

  it('does not break pass-through when the state directory cannot be written', async () => {
    await withFakeHome(async (h) => {
      await h.write('blocked', 'a file, not a directory')
      const env = { ...h.env, XDG_STATE_HOME: h.path('blocked') }
      const r = await tap(['--orig-b64', b64('printf ok')], env, await readFile(INPUT))
      assert.equal(r.code, 0)
      assert.equal(r.stdout, 'ok')
    })
  })
})
