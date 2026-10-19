import assert from 'node:assert/strict'
import { lstat, readFile, readlink, symlink } from 'node:fs/promises'
import { test } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { applyShellSetup, rcFile, setupBlock, shellSetupStatus, userShell } from './shell-setup.ts'

test('setup appends one marked line, keeps every line the user wrote, and undo takes out only that line', async () => {
  await withFakeHome(async (h) => {
    const original = '# my zshrc\nexport EDITOR=vim'
    await h.write('.zshrc', original)
    const before = await shellSetupStatus('zsh', h.home, h.env, undefined)
    assert.deepEqual([before.loaded, before.added], [false, false])

    const added = await applyShellSetup('zsh', h.home, h.env, undefined)
    assert.equal(added.status, 'added')
    const text = await readFile(h.path('.zshrc'), 'utf8')
    assert.ok(text.startsWith(`${original}\n`))
    assert.ok(text.endsWith(setupBlock('zsh')))
    assert.match(text, /^eval "\$\(sideby shell-init zsh\)"$/m)
    // Run again: already loaded, nothing written.
    assert.equal((await applyShellSetup('zsh', h.home, h.env, undefined)).status, 'unchanged')
    assert.equal(await readFile(h.path('.zshrc'), 'utf8'), text)

    assert.equal((await applyShellSetup('zsh', h.home, h.env, undefined, { undo: true })).status, 'removed')
    assert.equal(await readFile(h.path('.zshrc'), 'utf8'), `${original}\n`)
    assert.equal((await applyShellSetup('zsh', h.home, h.env, undefined, { undo: true })).status, 'unchanged')
  })
})

test('a line the user wrote, or a configured shellInitFile, counts as loaded and is never touched', async () => {
  await withFakeHome(async (h) => {
    await h.write('.zshrc', 'source <(sideby shell-init zsh)\n')
    const st = await shellSetupStatus('zsh', h.home, h.env, undefined)
    assert.deepEqual([st.loaded, st.added], [true, false])
    assert.equal((await applyShellSetup('zsh', h.home, h.env, undefined, { undo: true })).status, 'unchanged')
    assert.equal(await readFile(h.path('.zshrc'), 'utf8'), 'source <(sideby shell-init zsh)\n')
    assert.equal((await shellSetupStatus('bash', h.home, h.env, { bash: '~/x.bash' })).loaded, true)
  })
})

test('a missing rc file is created; a linked one is written at its target and stays a link', async () => {
  await withFakeHome(async (h) => {
    assert.equal((await applyShellSetup('bash', h.home, h.env, undefined)).status, 'added')
    assert.equal(await readFile(h.path('.bashrc'), 'utf8'), setupBlock('bash'))

    const target = await h.write('dotfiles/zshrc', 'alias ll="ls -l"\n')
    await symlink(target, h.path('.zshrc'))
    const r = await applyShellSetup('zsh', h.home, h.env, undefined)
    assert.equal(r.status, 'added')
    assert.ok((await lstat(h.path('.zshrc'))).isSymbolicLink())
    assert.equal(await readlink(h.path('.zshrc')), target)
    assert.equal(await readFile(target, 'utf8'), `alias ll="ls -l"\n\n${setupBlock('zsh')}`)
  })
})

test('the shell comes from $SHELL, and zsh reads $ZDOTDIR', () => {
  assert.equal(userShell({ SHELL: '/bin/bash' }), 'bash')
  assert.equal(userShell({ SHELL: '/usr/bin/fish' }), 'zsh')
  assert.equal(rcFile('zsh', '/h', { ZDOTDIR: '/h/.config/zsh' }), '/h/.config/zsh/.zshrc')
  assert.equal(rcFile('bash', '/h', {}), '/h/.bashrc')
})
