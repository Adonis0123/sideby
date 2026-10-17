// `pnpm release <patch|minor>` (docs/release.md): the daily release in one command. It tags the version with
// `npm version`, pushes the tag (release.yml checks and publishes it), waits until the registry serves it, and then
// puts the npm package back behind the global `sideby` when a Local Build (ADR-0024) was running there, so the
// maintainer runs what was published rather than an older checkout. It never publishes by itself.
import { execFileSync, spawnSync } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { fetchLatest } from '../src/core/update.ts'
import { dirs, globalPkg, kind, localOff, pkgDir } from './local.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUMPS = ['patch', 'minor'] as const
/** How long to wait for the registry: release.yml runs `pnpm check` before it publishes. */
const WAIT_MS = 25 * 60_000
const POLL_MS = 15_000

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

function step(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0)
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed; fix it and run pnpm release again`)
}

/** Why the checkout cannot be released now, or null. */
export function releaseProblem(s: { branch: string; dirty: string; behind: number }): string | null {
  if (s.branch !== 'main') return `releases go from main, and this is ${s.branch}; switch to main first`
  if (s.dirty) return 'the working tree has changes; commit or stash them first'
  if (s.behind) return `main is ${s.behind} commit(s) behind origin/main; pull first`
  return null
}

/** Whether the global sideby runs the Local Build of `pnpm local`. */
async function localBuildLive(): Promise<boolean> {
  const d = dirs()
  return (await kind(globalPkg(d))) === 'link' && (await readlink(globalPkg(d))) === pkgDir(d)
}

async function waitForRegistry(version: string): Promise<boolean> {
  const until = Date.now() + WAIT_MS
  while (Date.now() < until) {
    if ((await fetchLatest(process.env).catch(() => null)) === version) return true
    console.log(`waiting for npm to serve ${version} (release.yml checks, builds and publishes it)…`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return false
}

async function main(argv: string[]): Promise<void> {
  const bump = argv[0] as (typeof BUMPS)[number]
  if (!BUMPS.includes(bump)) throw new Error('usage: pnpm release <patch|minor>  (minor for new features)')
  git('fetch', '-q', 'origin')
  const problem = releaseProblem({
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain'),
    behind: Number(git('rev-list', '--count', 'HEAD..origin/main')),
  })
  if (problem) throw new Error(problem)
  step('npm', ['version', bump, '-m', '🔖 chore(release): v%s'])
  const version = (JSON.parse(git('show', 'HEAD:package.json')) as { version: string }).version
  step('git', ['push', '--follow-tags', 'origin', 'main'])
  if (!(await waitForRegistry(version)))
    throw new Error(
      `npm did not serve ${version} within ${WAIT_MS / 60_000} minutes; look at the Release workflow on GitHub, then run \`pnpm local --off\` once it is published`,
    )
  console.log(`sideby ${version} is published.`)
  if (await localBuildLive()) await localOff(dirs())
  else console.log('The global sideby is not a Local Build; `sideby update` installs the new version.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`pnpm release: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
