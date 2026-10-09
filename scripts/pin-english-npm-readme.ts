// npm publish stores a readme on the registry document, separate from the files in the tarball.
// @npmcli/package-json globs `{README,README.*}` and keeps the first name matching
// `/\.m?a?r?k?d?o?w?n?$/i`. Both README.md and README.zh-CN.md match. glob's path-scurry
// inserts each directory entry at the front of its child list, reversing readdir, so
// README.zh-CN.md is first. npmjs.com renders that registry field. The packed README.md
// stays English. Setting only `readmeFilename` does not help: an empty `readme` makes the
// glob run again and overwrite the name.
//
// `prepublishOnly` fills `readme` from README.md and moves README.zh-CN.md aside so the
// glob cannot see it. `postpublish` puts both back. `pnpm publish` snapshots the manifest
// before `prepublishOnly` and packs that copy, then runs `npm publish --ignore-scripts` on
// the tarball. Hiding README.zh-CN.md before that pack is what makes the tarball scan land
// on README.md. A committed `.npmrc` cannot set pnpm's `embed-readme`: leak-check rejects
// `.npmrc` as a credential-shaped file.
//
// `node scripts/pin-english-npm-readme.ts --publish` runs `npm publish --access public` and
// restores even when npm throws (npm 11 exits before `postpublish` when the version is
// already on the registry).
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(root, 'package.json')
const readmePath = join(root, 'README.md')
const localizedPath = join(root, 'README.zh-CN.md')

interface PackageManifest {
  readme?: string
  readmeFilename?: string
}

function gitDir(): string {
  const git = join(root, '.git')
  if (!existsSync(git)) return tmpdir()
  if (statSync(git).isDirectory()) return git
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))
  const raw = match?.[1]?.trim()
  if (!raw) return tmpdir()
  return isAbsolute(raw) ? raw : join(root, raw)
}

function backupDir(): string {
  return join(gitDir(), 'sideby-npm-publish-backup')
}

function moveFile(from: string, to: string): void {
  try {
    copyFileSync(from, to)
    unlinkSync(from)
  } catch (err) {
    console.error(`pin-english-npm-readme: could not move ${from} to ${to}`)
    throw err
  }
}

function restore(): void {
  const dir = backupDir()
  if (!existsSync(dir)) return
  const pkgBackup = join(dir, 'package.json')
  if (existsSync(pkgBackup)) copyFileSync(pkgBackup, pkgPath)
  const localizedBackup = join(dir, 'README.zh-CN.md')
  if (existsSync(localizedBackup)) {
    if (existsSync(localizedPath)) unlinkSync(localizedPath)
    moveFile(localizedBackup, localizedPath)
  }
  rmSync(dir, { recursive: true, force: true })
  console.log('pin-english-npm-readme: restored package.json and README.zh-CN.md')
}

function pin(): void {
  const dir = backupDir()
  if (existsSync(dir)) {
    console.log('pin-english-npm-readme: already pinned')
    return
  }
  if (!existsSync(readmePath) || !existsSync(localizedPath)) {
    console.error('pin-english-npm-readme: README.md and README.zh-CN.md must both be in the repo root')
    process.exitCode = 1
    return
  }
  mkdirSync(dir, { recursive: true })
  try {
    copyFileSync(pkgPath, join(dir, 'package.json'))
    moveFile(localizedPath, join(dir, 'README.zh-CN.md'))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest
    pkg.readmeFilename = 'README.md'
    pkg.readme = readFileSync(readmePath, 'utf8')
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  } catch (err) {
    restore()
    throw err
  }
  console.log('pin-english-npm-readme: registry readme set from README.md')
}

function check(): number {
  pin()
  try {
    if (process.exitCode) return 1
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest
    const readme = readFileSync(readmePath, 'utf8')
    const english = pkg.readmeFilename === 'README.md' && pkg.readme === readme
    const hidden = !existsSync(localizedPath)
    const notChinese = !pkg.readme?.includes('为什么不直接写个别名')
    if (!english || !hidden || !notChinese) {
      console.error(
        `pin-english-npm-readme: check failed (filename=${pkg.readmeFilename}, hidden=${hidden}, notChinese=${notChinese})`,
      )
      return 1
    }
    console.log('pin-english-npm-readme: check ok')
    return 0
  } finally {
    restore()
  }
}

function publish(extra: readonly string[]): number {
  pin()
  if (process.exitCode) {
    restore()
    return 1
  }
  try {
    const result = spawnSync('npm', ['publish', '--access', 'public', ...extra], {
      cwd: root,
      stdio: 'inherit',
    })
    return result.status ?? 1
  } finally {
    restore()
  }
}

const args = process.argv.slice(2)
if (args.includes('--restore')) {
  restore()
} else if (args.includes('--check')) {
  process.exitCode = check()
} else if (args.includes('--publish')) {
  process.exitCode = publish(args.filter((arg) => arg !== '--publish'))
} else if (args.length === 0) {
  pin()
} else {
  console.error('usage: node scripts/pin-english-npm-readme.ts [--restore | --check | --publish [npm flags]]')
  process.exitCode = 1
}
