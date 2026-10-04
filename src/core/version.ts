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
