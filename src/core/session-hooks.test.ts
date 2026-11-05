// The command a Host runs for sideby's session hooks: this Node and this sideby by absolute path, through the path
// the process was started by when that leads to this sideby, so a session follows the copy installed there now.
import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withFakeHome } from '../../testing/index.ts'
import { sidebyHookCommand } from './session-hooks.ts'

const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
const q = (s: string) => `'${s}'`

test('a hook runs this sideby by its real path when the started-by path is another program or missing', () => {
  const want = `${q(process.execPath)} ${q(main)} network-hook claude PreToolUse`
  assert.equal(sidebyHookCommand('network-hook', 'claude', 'PreToolUse', undefined), want)
  assert.equal(
    sidebyHookCommand('network-hook', 'claude', 'PreToolUse', fileURLToPath(import.meta.url)),
    want,
  )
  assert.equal(sidebyHookCommand('network-hook', 'claude', 'PreToolUse', '/no/such/sideby'), want)
})

test('a hook keeps the linked path sideby was started by, so an update or a Local Build switch reaches it', async () => {
  await withFakeHome(async (h) => {
    // Like a global install: bin/sideby -> node_modules/sideby/... -> the package folder.
    const bin = h.path('bin')
    await mkdir(bin)
    const link = join(bin, 'sideby')
    await symlink(main, link)
    assert.equal(
      sidebyHookCommand('unattended-hook', 'codex', 'Stop', link),
      `${q(process.execPath)} ${q(link)} unattended-hook codex Stop`,
    )
  })
})
