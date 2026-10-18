// Lists README media and copy that may be stale, from docs/assets/manifest.json. A medium is stale when a
// commit after its last retake (or its last `--mark`) touched a path it watches; the copy is worth a look when
// `feat` commits landed after the README last changed. npm runs it from `preversion`; it only warns and exits 0.
// Usage, from the repository root:
//   node scripts/readme-assets.ts              list what may be stale
//   node scripts/readme-assets.ts --mark <id>  record that <id> (or `copy`) was checked at HEAD and needs nothing
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { manifestText } from './manifest.ts'

interface Asset {
  id: string
  kind: 'auto' | 'creative'
  files?: string[]
  url?: string
  checked?: string
  watch: string[]
  retake: string
}
interface Manifest {
  assets: Asset[]
  copy: { files: string[]; commits: string; checked?: string }
}

const root = resolve(import.meta.dirname, '..')
const manifestFile = join(root, 'docs/assets/manifest.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const markArg = process.argv.indexOf('--mark')
if (markArg !== -1) {
  const id = process.argv[markArg + 1]
  const target = id === 'copy' ? manifest.copy : manifest.assets.find((a) => a.id === id)
  if (!target) {
    console.error(
      `readme-assets: no asset "${id}"; use one of ${[...manifest.assets.map((a) => a.id), 'copy'].join(', ')}`,
    )
    process.exit(1)
  }
  target.checked = git('rev-parse', '--short', 'HEAD')
  // Keep the file as `pnpm lint` wants it, from whatever directory this runs in.
  writeFileSync(manifestFile, manifestText(manifest))
  console.log(`readme-assets: ${id} checked at ${target.checked}; commit docs/assets/manifest.json`)
  process.exit(0)
}

const warnings: string[] = []
/** True when `c` is a commit of this branch's history (a `checked` from an amended or unpushed commit is not). */
function inHistory(c: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', c, 'HEAD'], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The later of the last commit that changed `files` and `checked`: the point a medium was last known good. */
function baseline(files: string[] = [], checked?: string, id = 'copy'): string | undefined {
  if (checked && !inHistory(checked)) {
    warnings.push(
      `${id}: checked commit ${checked} is not in this branch's history; check it, then --mark ${id}`,
    )
    checked = undefined
  }
  const candidates = [
    files.length ? git('log', '-1', '--format=%h', '--', ...files) : '',
    checked ?? '',
  ].filter(Boolean)
  const since = (c: string) => Number(git('rev-list', '--count', `${c}..HEAD`))
  return candidates.sort((a, b) => since(a) - since(b))[0]
}
const commits = (base: string, ...args: string[]) =>
  git('log', '--format=%h %s', `${base}..HEAD`, ...args)
    .split('\n')
    .filter(Boolean)

const report: string[] = []
for (const asset of manifest.assets) {
  const base = baseline(asset.files, asset.checked, asset.id)
  if (!base) {
    report.push(`${asset.id} (${asset.kind}): never checked; retake with: ${asset.retake}`)
    continue
  }
  const hits = commits(base, '--', ...asset.watch)
  if (!hits.length) continue
  report.push(
    `${asset.id} (${asset.kind}): ${hits.length} commit(s) since ${base} touched what it shows`,
    ...hits.slice(0, 8).map((c) => `  ${c}`),
    ...(hits.length > 8 ? [`  … and ${hits.length - 8} more`] : []),
    `  retake: ${asset.retake}`,
  )
}
const copyBase = baseline(manifest.copy.files, manifest.copy.checked)
const feats = copyBase
  ? commits(copyBase).filter((c) => new RegExp(manifest.copy.commits).test(c.slice(c.indexOf(' ') + 1)))
  : []
if (feats.length) {
  report.push(
    `copy: ${feats.length} feat commit(s) since the README last changed (${copyBase}); check README, README.zh-CN and docs/guide`,
    ...feats.map((c) => `  ${c}`),
  )
}

for (const w of warnings) console.log(`readme-assets: ${w}`)
if (!report.length) {
  console.log('readme-assets: README media and copy are up to date')
} else {
  console.log(
    [
      'readme-assets: these may be stale (a warning; nothing is blocked):',
      ...report,
      'Ask your agent to run the readme-assets skill, or after checking one by hand: node scripts/readme-assets.ts --mark <id>',
    ].join('\n'),
  )
}
