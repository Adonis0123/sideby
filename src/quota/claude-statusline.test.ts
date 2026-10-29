import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { sha256 } from '../core/fs-safe.ts'
import type { ReadContext } from '../types.ts'
import { backupFile, claudeStatusline, unifiedDiff, wrapCommand } from './claude-statusline.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const ORIGINAL = `{
    "model": "opus",
    "statusLine": {
        "type": "command",
        "command": "bash ~/.claude/statusline-command.sh",
        "padding": 1
    },
    "theme": "dark"
}
`

function ctx(h: FakeHome, env = h.env): ReadContext {
  return { home: h.home, now: NOW, stateDir: h.path('.local/state/sideby'), env }
}

async function installSideby(h: FakeHome): Promise<void> {
  await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

async function setup(h: FakeHome, content = ORIGINAL, mode = 0o640): Promise<string> {
  await installSideby(h)
  return h.write('.claude/settings.json', content, mode)
}

describe('claude statusline setup', () => {
  it('plans, applies, reports enabled, and tears down to the exact original bytes', async () => {
    await withFakeHome(async (h) => {
      const file = await setup(h)
      const before = await readFile(file)
      const plan = await claudeStatusline.plan(ctx(h))
      assert.equal(plan.status, 'ready')
      assert.equal(plan.file, file)
      assert.match(plan.diff, /^--- a\/~\/\.claude\/settings\.json \(statusLine only\)\n\+\+\+ b\//)
      assert.match(plan.diff, /^- +"command": "bash ~\/\.claude\/statusline-command\.sh",$/m)
      assert.match(plan.diff, /^\+ +"command": "sideby statusline-tap --orig-b64 /m)
      assert.match(plan.diff, /^\+ +"refreshInterval": 30$/m)
      // command and padding (it gains a comma) change, refreshInterval is added.
      assert.equal(plan.diff.split('\n').filter((l) => /^[-+][^-+]/.test(l)).length, 5)

      const applied = await claudeStatusline.apply(ctx(h))
      assert.equal(applied.status, 'enabled')
      const wrapped = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(wrapped.statusLine, {
        type: 'command',
        command: wrapCommand('bash ~/.claude/statusline-command.sh'),
        padding: 1,
        refreshInterval: 30,
      })
      assert.equal(wrapped.model, 'opus')
      assert.equal((await stat(file)).mode & 0o777, 0o640)
      const backup = JSON.parse(await readFile(backupFile(ctx(h).stateDir), 'utf8'))
      assert.equal(backup.file, file)
      assert.equal(Buffer.from(backup.originalBase64, 'base64').equals(before), true)
      assert.equal((await stat(backupFile(ctx(h).stateDir))).mode & 0o777, 0o600)

      assert.equal((await claudeStatusline.plan(ctx(h))).status, 'enabled')
      const again = await claudeStatusline.apply(ctx(h))
      assert.equal(again.status, 'enabled')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLine.command, wrapped.statusLine.command)

      const down = await claudeStatusline.teardown(ctx(h))
      assert.equal(down.ok, true, down.message)
      assert.ok((await readFile(file)).equals(before))
      assert.equal((await stat(file)).mode & 0o777, 0o640)
      await assert.rejects(lstat(backupFile(ctx(h).stateDir)))
      const twice = await claudeStatusline.teardown(ctx(h))
      assert.equal(twice.ok, false)
      assert.match(twice.message, /not enabled/)
    })
  })

  it('refuses teardown when the file changed after apply, leaving it untouched', async () => {
    await withFakeHome(async (h) => {
      const file = await setup(h)
      assert.equal((await claudeStatusline.apply(ctx(h))).status, 'enabled')
      const edited = (await readFile(file, 'utf8')).replace('"dark"', '"light"')
      await writeFile(file, edited)
      const down = await claudeStatusline.teardown(ctx(h))
      assert.equal(down.ok, false)
      assert.match(down.message, /sideby statusline-tap/)
      // Only the statusLine change is shown; the user's other edits (the theme) never enter the diff.
      assert.match(down.diff ?? '', /^\+.*statusline-command\.sh/m)
      assert.doesNotMatch(down.diff ?? '', /light/)
      assert.equal(await readFile(file, 'utf8'), edited)
      await lstat(backupFile(ctx(h).stateDir))
    })
  })

  it('adds a plain tap command when there was no statusLine', async () => {
    await withFakeHome(async (h) => {
      const original = '{\n  "model": "sonnet"\n}\n'
      const file = await setup(h, original, 0o644)
      const applied = await claudeStatusline.apply(ctx(h))
      assert.equal(applied.status, 'enabled')
      assert.equal(
        await readFile(file, 'utf8'),
        '{\n  "model": "sonnet",\n  "statusLine": {\n    "type": "command",\n    "command": "sideby statusline-tap",\n    "refreshInterval": 30\n  }\n}\n',
      )
      assert.equal((await claudeStatusline.teardown(ctx(h))).ok, true)
      assert.ok((await readFile(file)).equals(Buffer.from(original)))
    })
  })

  it('keeps a refreshInterval the user set', async () => {
    await withFakeHome(async (h) => {
      const file = await setup(
        h,
        ORIGINAL.replace('"padding": 1', '"padding": 1,\n        "refreshInterval": 5'),
      )
      assert.equal((await claudeStatusline.apply(ctx(h))).status, 'enabled')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLine.refreshInterval, 5)
      assert.equal((await claudeStatusline.plan(ctx(h))).status, 'enabled')
    })
  })

  it('offers only the refresh to a status line an older sideby wrapped; teardown still restores the original', async () => {
    await withFakeHome(async (h) => {
      // What an older sideby left: the wrapped file without refreshInterval, and a backup naming it.
      const old = ORIGINAL.replace(
        '"bash ~/.claude/statusline-command.sh"',
        JSON.stringify(wrapCommand('bash ~/.claude/statusline-command.sh')),
      )
      const file = await setup(h, old)
      const bf = backupFile(ctx(h).stateDir)
      await h.write(
        relative(h.home, bf),
        JSON.stringify({
          file,
          originalBase64: Buffer.from(ORIGINAL).toString('base64'),
          originalHash: sha256(ORIGINAL),
          wrappedHash: sha256(old),
          appliedAt: NOW.toISOString(),
        }),
        0o600,
      )
      const plan = await claudeStatusline.plan(ctx(h))
      assert.equal(plan.status, 'ready')
      assert.equal(plan.upgrade, true)
      assert.match(plan.message, /waits on background agents/)
      assert.match(plan.diff, /^\+ +"refreshInterval": 30$/m)
      assert.doesNotMatch(plan.diff, /^[-+] +"command"/m)

      const before = await snapshot(h.home)
      const applied = await claudeStatusline.apply(ctx(h))
      assert.equal(applied.status, 'enabled')
      assert.equal(applied.upgrade, undefined)
      assert.deepEqual(
        diffSnapshots(before, await snapshot(h.home)),
        [relative(h.home, file), relative(h.home, bf)].sort(),
      )
      const now = await readFile(file, 'utf8')
      assert.deepEqual(JSON.parse(now).statusLine, { ...JSON.parse(old).statusLine, refreshInterval: 30 })
      const backup = JSON.parse(await readFile(bf, 'utf8'))
      assert.equal(backup.wrappedHash, sha256(now))
      assert.equal(backup.originalHash, sha256(ORIGINAL))
      assert.equal((await claudeStatusline.plan(ctx(h))).status, 'enabled')

      assert.equal((await claudeStatusline.teardown(ctx(h))).ok, true)
      assert.equal(await readFile(file, 'utf8'), ORIGINAL)
    })
  })

  it('adds the refresh without a backup, leaving teardown to refuse as before', async () => {
    await withFakeHome(async (h) => {
      const file = await setup(
        h,
        '{\n  "statusLine": {\n    "type": "command",\n    "command": "sideby statusline-tap"\n  }\n}\n',
      )
      const applied = await claudeStatusline.apply(ctx(h))
      assert.equal(applied.status, 'enabled')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLine.refreshInterval, 30)
      await assert.rejects(lstat(backupFile(ctx(h).stateDir)))
      assert.equal((await claudeStatusline.teardown(ctx(h))).ok, false)
    })
  })

  it('is blocked when settings.json is missing or not a JSON object', async () => {
    await withFakeHome(async (h) => {
      await installSideby(h)
      const missing = await claudeStatusline.plan(ctx(h))
      assert.equal(missing.status, 'blocked')
      assert.match(missing.message, /does not exist/)
      await h.write('.claude/settings.json', '[1, 2]')
      assert.equal((await claudeStatusline.apply(ctx(h))).status, 'blocked')
      await h.write('.claude/settings.json', '{ broken')
      assert.equal((await claudeStatusline.plan(ctx(h))).status, 'blocked')
      assert.equal(await readFile(h.path('.claude/settings.json'), 'utf8'), '{ broken')
    })
  })

  it('is blocked when sideby is not on PATH or only in the npx cache', async () => {
    await withFakeHome(async (h) => {
      const file = await h.write('.claude/settings.json', ORIGINAL)
      const none = await claudeStatusline.apply(ctx(h))
      assert.equal(none.status, 'blocked')
      assert.match(none.message, /npm i -g sideby/)
      const npxBin = h.path('.npm/_npx/abc123/node_modules/.bin')
      await mkdir(npxBin, { recursive: true })
      await writeFile(join(npxBin, 'sideby'), '#!/bin/sh\n', { mode: 0o755 })
      const npx = await claudeStatusline.plan(ctx(h, { ...h.env, PATH: `${npxBin}:/usr/bin:/bin` }))
      assert.equal(npx.status, 'blocked')
      assert.match(npx.message, /npx cache/)
      assert.equal(await readFile(file, 'utf8'), ORIGINAL)
    })
  })

  it('changes the target of a symlinked settings.json and keeps the link', async () => {
    await withFakeHome(async (h) => {
      await installSideby(h)
      const real = await h.write('dotfiles/claude-settings.json', ORIGINAL)
      await h.mkdir('.claude')
      await symlink(real, h.path('.claude/settings.json'))
      const plan = await claudeStatusline.apply(ctx(h))
      assert.equal(plan.status, 'enabled')
      assert.equal(plan.file, real)
      assert.match(plan.message, /is a link/)
      assert.ok((await lstat(h.path('.claude/settings.json'))).isSymbolicLink())
      assert.equal((await claudeStatusline.teardown(ctx(h))).ok, true)
      assert.equal(await readFile(real, 'utf8'), ORIGINAL)
    })
  })
})

describe('unifiedDiff', () => {
  it('returns empty for equal text and separate hunks for distant changes', () => {
    assert.equal(unifiedDiff('a\n', 'a\n', 'f'), '')
    const old = `${Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')}\n`
    const next = old.replace('l2\n', 'L2\n').replace('l17\n', 'L17\n')
    const d = unifiedDiff(old, next, 'f')
    assert.equal(d.match(/^@@/gm)?.length, 2)
    assert.match(d, /^@@ -1,6 \+1,6 @@$/m)
    assert.match(d, /^-l17\n\+L17$/m)
  })
})
