import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Config } from '../core/config.ts'
import { writeFileAtomic } from '../core/fs-safe.ts'
import { expandUserPath } from '../core/paths.ts'
import type { FamilyDef, HookEvent, HookFilter, HookHandler, Plugin, PluginApi } from '../types.ts'
import { AbortLaunch, type HookBus } from './bus.ts'

export interface PluginManifest {
  name: string
  version: string
  description?: string
  main?: string
  userConfig?: Record<string, { type?: string; default?: unknown; title?: string; description?: string }>
}

export interface LoadedPlugin {
  name: string
  version: string
  source: 'builtin' | string
  description?: string
  families: string[]
  config: Record<string, unknown>
}

export interface PluginLoadError {
  /** Plugin directory, or the plugin name when known. */
  where: string
  message: string
}

export interface BuiltinPlugin {
  plugin: Plugin
  version: string
  description: string
  /** Built-in Plugins that stay off unless the config enables them. */
  defaultEnabled: boolean
}

export interface LoadResult {
  plugins: LoadedPlugin[]
  errors: PluginLoadError[]
  families: Map<string, FamilyDef>
  familyOwner: Map<string, string>
}

/** Rejects plugin files other users could have written: plugins run with the user's full permissions. */
export async function checkTrusted(path: string): Promise<string | null> {
  const st = await stat(path)
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) return `${path} is owned by another user`
  if ((st.mode & 0o022) !== 0) return `${path} is writable by group or others; run \`chmod go-w "${path}"\``
  return null
}

/**
 * checkTrusted for a directory and everything under it, at any depth; symlinks are judged by their
 * targets and each real directory is visited once, so a link cycle cannot loop forever.
 */
export async function checkTrustedTree(root: string, seen = new Set<string>()): Promise<string | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(root)
  } catch {
    return `${root} is missing or a dangling link`
  }
  const own = await checkTrusted(root)
  if (own) return own
  if (!st.isDirectory()) return null
  const real = await realpath(root)
  if (seen.has(real)) return null
  seen.add(real)
  for (const e of await readdir(root)) {
    const problem = await checkTrustedTree(join(root, e), seen)
    if (problem) return problem
  }
  return null
}

function settingsFor(config: Config, name: string, manifest?: PluginManifest): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(manifest?.userConfig ?? {})) if ('default' in v) defaults[k] = v.default
  return { ...defaults, ...(config.plugins?.[name] ?? {}) }
}

async function register(
  plugin: Plugin,
  bus: HookBus,
  result: LoadResult,
  source: string,
  settings: Record<string, unknown>,
): Promise<string[]> {
  if (!plugin || typeof plugin.name !== 'string' || typeof plugin.register !== 'function')
    throw new Error(`${source}: default export must be { name, register(api) }`)
  // Stage everything the Plugin registers; commit only after register() succeeds, so a Plugin that fails
  // halfway leaves no Family and no hook behind.
  const stagedFamilies: FamilyDef[] = []
  const stagedHooks: (() => void)[] = []
  const api: PluginApi = {
    family(def: FamilyDef) {
      // The id becomes part of account refs and shell function names.
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(def.id))
        throw new Error(
          `family id "${def.id}" must be lowercase letters, digits or "-", starting with a letter`,
        )
      const owner = result.familyOwner.get(def.id)
      if (owner) throw new Error(`family ${def.id} is already provided by ${owner}`)
      if (stagedFamilies.some((f) => f.id === def.id)) throw new Error(`family ${def.id} is registered twice`)
      stagedFamilies.push(def)
    },
    on<E extends HookEvent>(event: E, a: HookFilter | HookHandler<E>, b?: HookHandler<E>) {
      const [filter, handler] = typeof a === 'function' ? [{}, a] : [a, b!]
      if (!['launch.before', 'account.created', 'doctor.check'].includes(event))
        throw new Error(`unknown hook event ${event}`)
      // Each hook sees its own Plugin's settings; env and args stay shared so mutations reach the Launch.
      const withConfig = ((ctx: { config: Record<string, unknown> }) =>
        handler({ ...ctx, config: settings } as never)) as HookHandler<E>
      stagedHooks.push(() => bus.add(plugin.name, event, filter, withConfig))
    },
    abort: (message: string) => new AbortLaunch(message),
    fs: {
      async writeFileAtomic(path, data, mode) {
        await writeFileAtomic(path, data, mode)
      },
    },
  }
  await plugin.register(api)
  for (const def of stagedFamilies) {
    result.families.set(def.id, def)
    result.familyOwner.set(def.id, plugin.name)
  }
  for (const add of stagedHooks) add()
  return stagedFamilies.map((f) => f.id)
}

async function candidateDirs(
  config: Config,
  userPluginsDir: string,
  home: string,
  errors: PluginLoadError[],
) {
  const dirs: string[] = []
  let entries: string[] = []
  try {
    entries = (await readdir(userPluginsDir)).sort()
  } catch {
    // no user plugins directory
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue
    const p = join(userPluginsDir, e)
    try {
      if ((await stat(p)).isDirectory()) dirs.push(p)
    } catch (err) {
      errors.push({
        where: p,
        message: `cannot read plugin directory: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      })
    }
  }
  for (const raw of config.pluginDirs ?? []) {
    const p = expandUserPath(raw, home)
    if (!p) errors.push({ where: raw, message: 'pluginDirs entries must be absolute or start with ~/' })
    else dirs.push(p)
  }
  return dirs
}

export async function loadPlugins(opts: {
  builtins: BuiltinPlugin[]
  config: Config
  bus: HookBus
  userPluginsDir: string
  home: string
}): Promise<LoadResult> {
  const result: LoadResult = { plugins: [], errors: [], families: new Map(), familyOwner: new Map() }
  const seen = new Set<string>()

  for (const b of opts.builtins) {
    const settings = settingsFor(opts.config, b.plugin.name)
    const enabled = settings.enabled === undefined ? b.defaultEnabled : settings.enabled === true
    if (!enabled) continue
    try {
      const families = await register(b.plugin, opts.bus, result, 'builtin', settings)
      seen.add(b.plugin.name)
      result.plugins.push({
        name: b.plugin.name,
        version: b.version,
        source: 'builtin',
        description: b.description,
        families,
        config: settings,
      })
    } catch (err) {
      result.errors.push({ where: b.plugin.name, message: (err as Error).message })
    }
  }

  for (const dir of await candidateDirs(opts.config, opts.userPluginsDir, opts.home, result.errors)) {
    try {
      const manifestPath = join(dir, 'plugin.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest
      if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('plugin.json needs a "name"')
      const settings = settingsFor(opts.config, manifest.name, manifest)
      if (settings.enabled === false) continue
      if (seen.has(manifest.name)) throw new Error(`a plugin named ${manifest.name} is already loaded`)
      const entry = join(dir, manifest.main ?? 'index.ts')
      // The entry can import any file next to it, so every file in the plugin directory must be trusted,
      // and the entry itself must be one of those files (`main: "../x.ts"` must not escape the check).
      const problem = await checkTrustedTree(dir)
      if (problem) throw new Error(`not loaded: ${problem}`)
      const [dirReal, entryReal] = await Promise.all([realpath(dir), realpath(entry).catch(() => null)])
      if (!entryReal) throw new Error(`not loaded: entry ${entry} is missing`)
      if (!entryReal.startsWith(`${dirReal}${sep}`))
        throw new Error(`not loaded: entry ${entry} is outside the plugin directory`)
      const mod = (await import(pathToFileURL(entry).href)) as { default?: Plugin }
      if (!mod.default) throw new Error(`${entry} has no default export`)
      if (mod.default.name !== manifest.name)
        throw new Error(
          `plugin.json name ${manifest.name} does not match the exported name ${mod.default.name}`,
        )
      const families = await register(mod.default, opts.bus, result, dir, settings)
      seen.add(manifest.name)
      result.plugins.push({
        name: manifest.name,
        version: manifest.version ?? '0.0.0',
        source: dir,
        ...(manifest.description ? { description: manifest.description } : {}),
        families,
        config: settings,
      })
    } catch (err) {
      result.errors.push({ where: dir, message: (err as Error).message })
    }
  }
  return result
}
