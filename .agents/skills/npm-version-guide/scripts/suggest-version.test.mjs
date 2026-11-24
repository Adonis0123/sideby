// Tests for suggest-version.mjs. Each test builds a small git repository and runs the script on it.
// Run: node --test skills/npm-version-guide/scripts/suggest-version.test.mjs
// Set VER_FIXTURES_DIR to keep the repositories in a folder of your choice (default: a new temp folder).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'suggest-version.mjs')
const KEEP = Boolean(process.env.VER_FIXTURES_DIR)
const BASE = KEEP ? path.resolve(process.env.VER_FIXTURES_DIR) : mkdtempSync(path.join(os.tmpdir(), 'suggest-version-'))
mkdirSync(BASE, { recursive: true })
after(() => { if (!KEEP) rmSync(BASE, { recursive: true, force: true }) })

// Isolate from the machine's git config (hooks, signing, default branch).
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' })
}

function repo(name, pkg) {
  const dir = path.join(BASE, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  if (pkg) write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  return dir
}

function write(dir, file, text) {
  const full = path.join(dir, file)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, text)
}

function commit(dir, message, files = {}) {
  for (const [f, t] of Object.entries(files)) {
    if (t === null) unlinkSync(path.join(dir, f))
    else write(dir, f, t)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', message)
}

function run(dir, ...args) {
  const out = execFileSync(process.execPath, [SCRIPT, '--json', ...args], { cwd: dir, env: ENV, encoding: 'utf8' })
  return JSON.parse(out)
}

function runText(dir, ...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env: ENV, encoding: 'utf8' })
}

const lib = (version, extra = {}) => ({ name: 'demo-lib', version, main: 'index.js', ...extra })

test('0.x: emoji feat and fix give patch', () => {
  const d = repo('zero-feat-fix', lib('0.3.0'))
  commit(d, 'chore: initial', { 'index.js': 'module.exports = 1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v0.3.0')
  commit(d, '✨ feat(cli): add a flag', { 'src/a.js': '2\n' })
  commit(d, ':bug: fix: handle empty input', { 'src/a.js': '3\n' })
  commit(d, '♻️ refactor: tidy', { 'src/a.js': '4\n' })
  const r = run(d)
  assert.equal(r.raw_level, 'minor')
  assert.equal(r.suggested_level, 'patch')
  assert.equal(r.next, 'confirm-bump')
  assert.equal(r.next_version, '0.3.1')
  assert.equal(r.config_source, 'inferred')
  const text = runText(d)
  assert.match(text, /^suggested_level: patch$/m)
  assert.match(text, /^next: confirm-bump$/m)
})

test('1.x: "!" gives major', () => {
  const d = repo('one-bang', lib('1.4.2'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.4.2')
  commit(d, '💥 feat(api)!: rename option', { 'src/a.js': '2\n' })
  const r = run(d)
  assert.equal(r.suggested_level, 'major')
  assert.equal(r.next_version, '2.0.0')
  assert.equal(r.npm_version_command, 'npm version 2.0.0')
})

test('1.x: feat gives minor, release commits ignored', () => {
  const d = repo('one-feat', lib('1.0.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'feat: add a helper', { 'src/a.js': '2\n' })
  commit(d, 'docs: readme', { 'README.md': 'x\n' })
  const r = run(d)
  assert.equal(r.suggested_level, 'minor')
  assert.equal(r.next_version, '1.1.0')
  assert.equal(r.prerelease_command, 'npm version 1.1.0-beta.0')
  assert.equal(r.prerelease_version, '1.1.0-beta.0')
})

test('no tag: first release', () => {
  const d = repo('no-tag', lib('1.0.0'))
  commit(d, 'feat: everything', { 'index.js': '1\n' })
  const r = run(d)
  assert.equal(r.next, 'first-release')
  assert.equal(r.suggested_level, 'none')
  assert.match(r.last_release, /^none/)
})

test('nothing since the last release', () => {
  const d = repo('nothing', lib('2.1.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  commit(d, '🔖 chore(release): v2.1.0')
  git(d, 'tag', 'v2.1.0')
  commit(d, 'ci: cache', { '.github/x.yml': 'a: 1\n' })
  const r = run(d)
  assert.equal(r.suggested_level, 'none')
  assert.equal(r.next, 'nothing-to-release')
})

test('unparseable commit goes to needs_ai, level stays a lower bound', () => {
  const d = repo('unparseable', lib('1.2.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.2.0')
  commit(d, 'fix: off by one', { 'src/a.js': '2\n' })
  commit(d, 'Update things', { 'src/a.js': '3\n' })
  const r = run(d)
  assert.equal(r.next, 'ai-review')
  assert.equal(r.suggested_level, 'patch')
  assert.equal(r.needs_ai_count, 1)
  assert.match(r.needs_ai[0].reason, /not a Conventional Commit/)
})

test('fix touching a file behind exports goes to needs_ai', () => {
  const d = repo('fix-exports', { name: 'demo-lib', version: '1.0.0', exports: { '.': './lib/index.js', './util': './lib/util.js' } })
  commit(d, 'chore: initial', { 'lib/index.js': '1\n', 'lib/util.js': '1\n', 'test/a.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'fix: tests only', { 'test/a.js': '2\n' })
  commit(d, 'fix(util): change return value', { 'lib/util.js': '2\n' })
  const r = run(d)
  assert.equal(r.next, 'ai-review')
  assert.equal(r.needs_ai.length, 1)
  assert.match(r.needs_ai[0].reason, /Public Interface file lib\/util\.js/)
  assert.equal(r.needs_ai[0].at_least, 'patch')
  assert.equal(r.suggested_level, 'patch')
  assert.equal(r.next_version, '1.0.1')
  assert.match(r.public_interface_tracked, /^2 of 2/)
})

test('package.json: removing a bin command gives major', () => {
  const d = repo('bin-removed', { name: 'demo-cli', version: '1.3.0', bin: { 'demo-cli': 'cli.js', 'demo-old': 'old.js' } })
  commit(d, 'chore: initial', { 'cli.js': '1\n', 'old.js': '1\n' })
  git(d, 'tag', 'v1.3.0')
  commit(d, 'chore: drop the old command', {
    'old.js': null,
    'package.json': `${JSON.stringify({ name: 'demo-cli', version: '1.3.0', bin: { 'demo-cli': 'cli.js' } }, null, 2)}\n`,
  })
  const r = run(d)
  assert.equal(r.suggested_level, 'major')
  assert.ok(r.signals.some((s) => s.level === 'major' && /bin command "demo-old" removed/.test(s.text)))
})

test('package.json: raised engines.node and new optional peer', () => {
  const d = repo('engines-peer', lib('1.0.0', { engines: { node: '>=18' } }))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'chore: require node 20', {
    'package.json': `${JSON.stringify(lib('1.0.0', { engines: { node: '>=20' }, peerDependencies: { react: '^18' }, peerDependenciesMeta: { react: { optional: true } } }), null, 2)}\n`,
  })
  const r = run(d)
  assert.equal(r.suggested_level, 'major')
  assert.ok(r.signals.some((s) => s.level === 'minor' && /optional peer/.test(s.text)))
})

test('monorepo: --package only looks at that folder and uses its config override', () => {
  const d = repo('monorepo', { name: 'root', version: '0.0.0', private: true })
  write(d, 'packages/a/package.json', `${JSON.stringify(lib('0.2.0', { name: '@demo/a' }), null, 2)}\n`)
  write(d, 'packages/b/package.json', `${JSON.stringify(lib('0.5.0', { name: '@demo/b' }), null, 2)}\n`)
  write(d, '.agents/release.json', `${JSON.stringify({
    version: 1,
    versioning: { zeroMajor: 'minor' },
    packages: [{ dir: 'packages/a', versioning: { zeroMajor: 'major' } }, { dir: 'packages/b' }],
  }, null, 2)}\n`)
  commit(d, 'chore: initial', { 'packages/a/index.js': '1\n', 'packages/b/index.js': '1\n' })
  git(d, 'tag', '@demo/a@0.2.0')
  git(d, 'tag', '@demo/b@0.5.0')
  commit(d, 'feat(b)!: break b', { 'packages/b/src.js': '2\n' })
  commit(d, 'fix(a): small fix', { 'packages/a/src.js': '2\n' })

  const a = run(d, '--package', 'packages/a')
  assert.equal(a.config_source, '.agents/release.json')
  assert.equal(a.zero_major, 'major')
  assert.equal(a.commits_since, 1)
  assert.equal(a.suggested_level, 'patch')
  assert.equal(a.next_version, '0.2.1')
  assert.match(a.last_release, /^@demo\/a@0\.2\.0/)

  const b = run(d, '--package', 'packages/b')
  assert.equal(b.commits_since, 1)
  assert.equal(b.raw_level, 'major')
  assert.equal(b.suggested_level, 'minor')
  assert.equal(b.next_version, '0.6.0')
})

test('the script changes nothing in the repository', () => {
  const d = repo('read-only', lib('1.0.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'feat: x', { 'index.js': '2\n' })
  write(d, 'dirty.txt', 'untracked\n')
  const before = [git(d, 'rev-parse', 'HEAD'), git(d, 'status', '--porcelain'), git(d, 'tag', '-l'), git(d, 'stash', 'list')]
  run(d)
  runText(d)
  const afterState = [git(d, 'rev-parse', 'HEAD'), git(d, 'status', '--porcelain'), git(d, 'tag', '-l'), git(d, 'stash', 'list')]
  assert.deepEqual(afterState, before)
})

test('Pre-release line: continue it instead of starting a new one', () => {
  const d = repo('prerelease', lib('1.3.0-beta.2'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.3.0-beta.2')
  commit(d, 'feat: more', { 'src/a.js': '2\n' })
  const r = run(d)
  assert.equal(r.current_is_prerelease, 'yes')
  assert.equal(r.suggested_level, 'minor')
  assert.equal(r.next_version, '1.3.0')
  assert.equal(r.prerelease_command, 'npm version 1.3.0-beta.3')
  assert.equal(r.prerelease_mode, 'continue')
})

test('runs when called through a symlinked skill folder', () => {
  const d = repo('symlink', lib('1.0.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'fix: x', { 'src/a.js': '2\n' })
  const link = path.join(BASE, 'linked-skill')
  rmSync(link, { force: true })
  symlinkSync(path.dirname(path.dirname(SCRIPT)), link)
  const out = execFileSync(process.execPath, [path.join(link, 'scripts', 'suggest-version.mjs')], { cwd: d, env: ENV, encoding: 'utf8' })
  assert.match(out, /^suggested_level: patch$/m)
  assert.match(out, /^next: confirm-bump$/m)
})

const pj = (o) => `${JSON.stringify(o, null, 2)}\n`

test('fix with an untracked entry point (build output) goes to needs_ai, keeping patch', () => {
  const d = repo('untracked-entry', { name: 'demo-lib', version: '1.0.0', main: 'dist/index.js' })
  write(d, '.gitignore', 'dist/\n')
  commit(d, 'chore: initial', { 'src/index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'fix: change output', { 'src/index.js': '2\n' })
  commit(d, 'docs: notes', { 'README.md': 'x\n' })
  const r = run(d)
  assert.match(r.public_interface_tracked, /^0 of 1/)
  assert.equal(r.next, 'ai-review')
  assert.equal(r.needs_ai.length, 1)
  assert.equal(r.needs_ai[0].at_least, 'patch')
  assert.equal(r.suggested_level, 'patch')
})

test('exports: entry set to null is breaking, conditions to one target needs review', () => {
  const before = { name: 'demo-lib', version: '1.0.0', exports: { '.': { import: './a.mjs', require: './a.cjs' }, './legacy': './legacy.js' } }
  const d = repo('exports-null', before)
  commit(d, 'chore: initial', { 'a.mjs': '1\n', 'a.cjs': '1\n', 'legacy.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'chore: reshape exports', { 'package.json': pj({ ...before, exports: { '.': './a.mjs', './legacy': null } }) })
  const r = run(d)
  assert.equal(r.suggested_level, 'major')
  assert.ok(r.signals.some((s) => s.level === 'major' && /"\.\/legacy" now points to null/.test(s.text)))
  assert.ok(r.signals.some((s) => s.level === 'needs_ai' && /"\." changed from conditions/.test(s.text)))
})

for (const [name, from, to, expect] of [
  ['caret to tilde', '^20.0.0', '~20.0.0', 'major'],
  ['upper bound added', '>=18', '>=18 <23', 'major'],
  ['widened', '>=18', '>=16', 'none'],
  ['union widened', '^18', '^18 || ^19', 'none'],
  ['hyphen range', '>=18', '18 - 20', 'needs_ai'],
]) {
  test(`engines.node ${name}: ${from} -> ${to} gives ${expect}`, () => {
    const d = repo(`engines-${name.replace(/\s+/g, '-')}`, lib('1.0.0', { engines: { node: from } }))
    commit(d, 'chore: initial', { 'index.js': '1\n' })
    git(d, 'tag', 'v1.0.0')
    commit(d, 'chore: engines', { 'package.json': pj(lib('1.0.0', { engines: { node: to } })) })
    const r = run(d)
    if (expect === 'needs_ai') assert.equal(r.next, 'ai-review')
    else assert.equal(r.raw_level, expect)
  })
}

test('peer dependency narrowed gives major', () => {
  const d = repo('peer-narrowed', lib('1.0.0', { peerDependencies: { react: '^18.0.0 || ^19.0.0' } }))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'chore: drop react 18', { 'package.json': pj(lib('1.0.0', { peerDependencies: { react: '^19.0.0' } })) })
  assert.equal(run(d).raw_level, 'major')
})

test('monorepo: v* tags are not trusted without a tagPrefix in the settings', () => {
  const d = repo('monorepo-v-tags', { name: 'root', version: '0.0.0', private: true, workspaces: ['packages/*'] })
  write(d, 'packages/a/package.json', pj(lib('1.0.0', { name: '@demo/a' })))
  commit(d, 'chore: initial', { 'packages/a/index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'fix(a): x', { 'packages/a/src.js': '2\n' })
  const r = run(d, '--package', 'packages/a')
  assert.equal(r.next, 'need-since')
  const s = run(d, '--package', 'packages/a', '--since', 'v1.0.0')
  assert.equal(s.next, 'confirm-bump')
  write(d, '.agents/release.json', pj({ version: 1, packages: [{ dir: 'packages/a', versioning: { tagPrefix: 'v' } }] }))
  commit(d, 'chore: settings')
  const t = run(d, '--package', 'packages/a')
  assert.match(t.last_release, /^v1\.0\.0/)
  assert.equal(t.suggested_level, 'patch')
})

test('invalid settings stop the run with fix-config', () => {
  const d = repo('bad-config', lib('1.0.0'))
  write(d, '.agents/release.json', pj({ version: 2, versioning: { zeroMajor: 'patch', preid: '01' }, publish: { prereleaseTag: 'latest', acess: 'public' } }))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'feat: x', { 'src/a.js': '1\n' })
  const r = run(d)
  assert.equal(r.next, 'fix-config')
  for (const re of [/"version" must be 1/, /zeroMajor/, /preid/, /prereleaseTag/, /unknown field "acess"/]) {
    assert.ok(r.config_errors.some((e) => re.test(e)), String(re))
  }
  for (const tag of ['v1.4', 'x', '1']) {
    write(d, '.agents/release.json', pj({ version: 1, publish: { prereleaseTag: tag } }))
    assert.equal(run(d).next, 'fix-config', tag)
  }
})

test('empty tagPrefix recognises bare version tags', () => {
  const d = repo('empty-prefix', lib('1.0.0'))
  write(d, '.agents/release.json', pj({ version: 1, versioning: { tagPrefix: '' } }))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', '1.0.0')
  commit(d, 'feat: x', { 'src/a.js': '2\n' })
  const r = run(d)
  assert.match(r.last_release, /^1\.0\.0 /)
  assert.equal(r.next_version, '1.1.0')
})

test('Pre-release: never goes backwards, promotes without new commits, major starts a new line', () => {
  const d = repo('prerelease-rc', lib('1.2.0-rc.3'))
  commit(d, 'chore: initial', { 'index.js': '1\n', 'src/a.js': '1\n' })
  git(d, 'tag', 'v1.2.0-rc.3')
  const idle = run(d)
  assert.equal(idle.next, 'confirm-bump')
  assert.equal(idle.next_version, '1.2.0')
  assert.match(idle.release_mode, /promote/)
  assert.equal(idle.prerelease_version, '1.2.0-rc.4')
  commit(d, 'fix: y', { 'src/a.js': '2\n' })
  const fixed = run(d)
  assert.equal(fixed.next_version, '1.2.0')
  assert.equal(fixed.prerelease_version, '1.2.0-rc.4')
  commit(d, 'feat!: z', { 'src/a.js': '3\n' })
  const broke = run(d)
  assert.equal(broke.next_version, '2.0.0')
  assert.equal(broke.prerelease_version, '2.0.0-beta.0')
  assert.equal(broke.prerelease_mode, 'start')
})

test('release habits: release script and the last release commit format are reported', () => {
  const d = repo('release-habits', lib('2.1.0', { scripts: { release: 'node scripts/release.mjs' } }))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  commit(d, '🔖 chore(release): v2.1.0')
  git(d, 'tag', 'v2.1.0')
  commit(d, 'feat: add a helper', { 'src/a.js': '2\n' })
  const r = run(d)
  assert.deepEqual(r.release_script, ['package.json scripts.release: node scripts/release.mjs'])
  assert.equal(r.release_commit_format, '🔖 chore(release): v%s')
  assert.equal(r.release_commit_format_from, 'the commit of v2.1.0')
  const text = runText(d)
  assert.match(text, /^release_script: package\.json scripts\.release: node scripts\/release\.mjs$/m)
  assert.match(text, /^release_commit_format: 🔖 chore\(release\): v%s$/m)
})

test('release habits: defaults without a release script or a versioned release commit', () => {
  const d = repo('release-defaults', lib('1.0.0'))
  commit(d, 'chore: initial', { 'index.js': '1\n' })
  git(d, 'tag', 'v1.0.0')
  commit(d, 'fix: small', { 'src/a.js': '2\n' })
  const r = run(d)
  assert.deepEqual(r.release_script, [])
  assert.equal(r.release_commit_format, 'chore(release): v%s')
  assert.match(r.release_commit_format_from, /^default \(the commit of v1\.0\.0 does not name 1\.0\.0\)$/)
  assert.match(runText(d), /^release_script: none in package\.json \(check AGENTS\.md/m)

  const first = repo('release-defaults-first', lib('1.0.0'))
  commit(first, 'feat: everything', { 'index.js': '1\n' })
  const f = run(first)
  assert.equal(f.next, 'first-release')
  assert.equal(f.release_commit_format, 'chore(release): v%s')
  assert.match(f.release_commit_format_from, /^default \(no release tag yet\)$/)

  const since = run(d, '--since', 'v1.0.0')
  assert.match(since.release_commit_format_from, /^default \(v1\.0\.0 names no version\)$/)
})

test('release habits: monorepo reports the root release script and package@version formats', () => {
  const d = repo('release-monorepo', { name: 'root', version: '0.0.0', private: true, scripts: { release: 'changeset publish' } })
  write(d, 'packages/a/package.json', `${JSON.stringify(lib('0.2.0', { name: '@demo/a' }), null, 2)}\n`)
  commit(d, 'chore: initial', { 'packages/a/index.js': '1\n' })
  commit(d, 'release: @demo/a@0.2.0')
  git(d, 'tag', '@demo/a@0.2.0')
  commit(d, 'fix(a): small fix', { 'packages/a/src.js': '2\n' })
  const a = run(d, '--package', 'packages/a')
  assert.deepEqual(a.release_script, ['root package.json scripts.release: changeset publish'])
  assert.equal(a.release_commit_format, 'release: @demo/a@%s')
})
