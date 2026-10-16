// `pnpm local` (ADR-0024): compiles this checkout's working tree aside and puts it behind the global `sideby`, so
// the Panel in a Portal and the CLI run the code an agent just changed. A build that does not compile or start is
// never switched in. `--back` swaps the previous build back; `--off` returns to the npm package.
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** What a published package holds besides `dist` (package.json `files`). */
const COPIED = ['package.json', 'schemas', 'skills', 'README.md', 'README.zh-CN.md', 'LICENSE']
const KEEP_OLD = 3
const BIN = 'dist/src/cli/main.js'

export interface LocalDirs {
  /** `$XDG_DATA_HOME/sideby-dev`: `pkg` (the running build), `old/<id>`, `npm` (the package it replaced). */
  dev: string
  /** npm's global prefix: `<prefix>/lib/node_modules/sideby` and `<prefix>/bin/sideby`. */
  prefix: string
}

const pkgDir = (d: LocalDirs) => join(d.dev, 'pkg')
const globalPkg = (d: LocalDirs) => join(d.prefix, 'lib', 'node_modules', 'sideby')
const globalBin = (d: LocalDirs) => join(d.prefix, 'bin', 'sideby')

async function kind(p: string): Promise<'link' | 'dir' | 'file' | null> {
  try {
    const s = await lstat(p)
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

async function buildIdOf(dir: string): Promise<string> {
  try {
    const id = (JSON.parse(await readFile(join(dir, 'dist', 'build.json'), 'utf8')) as { id?: unknown }).id
    if (typeof id === 'string' && /^[\w.-]+$/.test(id)) return id
  } catch {
    // an unreadable build gets a name of its own below
  }
  return `unknown-${randomBytes(3).toString('hex')}`
}

/** Moves the running build to `old/<id>` and `stage` into its place: two renames, never a half-written `pkg`. */
export async function switchIn(d: LocalDirs, stage: string): Promise<void> {
  const pkg = pkgDir(d)
  await mkdir(join(d.dev, 'old'), { recursive: true })
  if (await kind(pkg)) await rename(pkg, join(d.dev, 'old', await buildIdOf(pkg)))
  await rename(stage, pkg)
  const old = (await readdir(join(d.dev, 'old'))).sort()
  for (const name of old.slice(0, Math.max(0, old.length - KEEP_OLD)))
    await rm(join(d.dev, 'old', name), { recursive: true, force: true })
}

/** Swaps the running build with the newest old one; false when there is none. */
export async function switchBack(d: LocalDirs): Promise<boolean> {
  const old = (await readdir(join(d.dev, 'old')).catch(() => [] as string[])).sort()
  const prev = old.at(-1)
  if (!prev) return false
  const swap = join(d.dev, `.back-${prev}`)
  await rename(join(d.dev, 'old', prev), swap)
  await switchIn(d, swap)
  return true
}

/**
 * Points the global npm package at `pkg`. A real npm install moves to `<dev>/npm` first, so `--off` can put it
 * back without the network; a link elsewhere (npm link) is replaced. Returns what it did, for the summary.
 */
export async function linkGlobal(d: LocalDirs): Promise<string> {
  const target = globalPkg(d)
  const pkg = pkgDir(d)
  let did = 'the global sideby already runs the local build'
  const k = await kind(target)
  if (k !== 'link' || (await readlink(target)) !== pkg) {
    if (k === 'dir') {
      await rm(join(d.dev, 'npm'), { recursive: true, force: true })
      await rename(target, join(d.dev, 'npm'))
      did = `the npm package moved to ${join(d.dev, 'npm')}; the global sideby now runs the local build`
    } else {
      if (k) await rm(target, { force: true })
      did = 'the global sideby now runs the local build'
    }
    await mkdir(dirname(target), { recursive: true })
    await symlink(pkg, target, 'dir')
  }
  const bin = globalBin(d)
  const want = relative(dirname(bin), join(target, BIN))
  if ((await kind(bin)) !== 'link' || (await readlink(bin)) !== want) {
    await rm(bin, { force: true })
    await mkdir(dirname(bin), { recursive: true })
    await symlink(want, bin)
  }
  return did
}

/** Undoes linkGlobal: the npm package it moved comes back; false when there is none to restore (install it). */
export async function unlinkGlobal(d: LocalDirs): Promise<boolean> {
  const target = globalPkg(d)
  if ((await kind(target)) === 'link') await rm(target, { force: true })
  else if (await kind(target)) return true // a real package is already there
  if (!(await kind(join(d.dev, 'npm')))) return false
  await rename(join(d.dev, 'npm'), target)
  return true
}

function dirs(): LocalDirs {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const prefix = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8' })
  if (prefix.status !== 0 || !prefix.stdout.trim()) throw new Error('`npm prefix -g` failed; is npm on PATH?')
  return { dev: join(data, 'sideby-dev'), prefix: prefix.stdout.trim() }
}

/** Only an npm global install is handled (ADR-0024); pnpm, bun and Volta keep their own records. */
function refuseOtherManagers(d: LocalDirs): void {
  const p = d.prefix.split('\\').join('/')
  if (p.includes('/.volta/'))
    throw new Error('Volta manages the global sideby here; pnpm local supports npm only')
  if (spawnSync('which', ['sideby'], { encoding: 'utf8' }).stdout.match(/pnpm|\.bun\//))
    throw new Error('sideby on PATH comes from pnpm or bun; pnpm local supports an npm global install only')
}

async function git(args: string[]): Promise<string> {
  return (await run('git', args, { cwd: ROOT })).stdout.trim()
}

async function build(d: LocalDirs): Promise<{ stage: string; id: string; commit: string; dirty: boolean }> {
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(3).toString('hex')}`
  const stage = join(d.dev, `.stage-${id}`)
  await mkdir(d.dev, { recursive: true })
  try {
    await run(
      join(ROOT, 'node_modules', '.bin', 'tsc'),
      ['-p', 'tsconfig.build.json', '--outDir', join(stage, 'dist')],
      {
        cwd: ROOT,
        maxBuffer: 16 << 20,
      },
    )
  } catch (e) {
    await rm(stage, { recursive: true, force: true })
    const out = (e as { stdout?: string }).stdout ?? ''
    throw new Error(`tsc failed; the running build was kept:\n${out.split('\n').slice(0, 20).join('\n')}`)
  }
  await chmod(join(stage, BIN), 0o755)
  for (const f of COPIED) await cp(join(ROOT, f), join(stage, f), { recursive: true }).catch(() => {})
  // The real folder: a worktree's node_modules is often itself a link that goes away with the worktree.
  await symlink(await realpath(join(ROOT, 'node_modules')), join(stage, 'node_modules'), 'dir')
  const commit = await git(['rev-parse', '--short', 'HEAD']).catch(() => '')
  const dirty = (await git(['status', '--porcelain']).catch(() => '')) !== ''
  const info = { id, local: true, commit, dirty, builtAt: new Date().toISOString() }
  await writeFile(join(stage, 'dist', 'build.json'), `${JSON.stringify(info)}\n`)
  const version = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string })
    .version
  const smoke = spawnSync(process.execPath, [join(stage, BIN), '--version'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEBY_NO_UPDATE_NOTIFIER: '1' },
  })
  if (smoke.status !== 0 || !smoke.stdout.includes(version)) {
    await rm(stage, { recursive: true, force: true })
    throw new Error(
      `the new build did not start (sideby --version):\n${(smoke.stderr || smoke.stdout).slice(0, 2000)}`,
    )
  }
  return { stage, id, commit, dirty }
}

/** A background Panel of the old build is replaced: `ui --background` from the new code stops it first. */
async function restartPanel(sideby: string[]): Promise<boolean> {
  const { resolvePaths } = await import('../src/core/paths.ts')
  const { backgroundPanelPort } = await import('../src/panel/background.ts')
  const port = await backgroundPanelPort(resolvePaths()).catch(() => null)
  if (port === null) return false
  const [file, ...pre] = sideby as [string, ...string[]]
  const r = spawnSync(file, [...pre, 'ui', '--background', '--no-open', '--port', String(port)], {
    stdio: 'ignore',
  })
  return r.status === 0
}

async function main(argv: string[]): Promise<void> {
  const d = dirs()
  if (argv.includes('--off')) {
    if (await unlinkGlobal(d)) console.log('The global sideby runs the npm package again.')
    else {
      console.log('No npm package was kept; installing sideby from npm…')
      const r = spawnSync('npm', ['install', '-g', 'sideby'], { stdio: 'inherit' })
      if (r.status !== 0) throw new Error('`npm install -g sideby` failed; run it yourself')
    }
    await restartPanel(['sideby'])
    return
  }
  refuseOtherManagers(d)
  if (argv.includes('--back')) {
    if (!(await switchBack(d))) throw new Error(`no earlier local build in ${join(d.dev, 'old')}`)
    console.log(`Switched back to the previous local build (${await buildIdOf(pkgDir(d))}).`)
  } else {
    const b = await build(d)
    await switchIn(d, b.stage)
    console.log(
      `Local build ${b.commit || 'without git'}${b.dirty ? '+ (uncommitted changes)' : ''} is live.`,
    )
  }
  console.log(await linkGlobal(d))
  if (await restartPanel([process.execPath, join(pkgDir(d), BIN)]))
    console.log('The background panel restarted with it.')
  console.log(
    'Open panels reload by themselves; a Portal loads it on its next request. Undo: pnpm local --back',
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`pnpm local: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
