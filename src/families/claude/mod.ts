// sideby's Claude Code mod (spec §3.32 step 3, ADR-0039): `mods/claude` in the package, loaded with `--plugin-dir`
// so nothing is written into the Account directory. Claude Code runs mods from 2.1.287 on ("Mods are on by default.
// In the terminal, use Claude Code v2.1.287 or later", code.claude.com/docs/en/plugins/mods/overview, read
// 2026-10-20); an older Claude Code would load the folder as a plugin it cannot read, so it gets no flag.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '../../core/fs-safe.ts'
import type { Env } from '../../types.ts'

export const MOD_MIN_VERSION = '2.1.287'

/** The mod folder: three levels above this file in a checkout, four in the published `dist/src`. */
export function claudeModDir(): string | undefined {
  for (const rel of ['../../../mods/claude', '../../../../mods/claude']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir
  }
  return undefined
}

/** `2.1.304` from `claude --version` output such as `2.1.304 (Claude Code)`. */
export function parseClaudeVersion(out: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+)/.exec(out)?.[1]
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export type VersionRunner = (bin: string, env: Env) => Promise<string>

const runVersion: VersionRunner = (bin, env) =>
  new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { env: env as NodeJS.ProcessEnv, timeout: 5000 }, (err, out) =>
      err ? reject(err) : resolve(String(out)),
    )
  })

interface VersionCache {
  format: 1
  path: string
  mtimeMs: number
  size: number
  version: string
}

/**
 * The version of the Claude Code at `bin`, asked once per installed binary: the answer is kept in
 * `<state>/cache/claude-version.json` with the binary's real path, size and change time, and asked again when any
 * of them differs (an update replaces the binary or moves the link). Undefined when it cannot be told.
 */
export async function claudeVersion(
  bin: string,
  env: Env,
  stateDir: string,
  run: VersionRunner = runVersion,
): Promise<string | undefined> {
  let path: string
  let mtimeMs: number
  let size: number
  try {
    path = await realpath(bin)
    ;({ mtimeMs, size } = await stat(path))
  } catch {
    return undefined
  }
  const file = join(stateDir, 'cache', 'claude-version.json')
  try {
    const kept = JSON.parse(await readFile(file, 'utf8')) as Partial<VersionCache>
    if (
      kept.format === 1 &&
      kept.path === path &&
      kept.mtimeMs === mtimeMs &&
      kept.size === size &&
      typeof kept.version === 'string'
    )
      return kept.version
  } catch {
    // Not kept yet, or unreadable: ask the binary.
  }
  let version: string | undefined
  try {
    version = parseClaudeVersion(await run(path, env))
  } catch {
    return undefined
  }
  if (!version) return undefined
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const entry: VersionCache = { format: 1, path, mtimeMs, size, version }
    await writeFileAtomic(file, `${JSON.stringify(entry)}\n`, 0o600)
  } catch {
    // Asked again next time.
  }
  return version
}

/** Options after which Claude Code prints and exits, so there is nothing for the mod to show. */
const HEADLESS = new Set(['-p', '--print'])

/**
 * `args` with `--plugin-dir <mod>` in front: a subcommand (`mcp list`) refuses it after its name, and nothing in front
 * can turn it into prompt text. Or `args` unchanged when the mod does not apply: a headless run, no mod folder in the package, Claude Code not
 * found or older than MOD_MIN_VERSION.
 */
export async function withClaudeMod(
  args: readonly string[],
  opts: { bin: string | null; env: Env; stateDir: string; dir?: string; run?: VersionRunner },
): Promise<string[]> {
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  if (options.some((a) => HEADLESS.has(a))) return [...args]
  const dir = opts.dir ?? claudeModDir()
  if (!dir || !opts.bin) return [...args]
  const version = await claudeVersion(opts.bin, opts.env, opts.stateDir, opts.run)
  if (!version || !versionAtLeast(version, MOD_MIN_VERSION)) return [...args]
  return ['--plugin-dir', dir, ...args]
}
