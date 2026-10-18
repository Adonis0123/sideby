// `pnpm local` (ADR-0024): compiles this checkout's working tree aside and puts it behind the global `sideby`, so
// the Panel in a Portal and the CLI run the code an agent just changed. A build that does not compile or start is
// never switched in. `--back` swaps the previous build back; `--off` returns to the npm package, the newest one
// published when the copy kept aside is older (after a release, that copy is the version before it).
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  devDir,
  globalPkg,
  keptVersion,
  kind,
  type LocalDirs,
  linkGlobal,
  offPlan,
  pkgDir,
  switchLocal,
  unlinkGlobal,
} from '../src/core/local-build.ts'

export { globalPkg, keptVersion, kind, type LocalDirs, linkGlobal, offPlan, pkgDir, unlinkGlobal }

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KEEP_OLD = 3
const BIN = 'dist/src/cli/main.js'

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
/** What a published package holds besides `dist`: package.json and its `files`, read from it so the two never drift. */
export async function copiedFiles(root = ROOT): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files?: string[] }
  return ['package.json', ...(pkg.files ?? []).filter((f) => f !== 'dist')]
}

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

/** `pnpm local --off`: the global sideby runs the npm package again, the newest published one. */
export async function localOff(d: LocalDirs): Promise<void> {
  const { resolvePaths } = await import('../src/core/paths.ts')
  const r = await switchLocal(resolvePaths(), d, 'npm', process.env, {
    onOutput: (t) => process.stdout.write(t),
  })
  if (!r.ok) throw new Error(r.message)
  console.log(`${r.message[0]?.toUpperCase()}${r.message.slice(1)}.`)
  await restartPanel(['sideby'])
  await refreshLoginItem(join(globalPkg(d), BIN))
  // switchLocal ran `sideby update --yes` of the npm code, which brings the skill to its version (spec §3.23).
  if (r.skillSynced === false)
    console.log('The sideby skill was not brought along; run `sideby update` to see why.')
}

/**
 * A login item (`sideby autostart on`, ADR-0029) records the sideby it starts; point an existing one at `entry`, the
 * sideby now in use. Never creates one; a failure only prints a note.
 */
async function refreshLoginItem(entry: string): Promise<void> {
  const { refreshAutostart } = await import('../src/core/autostart.ts')
  const { resolvePaths } = await import('../src/core/paths.ts')
  const real = await realpath(entry).catch(() => null)
  if (!real) return
  const r = await refreshAutostart({
    home: resolvePaths().home,
    launcher: { node: process.execPath, entry: real },
  })
  if (r.rewritten) console.log('The login item now starts it too.')
  else if (r.note && (r.state === 'on' || r.state === 'stale'))
    console.log(`The login item was not changed: ${r.note}`)
}

export function dirs(): LocalDirs {
  const prefix = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8' })
  if (prefix.status !== 0 || !prefix.stdout.trim()) throw new Error('`npm prefix -g` failed; is npm on PATH?')
  return { dev: devDir(process.env), prefix: prefix.stdout.trim() }
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
  for (const f of await copiedFiles())
    await cp(join(ROOT, f), join(stage, f), { recursive: true }).catch(() => {})
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
  if (argv.includes('--off')) return localOff(d)
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
  await refreshLoginItem(join(pkgDir(d), BIN))
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
