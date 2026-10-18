import assert from 'node:assert/strict'
import { access, stat } from 'node:fs/promises'
import { test } from 'node:test'
import { fakeHost, withFakeHome } from '../../testing/index.ts'
import {
  askLauncher,
  askRunCommand,
  guessTerminal,
  installedTerminals,
  launchArgs,
  launcherProblem,
  openTerminal,
  TERMINALS,
  validateCustomTemplate,
  wslDistro,
} from './terminal.ts'

const launcher = { node: '/opt/node/bin/node', entry: '/opt/sideby/dist/src/cli/main.js' }
const stateDir = '/opt/state/sideby'
const command = `'/opt/node/bin/node' '/opt/sideby/dist/src/cli/main.js' ask --run '0123456789abcdef' --state-dir '${stateDir}'`
const held = `${command} || { echo; echo "sideby: press Return to close"; read _; }`
const cwd = '/tmp/project'

test('accepts only sixteen lowercase hexadecimal task ids', () => {
  assert.equal(askRunCommand('0123456789abcdef', stateDir, launcher), command)
  assert.equal(
    askRunCommand('0123456789abcdef', stateDir, null),
    `sideby ask --run '0123456789abcdef' --state-dir '${stateDir}'`,
  )
  // Pasted by hand, a state folder a shell cannot take is left out rather than quoted.
  assert.equal(
    askRunCommand('0123456789abcdef', 'relative/state', null),
    "sideby ask --run '0123456789abcdef'",
  )
  for (const id of ["x'; rm -rf ~", '$(id)', '`id`', '0123456789abcdef\n', '0123456789abcdeF', ''])
    assert.throws(() => askRunCommand(id, stateDir, launcher))
  const old = "'/opt/node/bin/node' '/opt/sideby/dist/src/cli/main.js' ask --run '0123456789abcdef'"
  for (const bad of [
    'echo unsafe',
    "sideby ask --run '0123456789abcdef'",
    old,
    `${command}; id`,
    `${command}\n`,
    `${old} --state-dir $(id)`,
  ])
    assert.throws(() => launchArgs('orca', { cwd, command: bad }))
})

test('the task command runs this Node and CLI entry by absolute path, never sideby by name', () => {
  const own = askLauncher()
  assert.equal(own.node, process.execPath)
  assert.match(own.entry, /\/src\/cli\/main\.ts$/)
  const run = askRunCommand('0123456789abcdef', stateDir)
  assert.equal(run, `'${own.node}' '${own.entry}' ask --run '0123456789abcdef' --state-dir '${stateDir}'`)
  // A quote in a path stays POSIX-quoted, and the launcher still accepts the command.
  const quoted = askRunCommand('0123456789abcdef', "/opt/o'brien/state", {
    node: "/opt/o'brien/node",
    entry: launcher.entry,
  })
  assert.ok(quoted.startsWith("'/opt/o'\\''brien/node' "))
  assert.equal(launchArgs('orca', { cwd, command: quoted }).args[5], quoted)
  for (const node of ['relative/node', '/opt/a\\b/node', '/opt/a\nb/node', '/opt/a\u0007b/node']) {
    assert.equal(launcherProblem({ node, entry: launcher.entry })?.reason, 'unsafe-path')
    assert.throws(() => askRunCommand('0123456789abcdef', stateDir, { node, entry: launcher.entry }))
    assert.equal(launcherProblem(launcher, node)?.reason, 'unsafe-path')
    assert.throws(() => askRunCommand('0123456789abcdef', node, launcher))
  }
  const npx = launcherProblem({
    node: launcher.node,
    entry: '/u/.npm/_npx/1a2b/node_modules/sideby/dist/src/cli/main.js',
  })
  assert.equal(npx?.reason, 'npx-cache')
  assert.match(npx!.detail, /npm i -g sideby/)
  assert.equal(launcherProblem(launcher), null)
  assert.equal(launcherProblem(launcher, stateDir), null)
})

test('chooses installed config, then installed environment, then Terminal', () => {
  const installed = [{ id: 'ghostty' as const }, { id: 'kitty' as const }]
  assert.deepEqual(guessTerminal({ preferred: 'kitty', env: { TERM_PROGRAM: 'ghostty' }, installed }), {
    id: 'kitty',
    source: 'config',
  })
  assert.deepEqual(guessTerminal({ preferred: 'orca', env: { TERM_PROGRAM: 'ghostty' }, installed }), {
    id: 'ghostty',
    source: 'env',
  })
  assert.deepEqual(guessTerminal({ env: { TERM_PROGRAM: 'unknown' }, installed }), {
    id: 'terminal',
    source: 'default',
  })
  for (const entry of TERMINALS.filter((t) => t.id !== 'custom')) {
    const env = entry.marker ? { [entry.marker]: '1' } : { TERM_PROGRAM: entry.termPrograms[0] }
    assert.equal(guessTerminal({ env, installed: [{ id: entry.id }] }).id, entry.id)
  }
})

test('discovers apps in both directories and executable Orca on PATH', async () => {
  await withFakeHome(async (h) => {
    await h.mkdir('Applications/Ghostty.app')
    await h.mkdir('system/kitty.app')
    await h.write('Applications/Alacritty.app', 'not a directory')
    const orca = await fakeHost(h, 'orca')
    const deps = {
      home: h.home,
      env: { PATH: h.bin },
      appDirs: [h.path('system'), h.path('Applications')],
      fs: { stat, access },
      platform: 'darwin' as const,
    }
    const found = await installedTerminals(deps)
    assert.deepEqual(
      found.map((t) => t.id),
      ['ghostty', 'orca', 'kitty'],
    )
    assert.equal(found.find((t) => t.id === 'orca')?.executable, orca)
    assert.equal(
      found.find((t) => t.id === 'kitty')?.executable,
      h.path('system/kitty.app/Contents/MacOS/kitty'),
    )
    assert.deepEqual(await installedTerminals({ ...deps, platform: 'linux' }), [])
  })
})

test('builds separate argv for every command line terminal', () => {
  const expected = {
    ghostty: {
      file: '/usr/bin/open',
      args: ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', '/bin/sh', '-lc', held],
    },
    orca: {
      file: 'orca',
      args: [
        'terminal',
        'create',
        '--worktree',
        'active',
        '--command',
        command,
        '--title',
        'sideby',
        '--focus',
        '--json',
      ],
    },
    wezterm: {
      file: '/Applications/WezTerm.app/Contents/MacOS/wezterm',
      args: ['start', '--cwd', cwd, '--', '/bin/sh', '-lc', held],
    },
    kitty: {
      file: '/Applications/kitty.app/Contents/MacOS/kitty',
      args: ['--single-instance', '--directory', cwd, '/bin/sh', '-lc', held],
    },
    alacritty: {
      file: '/usr/bin/open',
      args: ['-na', 'Alacritty', '--args', '--working-directory', cwd, '-e', '/bin/sh', '-lc', held],
    },
  }
  for (const id of Object.keys(expected) as (keyof typeof expected)[])
    assert.deepEqual(launchArgs(id, { cwd, command }), expected[id])
})

test('custom substitution preserves argument boundaries without evaluating shell syntax', () => {
  const cwd = `/tmp/a ' " $(touch /tmp/x)\nend`
  assert.deepEqual(
    launchArgs('custom', { cwd, command, custom: '"/Applications/My Terminal/bin" --cwd="{cwd}" -e {cmd}' }),
    { file: '/Applications/My Terminal/bin', args: [`--cwd=${cwd}`, '-e', command] },
  )
  for (const custom of ['', 'app "unterminated', 'app {cwd}', 'app {cmd}', '{cmd} {cwd}']) {
    assert.throws(() => launchArgs('custom', { cwd, command, custom }))
    assert.throws(() => validateCustomTemplate(custom), /custom terminal/)
  }
  assert.deepEqual(validateCustomTemplate('my-term --cwd {cwd} -e {cmd}'), [
    'my-term',
    '--cwd',
    '{cwd}',
    '-e',
    '{cmd}',
  ])
})

test('AppleScript gets only the fixed command, escaped for AppleScript, and never the working directory', () => {
  const cwd = `/tmp/a ' " $(touch /tmp/x)\nend\\\u0001\b\f`
  const hostile = askRunCommand('0123456789abcdef', stateDir, {
    node: '/opt/say "hi"/node',
    entry: launcher.entry,
  })
  for (const id of ['terminal', 'iterm2'] as const) {
    const result = launchArgs(id, { cwd, command: hostile })
    assert.equal(result.file, '/usr/bin/osascript')
    assert.equal(result.args[0], '-e')
    const script = result.args[1]!
    assert.ok(!script.includes('touch'))
    assert.ok(!script.includes(' cd '))
    // A control character would not compile in AppleScript; the script has none but its own newlines.
    assert.ok(!new RegExp(String.raw`[\x00-\x09\x0b-\x1f\x7f]`).test(script))
    const literal = script.match(/(?:do script|write text) ("(?:\\.|[^"\\])*")/)?.[1]
    assert.ok(literal)
    // Only \\ and \" are AppleScript escapes, so JSON reads this literal back the same way.
    assert.equal(JSON.parse(literal), hostile)
    if (id === 'terminal') assert.match(script, /if not .*running then launch/)
    else {
      assert.match(script, /create window with default profile/)
      // Never the current window: it can be iTerm2's updater or settings window.
      assert.doesNotMatch(script, /current window/)
    }
  }
})

test('maps platform, missing installation, Automation refusal and exec failures', async () => {
  const opts = { cwd, command, platform: 'darwin' as const, installed: [{ id: 'terminal' as const }] }
  let calls = 0
  const exec = async () => {
    calls++
    return { code: 0, stdout: '', stderr: '' }
  }
  assert.deepEqual(await openTerminal('terminal', { ...opts, platform: 'linux' }, exec), {
    ok: false,
    reason: 'unsupported-platform',
  })
  assert.equal((await openTerminal('orca', opts, exec)).ok, false)
  assert.equal(calls, 0)
  assert.deepEqual(await openTerminal('terminal', opts, exec), { ok: true })
  for (const stderr of ['error -1743', 'Not authorized to send Apple events']) {
    const result = await openTerminal('terminal', opts, async () => ({ code: 1, stdout: '', stderr }))
    assert.ok(!result.ok && result.reason === 'automation-denied')
  }
  const result = await openTerminal('terminal', opts, async () => {
    throw new Error('private output')
  })
  assert.ok(!result.ok && result.reason === 'failed')
  assert.ok(!JSON.stringify(result).includes('private output'))
  const failed = await openTerminal('terminal', opts, async () => ({
    code: 2,
    stdout: '',
    stderr: 'private output',
  }))
  assert.ok(!failed.ok && failed.reason === 'failed')
})

test('AppleScript argv handles running and stopped terminals in one invocation', () => {
  const text = `"${command}"`
  assert.deepEqual(launchArgs('terminal', { cwd, command }), {
    file: '/usr/bin/osascript',
    args: [
      '-e',
      `tell application id "com.apple.Terminal"
if not running then launch
do script ${text}
activate
end tell`,
    ],
  })
  assert.deepEqual(launchArgs('iterm2', { cwd, command }), {
    file: '/usr/bin/osascript',
    args: [
      '-e',
      // Always its own new window: the current window may be the updater, and a fresh start may open none.
      `tell application id "com.googlecode.iterm2"
activate
set taskWindow to (create window with default profile)
tell current session of taskWindow to write text ${text}
end tell`,
    ],
  })
})

test('uses discovered binaries and preserves hostile cwd as argv', async () => {
  await withFakeHome(async (h) => {
    const cwd = `${h.home}/'"$(touch /tmp/x)\n`
    const executable = await fakeHost(h, 'wezterm')
    const installed = [{ id: 'wezterm' as const, executable }]
    const result = await openTerminal(
      'wezterm',
      { cwd, command, installed, platform: 'darwin' },
      async (file, args) => {
        assert.equal(file, executable)
        assert.deepEqual(args, ['start', '--cwd', cwd, '--', '/bin/sh', '-lc', held])
        return { code: 0, stdout: '', stderr: '' }
      },
    )
    assert.deepEqual(result, { ok: true })
    for (const id of ['ghostty', 'kitty', 'alacritty'] as const) {
      const launch = launchArgs(id, { cwd, command })
      assert.ok(launch.args.includes(cwd) || launch.args.includes(`--working-directory=${cwd}`))
      assert.equal(launch.args.at(-1), held)
    }
    assert.ok(!JSON.stringify(launchArgs('orca', { cwd, command })).includes(cwd))
  })
})

test('finds the bundled Orca CLI when PATH has no Orca', async () => {
  await withFakeHome(async (h) => {
    await h.mkdir('Applications/Orca.app')
    const found = await installedTerminals({
      home: h.home,
      env: { PATH: h.bin },
      appDirs: [h.path('Applications')],
      platform: 'darwin',
    })
    assert.equal(found[0]?.executable, h.path('Applications/Orca.app/Contents/Resources/bin/orca'))
  })
})

test('on WSL, finds Windows Terminal on PATH or in a Windows user folder', async () => {
  await withFakeHome(async (h) => {
    const deps = { home: h.home, env: { PATH: h.bin }, platform: 'linux' as const, wslMount: h.path('mnt') }
    assert.deepEqual(await installedTerminals(deps), [])
    await h.write('mnt/c/Users/me/AppData/Local/Microsoft/WindowsApps/wt.exe', '', 0o755)
    assert.deepEqual(await installedTerminals(deps), [
      {
        id: 'windows-terminal',
        executable: h.path('mnt/c/Users/me/AppData/Local/Microsoft/WindowsApps/wt.exe'),
      },
    ])
    const onPath = await fakeHost(h, 'wt.exe')
    assert.equal((await installedTerminals(deps))[0]?.executable, onPath)
    // Plain Linux has no Windows Terminal to open.
    assert.deepEqual(await installedTerminals({ ...deps, wslMount: undefined }), [])
  })
})

test('Windows Terminal opens a tab that runs the task in this WSL distribution', () => {
  const wt = '/mnt/c/Users/me/AppData/Local/Microsoft/WindowsApps/wt.exe'
  // wt.exe splits its command line at `;`, so the hold after a failure is written without one.
  const tabHeld = `${command} || (echo && echo sideby: press Return to close && read _)`
  assert.deepEqual(launchArgs('windows-terminal', { cwd, command, executable: wt, wslDistro: 'Ubuntu' }), {
    file: wt,
    args: [
      '-w',
      '0',
      'new-tab',
      '--title',
      'sideby',
      'wsl.exe',
      '-d',
      'Ubuntu',
      '--cd',
      cwd,
      '-e',
      '/bin/sh',
      '-lc',
      tabHeld,
    ],
  })
  assert.deepEqual(launchArgs('windows-terminal', { cwd, command, executable: wt }).args.slice(5, 8), [
    'wsl.exe',
    '--cd',
    cwd,
  ])
  // A zsh or bash login shell runs it interactively, like a new tab would, so its rc file puts sideby on PATH.
  assert.deepEqual(
    launchArgs('windows-terminal', { cwd, command, executable: wt, shell: '/usr/bin/zsh' }).args.slice(-3),
    ['/usr/bin/zsh', '-lic', tabHeld],
  )
  assert.deepEqual(
    launchArgs('windows-terminal', { cwd, command, executable: wt, shell: '/usr/bin/fish' }).args.slice(
      -3,
      -1,
    ),
    ['/bin/sh', '-lc'],
  )
  // A `;` or `"` would be split or unquoted on the way through wt.exe and wsl.exe; refuse instead of guessing.
  for (const bad of ['/tmp/a;b', '/tmp/"a"'])
    assert.throws(() => launchArgs('windows-terminal', { cwd: bad, command, executable: wt }))
})

test('opens Windows Terminal and custom templates on Linux, and only those', async () => {
  const exec = async () => ({ code: 0, stdout: '', stderr: '' })
  const installed = [{ id: 'windows-terminal' as const, executable: '/mnt/c/wt.exe' }]
  assert.deepEqual(
    await openTerminal('windows-terminal', { cwd, command, platform: 'linux', installed }, exec),
    { ok: true },
  )
  assert.deepEqual(
    await openTerminal(
      'custom',
      { cwd, command, custom: 'my-term --cwd {cwd} -e {cmd}', platform: 'linux', installed: [] },
      exec,
    ),
    { ok: true },
  )
  assert.deepEqual(await openTerminal('ghostty', { cwd, command, platform: 'linux', installed }, exec), {
    ok: false,
    reason: 'unsupported-platform',
  })
})

test('guesses Windows Terminal on WSL, where there is no macOS Terminal', () => {
  assert.equal(guessTerminal({ env: {}, installed: [{ id: 'windows-terminal' }] }).id, 'windows-terminal')
  assert.equal(
    guessTerminal({ env: {}, installed: [{ id: 'windows-terminal' }, { id: 'custom' }] }).id,
    'windows-terminal',
  )
})

test('reads the WSL distribution from the environment, else from wslpath', async () => {
  const exec = async () => ({ code: 0, stdout: '\\\\wsl.localhost\\Ubuntu-24.04\\\n', stderr: '' })
  assert.equal(await wslDistro({ WSL_DISTRO_NAME: 'Debian' }, exec), 'Debian')
  assert.equal(await wslDistro({}, exec), 'Ubuntu-24.04')
  assert.equal(
    await wslDistro({}, async () => ({ code: 0, stdout: '\\\\wsl$\\Ubuntu\\', stderr: '' })),
    'Ubuntu',
  )
  assert.equal(await wslDistro({}, async () => ({ code: 1, stdout: '', stderr: 'no' })), undefined)
})
