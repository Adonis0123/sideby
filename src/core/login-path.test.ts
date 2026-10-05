// Host PATH for a Panel started outside a terminal: read from the login shell, robust to rc-file noise.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { loginShellPath, mergePaths, parseMarkedPath } from './login-path.ts'

describe('login shell PATH', () => {
  it('merges the PATH the login shell prints between the markers, ignoring rc noise', async () => {
    await withFakeHome(async (h) => {
      // A fake shell: rc noise on stdout and stderr, then runs the script with a PATH it extends, then more noise.
      const shell = await h.write(
        'fake-shell',
        `#!/bin/sh
echo "Welcome! PATH=/not/this"
echo "rc warning" >&2
PATH="${h.home}/.local/bin:/opt/fake/bin:$PATH"; export PATH
/bin/sh -c "$2"
echo "bye"
`,
        0o755,
      )
      const r = await loginShellPath({ ...h.env, PATH: '/usr/bin:/bin' }, { shell })
      assert.equal(r.source, 'login-shell')
      assert.equal(r.path, `${h.home}/.local/bin:/opt/fake/bin:/usr/bin:/bin`)
    })
  })

  it('falls back to the current PATH on a timeout, a missing shell or unreadable output', async () => {
    await withFakeHome(async (h) => {
      const env = { ...h.env, PATH: '/usr/bin:/bin' }
      const slow = await h.write('slow-shell', '#!/bin/sh\nsleep 30\n', 0o755)
      const t0 = Date.now()
      const late = await loginShellPath(env, { shell: slow, timeoutMs: 300 })
      assert.ok(Date.now() - t0 < 5000)
      assert.equal(late.source, 'fallback')
      assert.equal(late.path, '/usr/bin:/bin')
      assert.match(late.reason!, /did not answer within 300 ms/)

      const missing = await loginShellPath(env, { shell: h.path('no-such-shell') })
      assert.deepEqual([missing.source, missing.path], ['fallback', '/usr/bin:/bin'])

      const silent = await h.write('silent-shell', '#!/bin/sh\necho hello\nexit 3\n', 0o755)
      const none = await loginShellPath(env, { shell: silent })
      assert.deepEqual([none.source, none.path], ['fallback', '/usr/bin:/bin'])
    })
  })

  it('keeps a PATH the shell printed even when the shell then hangs', async () => {
    await withFakeHome(async (h) => {
      const hang = await h.write(
        'hang-shell',
        '#!/bin/sh\nPATH="/opt/x/bin:$PATH"; export PATH\n/bin/sh -c "$2"\nsleep 30\n',
        0o755,
      )
      const r = await loginShellPath({ ...h.env, PATH: '/usr/bin' }, { shell: hang, timeoutMs: 500 })
      assert.equal(r.source, 'login-shell')
      assert.equal(r.path, '/opt/x/bin:/usr/bin')
    })
  })

  it('parses only absolute entries and merges without duplicates', () => {
    assert.equal(parseMarkedPath('noise'), undefined)
    assert.equal(parseMarkedPath('__SIDEBY_PATH_BEGIN__\n\n__SIDEBY_PATH_END__'), undefined)
    assert.equal(parseMarkedPath('__SIDEBY_PATH_BEGIN__\nrel:/a:\n__SIDEBY_PATH_END__\n'), '/a')
    assert.equal(mergePaths('/a:/b', '/b:/c::rel', undefined), '/a:/b:/c')
  })
})
