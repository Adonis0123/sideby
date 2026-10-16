import { readFileSync } from 'node:fs'

let cached: string | undefined

/** The sideby package version, read once from package.json (two levels up from src/, three from dist/src/). */
export function packageVersion(): string {
  if (cached) return cached
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'sideby' && pkg.version) {
        cached = pkg.version
        return cached
      }
    } catch {
      // try the next layout
    }
  }
  cached = '0.0.0'
  return cached
}

let cachedBuild: string | undefined

/**
 * Identity of the code that is running: the version plus the id `pnpm build` writes to `dist/build.json`, so a
 * rebuilt or reinstalled package differs even when its version does not. Long-running Panels compare it to
 * notice new code. From source there is no build file (`<version>+source`). `SIDEBY_BUILD_ID` overrides the
 * id for tests.
 */
export function buildId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SIDEBY_BUILD_ID) return `${packageVersion()}+${env.SIDEBY_BUILD_ID}`
  if (cachedBuild) return cachedBuild
  let id = 'source'
  try {
    // dist/src/core/version.js → dist/build.json; from src/ the file does not exist.
    const data = JSON.parse(readFileSync(new URL('../../build.json', import.meta.url), 'utf8')) as {
      id?: unknown
    }
    if (typeof data.id === 'string' && data.id) id = data.id
  } catch {
    // running from source
  }
  cachedBuild = `${packageVersion()}+${id}`
  return cachedBuild
}

/** What `pnpm local` records about a Local Build (ADR-0024). */
export interface LocalBuild {
  commit: string
  /** The working tree had changes that were not committed. */
  dirty: boolean
  builtAt: string
}

/** The Local Build fields of a `dist/build.json`, or null for a published build or anything unexpected. */
export function parseLocalBuild(data: unknown): LocalBuild | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.local !== true) return null
  return {
    commit: typeof d.commit === 'string' ? d.commit : '',
    dirty: d.dirty === true,
    builtAt: typeof d.builtAt === 'string' ? d.builtAt : '',
  }
}

let cachedLocal: LocalBuild | null | undefined

/** The running code's Local Build, or null when it was published or runs from source. */
export function localBuild(): LocalBuild | null {
  if (cachedLocal !== undefined) return cachedLocal
  try {
    cachedLocal = parseLocalBuild(
      JSON.parse(readFileSync(new URL('../../build.json', import.meta.url), 'utf8')),
    )
  } catch {
    cachedLocal = null
  }
  return cachedLocal
}
